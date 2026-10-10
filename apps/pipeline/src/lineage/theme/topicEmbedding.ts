/**
 * R2-11 (design 41 D7, doc 42 stage 2): embedding relevance for the theme
 * topic gate.
 *
 * The BFS embeds every candidate of the depth-1 pool (all seeds, their
 * references and their citing papers — the lists the BFS fetches anyway)
 * once, scores each by cosine to a theme query
 *
 *   q = normalize(mean(centroid(subject seeds' title+abstract), embed(theme; aliases; _topic_terms)))
 *
 * and standardises the scores over the pool (z = (cos - mu) / sd). Raw
 * cosine thresholds do not transfer between themes; z-scores do (doc 42).
 * `TopicScope.admits(..., z)` then applies `(term match AND z >= 0) OR
 * z >= 1.0`. Candidates seen later (depth >= 2) are scored with the same
 * mu/sd.
 *
 * Production embedder: `Xenova/bge-small-en-v1.5` (q8, pinned revision)
 * through `@huggingface/transformers`, an optionalDependency loaded by
 * dynamic import and only on the first cache miss. Vectors are cached on
 * disk, keyed by model + revision + sha256(text) and rounded to 4
 * decimals, so a rebuild is deterministic across CPUs and a warm cache
 * never loads the model. Any failure (package missing, model download,
 * inference) falls back to the Stage-1 term-only rule; the method used
 * is recorded in the artifact as `meta.topic_gate`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThemePaper } from "./openalexWork.js";
import type { TopicScope } from "./topicScope.js";

/** Pinned production model. Changing any field changes every cache key
 * (and must be re-evaluated with `eval/evalRelevanceCli.ts --embed`). */
export const TOPIC_EMBEDDING_MODEL = Object.freeze({
  repo: "Xenova/bge-small-en-v1.5",
  /** huggingface.co/Xenova/bge-small-en-v1.5 commit (2025-07-22). */
  revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
  dtype: "q8",
  /** bge's retrieval instruction, prepended to the QUERY only. */
  queryPrefix: "Represent this sentence for searching relevant passages: ",
});

/** Embeds texts into L2-normalised vectors. */
export interface TopicEmbedder {
  readonly model: string;
  readonly revision: string;
  /** Prepended to the theme query text (not to papers). */
  readonly queryPrefix: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface TopicGateMeta {
  method: "embedding+terms" | "terms";
  model: string | null;
  revision: string | null;
  thresholds: { z_lo: number; z_hi: number } | null;
  pool_size: number;
  /** Why the embedding gate was not used (fallback to terms). */
  fallback_reason?: string;
  /** Candidates admitted by the term rule because they could not be
   * embedded after the pool was scored (depth >= 2 inference failure). */
  unscored?: number;
}

/** Paper text that is embedded: title + the first 1500 characters of the
 * abstract (same as the doc 42 evaluation). */
export function paperEmbeddingText(p: { title?: unknown; abstract?: unknown }): string {
  const title = typeof p.title === "string" ? p.title : "";
  const abstract = typeof p.abstract === "string" ? p.abstract : "";
  return `${title}. ${abstract.slice(0, 1500)}`;
}

/** Text of the theme-terms query vector. */
export function themeQueryText(scope: TopicScope, queryPrefix: string): string {
  return `${queryPrefix}${scope.queryTerms.join("; ")}`;
}

// ---- vector math ----

export function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * (b[i] ?? 0);
  return s;
}

export function normalizeVec(v: readonly number[]): number[] {
  const n = Math.sqrt(dot(v, v)) || 1;
  return v.map((x) => x / n);
}

export function meanVec(vs: readonly (readonly number[])[]): number[] {
  const out = new Array<number>(vs[0]!.length).fill(0);
  for (const v of vs) for (let i = 0; i < v.length; i++) out[i]! += v[i]! / vs.length;
  return normalizeVec(out);
}

export function roundVec(v: readonly number[]): number[] {
  return v.map((x) => Math.round(x * 10000) / 10000);
}

// ---- disk cache ----

/** sha256 over model, revision and text: one key per (model version, text). */
export function embeddingCacheKey(model: string, revision: string, text: string): string {
  return createHash("sha256").update(`${model}\u0000${revision}\u0000${text}`).digest("hex");
}

/** `emb_<model>_<rev12>_<key>.json` inside `dir`. */
export function embeddingCachePath(
  dir: string,
  model: string,
  revision: string,
  text: string,
): string {
  const m = model.replace(/[^A-Za-z0-9.-]+/g, "-");
  return join(
    dir,
    `emb_${m}_${revision.slice(0, 12)}_${embeddingCacheKey(model, revision, text)}.json`,
  );
}

/** Wraps an embedder with the on-disk vector cache. Fresh and cached
 * vectors are both rounded to 4 decimals, so a cache hit and a miss give
 * identical scores. `dir === null` = no disk cache (rounding still applies). */
export class CachedTopicEmbedder implements TopicEmbedder {
  hits = 0;
  misses = 0;
  readonly model: string;
  readonly revision: string;
  readonly queryPrefix: string;

  constructor(
    private readonly inner: TopicEmbedder,
    private readonly dir: string | null,
  ) {
    this.model = inner.model;
    this.revision = inner.revision;
    this.queryPrefix = inner.queryPrefix;
  }

  private read(text: string): number[] | null {
    if (this.dir === null) return null;
    try {
      const raw = JSON.parse(
        readFileSync(embeddingCachePath(this.dir, this.model, this.revision, text), "utf8"),
      ) as { model?: unknown; revision?: unknown; vector?: unknown };
      if (raw.model !== this.model || raw.revision !== this.revision) return null;
      const v = raw.vector;
      return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number")
        ? (v as number[])
        : null;
    } catch {
      return null;
    }
  }

  private write(text: string, vector: number[]): void {
    if (this.dir === null) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const path = embeddingCachePath(this.dir, this.model, this.revision, text);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ model: this.model, revision: this.revision, vector }));
      renameSync(tmp, path);
    } catch {
      // A cache write failure only costs a recomputation next time.
    }
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const out: (number[] | null)[] = texts.map((t) => this.read(t));
    const missing = [...new Set(texts.filter((_, i) => out[i] === null))];
    this.hits += texts.length - texts.filter((_, i) => out[i] === null).length;
    if (missing.length > 0) {
      this.misses += missing.length;
      const fresh = await this.inner.embed(missing);
      if (fresh.length !== missing.length) {
        throw new Error(`embedder returned ${fresh.length} vectors for ${missing.length} texts`);
      }
      const byText = new Map<string, number[]>();
      missing.forEach((t, i) => {
        const v = roundVec(fresh[i]!);
        byText.set(t, v);
        this.write(t, v);
      });
      texts.forEach((t, i) => {
        if (out[i] === null) out[i] = byText.get(t)!;
      });
    }
    return out as number[][];
  }
}

// ---- transformers.js implementation ----

type FeatureExtractor = (
  texts: string[],
  opts: Record<string, unknown>,
) => Promise<{ tolist(): number[][] }>;

interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    opts: Record<string, unknown>,
  ) => Promise<FeatureExtractor>;
  env: { cacheDir: string | null };
}

export interface TransformersEmbedderOptions {
  /** Where model files are downloaded / read (Actions-cached in CI). */
  modelCacheDir?: string | null;
  /** Test seam / alternative install location. */
  importModule?: () => Promise<unknown>;
  batchSize?: number;
}

/** Package name in a variable so the type checker and bundlers do not
 * require the optional dependency to be installed. */
const TRANSFORMERS_PACKAGE = "@huggingface/transformers";

/** `@huggingface/transformers` feature-extraction embedder (mean pooling,
 * normalised). The package and the model are loaded on the first
 * `embed` call, so a fully cached run never touches either. */
export function createTransformersEmbedder(
  options: TransformersEmbedderOptions = {},
): TopicEmbedder {
  const { repo, revision, dtype, queryPrefix } = TOPIC_EMBEDDING_MODEL;
  let extractor: Promise<FeatureExtractor> | null = null;
  const load = async (): Promise<FeatureExtractor> => {
    const mod = (await (options.importModule ?? (() => import(TRANSFORMERS_PACKAGE)))()) as
      | TransformersModule
      | { default?: TransformersModule };
    const tf = ("pipeline" in mod ? mod : mod.default) as TransformersModule | undefined;
    if (!tf || typeof tf.pipeline !== "function") {
      throw new Error(`${TRANSFORMERS_PACKAGE} has no pipeline() export`);
    }
    if (options.modelCacheDir) tf.env.cacheDir = options.modelCacheDir;
    return tf.pipeline("feature-extraction", repo, { dtype, revision });
  };
  const batch = options.batchSize ?? 16;
  return {
    model: repo,
    revision,
    queryPrefix,
    async embed(texts) {
      if (texts.length === 0) return [];
      extractor ??= load();
      const fx = await extractor;
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batch) {
        const r = await fx(texts.slice(i, i + batch), { pooling: "mean", normalize: true });
        out.push(...r.tolist());
      }
      return out;
    },
  };
}

// ---- relevance ----

function idOf(p: { paperId?: unknown; id?: unknown }): string {
  return typeof p.paperId === "string" ? p.paperId : typeof p.id === "string" ? p.id : "";
}

/** z-scores of candidates against the theme query, standardised over the
 * pool it was built from. */
export class TopicRelevance {
  private readonly zs = new Map<string, number>();
  /** Candidates that could not be embedded after construction. */
  unscored = 0;

  constructor(
    private readonly embedder: TopicEmbedder,
    private readonly query: readonly number[],
    readonly mu: number,
    readonly sd: number,
    readonly poolSize: number,
    private readonly logger?: { warn?: (msg: string) => void },
  ) {}

  private zOf(vec: readonly number[]): number {
    return (dot(vec, this.query) - this.mu) / this.sd;
  }

  /** z of an already-scored candidate, `undefined` otherwise. */
  z(paperId: string): number | undefined {
    return this.zs.get(paperId);
  }

  /** @internal */
  set(paperId: string, vec: readonly number[]): void {
    this.zs.set(paperId, this.zOf(vec));
  }

  /** Score candidates not seen yet with the pool's mu/sd. Never throws: a
   * failure leaves them unscored (the term rule then decides them). */
  async ensure(papers: readonly { paperId?: unknown; title?: unknown; abstract?: unknown }[]) {
    const todo = papers.filter((p) => idOf(p) !== "" && !this.zs.has(idOf(p)));
    if (todo.length === 0) return;
    try {
      const vecs = await this.embedder.embed(todo.map(paperEmbeddingText));
      todo.forEach((p, i) => {
        this.set(idOf(p), vecs[i]!);
      });
    } catch (exc) {
      this.unscored += todo.length;
      this.logger?.warn?.(
        `topic gate: could not embed ${todo.length} later candidate(s), term rule applies: ${String(exc)}`,
      );
    }
  }
}

/** Build the relevance scorer for one theme. Throws when the embedder
 * fails (the caller falls back to the term rule). */
export async function buildTopicRelevance(args: {
  scope: TopicScope;
  seeds: readonly ThemePaper[];
  /** Every candidate of the pool (seeds may be included; deduplicated by id). */
  pool: readonly ThemePaper[];
  embedder: TopicEmbedder;
  logger?: { warn?: (msg: string) => void };
}): Promise<TopicRelevance> {
  const { scope, seeds, embedder } = args;
  const byId = new Map<string, ThemePaper>();
  for (const p of [...seeds, ...args.pool]) {
    const id = idOf(p);
    if (id !== "" && !byId.has(id)) byId.set(id, p);
  }
  const papers = [...byId.values()];
  if (seeds.length === 0 || papers.length < 2) {
    throw new Error(`pool too small for z-scores (${papers.length} paper(s))`);
  }
  const [termsVec, ...vecs] = await embedder.embed([
    themeQueryText(scope, embedder.queryPrefix),
    ...papers.map(paperEmbeddingText),
  ]);
  if (!termsVec || vecs.length !== papers.length) {
    throw new Error("embedder returned the wrong number of vectors");
  }
  const vecById = new Map(papers.map((p, i) => [idOf(p), vecs[i]!]));
  const seedVecs = seeds.map((s) => ({ s, v: vecById.get(idOf(s)) })).filter((x) => x.v);
  const subject = seedVecs.filter((x) => scope.role(x.s) === "subject");
  const centroid = meanVec((subject.length > 0 ? subject : seedVecs).map((x) => x.v!));
  const query = meanVec([centroid, termsVec]);
  const cos = vecs.map((v) => dot(v, query));
  const mu = cos.reduce((a, b) => a + b, 0) / cos.length;
  const sd = Math.sqrt(cos.reduce((a, b) => a + (b - mu) ** 2, 0) / cos.length);
  if (!Number.isFinite(sd) || sd <= 1e-9) throw new Error("degenerate pool (zero variance)");
  const rel = new TopicRelevance(embedder, query, mu, sd, papers.length, args.logger);
  for (const [id, v] of vecById) rel.set(id, v);
  return rel;
}

/** `meta.topic_gate` for the term-only rule. */
export function termsGateMeta(poolSize: number, reason?: string): TopicGateMeta {
  return {
    method: "terms",
    model: null,
    revision: null,
    thresholds: null,
    pool_size: poolSize,
    ...(reason !== undefined ? { fallback_reason: reason.slice(0, 300) } : {}),
  };
}

/**
 * Entry point used by the BFS: build the relevance scorer from the
 * prefetched pool, or fall back to the term rule (never throws). Returns
 * the scorer (or null) and the `meta.topic_gate` stamp.
 */
export async function prepareTopicGate(args: {
  scope: TopicScope;
  seeds: readonly ThemePaper[];
  pool: readonly ThemePaper[];
  embedder: TopicEmbedder | null;
  logger?: { warn?: (msg: string) => void };
}): Promise<{ relevance: TopicRelevance | null; meta: TopicGateMeta }> {
  const { scope, embedder, logger } = args;
  const poolSize = new Set([...args.seeds, ...args.pool].map(idOf).filter((x) => x !== "")).size;
  if (embedder === null) {
    return { relevance: null, meta: termsGateMeta(poolSize, "embedding disabled") };
  }
  try {
    const relevance = await buildTopicRelevance({ ...args, embedder });
    return {
      relevance,
      meta: {
        method: "embedding+terms",
        model: embedder.model,
        revision: embedder.revision,
        thresholds: { z_lo: scope.options.zLo, z_hi: scope.options.zHi },
        pool_size: relevance.poolSize,
      },
    };
  } catch (exc) {
    const reason = exc instanceof Error ? exc.message : String(exc);
    logger?.warn?.(
      `topic gate: embedding unavailable, falling back to the term-only rule (${reason.slice(0, 200)})`,
    );
    return { relevance: null, meta: termsGateMeta(poolSize, reason) };
  }
}

/**
 * R2-4 (design doc 42): offline comparison of topic-relevance methods on
 * the hand-labelled set `test/lineage/theme/fixtures/relevance-eval-v1.json`
 * (+ the embedding scores in `relevance-eval-v1.scores.json`). No network,
 * no LLM, writes nothing; deterministic.
 *
 *   pnpm exec tsx apps/pipeline/src/lineage/theme/eval/evalRelevanceCli.ts [--json] [--failures]
 *     [--embed [--model-cache <dir>] [--vector-cache <dir>]]
 *
 * `--embed` (R2-11) re-runs the PRODUCTION gate on the labelled set:
 * `TopicScope` defaults + `topicEmbedding.ts` (bge-small q8, pinned
 * revision, 4-decimal vector cache) with the whole labelled theme pool
 * as the z pool. Needs `@huggingface/transformers` (optionalDependency)
 * and downloads the model (~34 MB) on first use; everything else stays
 * offline.
 *
 * Methods (see doc 42 for the definitions):
 *  - rules: the live `TopicScope` gate, strict (term match / allowlist /
 *    descendant title) and with co-citation support counted over the
 *    whole candidate pool (an upper bound of the live in-graph support);
 *  - OpenAlex topics / keywords / concepts / subfield;
 *  - embedding similarity (MiniLM, bge-small) to several theme queries,
 *    with thresholds tuned on all themes ("tuned", optimistic) and
 *    leave-one-theme-out ("loto": tuned on the other three themes);
 *  - combinations.
 * Seeds are excluded from the scores: the gate never judges them.
 */

import { readFileSync } from "node:fs";
import { isMain } from "../../../shared/cli/isMain.js";
import type { ThemePaper } from "../openalexWork.js";
import {
  buildTopicRelevance,
  CachedTopicEmbedder,
  createTransformersEmbedder,
  type TopicEmbedder,
} from "../topicEmbedding.js";
import { looksLikeDataset, TopicScope } from "../topicScope.js";

const FIXTURE = "apps/pipeline/test/lineage/theme/fixtures/relevance-eval-v1.json";
const SCORES = "apps/pipeline/test/lineage/theme/fixtures/relevance-eval-v1.scores.json";

type Topic = [string, string, number, string];
type Concept = [string, string, number, number];

export interface Cand {
  id: string;
  title: string;
  abstract: string;
  year: number | null;
  sources: string[];
  on_topic: boolean;
  reason: string;
  topics: Topic[];
  concepts: Concept[];
  keywords: [string, number][];
  pool_neighbours: string[];
  in_published_history: boolean;
}

interface ThemeFx {
  theme: string;
  seeds: string[];
  openalex_search: {
    topics: { id: string; name: string }[];
    keywords: { id: string; name: string }[];
  };
  candidates: Cand[];
  neighbour_papers: Record<string, { title: string; abstract: string; seed: boolean }>;
}

interface Fixture {
  themes: Record<string, ThemeFx>;
}

type Scores = {
  models: Record<string, { scores: Record<string, Record<string, Record<string, number>>> }>;
};

/** Per-candidate decision of one method. */
type Method = (slug: string, c: Cand) => boolean;

interface Ctx {
  fx: Fixture;
  scores: Scores;
  /** Live defaults (R2-11: term match only). */
  scopes: Map<string, TopicScope>;
  /** Pre-R2-11 rules: foundational allowlist + co-citation support (2). */
  legacyScopes: Map<string, TopicScope>;
}

/** The pre-R2-11 production options, for the "rules (今)" rows of doc 42. */
const LEGACY_SCOPE = { minSupport: 2, admitFoundational: true } as const;

const isSeed = (c: Cand) => c.sources.includes("seed");
const isDescendant = (c: Cand) =>
  c.sources.some((s) => s.startsWith("cites:")) && !c.sources.some((s) => s.startsWith("ref_of:"));

const indexCache = new WeakMap<ThemeFx, Map<string, Cand>>();
function candIndex(t: ThemeFx): Map<string, Cand> {
  let m = indexCache.get(t);
  if (!m) {
    m = new Map(t.candidates.map((c) => [c.id, c]));
    indexCache.set(t, m);
  }
  return m;
}

/** Cache a deterministic method's answers (the threshold sweeps call
 * the rule half of a combination thousands of times). */
function memo(m: Method): Method {
  const cache = new Map<string, boolean>();
  return (slug, c) => {
    const k = `${slug}\u0000${c.id}`;
    let v = cache.get(k);
    if (v === undefined) {
      v = m(slug, c);
      cache.set(k, v);
    }
    return v;
  };
}

// ---------- rules ----------

/** Theme-term match only: no foundational allowlist, no support. */
function rulesTerms(ctx: Ctx): Method {
  return (slug, c) => {
    const scope = ctx.scopes.get(slug)!;
    if (isDescendant(c)) return scope.admitsDescendant(c) === "topic";
    return scope.isOnTopic(c);
  };
}

/** Title is about the theme (`TopicScope.role === "subject"`). */
function rulesTitle(ctx: Ctx): Method {
  return (slug, c) => ctx.scopes.get(slug)!.role(c) === "subject";
}

function rulesStrict(ctx: Ctx): Method {
  return (slug, c) => {
    const scope = ctx.legacyScopes.get(slug)!;
    if (isDescendant(c)) return scope.admitsDescendant(c) === "topic";
    return scope.admits(c, 0) !== null;
  };
}

/** Rules with support = number of NON-seed pool neighbours that match a
 * theme term. Over the whole pool, so an upper bound of the live gate
 * (which only counts neighbours that made it into the width-capped graph). */
function rulesSupport(ctx: Ctx): Method {
  const cache = new Map<string, boolean>();
  const lender = (slug: string, id: string): boolean => {
    const key = `${slug}\u0000${id}`;
    if (cache.has(key)) return cache.get(key)!;
    const t = ctx.fx.themes[slug]!;
    const scope = ctx.scopes.get(slug)!;
    const cand = candIndex(t).get(id);
    let ok: boolean;
    if (cand)
      ok =
        !isSeed(cand) &&
        (isDescendant(cand) ? scope.role(cand) === "subject" : scope.isOnTopic(cand));
    else {
      const p = t.neighbour_papers[id];
      ok = p !== undefined && !p.seed && scope.isOnTopic(p);
    }
    cache.set(key, ok);
    return ok;
  };
  return (slug, c) => {
    const scope = ctx.legacyScopes.get(slug)!;
    const support = c.pool_neighbours.filter((n) => n !== c.id && lender(slug, n)).length;
    if (isDescendant(c)) {
      const why = scope.admitsDescendant(c);
      return why === "topic" || (why === "provisional" && support >= scope.options.minSupport);
    }
    return scope.admits(c, support) !== null;
  };
}

/** The live gate as the BFS calls it: `admits(c, 0, z)` for references,
 * `admitsDescendant(c, z)` for citing papers; `z` from `zOf` (undefined
 * = term-only rule). */
function production(ctx: Ctx, zOf?: (slug: string, c: Cand) => number | undefined): Method {
  return (slug, c) => {
    const scope = ctx.scopes.get(slug)!;
    const z = zOf?.(slug, c);
    if (isDescendant(c)) return scope.admitsDescendant(c, z) === "topic";
    return scope.admits(c, 0, z) !== null;
  };
}

/** R2-11: z-scores from the production embedding path, per theme. */
export async function productionZ(
  fx: Fixture,
  embedder: TopicEmbedder,
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  for (const [slug, t] of Object.entries(fx.themes)) {
    const scope = TopicScope.forTheme(t.theme);
    const byId = candIndex(t);
    const seeds = t.seeds.map((id) => byId.get(id)).filter((c) => c !== undefined);
    const rel = await buildTopicRelevance({
      scope,
      seeds: seeds as unknown as ThemePaper[],
      pool: t.candidates as unknown as ThemePaper[],
      embedder,
    });
    out.set(slug, new Map(t.candidates.map((c) => [c.id, rel.z(c.id)!])));
  }
  return out;
}

function productionRow(ctx: Ctx, zs: Map<string, Map<string, number>>): Row {
  return rowFixed(
    ctx,
    "e combo",
    "PRODUCTION embedding+terms (TopicScope + topicEmbedding.ts, bge-small q8)",
    production(ctx, (s, c) => zs.get(s)?.get(c.id)),
  );
}

// ---------- OpenAlex ----------

function subjectSeeds(ctx: Ctx, slug: string): Cand[] {
  const t = ctx.fx.themes[slug]!;
  const scope = ctx.scopes.get(slug)!;
  const seeds = t.candidates.filter(isSeed);
  const subj = seeds.filter((s) => scope.role(s) === "subject");
  return subj.length > 0 ? subj : seeds;
}

function oaSearchTopic(ctx: Ctx): Method {
  return (slug, c) => {
    const top = ctx.fx.themes[slug]!.openalex_search.topics[0];
    return top !== undefined && c.topics.some((t) => t[0] === top.id);
  };
}

function oaSeedPrimaryTopic(ctx: Ctx): Method {
  return (slug, c) => {
    const set = new Set(
      subjectSeeds(ctx, slug)
        .map((s) => s.topics[0]?.[0])
        .filter(Boolean),
    );
    return c.topics[0] !== undefined && set.has(c.topics[0][0]);
  };
}

function oaSeedAnyTopic(ctx: Ctx, minScore = 0): Method {
  return (slug, c) => {
    const set = new Set(subjectSeeds(ctx, slug).flatMap((s) => s.topics.map((t) => t[0])));
    return c.topics.some((t) => t[2] >= minScore && set.has(t[0]));
  };
}

function oaKeyword(ctx: Ctx): Method {
  return (slug, c) => {
    const kw = ctx.fx.themes[slug]!.openalex_search.keywords[0]?.name?.toLowerCase();
    return kw !== undefined && c.keywords.some(([k]) => k.toLowerCase() === kw);
  };
}

function oaConcept(ctx: Ctx): Method {
  return (slug, c) => {
    const seeds = subjectSeeds(ctx, slug);
    const count = new Map<string, number>();
    for (const s of seeds) {
      for (const k of new Set(
        s.concepts.filter((x) => x[2] >= 2 && x[3] >= 0.4).map((x) => x[0]),
      )) {
        count.set(k, (count.get(k) ?? 0) + 1);
      }
    }
    const set = new Set(
      [...count].filter(([, n]) => n >= Math.ceil(seeds.length / 2)).map(([k]) => k),
    );
    return c.concepts.some((x) => x[2] >= 2 && x[3] >= 0.4 && set.has(x[0]));
  };
}

function oaSubfield(ctx: Ctx): Method {
  return (slug, c) => {
    const set = new Set(
      subjectSeeds(ctx, slug)
        .map((s) => s.topics[0]?.[3])
        .filter(Boolean),
    );
    return c.topics[0] !== undefined && set.has(c.topics[0][3]);
  };
}

// ---------- embeddings ----------

function embScore(ctx: Ctx, model: string, query: string, slug: string, c: Cand): number {
  return ctx.scores.models[model]?.scores[slug]?.[c.id]?.[query] ?? -1;
}

/** Within-theme z-score of a similarity: (s - mean) / sd over the
 * theme's candidate pool (labelled sample, seeds included). Removes the
 * per-model / per-theme offset that makes raw cosine thresholds not
 * transfer between themes. Computable at generation time (the pool is
 * known before the gate runs). */
const zStats = new Map<string, { mu: number; sd: number }>();
function embZ(ctx: Ctx, model: string, query: string, slug: string, c: Cand): number {
  const key = `${model}\u0000${query}\u0000${slug}`;
  let st = zStats.get(key);
  if (!st) {
    const xs = ctx.fx.themes[slug]!.candidates.map((x) => embScore(ctx, model, query, slug, x));
    const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length) || 1;
    st = { mu, sd };
    zStats.set(key, st);
  }
  return (embScore(ctx, model, query, slug, c) - st.mu) / st.sd;
}

const embZAt =
  (ctx: Ctx, model: string, query: string, z: number): Method =>
  (slug, c) =>
    embZ(ctx, model, query, slug, c) >= z;

const embAt =
  (ctx: Ctx, model: string, query: string, t: number): Method =>
  (slug, c) =>
    embScore(ctx, model, query, slug, c) >= t;

// ---------- metrics ----------

export interface Prf {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  p: number;
  r: number;
  f1: number;
}

export function prf(pairs: { pred: boolean; gold: boolean }[]): Prf {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const { pred, gold } of pairs) {
    if (pred && gold) tp++;
    else if (pred) fp++;
    else if (gold) fn++;
    else tn++;
  }
  const p = tp + fp === 0 ? 0 : tp / (tp + fp);
  const r = tp + fn === 0 ? 0 : tp / (tp + fn);
  return { tp, fp, fn, tn, p, r, f1: p + r === 0 ? 0 : (2 * p * r) / (p + r) };
}

function evalOn(ctx: Ctx, m: Method, slugs: string[], historyOnly = false): Prf {
  const pairs: { pred: boolean; gold: boolean }[] = [];
  for (const slug of slugs) {
    for (const c of ctx.fx.themes[slug]!.candidates) {
      if (isSeed(c)) continue;
      if (historyOnly && !c.in_published_history) continue;
      pairs.push({ pred: m(slug, c), gold: c.on_topic });
    }
  }
  return prf(pairs);
}

const GRID = Array.from({ length: 61 }, (_, i) => Math.round((0.2 + i * 0.01) * 100) / 100);
const ZGRID = Array.from({ length: 41 }, (_, i) => Math.round((-1 + i * 0.1) * 100) / 100);

/** Threshold maximising micro F1 on `slugs` (ties -> higher threshold). */
function bestT(ctx: Ctx, mk: (t: number) => Method, slugs: string[], grid = GRID): number {
  let best = grid[0]!;
  let bestF = -1;
  for (const t of grid) {
    const f = evalOn(ctx, mk(t), slugs).f1;
    if (f >= bestF) {
      bestF = f;
      best = t;
    }
  }
  return best;
}

interface Row {
  method: string;
  family: string;
  perTheme: Record<string, Prf>;
  micro: Prf;
  /** Only candidates that were once published (`in_published_history`). */
  history: Prf;
  thresholds?: Record<string, number>;
}

function rowFixed(ctx: Ctx, family: string, name: string, m: Method): Row {
  const slugs = Object.keys(ctx.fx.themes);
  const perTheme: Record<string, Prf> = {};
  for (const s of slugs) perTheme[s] = evalOn(ctx, m, [s]);
  return {
    method: name,
    family,
    perTheme,
    micro: evalOn(ctx, m, slugs),
    history: evalOn(ctx, m, slugs, true),
  };
}

/** Leave-one-theme-out: each theme is scored with the threshold tuned on
 * the other three. Micro = pooled counts over the four held-out themes. */
function rowLoto(
  ctx: Ctx,
  family: string,
  name: string,
  mk: (t: number) => Method,
  grid = GRID,
): Row {
  const slugs = Object.keys(ctx.fx.themes);
  const perTheme: Record<string, Prf> = {};
  const thresholds: Record<string, number> = {};
  const pairs: { pred: boolean; gold: boolean }[] = [];
  const hist: { pred: boolean; gold: boolean }[] = [];
  for (const s of slugs) {
    const t = bestT(
      ctx,
      mk,
      slugs.filter((x) => x !== s),
      grid,
    );
    thresholds[s] = t;
    const m = mk(t);
    perTheme[s] = evalOn(ctx, m, [s]);
    for (const c of ctx.fx.themes[s]!.candidates) {
      if (isSeed(c)) continue;
      pairs.push({ pred: m(s, c), gold: c.on_topic });
      if (c.in_published_history) hist.push({ pred: m(s, c), gold: c.on_topic });
    }
  }
  return { method: name, family, perTheme, micro: prf(pairs), history: prf(hist), thresholds };
}

export function runEval(fx: Fixture, scores: Scores): { rows: Row[]; ctx: Ctx } {
  const scopes = new Map(
    Object.entries(fx.themes).map(([s, t]) => [s, TopicScope.forTheme(t.theme)]),
  );
  const legacyScopes = new Map(
    Object.entries(fx.themes).map(([s, t]) => [s, TopicScope.forTheme(t.theme, LEGACY_SCOPE)]),
  );
  const ctx: Ctx = { fx, scores, scopes, legacyScopes };
  const rows: Row[] = [];
  const strict = memo(rulesStrict(ctx));
  const support = memo(rulesSupport(ctx));
  const terms = memo(rulesTerms(ctx));
  const title = memo(rulesTitle(ctx));
  rows.push(rowFixed(ctx, "a rules", "title about theme only (role=subject)", title));
  rows.push(rowFixed(ctx, "a rules", "theme-term match only (no allowlist)", terms));
  rows.push(rowFixed(ctx, "a rules", "rules strict (term/allowlist/descendant title)", strict));
  rows.push(rowFixed(ctx, "a rules", "rules + pool support>=2 (live upper bound)", support));
  rows.push(
    rowFixed(ctx, "a rules", "production stage 1 (TopicScope defaults, no z)", production(ctx)),
  );
  rows.push(rowFixed(ctx, "b openalex", "OA search topic (top-1)", oaSearchTopic(ctx)));
  rows.push(
    rowFixed(ctx, "b openalex", "OA primary topic = subject-seed primary", oaSeedPrimaryTopic(ctx)),
  );
  rows.push(
    rowFixed(ctx, "b openalex", "OA any topic in subject-seed topics", oaSeedAnyTopic(ctx)),
  );
  rows.push(
    rowFixed(
      ctx,
      "b openalex",
      "OA any topic (score>=0.9) in seed topics",
      oaSeedAnyTopic(ctx, 0.9),
    ),
  );
  rows.push(rowFixed(ctx, "b openalex", "OA keyword = theme keyword", oaKeyword(ctx)));
  rows.push(
    rowFixed(ctx, "b openalex", "OA concept (L>=2) shared by subject seeds", oaConcept(ctx)),
  );
  rows.push(rowFixed(ctx, "b openalex", "OA primary subfield = seed subfield", oaSubfield(ctx)));
  for (const model of Object.keys(scores.models)) {
    for (const q of ["name", "terms", "seeds", "subject", "subject_terms"]) {
      rows.push(
        rowLoto(ctx, "c embedding", `${model} ${q} (loto t)`, (t) => embAt(ctx, model, q, t)),
      );
    }
    for (const q of ["terms", "subject", "subject_terms"]) {
      rows.push(
        rowLoto(
          ctx,
          "c embedding",
          `${model} z(${q}) (loto z)`,
          (z) => embZAt(ctx, model, q, z),
          ZGRID,
        ),
      );
    }
  }
  // Combinations (thresholds leave-one-theme-out).
  const M = "bge-small-en-v1.5";
  const M2 = "all-MiniLM-L6-v2";
  for (const model of [M, M2]) {
    const e = (t: number) => embAt(ctx, model, "subject_terms", t);
    rows.push(
      rowLoto(
        ctx,
        "e combo",
        `rules strict OR ${model} subject_terms>=t`,
        (t) => (s, c) => strict(s, c) || e(t)(s, c),
      ),
    );
    rows.push(
      rowLoto(
        ctx,
        "e combo",
        `rules strict AND ${model} subject_terms>=t`,
        (t) => (s, c) => strict(s, c) && e(t)(s, c),
      ),
    );
    rows.push(
      rowLoto(
        ctx,
        "e combo",
        `rules+support AND ${model} subject_terms>=t`,
        (t) => (s, c) => support(s, c) && e(t)(s, c),
      ),
    );
    rows.push(
      rowLoto(
        ctx,
        "e combo",
        `${model} subject_terms>=t AND NOT dataset`,
        (t) => (s, c) => e(t)(s, c) && !looksLikeDataset(c),
      ),
    );
    rows.push(
      rowLoto(
        ctx,
        "e combo",
        `title-subject OR (rules strict AND ${model} subject_terms>=t)`,
        (t) => (s, c) => {
          const role = ctx.scopes.get(s)!.role(c);
          return role === "subject" || (strict(s, c) && e(t)(s, c));
        },
      ),
    );
  }
  for (const model of [M, M2]) {
    for (const q of ["terms", "subject_terms"]) {
      const ez = (z: number) => embZAt(ctx, model, q, z);
      rows.push(
        rowLoto(
          ctx,
          "e combo",
          `terms-only AND z(${model} ${q})>=z`,
          (z) => (s, c) => terms(s, c) && ez(z)(s, c),
          ZGRID,
        ),
      );
      rows.push(
        rowLoto(
          ctx,
          "e combo",
          `rules strict AND z(${model} ${q})>=z`,
          (z) => (s, c) => strict(s, c) && ez(z)(s, c),
          ZGRID,
        ),
      );
      rows.push(
        rowLoto(
          ctx,
          "e combo",
          `title-subject OR (rules+support AND z(${model} ${q})>=z)`,
          (z) => (s, c) => title(s, c) || (support(s, c) && ez(z)(s, c)),
          ZGRID,
        ),
      );
      rows.push(
        rowLoto(
          ctx,
          "e combo",
          `terms-only OR z(${model} ${q})>=z`,
          (z) => (s, c) => terms(s, c) || ez(z)(s, c),
          ZGRID,
        ),
      );
    }
  }
  // Recommended shape (doc 42): a theme-term match is kept unless the
  // embedding says it is far from the theme (z < lo: "... with GCNs for
  // SRL"); a paper without a term match needs a high z (precursors such
  // as DeepWalk / Non-local / Adaptive Mixtures of Local Experts).
  // Fixed thresholds, no tuning.
  for (const model of [M2, M]) {
    for (const q of ["terms", "subject_terms"]) {
      for (const [lo, hi] of [
        [0, 1.0],
        [0.3, 1.0],
        [0.3, 1.2],
        [0.5, 1.5],
      ] as const) {
        rows.push(
          rowFixed(
            ctx,
            "e combo",
            `(terms-only AND z>=${lo}) OR z>=${hi} [${model} ${q}]`,
            (s, c) => {
              const z = embZ(ctx, model, q, s, c);
              return (terms(s, c) && z >= lo) || z >= hi;
            },
          ),
        );
      }
    }
  }
  const anyTopic = memo(oaSeedAnyTopic(ctx));
  rows.push(
    rowLoto(
      ctx,
      "e combo",
      `rules strict OR (OA seed topic AND ${M} subject_terms>=t)`,
      (t) => (s, c) => strict(s, c) || (anyTopic(s, c) && embAt(ctx, M, "subject_terms", t)(s, c)),
    ),
  );
  rows.push(
    rowFixed(
      ctx,
      "e combo",
      "rules strict AND OA seed topic",
      (s, c) => strict(s, c) && anyTopic(s, c),
    ),
  );
  rows.push(
    rowFixed(
      ctx,
      "e combo",
      "rules strict AND NOT dataset",
      (s, c) => strict(s, c) && !looksLikeDataset(c),
    ),
  );
  return { rows, ctx };
}

const SHORT: Record<string, string> = {
  "graph-neural-network": "GNN",
  "flash-attention": "FA",
  "mixture-of-experts": "MoE",
  "vision-transformer": "ViT",
};

function fmt(x: number): string {
  return x.toFixed(2);
}

export function renderMarkdown(rows: Row[]): string {
  const slugs = Object.keys(rows[0]!.perTheme);
  const head = `| family | method | P | R | F1 | TP/FP/FN | published: kept on/off | ${slugs.map((s) => `${SHORT[s] ?? s} F1 (P/R)`).join(" | ")} | t |`;
  const sep = `|${"---|".repeat(7 + slugs.length)}`;
  const body = rows.map((r) => {
    const m = r.micro;
    const th = r.thresholds ? slugs.map((s) => r.thresholds![s]!.toFixed(2)).join("/") : "-";
    const h = r.history;
    return `| ${r.family} | ${r.method} | ${fmt(m.p)} | ${fmt(m.r)} | ${fmt(m.f1)} | ${m.tp}/${m.fp}/${m.fn} | ${h.tp}/${h.tp + h.fn} · ${h.fp}/${h.fp + h.tn} | ${slugs
      .map((s) => {
        const x = r.perTheme[s]!;
        return `${fmt(x.f1)} (${fmt(x.p)}/${fmt(x.r)})`;
      })
      .join(" | ")} | ${th} |`;
  });
  return [head, sep, ...body].join("\n");
}

function failures(ctx: Ctx, name: string, m: Method, limit = 12): string {
  const lines = [`### ${name}`];
  for (const [slug, t] of Object.entries(ctx.fx.themes)) {
    const fp = t.candidates.filter((c) => !isSeed(c) && m(slug, c) && !c.on_topic);
    const fn = t.candidates.filter((c) => !isSeed(c) && !m(slug, c) && c.on_topic);
    lines.push(
      `- ${SHORT[slug]} FP(${fp.length}): ${fp
        .slice(0, limit)
        .map((c) => c.title.slice(0, 60))
        .join(" | ")}`,
    );
    lines.push(
      `- ${SHORT[slug]} FN(${fn.length}): ${fn
        .slice(0, limit)
        .map((c) => c.title.slice(0, 60))
        .join(" | ")}`,
    );
  }
  return lines.join("\n");
}

function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

async function main(argv: string[]): Promise<number> {
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
  const scores = JSON.parse(readFileSync(SCORES, "utf8")) as Scores;
  const { rows, ctx } = runEval(fx, scores);
  if (argv.includes("--embed")) {
    const t0 = Date.now();
    const embedder = new CachedTopicEmbedder(
      createTransformersEmbedder({ modelCacheDir: argValue(argv, "--model-cache") }),
      argValue(argv, "--vector-cache"),
    );
    const zs = await productionZ(fx, embedder);
    rows.push(productionRow(ctx, zs));
    process.stderr.write(
      `production embedder: ${embedder.misses} embedded, ${embedder.hits} cached, ${((Date.now() - t0) / 1000).toFixed(1)} s\n`,
    );
  }
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`);
    return 0;
  }
  const n = Object.values(fx.themes).map((t) => {
    const c = t.candidates.filter((x) => !isSeed(x));
    return `${t.theme}: ${c.length} (${c.filter((x) => x.on_topic).length} on-topic)`;
  });
  process.stdout.write(`candidates (seeds excluded): ${n.join(", ")}\n\n${renderMarkdown(rows)}\n`);
  if (argv.includes("--failures")) {
    const strict = rulesStrict(ctx);
    const terms = rulesTerms(ctx);
    process.stdout.write(`\n${failures(ctx, "rules strict", strict)}\n`);
    process.stdout.write(`\n${failures(ctx, "rules + support", rulesSupport(ctx))}\n`);
    process.stdout.write(`\n${failures(ctx, "OA any seed topic", oaSeedAnyTopic(ctx))}\n`);
    for (const t of [0.6, 0.65, 0.7]) {
      const et = embAt(ctx, "bge-small-en-v1.5", "subject_terms", t);
      process.stdout.write(`\n${failures(ctx, `bge subject_terms>=${t}`, et)}\n`);
      process.stdout.write(
        `\n${failures(ctx, `rules strict AND bge subject_terms>=${t}`, (s, c) => strict(s, c) && et(s, c))}\n`,
      );
    }
    const rec: Method = (s, c) => {
      const z = embZ(ctx, "bge-small-en-v1.5", "subject_terms", s, c);
      return (terms(s, c) && z >= 0) || z >= 1.0;
    };
    process.stdout.write(
      `\n${failures(ctx, "recommended: (terms AND z>=0) OR z>=1.0 [bge-small subject_terms]", rec)}\n`,
    );
  }
  return 0;
}

if (isMain(import.meta.url)) {
  // exitCode, not process.exit(): exiting while onnxruntime-node's
  // threads are alive aborts the process (rc 134) on macOS.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`${String(e)}\n`);
      process.exitCode = 1;
    },
  );
}

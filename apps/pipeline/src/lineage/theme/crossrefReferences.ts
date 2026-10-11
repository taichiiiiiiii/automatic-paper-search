/**
 * R2-28 (design 41, research 47 §2.2): Crossref reference lists for citing
 * papers whose publisher withholds the list from Semantic Scholar (S2
 * returns the paper with an empty `/references`, e.g. MMoE KDD'18, ScheMoE
 * EuroSys'24) and that OpenAlex has no `referenced_works` for either.
 *
 * Only the CITATION is recovered (which in-graph papers the citing paper
 * lists); Crossref has no citation sentences, so such pairs become
 * `api_citation` (baseline_only, "Crossref の参考文献リストで確認") — never a
 * strong claim (design 41 D5).
 *
 * Etiquette (Crossref REST API; design 51 §E3): with a contact `mailto`
 * (polite pool) at most {@link CROSSREF_MAX_CONCURRENT} requests in flight
 * and >= {@link CROSSREF_MIN_INTERVAL_MS} between request starts (10
 * req/s); without one, the public-pool limits (1 in flight, 5 req/s). A
 * 429 / 403 stops Crossref for the rest of the run; at most `maxRequests`
 * per run. Off unless `PAPERPILOT_CROSSREF_REFERENCES=on`.
 *
 * Cache `data/state/lineage-cache/crossref_references.json` (one line per
 * DOI; compact references, no abstracts):
 *
 *   { "schema_version": "crossref-references-cache-v1",
 *     "entries": { "<doi>": { "fetched_at": "…",
 *                             "refs": [[doi|null, arxiv|null, "text ≤ 200 chars"], …] | null } } }
 *
 * `refs: null` = Crossref has no such DOI or no reference list.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FetchLike } from "../../collect/http/requestWithRetry.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { arxivIdsIn } from "./arxivHtml.js";
import { identifiersOf, normTitle } from "./s2Citations.js";

export const CROSSREF_SCHEMA = "crossref-references-cache-v1";
export const CROSSREF_FILENAME = "crossref_references.json";
export const CROSSREF_MAX_CONCURRENT = 3;
export const CROSSREF_MIN_INTERVAL_MS = 100;
/** Public pool (no contact): 1 in flight, 5 req/s. */
export const CROSSREF_PUBLIC_MAX_CONCURRENT = 1;
export const CROSSREF_PUBLIC_MIN_INTERVAL_MS = 200;
export const CROSSREF_DEFAULT_MAX_REQUESTS = 50;
export const CROSSREF_TTL_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const REF_TEXT_CHARS = 200;

/** [doi, arxiv id, text] of one reference. */
export type CompactRef = [string | null, string | null, string];

export interface CrossrefEntry {
  fetched_at: string;
  refs: CompactRef[] | null;
}

export interface CrossrefDeps {
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  /** Polite-pool contact (required for the polite pool). */
  mailto: string | null;
  now?: () => Date;
  monotonicNow?: () => number;
  maxRequests?: number;
  logger?: { warn: (msg: string) => void };
}

export interface CrossrefStats {
  lookups: number;
  cacheHits: number;
  requests: number;
  notFound: number;
  failed: number;
  blocked: boolean;
  budgetSkips: number;
  /** In-graph citations recovered from Crossref lists (edges added). */
  pairsAdded: number;
}

function isoZ(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

function isEntry(x: unknown): x is CrossrefEntry {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const e = x as Record<string, unknown>;
  return typeof e.fetched_at === "string" && (e.refs === null || Array.isArray(e.refs));
}

export function readCrossrefCache(path: string | null): Record<string, CrossrefEntry> {
  if (path === null || !existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (raw.schema_version !== CROSSREF_SCHEMA) return {};
    const out: Record<string, CrossrefEntry> = {};
    for (const [k, v] of Object.entries((raw.entries ?? {}) as Record<string, unknown>)) {
      if (isEntry(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeCrossrefCache(entries: Record<string, CrossrefEntry>): string {
  const keys = Object.keys(entries).sort();
  const lines = keys.map((k, i) => {
    const e = entries[k] as CrossrefEntry;
    const body = JSON.stringify({ fetched_at: e.fetched_at, refs: e.refs });
    return `    ${JSON.stringify(k)}: ${body}${i < keys.length - 1 ? "," : ""}`;
  });
  return (
    `{\n  "schema_version": ${JSON.stringify(CROSSREF_SCHEMA)},\n  "entries": {\n` +
    `${lines.join("\n")}${lines.length ? "\n" : ""}  }\n}\n`
  );
}

/** Compact one Crossref `reference[]` item. */
export function compactReference(ref: Record<string, unknown>): CompactRef {
  const s = (k: string): string => (typeof ref[k] === "string" ? (ref[k] as string) : "");
  const doi = s("DOI").trim().toLowerCase() || null;
  const text = [
    s("author"),
    s("article-title"),
    s("volume-title"),
    s("journal-title"),
    s("series-title"),
    s("unstructured"),
    s("year"),
  ]
    .filter(Boolean)
    .join(". ")
    .replace(/\s+/g, " ")
    .trim();
  const arxivFromDoi = doi?.match(/^10\.48550\/arxiv\.(.+)$/)?.[1] ?? null;
  const arxiv = arxivFromDoi ?? arxivIdsIn(text)[0] ?? null;
  return [doi, arxiv, Array.from(text).slice(0, REF_TEXT_CHARS).join("")];
}

/**
 * Whether `paper` is one of the compact references: DOI, arXiv id, or the
 * normalised title (>= 4 tokens) as a substring of the reference text.
 */
export function listsPaper(refs: readonly CompactRef[], paper: Record<string, unknown>): boolean {
  const ids = identifiersOf(paper);
  const title = normTitle(paper.title);
  const titleOk = title.split(" ").filter(Boolean).length >= 4;
  return refs.some(([doi, arxiv, text]) => {
    if (ids.doi && doi === ids.doi) return true;
    if (ids.arxiv && arxiv === ids.arxiv) return true;
    return titleOk && ` ${normTitle(text)} `.includes(` ${title} `);
  });
}

export class CrossrefReferenceSource {
  private readonly cachePath: string | null;
  private readonly deps: CrossrefDeps;
  private readonly entries: Record<string, CrossrefEntry>;
  private readonly dirty = new Set<string>();
  private readonly inflight = new Map<string, Promise<CompactRef[] | null>>();
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private lastStart: number | null = null;
  readonly stats: CrossrefStats = {
    lookups: 0,
    cacheHits: 0,
    requests: 0,
    notFound: 0,
    failed: 0,
    blocked: false,
    budgetSkips: 0,
    pairsAdded: 0,
  };

  constructor(cachePath: string | null, deps: CrossrefDeps) {
    this.cachePath = cachePath;
    this.deps = deps;
    this.entries = readCrossrefCache(cachePath);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private fresh(e: CrossrefEntry): boolean {
    const at = Date.parse(e.fetched_at);
    return !Number.isNaN(at) && this.now().getTime() - at < CROSSREF_TTL_DAYS * DAY_MS;
  }

  /** The compact reference list of `doi`, or null (none / unavailable). */
  async references(doiRaw: string): Promise<CompactRef[] | null> {
    this.stats.lookups += 1;
    const doi = doiRaw.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
    // arXiv DataCite DOIs are not in Crossref.
    if (doi.startsWith("10.48550/")) return null;
    const cached = this.entries[doi];
    if (cached && this.fresh(cached)) {
      this.stats.cacheHits += 1;
      return cached.refs;
    }
    const running = this.inflight.get(doi);
    if (running) return running;
    const p = this.fetchRefs(doi).finally(() => this.inflight.delete(doi));
    this.inflight.set(doi, p);
    return p;
  }

  private async acquire(): Promise<void> {
    const polite = !!this.deps.mailto;
    const maxActive = polite ? CROSSREF_MAX_CONCURRENT : CROSSREF_PUBLIC_MAX_CONCURRENT;
    if (this.active >= maxActive) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    this.active += 1;
    const clock = this.deps.monotonicNow ?? Date.now;
    if (this.lastStart !== null) {
      const interval = polite ? CROSSREF_MIN_INTERVAL_MS : CROSSREF_PUBLIC_MIN_INTERVAL_MS;
      const wait = this.lastStart + interval - clock();
      if (wait > 0) await this.deps.sleep(wait);
    }
    this.lastStart = clock();
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }

  private async fetchRefs(doi: string): Promise<CompactRef[] | null> {
    if (this.stats.blocked) return null;
    if (this.stats.requests >= (this.deps.maxRequests ?? CROSSREF_DEFAULT_MAX_REQUESTS)) {
      this.stats.budgetSkips += 1;
      return null;
    }
    this.stats.requests += 1;
    await this.acquire();
    let status: number;
    let body: unknown = null;
    try {
      const mail = this.deps.mailto ? `?mailto=${encodeURIComponent(this.deps.mailto)}` : "";
      const resp = await this.deps.fetchImpl(
        `https://api.crossref.org/works/${encodeURIComponent(doi)}${mail}`,
        {
          method: "GET",
          headers: {
            "User-Agent": `PaperPilot/0.1 (theme lineage${this.deps.mailto ? `; mailto:${this.deps.mailto}` : ""})`,
          },
          timeoutMs: 30_000,
        },
      );
      status = resp.status;
      if (status === 200) body = await resp.json();
    } catch (exc) {
      this.stats.failed += 1;
      this.deps.logger?.warn(`crossref: ${doi} failed: ${String(exc)}`);
      return null;
    } finally {
      this.release();
    }
    if (status === 404) {
      this.stats.notFound += 1;
      this.store(doi, null);
      return null;
    }
    if (status !== 200) {
      this.stats.failed += 1;
      if (status === 429 || status === 403) {
        this.stats.blocked = true;
        this.deps.logger?.warn(
          `crossref: ${status} for ${doi}; no more Crossref requests this run`,
        );
      }
      return null;
    }
    const msg = (body as { message?: Record<string, unknown> } | null)?.message;
    const raw = Array.isArray(msg?.reference) ? (msg?.reference as unknown[]) : [];
    const refs = raw
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
      .map(compactReference);
    this.store(doi, refs.length > 0 ? refs : null);
    return refs.length > 0 ? refs : null;
  }

  private store(doi: string, refs: CompactRef[] | null): void {
    this.entries[doi] = { fetched_at: isoZ(this.now()), refs };
    this.dirty.add(doi);
  }

  flush(): number {
    if (this.cachePath === null || this.dirty.size === 0) return 0;
    if (!existsSync(dirname(this.cachePath))) return 0;
    const onDisk = readCrossrefCache(this.cachePath);
    for (const k of this.dirty) onDisk[k] = this.entries[k] as CrossrefEntry;
    for (const [k, e] of Object.entries(onDisk)) if (!this.fresh(e)) delete onDisk[k];
    atomicWriteText(this.cachePath, serializeCrossrefCache(onDisk));
    const n = this.dirty.size;
    this.dirty.clear();
    return n;
  }

  summary(): string {
    const s = this.stats;
    return (
      `crossref summary: lookups=${s.lookups} (cache hits ${s.cacheHits}), requests=${s.requests}/` +
      `${this.deps.maxRequests ?? CROSSREF_DEFAULT_MAX_REQUESTS} (not found ${s.notFound}, failed ${s.failed}, ` +
      `budget skips ${s.budgetSkips}${s.blocked ? ", BLOCKED" : ""}), pairs added=${s.pairsAdded}, ` +
      `mailto=${this.deps.mailto ? "yes" : "no"}`
    );
  }
}

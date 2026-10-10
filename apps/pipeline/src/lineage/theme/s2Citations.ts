/**
 * Semantic Scholar citation signals for theme-lineage edges (design 41 D6,
 * R2-10). For one citing->cited pair this returns what S2's
 * `/paper/{citing}/references` knows about the citation: the sentences in
 * which the citing paper cites the other one (`contexts`), S2's citation
 * `intents` and `isInfluential`. Rule set v2 (`../classify/apiRelations.ts`)
 * turns those into a relation; see `./s2Relations.ts`.
 *
 * Theme graphs come from OpenAlex, so the citing paper is looked up in S2
 * by the identifiers the generator already has, in this order: an S2
 * paper id (40-hex `paperId`), `ARXIV:<id>`, `DOI:<doi>`, `MAG:<id>`, then
 * an exact (normalised) title match via `/paper/search/match`. The cited
 * paper is matched inside the reference list by S2 id, DOI, arXiv id or
 * normalised title (no request).
 *
 * Network: <= 1 request per `minIntervalMs` (1.1 s without a key — the
 * shared pool 429s often — 1.0 s with `PAPERPILOT_S2_API_KEY`, sent as
 * `x-api-key`; S2's free keys start at 1 req/s). 429 and 5xx are retried
 * with the server's `Retry-After` or exponential backoff (2 s .. 60 s, 6
 * attempts); a pair whose citing paper could not be fetched counts as
 * "no S2 data" for this run and is never cached.
 *
 * Persistent cache `data/state/lineage-cache/s2_references.json`
 * (promoted by regen-themes.yml with classifications.json):
 *
 *   { "schema_version": "s2-references-cache-v1",
 *     "entries": {
 *       "<citing graph id, e.g. openalex:W…>": {
 *         "s2": "ARXIV:2010.11929" | null,      // S2 lookup id; null = S2 has no such paper
 *         "fetched_at": "2026-10-10T00:00:00Z",  // oldest data in the entry
 *         "pairs": {
 *           "<cited graph id>": {"i": [intents], "c": [contexts], "f": isInfluential}
 *                               | null           // S2's reference list lacks this paper
 *         } } } }
 *
 * Only pairs the generator actually asked about are stored (a full
 * reference list is ~40 KB per paper), contexts are capped at 12 x 400
 * characters (4 before R2-23: a pair stored with 4 contexts and no `x: 1`
 * flag is refetched once, see `maybeTruncated`), and entries expire after 90 days (14 days for "S2 has no
 * such paper"). A lookup for a pair the entry does not hold refetches the
 * citing paper once per run and adds the pair.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FetchLike, HttpResponseLike } from "../../collect/http/requestWithRetry.js";
import { rateLimitHintMs } from "../../collect/http/requestWithRetry.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import type { PairSignals } from "../classify/apiRelations.js";

export const S2_REFERENCES_SCHEMA = "s2-references-cache-v1";
export const S2_REFERENCES_FILENAME = "s2_references.json";
export const S2_REFERENCES_TTL_DAYS = 90;
export const S2_NOT_FOUND_TTL_DAYS = 14;
/** Fields of each reference / citation. The bibliographic fields beyond
 * what relation classification needs (abstract, venue, citationCount,
 * authors) let the same fetched list serve as BFS expansion candidates
 * (R2-14, `./s2Expansion.ts`) without a second request. */
export const S2_REFERENCE_FIELDS =
  "contexts,intents,isInfluential,externalIds,title,year,abstract,venue,citationCount,authors";
const S2_GRAPH = "https://api.semanticscholar.org/graph/v1";
const PAGE_LIMIT = 1000;
const MAX_PAGES = 10;
/** Citing papers are fetched for expansion only: one page is plenty. */
const CITATION_PAGES = 1;
const MAX_CONTEXTS = 12;
/** R2-23: the cap before R2-23. A stored pair with this many contexts and
 * no `x` flag may have been cut short and is refetched once. */
const LEGACY_MAX_CONTEXTS = 4;
const MAX_CONTEXT_CHARS = 400;
export const S2_KEYLESS_INTERVAL_MS = 1100;
export const S2_KEYED_INTERVAL_MS = 1000;
const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One stored pair: intents, contexts, isInfluential. `x: 1` (R2-23) marks
 * a pair with {@link LEGACY_MAX_CONTEXTS} or more contexts stored under
 * the R2-23 cap ({@link MAX_CONTEXTS}), i.e. not cut at the old cap. */
export interface StoredPair {
  i: string[];
  c: string[];
  f: boolean | null;
  x?: 1;
}

export interface CitingEntry {
  s2: string | null;
  fetched_at: string;
  pairs: Record<string, StoredPair | null>;
}

export interface S2ReferencesCacheFile {
  schema_version: string;
  entries: Record<string, CitingEntry>;
}

/** What S2 says about one pair. `no_s2_data`: the citing paper is not in
 * S2 (or could not be fetched this run) — the caller keeps its non-S2
 * classification path for the pair. */
export type PairLookup =
  | { kind: "pair"; signals: PairSignals }
  | { kind: "no_s2_data"; reason: "no-id" | "citing-not-in-s2" | "fetch-failed" };

export interface S2CitationDeps {
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  /** Wall clock for `fetched_at` / TTL. */
  now?: () => Date;
  /** Monotonic ms clock for pacing (defaults to `Date.now`). */
  monotonicNow?: () => number;
  apiKey?: string | null;
  /** Overrides the pacing interval (e.g. a key with a higher limit). */
  minIntervalMs?: number | null;
  logger?: { warn: (msg: string) => void };
}

export interface S2CitationStats {
  requests: number;
  rateLimited: number;
  retries: number;
  citingFetched: number;
  citingNotInS2: number;
  citingFailed: number;
  lookups: number;
  cacheHits: number;
  pairsFound: number;
  pairsMissing: number;
  /** R2-14: `/citations` lists fetched / failed for expansion. */
  citationListsFetched: number;
  citationListsFailed: number;
  /** R2-23: stored pairs refetched because the old 4-context cap may have
   * cut them short. */
  contextRefreshes: number;
}

type PaperLike = Record<string, unknown>;

/** The paper inside one `/references` (`citedPaper`) or `/citations`
 * (`citingPaper`) entry. */
export interface S2EdgePaper {
  paperId?: unknown;
  title?: unknown;
  externalIds?: Record<string, unknown> | null;
  year?: unknown;
  abstract?: unknown;
  venue?: unknown;
  citationCount?: unknown;
  authors?: unknown;
}

/** One entry of `/paper/{id}/references` or `/paper/{id}/citations`. */
export interface RawRef {
  contexts?: unknown;
  intents?: unknown;
  isInfluential?: unknown;
  citedPaper?: S2EdgePaper | null;
  citingPaper?: S2EdgePaper | null;
}

const S2_SHA = /^[0-9a-f]{40}$/;

export function normTitle(t: unknown): string {
  return typeof t === "string"
    ? t
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
    : "";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function aliasOf(paper: PaperLike, ns: string): string | null {
  const aliases = paper.aliases;
  if (!Array.isArray(aliases)) return null;
  for (const a of aliases) {
    if (Array.isArray(a) && a[0] === ns && typeof a[1] === "string") return a[1];
  }
  return null;
}

/** The graph id of a paper dict (BFS `paperId`) or a graph node (`id`). */
export function graphIdOf(paper: PaperLike): string | null {
  return str(paper.paperId) ?? str(paper.id);
}

/** DOI / arXiv / MAG / S2 identifiers of a paper dict or graph node. */
export function identifiersOf(paper: PaperLike): {
  s2: string | null;
  arxiv: string | null;
  doi: string | null;
  mag: string | null;
} {
  const ext = (
    paper.externalIds && typeof paper.externalIds === "object" ? paper.externalIds : {}
  ) as Record<string, unknown>;
  const gid = graphIdOf(paper);
  const arxivRaw = str(ext.ArXiv) ?? str(paper.arxiv_id) ?? aliasOf(paper, "arxiv");
  const doiRaw = str(ext.DOI) ?? str(paper.doi) ?? aliasOf(paper, "doi");
  return {
    s2: gid !== null && S2_SHA.test(gid) ? gid : null,
    arxiv: arxivRaw ? arxivRaw.replace(/^arxiv:/i, "").replace(/v\d+$/, "") : null,
    doi: doiRaw ? doiRaw.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() : null,
    mag: str(ext.MAG) ?? (typeof ext.MAG === "number" ? String(ext.MAG) : null),
  };
}

/** S2 path ids to try for a citing paper, best first. */
export function lookupIdsOf(paper: PaperLike): string[] {
  const ids = identifiersOf(paper);
  const out: string[] = [];
  if (ids.s2) out.push(ids.s2);
  if (ids.arxiv) out.push(`ARXIV:${ids.arxiv}`);
  if (ids.doi) out.push(`DOI:${ids.doi}`);
  if (ids.mag) out.push(`MAG:${ids.mag}`);
  return out;
}

/** Find `cited` in a citing paper's S2 reference list. */
export function findReference(refs: readonly RawRef[], cited: PaperLike): RawRef | null {
  const ids = identifiersOf(cited);
  const title = normTitle(cited.title);
  const byField = (pred: (r: RawRef) => boolean) => refs.find(pred) ?? null;
  const ext = (r: RawRef, k: string): string | null => {
    const v = r.citedPaper?.externalIds?.[k];
    return typeof v === "string" ? v : null;
  };
  return (
    (ids.s2 ? byField((r) => r.citedPaper?.paperId === ids.s2) : null) ??
    (ids.doi ? byField((r) => ext(r, "DOI")?.toLowerCase() === ids.doi) : null) ??
    (ids.arxiv ? byField((r) => ext(r, "ArXiv")?.replace(/v\d+$/, "") === ids.arxiv) : null) ??
    (title.length >= 8 ? byField((r) => normTitle(r.citedPaper?.title) === title) : null)
  );
}

function compact(ref: RawRef): StoredPair {
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const c = strings(ref.contexts)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_CONTEXTS)
    .map((s) => Array.from(s).slice(0, MAX_CONTEXT_CHARS).join(""));
  return {
    i: strings(ref.intents),
    c,
    f: typeof ref.isInfluential === "boolean" ? ref.isInfluential : null,
    ...(c.length >= LEGACY_MAX_CONTEXTS ? { x: 1 as const } : {}),
  };
}

/** R2-23: a stored pair that may have been cut at the pre-R2-23 cap of
 * {@link LEGACY_MAX_CONTEXTS} contexts (S2 often has 5–20 per pair; the
 * build / contrast sentence was often among the dropped ones). */
export function maybeTruncated(pair: StoredPair | null | undefined): boolean {
  return pair != null && pair.c.length >= LEGACY_MAX_CONTEXTS && pair.x !== 1;
}

function signalsOf(pair: StoredPair | null): PairSignals {
  return pair === null
    ? { found: false, intents: [], contexts: [], isInfluential: null }
    : { found: true, intents: pair.i, contexts: pair.c, isInfluential: pair.f };
}

function isoZ(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

function isEntry(x: unknown): x is CitingEntry {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const e = x as Record<string, unknown>;
  return (
    (e.s2 === null || typeof e.s2 === "string") &&
    typeof e.fetched_at === "string" &&
    e.pairs !== null &&
    typeof e.pairs === "object" &&
    !Array.isArray(e.pairs)
  );
}

/** Read the cache file; any problem is an empty cache (never a crash). */
export function readS2ReferencesCache(path: string | null): Record<string, CitingEntry> {
  if (path === null || !existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (raw.schema_version !== S2_REFERENCES_SCHEMA) return {};
    const entries = raw.entries as Record<string, unknown>;
    const out: Record<string, CitingEntry> = {};
    for (const [k, v] of Object.entries(entries ?? {})) if (isEntry(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** One line per entry, keys sorted: small diffs in git. */
export function serializeS2ReferencesCache(entries: Record<string, CitingEntry>): string {
  const keys = Object.keys(entries).sort();
  const lines = keys.map((k, idx) => {
    const e = entries[k] as CitingEntry;
    const pairs = Object.fromEntries(
      Object.keys(e.pairs)
        .sort()
        .map((p) => [p, e.pairs[p]]),
    );
    const body = JSON.stringify({ s2: e.s2, fetched_at: e.fetched_at, pairs });
    return `    ${JSON.stringify(k)}: ${body}${idx < keys.length - 1 ? "," : ""}`;
  });
  return (
    `{\n  "schema_version": ${JSON.stringify(S2_REFERENCES_SCHEMA)},\n  "entries": {\n` +
    `${lines.join("\n")}${lines.length ? "\n" : ""}  }\n}\n`
  );
}

class TransientS2Error extends Error {}

export class S2CitationSource {
  private readonly cachePath: string | null;
  private readonly deps: S2CitationDeps;
  private readonly entries: Record<string, CitingEntry>;
  private readonly dirty = new Set<string>();
  /** Full reference lists fetched this run (null = failed this run). */
  private readonly memo = new Map<string, RawRef[] | null>();
  private readonly interval: number;
  private lastRequestAt: number | null = null;
  readonly stats: S2CitationStats = {
    requests: 0,
    rateLimited: 0,
    retries: 0,
    citingFetched: 0,
    citingNotInS2: 0,
    citingFailed: 0,
    lookups: 0,
    cacheHits: 0,
    pairsFound: 0,
    pairsMissing: 0,
    citationListsFetched: 0,
    citationListsFailed: 0,
    contextRefreshes: 0,
  };

  constructor(cachePath: string | null, deps: S2CitationDeps) {
    this.cachePath = cachePath;
    this.deps = deps;
    this.entries = readS2ReferencesCache(cachePath);
    this.interval =
      deps.minIntervalMs ?? (deps.apiKey ? S2_KEYED_INTERVAL_MS : S2_KEYLESS_INTERVAL_MS);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private fresh(entry: CitingEntry): boolean {
    const at = Date.parse(entry.fetched_at);
    if (Number.isNaN(at)) return false;
    const ttl = (entry.s2 === null ? S2_NOT_FOUND_TTL_DAYS : S2_REFERENCES_TTL_DAYS) * DAY_MS;
    return this.now().getTime() - at < ttl;
  }

  /** S2's signals for `cited` as referenced by `citing`. */
  async lookup(citing: PaperLike, cited: PaperLike): Promise<PairLookup> {
    this.stats.lookups += 1;
    const ck = graphIdOf(citing);
    const dk = graphIdOf(cited);
    if (ck === null || dk === null) return { kind: "no_s2_data", reason: "no-id" };
    let entry = this.entries[ck];
    if (entry && !this.fresh(entry)) entry = undefined;
    if (entry) {
      if (entry.s2 === null) return { kind: "no_s2_data", reason: "citing-not-in-s2" };
      if (Object.hasOwn(entry.pairs, dk)) {
        const stored = entry.pairs[dk] ?? null;
        if (!maybeTruncated(stored)) {
          this.stats.cacheHits += 1;
          return { kind: "pair", signals: signalsOf(stored) };
        }
        // R2-23: stored under the old 4-context cap — refetch the citing
        // paper once (shared by its other pairs this run); keep the stored
        // contexts if S2 cannot be reached.
        const refreshed = await this.refsFor(ck, citing, entry);
        if (typeof refreshed === "string") {
          this.stats.cacheHits += 1;
          return { kind: "pair", signals: signalsOf(stored) };
        }
        const ref = findReference(refreshed.refs, cited);
        // Not found again: keep the stored contexts, marked as checked so
        // later runs do not refetch for it.
        const pair = ref === null ? { ...(stored as StoredPair), x: 1 as const } : compact(ref);
        refreshed.entry.pairs[dk] = pair;
        this.dirty.add(ck);
        this.stats.contextRefreshes += 1;
        return { kind: "pair", signals: signalsOf(pair) };
      }
    }
    const loaded = await this.refsFor(ck, citing, entry);
    if (loaded === "not-found") return { kind: "no_s2_data", reason: "citing-not-in-s2" };
    if (loaded === "failed") return { kind: "no_s2_data", reason: "fetch-failed" };
    const { refs } = loaded;
    entry = loaded.entry;
    const ref = findReference(refs, cited);
    const pair = ref === null ? null : compact(ref);
    entry.pairs[dk] = pair;
    this.dirty.add(ck);
    if (pair === null) this.stats.pairsMissing += 1;
    else this.stats.pairsFound += 1;
    return { kind: "pair", signals: signalsOf(pair) };
  }

  /** The full S2 reference list of `citing` (fetched once per run and
   * shared with {@link lookup}). `null` = S2 has no such paper or could
   * not be reached this run. R2-14: BFS expansion fallback. */
  async referenceList(citing: PaperLike): Promise<RawRef[] | null> {
    const ck = graphIdOf(citing);
    if (ck === null) return null;
    let entry = this.entries[ck];
    if (entry && !this.fresh(entry)) entry = undefined;
    const loaded = await this.refsFor(ck, citing, entry);
    return typeof loaded === "string" ? null : loaded.refs;
  }

  /** One page (up to 1000) of S2's citing papers of `cited`, or `null`
   * when S2 has no such paper / could not be reached. Not cached here:
   * the expansion layer caches what it keeps. R2-14. */
  async citationList(cited: PaperLike): Promise<RawRef[] | null> {
    const ck = graphIdOf(cited);
    if (ck === null) return null;
    const entry = this.entries[ck];
    const known = entry && this.fresh(entry) ? entry.s2 : undefined;
    if (known === null) return null; // S2 has no such paper (recently checked)
    try {
      const ids = known ? [known] : lookupIdsOf(cited);
      for (const id of ids) {
        const list = await this.fetchList(id, "citations", CITATION_PAGES);
        if (list !== null) {
          this.stats.citationListsFetched += 1;
          return list;
        }
      }
      const title = str(cited.title);
      if (!known && title) {
        const matched = await this.matchTitle(title);
        if (matched !== null) {
          const list = await this.fetchList(matched, "citations", CITATION_PAGES);
          if (list !== null) {
            this.stats.citationListsFetched += 1;
            return list;
          }
        }
      }
      return null;
    } catch (exc) {
      if (!(exc instanceof TransientS2Error)) throw exc;
      this.stats.citationListsFailed += 1;
      this.deps.logger?.warn(`s2 citations: ${exc.message}`);
      return null;
    }
  }

  /** The reference list of `citing` from this run's memo or S2, keeping
   * the cache entry in step. `entry` is the fresh cache entry (if any). */
  private async refsFor(
    ck: string,
    citing: PaperLike,
    entry: CitingEntry | undefined,
  ): Promise<{ refs: RawRef[]; entry: CitingEntry } | "not-found" | "failed"> {
    if (entry && entry.s2 === null) return "not-found";
    let refs = this.memo.get(ck);
    if (refs === undefined) {
      const got = await this.fetchCiting(citing);
      if (got === "failed") {
        this.memo.set(ck, null);
        return "failed";
      }
      if (got === "not-found") {
        this.memo.set(ck, null);
        this.entries[ck] = { s2: null, fetched_at: isoZ(this.now()), pairs: {} };
        this.dirty.add(ck);
        return "not-found";
      }
      refs = got.refs;
      this.memo.set(ck, refs);
      if (!entry || entry.s2 !== got.s2) {
        entry = { s2: got.s2, fetched_at: isoZ(this.now()), pairs: {} };
        this.entries[ck] = entry;
      }
    }
    const current = entry ?? this.entries[ck];
    if (refs === null || !current) {
      return current && current.s2 === null ? "not-found" : "failed";
    }
    if (current.s2 === null) return "not-found";
    return { refs, entry: current };
  }

  /** Fetch the full reference list of `citing`. */
  private async fetchCiting(
    citing: PaperLike,
  ): Promise<{ s2: string; refs: RawRef[] } | "not-found" | "failed"> {
    const ids = lookupIdsOf(citing);
    try {
      for (const id of ids) {
        const refs = await this.fetchList(id, "references", MAX_PAGES);
        if (refs !== null) {
          this.stats.citingFetched += 1;
          return { s2: id, refs };
        }
      }
      const title = str(citing.title);
      if (title) {
        const matched = await this.matchTitle(title);
        if (matched !== null) {
          const refs = await this.fetchList(matched, "references", MAX_PAGES);
          if (refs !== null) {
            this.stats.citingFetched += 1;
            return { s2: matched, refs };
          }
        }
      }
      this.stats.citingNotInS2 += 1;
      return "not-found";
    } catch (exc) {
      if (!(exc instanceof TransientS2Error)) throw exc;
      this.stats.citingFailed += 1;
      this.deps.logger?.warn(`s2 citations: ${exc.message}`);
      return "failed";
    }
  }

  /** Up to `maxPages` pages of `/paper/{id}/{kind}`; null when S2 has no
   * such paper. */
  private async fetchList(
    id: string,
    kind: "references" | "citations",
    maxPages: number,
  ): Promise<RawRef[] | null> {
    const out: RawRef[] = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const url =
        `${S2_GRAPH}/paper/${encodeURI(id)}/${kind}` +
        `?fields=${S2_REFERENCE_FIELDS}&limit=${PAGE_LIMIT}&offset=${offset}`;
      const body = await this.getJson(url);
      if (body === null) return page === 0 ? null : out;
      const data = body.data;
      if (Array.isArray(data)) {
        for (const r of data) if (r && typeof r === "object") out.push(r as RawRef);
      }
      const next = body.next;
      if (typeof next !== "number" || next <= offset) break;
      offset = next;
    }
    return out;
  }

  private async matchTitle(title: string): Promise<string | null> {
    const url = `${S2_GRAPH}/paper/search/match?query=${encodeURIComponent(title)}&fields=paperId,title`;
    const body = await this.getJson(url);
    const data = body === null ? null : body.data;
    const first = Array.isArray(data)
      ? (data[0] as Record<string, unknown> | undefined)
      : undefined;
    if (!first) return null;
    const pid = str(first.paperId);
    return pid && normTitle(first.title) === normTitle(title) ? pid : null;
  }

  private async pace(): Promise<void> {
    const clock = this.deps.monotonicNow ?? Date.now;
    if (this.lastRequestAt !== null) {
      const wait = this.lastRequestAt + this.interval - clock();
      if (wait > 0) await this.deps.sleep(wait);
    }
    this.lastRequestAt = clock();
  }

  /** GET with pacing and 429/5xx backoff. `null` = 404/400 (no such
   * paper). @throws TransientS2Error when every attempt failed. */
  private async getJson(url: string): Promise<Record<string, unknown> | null> {
    const headers: Record<string, string> = { "User-Agent": "PaperPilot/0.1 (theme lineage)" };
    if (this.deps.apiKey) headers["x-api-key"] = this.deps.apiKey;
    let lastStatus = "no response";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) this.stats.retries += 1;
      await this.pace();
      this.stats.requests += 1;
      let resp: HttpResponseLike;
      try {
        resp = await this.deps.fetchImpl(url, { method: "GET", headers, timeoutMs: 30_000 });
      } catch (exc) {
        lastStatus = `network error ${String(exc)}`;
        await this.deps.sleep(Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS));
        continue;
      }
      if (resp.status === 200) {
        try {
          const body = await resp.json();
          if (body && typeof body === "object" && !Array.isArray(body)) {
            return body as Record<string, unknown>;
          }
        } catch {
          // malformed body: retry
        }
        lastStatus = "malformed body";
        continue;
      }
      if (resp.status === 404 || resp.status === 400) return null;
      if (resp.status === 429 || resp.status >= 500) {
        if (resp.status === 429) this.stats.rateLimited += 1;
        lastStatus = String(resp.status);
        const hint = resp.status === 429 ? rateLimitHintMs(resp.headers) : null;
        const backoff = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
        await this.deps.sleep(Math.min(Math.max(hint ?? 0, backoff), BACKOFF_MAX_MS * 2));
        continue;
      }
      throw new TransientS2Error(`S2 answered ${resp.status} for ${url}`);
    }
    throw new TransientS2Error(`S2 gave up after ${MAX_ATTEMPTS} attempts (${lastStatus}): ${url}`);
  }

  /** Merge this run's entries into the file on disk (another theme's run
   * may have written meanwhile), drop expired entries, write atomically.
   * No-op without a cache path or when the directory does not exist. */
  flush(): number {
    if (this.cachePath === null || this.dirty.size === 0) return 0;
    if (!existsSync(dirname(this.cachePath))) return 0;
    const onDisk = readS2ReferencesCache(this.cachePath);
    for (const k of this.dirty) {
      const mine = this.entries[k] as CitingEntry;
      const theirs = onDisk[k];
      if (theirs && theirs.s2 === mine.s2 && this.fresh(theirs)) {
        onDisk[k] = {
          s2: mine.s2,
          fetched_at: theirs.fetched_at < mine.fetched_at ? theirs.fetched_at : mine.fetched_at,
          pairs: { ...theirs.pairs, ...mine.pairs },
        };
      } else {
        onDisk[k] = mine;
      }
    }
    for (const [k, e] of Object.entries(onDisk)) if (!this.fresh(e)) delete onDisk[k];
    atomicWriteText(this.cachePath, serializeS2ReferencesCache(onDisk));
    const written = this.dirty.size;
    this.dirty.clear();
    return written;
  }

  summary(): string {
    const s = this.stats;
    return (
      `s2 citations summary: lookups=${s.lookups} (cache hits ${s.cacheHits}), ` +
      `pairs found=${s.pairsFound} missing=${s.pairsMissing}, context refreshes=${s.contextRefreshes}, ` +
      `citing fetched=${s.citingFetched} ` +
      `not-in-s2=${s.citingNotInS2} failed=${s.citingFailed}, requests=${s.requests} ` +
      `429=${s.rateLimited} retries=${s.retries}, key=${this.deps.apiKey ? "yes" : "no"}`
    );
  }
}

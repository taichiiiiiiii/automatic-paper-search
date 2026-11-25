/**
 * R2-36: publish max(OpenAlex, Semantic Scholar) citation counts.
 *
 * OpenAlex records can be corrupted or split (LoRA, arXiv 2106.09685 =
 * openalex:W3168867926: OpenAlex 2,510 vs Semantic Scholar 24,206; QLoRA
 * 500 vs 5,951), which under-ranks the key papers of a theme (card count,
 * heat colour, timeline y axis, "most cited" order). R2-35 already ranks
 * citing papers internally by the larger count; this module makes the
 * PUBLISHED `citation_count` the larger one too and records where it came
 * from (`citation_count_source`, set only when S2 wins — an absent field
 * means OpenAlex, which keeps every existing artifact byte-identical).
 *
 * Counts are fetched with one keyless-friendly `POST /paper/batch`
 * (`fields=citationCount`) per 250 ids, only for nodes that have an arXiv
 * id or DOI. Any failure (network, 429 exhaustion, malformed body) falls
 * back silently to OpenAlex. Answers are cached in
 * `s2_citation_counts.json` (`{schema_version, data}` wrapper) for
 * {@link S2_COUNT_TTL_DAYS} days, so a replay inside that window makes no
 * request and publishes the same bytes; "S2 does not know it" is cached too
 * (shorter), and a node answered by neither cache nor network just keeps
 * the OpenAlex count.
 *
 * #562: with a shared S2 pacer (`pace`, the theme build passes
 * `S2CitationSource.pace()`), every request — requestWithRetry's own
 * retries included — waits for the one-request-per-interval slot shared
 * with the other S2 stages, instead of this module's own interval. With
 * `retry` set (the theme CLI sets {@link S2_COUNT_RETRY}), a chunk that
 * still failed is fetched once more after one wait, all retry-phase waiting
 * bounded by `retry.budgetMs`. Library default: no pacer = own interval, no
 * retry (never sleeps beyond the old behaviour).
 */

import { titlesDisagreeStrongly } from "@paperpilot/core/abstract-sanity";
import {
  type FetchLike,
  type RequestWithRetryOptions,
  type Retry429Options,
  requestWithRetry,
} from "../../collect/http/requestWithRetry.js";
import type { ThemeGraphNode } from "../shared/node.js";
import { S2_KEYED_429_BACKOFF_BASE_MS, S2_KEYED_429_BACKOFF_MAX_MS } from "./s2Citations.js";
import { readVersionedCache, writeVersionedCache } from "./versionedCache.js";

export const S2_COUNT_CACHE_VERSION = "s2-citation-counts-cache-v1";
export const S2_COUNT_FILENAME = "s2_citation_counts.json";
export const S2_COUNT_TTL_DAYS = 30;
export const S2_COUNT_NOT_FOUND_TTL_DAYS = 7;
const S2_BATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/batch";
const BATCH_MAX_IDS = 250;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Politeness: <= 1 batch per second without a key (1.1 s); 1.25 s with one (#555: the key allows 1 request/s across ALL endpoints). */
const KEYLESS_INTERVAL_MS = 1100;
const KEYED_INTERVAL_MS = 1250;

/** #562: wait 30 s once, then refetch each failed chunk once; all waiting in
 * the retry phase (that wait, the module interval and requestWithRetry's
 * backoffs) is capped at 60 s per build. The shared pacer's own slot waits
 * (~1.1-1.25 s per request, at most ~3 requests per retried chunk) are
 * pacing, not retry waiting, and are not charged to the budget. */
export const S2_COUNT_RETRY = { waitMs: 30_000, budgetMs: 60_000 } as const;
export interface S2CountRetryOptions {
  waitMs: number;
  budgetMs: number;
}
/** A retried chunk needs at least this much budget left to be attempted. */
const RETRY_MIN_REMAINING_MS = 5_000;

export type CitationCountSource = "openalex" | "semantic_scholar";

/** `{ n: count | null (S2 has no such paper), at: ISO fetch time, t/a: S2's
 * title and first authors (R2-44, identity check; absent in older entries) }`. */
type CacheEntry = { n: number | null; at: string; t?: string; a?: string[] };

/** What one `/paper/batch` answer gives for an id. */
interface S2Answer {
  n: number | null;
  t?: string;
  a?: string[];
}

export interface S2CitationCountDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  apiKey?: string | null;
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
  /** #562: the shared S2 pacer; awaited before every request. */
  pace?: () => Promise<void>;
  /** #562: refetch a failed chunk once after `waitMs`; null/omitted = no retry. */
  retry?: S2CountRetryOptions | null;
}

/** requestWithRetry budget of the first pass. */
const FIRST_PASS_BUDGET: Pick<RequestWithRetryOptions, "overallDeadlineMs" | "retry429"> = {
  overallDeadlineMs: 90_000,
  retry429: { maxRetries: 4, maxWaitMs: 20_000, giveUpIfHintAboveMs: 60_000 },
};

/**
 * #570: with a key, a 429 backs off exponentially from 1 s capped at 8 s
 * (the `s2Citations.ts` constants, #571) instead of requestWithRetry's
 * 2 s doubling; a server hint is still used as is (capped by `maxWaitMs`).
 * Retry counts, hint caps and deadlines stay as given, so the worst-case
 * wait does not grow. Without a key the budget is returned unchanged.
 */
export function s2BatchRetry429(
  retry429: Retry429Options,
  apiKey: string | null | undefined,
): Retry429Options {
  if (!apiKey) return retry429;
  return {
    ...retry429,
    initialBackoffMs: S2_KEYED_429_BACKOFF_BASE_MS,
    maxBackoffMs: S2_KEYED_429_BACKOFF_MAX_MS,
  };
}

/** The S2 batch id of a node: `ARXIV:<id>` (version stripped) else
 * `DOI:<doi>`; `null` when the node carries neither. */
export function s2LookupId(node: {
  arxiv_id?: unknown;
  doi?: unknown;
  aliases?: unknown;
}): string | null {
  if (typeof node.arxiv_id === "string" && node.arxiv_id.trim()) {
    return `ARXIV:${node.arxiv_id.trim().replace(/v\d+$/i, "")}`;
  }
  if (typeof node.doi === "string" && node.doi.trim()) {
    return `DOI:${node.doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`;
  }
  return null;
}

/** Pure merge: the larger of the two counts, and who it came from. A tie
 * (or a missing / invalid S2 count) stays OpenAlex's. */
export function mergeCitationCounts(
  openalex: number,
  s2: number | null | undefined,
): { count: number; source: CitationCountSource } {
  const oa = Number.isFinite(openalex) && openalex > 0 ? Math.trunc(openalex) : 0;
  if (typeof s2 === "number" && Number.isFinite(s2) && s2 > oa) {
    return { count: Math.trunc(s2), source: "semantic_scholar" };
  }
  return { count: oa, source: "openalex" };
}

const surname = (name: string): string =>
  (name.trim().toLowerCase().split(/\s+/).pop() ?? "").replace(/[^\p{L}\p{N}]/gu, "");

const TITLE_STOP = new Set([
  "a",
  "an",
  "the",
  "of",
  "for",
  "and",
  "in",
  "on",
  "to",
  "with",
  "via",
  "by",
]);
const titleWords = (t: string): Set<string> =>
  new Set(
    t
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 0 && !TITLE_STOP.has(w)),
  );

/** Two titles of one arXiv id that share fewer than half of their words
 * (the RAGAS paper under a \"Design and Evaluation of a RAG Architecture for
 * OWASP\" title shares only the topic words). */
function titlesDiverge(a: string, b: string): boolean {
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (wa.size < 3 || wb.size < 3) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / (wa.size + wb.size - shared) < 0.5;
}

/**
 * R2-44: repair a node whose OpenAlex record drifted from the paper its
 * arXiv id names (2026-10-23, Retrieval-Augmented Generation: Self-RAG
 * carried another paper's authors and DOI; the RAGAS paper carried another
 * title). Authors with no surname in common with S2's are replaced by S2's
 * (and the record's DOI, which belongs to the other work, is dropped);
 * a title that plainly describes another subject is replaced too, together
 * with the text taken from the wrong record. Returns what changed.
 */
export function correctNodeIdentity(
  node: ThemeGraphNode,
  s2: { t?: string; a?: string[] },
): ("authors" | "title")[] {
  const out: ("authors" | "title")[] = [];
  const mine = new Set(node.authors.map(surname).filter((x) => x.length > 0));
  const theirs = (s2.a ?? []).map(surname).filter((x) => x.length > 0);
  if (mine.size > 0 && theirs.length > 0 && !theirs.some((x) => mine.has(x))) {
    node.authors = (s2.a ?? []).slice(0, 5);
    delete node.doi;
    if (Array.isArray(node.aliases)) {
      node.aliases = node.aliases.filter(([ns]) => ns !== "doi");
    }
    out.push("authors");
  }
  if (
    typeof s2.t === "string" &&
    s2.t.length > 0 &&
    node.title !== s2.t &&
    (titlesDisagreeStrongly(node.title, s2.t) || titlesDiverge(node.title, s2.t))
  ) {
    node.title = s2.t;
    node.tldr = "";
    delete node.short_abstract;
    out.push("title");
  }
  return out;
}

/** Raise `node.citation_count` to `s2` when S2's count is larger. Returns
 * true when the node changed. */
export function applyS2Count(node: ThemeGraphNode, s2: number | null | undefined): boolean {
  const merged = mergeCitationCounts(Number(node.citation_count) || 0, s2);
  if (merged.source !== "semantic_scholar") return false;
  node.citation_count = merged.count;
  node.citation_count_source = "semantic_scholar";
  return true;
}

function loadCache(path: string | null): Record<string, CacheEntry> {
  if (path === null) return {};
  const raw = readVersionedCache(path, S2_COUNT_CACHE_VERSION);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, CacheEntry> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    const nOk = e.n === null || (typeof e.n === "number" && Number.isInteger(e.n) && e.n >= 0);
    if (nOk && typeof e.at === "string") {
      const entry: CacheEntry = { n: e.n as number | null, at: e.at };
      if (typeof e.t === "string") entry.t = e.t;
      if (Array.isArray(e.a) && e.a.every((x) => typeof x === "string")) entry.a = e.a as string[];
      out[k] = entry;
    }
  }
  return out;
}

function isFresh(entry: CacheEntry, nowMs: number): boolean {
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at)) return false;
  if (entry.n !== null && entry.t === undefined) return false;
  const ttl = entry.n === null ? S2_COUNT_NOT_FOUND_TTL_DAYS : S2_COUNT_TTL_DAYS;
  return nowMs - at < ttl * DAY_MS;
}

/** Fetch `citationCount` for `ids` (already de-duplicated, sorted). Returns
 * the answers it got; a failed chunk contributes nothing. */
async function fetchChunk(
  ids: readonly string[],
  deps: S2CitationCountDeps,
  budget: Pick<RequestWithRetryOptions, "overallDeadlineMs" | "retry429"> = FIRST_PASS_BUDGET,
): Promise<Map<string, S2Answer> | null> {
  const headers: Record<string, string> = { "User-Agent": "PaperPilot/0.1" };
  if (deps.apiKey) headers["x-api-key"] = deps.apiKey;
  let resp: Awaited<ReturnType<typeof requestWithRetry>>;
  try {
    resp = await requestWithRetry(
      {
        method: "POST",
        url: S2_BATCH_URL,
        params: { fields: "citationCount,title,authors.name" },
        jsonBody: { ids },
        headers,
        timeoutMs: 30_000,
        ...budget,
        ...(budget.retry429 ? { retry429: s2BatchRetry429(budget.retry429, deps.apiKey) } : {}),
        label: "s2-citation-counts",
      },
      {
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
        // A logger without `warn` must not turn a 429 into a thrown TypeError.
        logger: { warn: (m: string) => deps.logger?.warn?.(m) },
      },
    );
  } catch {
    return null;
  }
  if (resp === null || resp.status !== 200) return null;
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return null;
  }
  if (!Array.isArray(body) || body.length !== ids.length) return null;
  const out = new Map<string, S2Answer>();
  for (let i = 0; i < ids.length; i++) {
    const item = body[i];
    if (item === null) {
      out.set(ids[i]!, { n: null });
    } else if (typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const c = rec.citationCount;
      if (typeof c === "number" && Number.isInteger(c) && c >= 0) {
        const answer: S2Answer = { n: c };
        answer.t = typeof rec.title === "string" ? rec.title : "";
        if (Array.isArray(rec.authors)) {
          answer.a = rec.authors
            .slice(0, 5)
            .map((x) =>
              x && typeof x === "object" ? String((x as { name?: unknown }).name ?? "") : "",
            )
            .filter((x) => x.length > 0);
        }
        out.set(ids[i]!, answer);
      }
      // A paper S2 knows without a count: no answer, nothing cached.
    } else {
      return null;
    }
  }
  return out;
}

export interface S2CountStats {
  eligible: number;
  fromCache: number;
  fetched: number;
  raised: number;
  /** R2-44: nodes whose authors / title were replaced by S2's. */
  corrected: number;
  failedChunks: number;
  /** #562: chunks fetched a second time after the retry wait. */
  retried: number;
  /** #562: retried chunks that answered. */
  recovered: number;
}

/** Raise the `citation_count` of every node whose Semantic Scholar count is
 * larger. `cachePath` null = no persistence. Never throws. */
export async function applyS2CitationCounts(
  nodes: ReadonlyMap<string, ThemeGraphNode> | Iterable<ThemeGraphNode>,
  opts: { cachePath: string | null } & S2CitationCountDeps,
): Promise<S2CountStats> {
  const list: ThemeGraphNode[] = nodes instanceof Map ? [...nodes.values()] : [...nodes];
  const stats: S2CountStats = {
    eligible: 0,
    fromCache: 0,
    fetched: 0,
    raised: 0,
    corrected: 0,
    failedChunks: 0,
    retried: 0,
    recovered: 0,
  };
  const byId = new Map<string, ThemeGraphNode[]>();
  for (const node of list) {
    const key = s2LookupId(node);
    if (key === null) continue;
    stats.eligible += 1;
    const group = byId.get(key);
    if (group) group.push(node);
    else byId.set(key, [node]);
  }
  const now = opts.now ?? (() => new Date());
  const nowMs = now().getTime();
  const cache = loadCache(opts.cachePath);
  const answers = new Map<string, S2Answer>();
  const missing: string[] = [];
  for (const key of [...byId.keys()].sort()) {
    const hit = cache[key];
    if (hit !== undefined && isFresh(hit, nowMs)) {
      answers.set(key, {
        n: hit.n,
        ...(hit.t !== undefined ? { t: hit.t } : {}),
        ...(hit.a ? { a: hit.a } : {}),
      });
      stats.fromCache += 1;
    } else {
      missing.push(key);
    }
  }

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.apiKey ? KEYED_INTERVAL_MS : KEYLESS_INTERVAL_MS;
  const pace = opts.pace;
  // With a shared pacer every request (requestWithRetry's retries included)
  // waits for its slot; the module's own interval then only applies without one.
  const fetchImpl: FetchLike = pace
    ? async (url, init) => {
        await pace();
        return opts.fetchImpl(url, init);
      }
    : opts.fetchImpl;
  const stamp = now()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const record = (got: Map<string, S2Answer>): void => {
    for (const [key, ans] of got) {
      answers.set(key, ans);
      cache[key] = {
        n: ans.n,
        at: stamp,
        ...(ans.t !== undefined ? { t: ans.t } : {}),
        ...(ans.a ? { a: ans.a } : {}),
      };
      stats.fetched += 1;
    }
  };
  const failed: string[][] = [];
  for (let i = 0; i < missing.length; i += BATCH_MAX_IDS) {
    if (i > 0 && !pace) await sleep(interval);
    const chunk = missing.slice(i, i + BATCH_MAX_IDS);
    const got = await fetchChunk(chunk, { ...opts, fetchImpl, sleep });
    if (got === null) failed.push(chunk);
    else record(got);
  }
  const retry = opts.retry;
  if (failed.length > 0 && retry && retry.budgetMs > 0) {
    // Every wait of the retry phase (the pre-retry wait, the module interval,
    // requestWithRetry's backoffs) is charged to one budget and clamped to it.
    let remaining = retry.budgetMs;
    const retrySleep = async (ms: number): Promise<void> => {
      const w = Math.max(0, Math.min(ms, remaining));
      remaining -= w;
      if (w > 0) await sleep(w);
    };
    await retrySleep(retry.waitMs);
    const stillFailed: string[][] = [];
    for (let j = 0; j < failed.length; j++) {
      const chunk = failed[j]!;
      if (remaining < RETRY_MIN_REMAINING_MS) {
        stillFailed.push(...failed.slice(j));
        break;
      }
      if (j > 0 && !pace) await retrySleep(interval);
      stats.retried += 1;
      const got = await fetchChunk(
        chunk,
        { ...opts, fetchImpl, sleep: retrySleep },
        {
          overallDeadlineMs: 30_000,
          retry429: {
            maxRetries: 1,
            maxWaitMs: RETRY_MIN_REMAINING_MS,
            giveUpIfHintAboveMs: RETRY_MIN_REMAINING_MS,
          },
        },
      );
      if (got === null) stillFailed.push(chunk);
      else {
        stats.recovered += 1;
        record(got);
      }
    }
    failed.splice(0, failed.length, ...stillFailed);
  }
  stats.failedChunks = failed.length;
  if (stats.fetched > 0 && opts.cachePath !== null) {
    const sorted: Record<string, CacheEntry> = {};
    for (const key of Object.keys(cache).sort()) sorted[key] = cache[key]!;
    try {
      writeVersionedCache(opts.cachePath, S2_COUNT_CACHE_VERSION, sorted);
    } catch (exc) {
      opts.logger?.warn?.(`s2 citation counts: cache write failed (${String(exc)})`);
    }
  }

  for (const [key, group] of byId) {
    const ans = answers.get(key);
    for (const node of group) {
      if (applyS2Count(node, ans?.n)) stats.raised += 1;
      // The arXiv id is an identity anchor independent of OpenAlex's own
      // record: when S2 says the paper with this id has other authors / a
      // plainly different title, the OpenAlex record has drifted.
      if (ans !== undefined && key.startsWith("ARXIV:")) {
        const fixed = correctNodeIdentity(node, ans);
        if (fixed.length > 0) {
          stats.corrected += 1;
          opts.logger?.warn?.(
            `s2 identity: ${node.id} corrected ${fixed.join("+")} from S2 (${key})`,
          );
        }
      }
    }
  }
  if (stats.failedChunks > 0) {
    opts.logger?.warn?.(
      `s2 citation counts: ${stats.failedChunks} batch(es) failed; those nodes keep OpenAlex counts`,
    );
  }
  opts.logger?.info?.(
    `s2 citation counts: eligible=${stats.eligible}, cached=${stats.fromCache}, fetched=${stats.fetched}, raised=${stats.raised}, identity corrected=${stats.corrected}, retried=${stats.retried} recovered=${stats.recovered}`,
  );
  return stats;
}

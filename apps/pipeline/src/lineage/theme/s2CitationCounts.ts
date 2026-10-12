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
 */

import {
  type FetchLike,
  type RequestWithRetryOptions,
  requestWithRetry,
} from "../../collect/http/requestWithRetry.js";
import type { ThemeGraphNode } from "../shared/node.js";
import { readVersionedCache, writeVersionedCache } from "./versionedCache.js";

export const S2_COUNT_CACHE_VERSION = "s2-citation-counts-cache-v1";
export const S2_COUNT_FILENAME = "s2_citation_counts.json";
export const S2_COUNT_TTL_DAYS = 30;
export const S2_COUNT_NOT_FOUND_TTL_DAYS = 7;
const S2_BATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/batch";
const BATCH_MAX_IDS = 250;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Politeness: <= 1 batch per second without a key (1.1 s), 1 s with one. */
const KEYLESS_INTERVAL_MS = 1100;
const KEYED_INTERVAL_MS = 1000;

export type CitationCountSource = "openalex" | "semantic_scholar";

/** `{ n: count | null (S2 has no such paper), at: ISO fetch time }`. */
type CacheEntry = { n: number | null; at: string };

export interface S2CitationCountDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  apiKey?: string | null;
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
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
    if (nOk && typeof e.at === "string") out[k] = { n: e.n as number | null, at: e.at };
  }
  return out;
}

function isFresh(entry: CacheEntry, nowMs: number): boolean {
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at)) return false;
  const ttl = entry.n === null ? S2_COUNT_NOT_FOUND_TTL_DAYS : S2_COUNT_TTL_DAYS;
  return nowMs - at < ttl * DAY_MS;
}

/** Fetch `citationCount` for `ids` (already de-duplicated, sorted). Returns
 * the answers it got; a failed chunk contributes nothing. */
async function fetchChunk(
  ids: readonly string[],
  deps: S2CitationCountDeps,
): Promise<Map<string, number | null> | null> {
  const headers: Record<string, string> = { "User-Agent": "PaperPilot/0.1" };
  if (deps.apiKey) headers["x-api-key"] = deps.apiKey;
  const budget: Pick<RequestWithRetryOptions, "overallDeadlineMs" | "retry429"> = {
    overallDeadlineMs: 90_000,
    retry429: { maxRetries: 4, maxWaitMs: 20_000, giveUpIfHintAboveMs: 60_000 },
  };
  let resp: Awaited<ReturnType<typeof requestWithRetry>>;
  try {
    resp = await requestWithRetry(
      {
        method: "POST",
        url: S2_BATCH_URL,
        params: { fields: "citationCount" },
        jsonBody: { ids },
        headers,
        timeoutMs: 30_000,
        ...budget,
      },
      { fetchImpl: deps.fetchImpl, sleep: deps.sleep, logger: deps.logger as never },
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
  const out = new Map<string, number | null>();
  for (let i = 0; i < ids.length; i++) {
    const item = body[i];
    if (item === null) {
      out.set(ids[i]!, null);
    } else if (typeof item === "object" && !Array.isArray(item)) {
      const c = (item as Record<string, unknown>).citationCount;
      if (typeof c === "number" && Number.isInteger(c) && c >= 0) out.set(ids[i]!, c);
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
  failedChunks: number;
}

/** Raise the `citation_count` of every node whose Semantic Scholar count is
 * larger. `cachePath` null = no persistence. Never throws. */
export async function applyS2CitationCounts(
  nodes: ReadonlyMap<string, ThemeGraphNode> | Iterable<ThemeGraphNode>,
  opts: { cachePath: string | null } & S2CitationCountDeps,
): Promise<S2CountStats> {
  const list: ThemeGraphNode[] = nodes instanceof Map ? [...nodes.values()] : [...nodes];
  const stats: S2CountStats = { eligible: 0, fromCache: 0, fetched: 0, raised: 0, failedChunks: 0 };
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
  const answers = new Map<string, number | null>();
  const missing: string[] = [];
  for (const key of [...byId.keys()].sort()) {
    const hit = cache[key];
    if (hit !== undefined && isFresh(hit, nowMs)) {
      answers.set(key, hit.n);
      stats.fromCache += 1;
    } else {
      missing.push(key);
    }
  }

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.apiKey ? KEYED_INTERVAL_MS : KEYLESS_INTERVAL_MS;
  const stamp = now()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  for (let i = 0; i < missing.length; i += BATCH_MAX_IDS) {
    if (i > 0) await sleep(interval);
    const chunk = missing.slice(i, i + BATCH_MAX_IDS);
    const got = await fetchChunk(chunk, opts);
    if (got === null) {
      stats.failedChunks += 1;
      continue;
    }
    for (const [key, n] of got) {
      answers.set(key, n);
      cache[key] = { n, at: stamp };
      stats.fetched += 1;
    }
  }
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
    const n = answers.get(key);
    for (const node of group) if (applyS2Count(node, n)) stats.raised += 1;
  }
  if (stats.failedChunks > 0) {
    opts.logger?.warn?.(
      `s2 citation counts: ${stats.failedChunks} batch(es) failed; those nodes keep OpenAlex counts`,
    );
  }
  opts.logger?.info?.(
    `s2 citation counts: eligible=${stats.eligible}, cached=${stats.fromCache}, fetched=${stats.fetched}, raised=${stats.raised}`,
  );
  return stats;
}

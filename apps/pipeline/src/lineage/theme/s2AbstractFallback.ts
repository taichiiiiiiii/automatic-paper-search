/**
 * #560: abstract fallback for the topic gate.
 *
 * The BFS drops every reference / citing paper that has no abstract
 * (`bfs.ts`: `filter((p) => p.abstract)`). OpenAlex has no abstract for a
 * number of core papers (publisher-restricted: Prefix-Tuning, CoOp, BART,
 * mT5 ... 105 candidates in one Prompt Tuning build, 68 of them answered by
 * Semantic Scholar). This asks Semantic Scholar for the missing abstracts
 * with one keyed `POST /paper/batch` per 250 papers and stores the text on
 * the paper as `_gate_abstract` -- NOT as `abstract`.
 *
 * Why a separate field: the text is used ONLY to decide whether the paper
 * is on topic (admission filters, topic scope, embedding). `toThemeNode`
 * builds `short_abstract` / `tldr` from `abstract`, so nothing taken from
 * Semantic Scholar is ever published, written to a cache file or committed
 * (license: design 41 / #497). A wrong match is prevented by requiring
 * S2's title to equal the paper's title (after normalisation); any failed
 * or throttled request leaves the paper exactly as before (no abstract,
 * dropped), never invents one.
 */

import type { FetchLike } from "../../collect/http/requestWithRetry.js";
import {
  type RequestWithRetryOptions,
  requestWithRetry,
} from "../../collect/http/requestWithRetry.js";
import { s2LookupId } from "./s2CitationCounts.js";

const S2_BATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/batch";
const CHUNK = 250;

/** After this many failed chunks in one run the fallback stops asking
 * (a degraded S2 must not stall the BFS: each attempt can wait ~90 s). */
export const MAX_FAILED_CHUNKS = 2;

export interface S2AbstractDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** The shared S2 pacer (one request per interval across ALL S2 calls). */
  pace?: () => Promise<void>;
  apiKey?: string | null;
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}

export interface S2AbstractStats {
  asked: number;
  filled: number;
  titleMismatch: number;
  notFound: number;
  failedChunks: number;
}

/** A paper as far as this module needs it. */
export interface AbstractFallbackPaper {
  abstract?: unknown;
  title?: unknown;
  externalIds?: Record<string, string> | null;
  _gate_abstract?: string;
  [key: string]: unknown;
}

function normTitle(t: unknown): string {
  return String(t ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function hasGateText(p: { abstract?: unknown; _gate_abstract?: unknown }): boolean {
  return (
    (typeof p.abstract === "string" && p.abstract.length > 0) ||
    (typeof p._gate_abstract === "string" && p._gate_abstract.length > 0)
  );
}

function lookupIdOf(p: AbstractFallbackPaper): string | null {
  const ids = p.externalIds ?? {};
  return s2LookupId({ arxiv_id: ids.ArXiv, doi: ids.DOI });
}

async function fetchChunk(
  ids: readonly string[],
  deps: S2AbstractDeps,
): Promise<Array<{ title?: unknown; abstract?: unknown } | null> | null> {
  const headers: Record<string, string> = { "User-Agent": "PaperPilot/0.1" };
  if (deps.apiKey) headers["x-api-key"] = deps.apiKey;
  const budget: Pick<RequestWithRetryOptions, "overallDeadlineMs" | "retry429"> = {
    overallDeadlineMs: 90_000,
    retry429: { maxRetries: 4, maxWaitMs: 20_000, giveUpIfHintAboveMs: 60_000 },
  };
  try {
    if (deps.pace) await deps.pace();
    const resp = await requestWithRetry(
      {
        method: "POST",
        url: S2_BATCH_URL,
        params: { fields: "title,abstract" },
        jsonBody: { ids },
        headers,
        timeoutMs: 30_000,
        ...budget,
      },
      {
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
        logger: { warn: (m: string) => deps.logger?.warn?.(m) } as never,
      },
    );
    if (resp === null || resp.status !== 200) return null;
    const body: unknown = await resp.json();
    if (!Array.isArray(body) || body.length !== ids.length) return null;
    return body.map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null));
  } catch {
    return null;
  }
}

/** What S2 answered for one lookup id (title kept for the title check). */
interface RememberedAbstract {
  title: unknown;
  abstract: string;
}

/**
 * #566: the S2 answers of one run, keyed by the run's `tried` set so the
 * memo lives exactly as long as `tried` (one build) without a new argument.
 * The BFS reads a seed's neighbours twice (topic-gate pool, then the BFS
 * proper) and the second read re-parses the fetch cache into NEW objects:
 * without the memo those ids are already "tried", so the second copy never
 * got the text and the paper was dropped. In memory only -- never written.
 */
const memoByRun = new WeakMap<Set<string>, Map<string, RememberedAbstract>>();

function memoFor(tried: Set<string>): Map<string, RememberedAbstract> {
  let memo = memoByRun.get(tried);
  if (memo === undefined) {
    memo = new Map();
    memoByRun.set(tried, memo);
  }
  return memo;
}

/**
 * Fills `_gate_abstract` on the papers that have no abstract and an S2
 * lookup id. Mutates the papers; never throws. Papers already tried in this
 * run (kept in `tried`) are not asked again; when S2 answered them, the
 * remembered text is attached to the new copy (same title check), even
 * after the run stopped asking (MAX_FAILED_CHUNKS). Re-attaching is not
 * counted in `stats` (stats describe requests and answers).
 */
export async function supplementAbstracts(
  papers: readonly AbstractFallbackPaper[],
  deps: S2AbstractDeps,
  tried: Set<string>,
  stats: S2AbstractStats,
): Promise<void> {
  const memo = memoFor(tried);
  for (const p of papers) {
    if (hasGateText(p)) continue;
    const id = lookupIdOf(p);
    const known = id === null ? undefined : memo.get(id);
    if (known !== undefined && normTitle(known.title) === normTitle(p.title)) {
      p._gate_abstract = known.abstract;
    }
  }
  if (stats.failedChunks >= MAX_FAILED_CHUNKS) return;
  const want = new Map<string, AbstractFallbackPaper[]>();
  for (const p of papers) {
    if (hasGateText(p)) continue;
    const id = lookupIdOf(p);
    if (id === null || tried.has(id)) continue;
    const list = want.get(id) ?? [];
    list.push(p);
    want.set(id, list);
  }
  const ids = [...want.keys()].sort();
  for (let i = 0; i < ids.length; i += CHUNK) {
    if (stats.failedChunks >= MAX_FAILED_CHUNKS) return;
    const chunk = ids.slice(i, i + CHUNK);
    for (const id of chunk) tried.add(id);
    stats.asked += chunk.length;
    const answers = await fetchChunk(chunk, deps);
    if (answers === null) {
      stats.failedChunks += 1;
      // A failed chunk is retried by a later call (not marked as tried).
      for (const id of chunk) tried.delete(id);
      continue;
    }
    chunk.forEach((id, k) => {
      const a = answers[k];
      if (!a) {
        stats.notFound += 1;
        return;
      }
      const abstract = typeof a.abstract === "string" ? a.abstract.trim() : "";
      if (!abstract) {
        stats.notFound += 1;
        return;
      }
      memo.set(id, { title: a.title, abstract });
      for (const p of want.get(id) ?? []) {
        if (normTitle(a.title) !== normTitle(p.title)) {
          stats.titleMismatch += 1;
          continue;
        }
        p._gate_abstract = abstract;
        stats.filled += 1;
      }
    });
  }
}

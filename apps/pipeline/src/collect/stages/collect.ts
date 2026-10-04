/**
 * Stage 0: parallel collection from enabled sources — TS port of
 * `paperpilot/pipeline/stage_collect.py` (COL-15, COL-16 of
 * docs/migration/safety-contracts.md).
 */

import type { Paper } from "../model/paper.js";
import { AllKeywordsFailedError, type DegradedKeyword, type Source } from "../sources/source.js";
import { dedupPapers } from "../state/seenIds.js";

/**
 * A `Source` plus the `enabled` flag `AbstractSource` carries in Python.
 * Part-1's `Source` interface (`sources/source.ts`) deliberately does not
 * carry this (it is a construction-time config concern there), so this
 * stage takes it alongside the source rather than extending/modifying that
 * interface.
 */
export interface SourceEntry {
  source: Source;
  enabled: boolean;
}

export interface SourceStatus {
  ok: boolean;
  count: number;
  error: string | null;
}

export interface SourceCompleteness {
  truncatedKeywords: string[];
  degradedKeywords: DegradedKeyword[];
}

export interface CollectResult {
  papers: Paper[];
  /** ISO `YYYY-MM-DD`. */
  sinceDate: string;
  status: Record<string, SourceStatus>;
  /** Present for every attempted (enabled) source, success or failure. */
  completeness: Record<string, SourceCompleteness>;
}

export interface CollectParams {
  keywords: string[];
  categories: string[];
  daysBack: number;
  maxResultsPerKeyword: number;
}

export interface CollectDeps {
  now?: () => Date;
  logger?: { warn: (msg: string) => void; info: (msg: string) => void };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** LOCAL-time `YYYY-MM-DD` — mirrors Python's naive `date.today()`, not UTC. */
function toIsoDate(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function collect(
  sources: readonly SourceEntry[],
  params: CollectParams,
  deps: CollectDeps = {},
): Promise<CollectResult> {
  const now = deps.now ? deps.now() : new Date();
  // Calendar (not millisecond) subtraction — DST-safe, mirrors Python's
  // `date.today() - timedelta(days=days_back)` operating on whole dates.
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - params.daysBack);
  const sinceDate = toIsoDate(since);
  const enabled = sources.filter((e) => e.enabled);
  const status: Record<string, SourceStatus> = {};
  const completeness: Record<string, SourceCompleteness> = {};

  if (enabled.length === 0) {
    deps.logger?.warn("stage0: no enabled sources");
    return { papers: [], sinceDate, status, completeness };
  }

  const settled = await Promise.allSettled(
    enabled.map((e) =>
      e.source.fetch({
        keywords: params.keywords,
        categories: params.categories,
        sinceDate,
        maxResults: params.maxResultsPerKeyword,
      }),
    ),
  );

  const papers: Paper[] = [];
  for (let i = 0; i < enabled.length; i++) {
    const src = (enabled[i] as SourceEntry).source;
    const outcome = settled[i] as PromiseSettledResult<Awaited<ReturnType<Source["fetch"]>>>;
    if (outcome.status === "rejected") {
      const err = outcome.reason;
      // `str(result)` in Python is the exception's message text only, not a
      // "Name: message" repr — mirrored here as `err.message`, not
      // `describeError(err)` (pyish.ts), which would add the name prefix.
      let errorMessage = err instanceof Error ? err.message : String(err);
      let truncated: string[] = [];
      let degraded: DegradedKeyword[] = [];
      if (err instanceof AllKeywordsFailedError) {
        truncated = err.truncatedKeywords;
        degraded = err.degradedKeywords;
        if (degraded.length > 0) {
          const [kw, reason] = degraded[0] as DegradedKeyword;
          errorMessage = `${errorMessage}; first keyword '${kw}': ${reason}`;
        }
      }
      completeness[src.name] = { truncatedKeywords: truncated, degradedKeywords: degraded };
      deps.logger?.warn(`stage0: source '${src.name}' failed: ${errorMessage}`);
      status[src.name] = { ok: false, count: 0, error: errorMessage };
      continue;
    }
    const result = outcome.value;
    deps.logger?.info(`stage0: source '${src.name}' returned ${result.papers.length} papers`);
    status[src.name] = { ok: true, count: result.papers.length, error: null };
    completeness[src.name] = {
      truncatedKeywords: result.truncatedKeywords,
      degradedKeywords: result.degradedKeywords,
    };
    papers.push(...result.papers);
  }

  const deduped = dedupPapers(papers);
  deps.logger?.info(`stage0: ${deduped.length} papers after dedup (from ${papers.length})`);
  return { papers: deduped, sinceDate, status, completeness };
}

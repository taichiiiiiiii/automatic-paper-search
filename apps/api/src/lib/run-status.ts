// R2-47: the public status of the theme-on-demand run behind a request id.
//
// The page used to learn nothing about a failed or cancelled run: the
// status route was dormant, so a request that died stayed "生成中" until
// the page's own timeout, and the Worker's in-flight record kept
// deduplicating a re-submission onto the dead run. This reads the
// workflow's recent runs with the dispatch PAT (Actions read is part of
// `actions:write`), picks the run whose display title ends with the
// request id (`run-match.ts`, which projects an explicit public shape),
// and caches the answer per request id for RUN_STATUS_TTL_MS so a page
// polling every few seconds costs GitHub one call per window, not per poll.

import type { Env } from "../types.js";
import { isRequestId } from "./request-id.js";
import { type PublicRun, pickMatchingRun } from "./run-match.js";

export const RUN_STATUS_TTL_MS = 15_000;
const RUNS_PER_PAGE = 30;
const MAX_CACHE_ENTRIES = 200;

export type RunLookup = { ok: true; run: PublicRun | null } | { ok: false };

export interface RunStatusDeps {
  fetch: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

interface CacheEntry {
  at: number;
  value: RunLookup;
}

// Per-isolate: an optimisation only, a cold isolate just asks GitHub.
const cache = new Map<string, CacheEntry>();

export function clearRunStatusCache(): void {
  cache.clear();
}

export async function lookupRun(
  requestId: unknown,
  env: Env,
  deps: RunStatusDeps,
): Promise<RunLookup> {
  if (!isRequestId(requestId)) return { ok: false };
  const pat = env.GH_DISPATCH_PAT;
  if (typeof pat !== "string" || pat.trim() === "") return { ok: false };
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(requestId);
  if (hit && now - hit.at < RUN_STATUS_TTL_MS) return hit.value;

  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=${RUNS_PER_PAGE}`;
  let value: RunLookup;
  try {
    const resp = await deps.fetch(url, {
      redirect: "manual",
      headers: {
        authorization: `Bearer ${pat}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "paperpilot-theme-status",
      },
    });
    if (!resp.ok) {
      deps.log?.(`run status lookup failed: ${resp.status}`);
      value = { ok: false };
    } else {
      const body = (await resp.json()) as { workflow_runs?: unknown };
      value = { ok: true, run: pickMatchingRun(body.workflow_runs, requestId) };
    }
  } catch (error) {
    deps.log?.(
      `run status lookup threw: ${error instanceof Error ? error.message : String(error)}`,
    );
    value = { ok: false };
  }
  // Failures are cached too (briefly) so an outage is not hammered.
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(requestId, { at: now, value });
  return value;
}

/** A run that ended without publishing: re-submitting may dispatch again. */
export function runEndedBadly(run: PublicRun | null): boolean {
  if (run === null || run.status !== "completed") return false;
  return run.conclusion !== "success" && run.conclusion !== null;
}

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
import { stageFromJobs } from "./run-stage.js";

export const RUN_STATUS_TTL_MS = 15_000;
const RUNS_PER_PAGE = 30;
const MAX_CACHE_ENTRIES = 200;

export type RunLookup = { ok: true; run: PublicRun | null } | { ok: false };

export interface RunStatusDeps {
  fetch: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

// Per-isolate: an optimisation only, a cold isolate just asks GitHub.
// #522: the workflow's run list is cached ONCE for the whole isolate, not per
// request id, so random well-formed ids (which never match a run) cannot each
// cost a GitHub call with the dispatch PAT: at most one list call per
// RUN_STATUS_TTL_MS per isolate. The jobs call (stage) is made only for a
// matched, still-running run, cached per run id.
let runsCache: CacheEntry<{ ok: true; runs: unknown } | { ok: false }> | null = null;
const stageCache = new Map<number, CacheEntry<string | null>>();

export function clearRunStatusCache(): void {
  runsCache = null;
  stageCache.clear();
}

async function recentRuns(
  env: Env,
  pat: string,
  deps: RunStatusDeps,
  now: number,
): Promise<{ ok: true; runs: unknown } | { ok: false }> {
  if (runsCache && now - runsCache.at < RUN_STATUS_TTL_MS) return runsCache.value;
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=${RUNS_PER_PAGE}`;
  let value: { ok: true; runs: unknown } | { ok: false };
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
      value = { ok: true, runs: body.workflow_runs };
    }
  } catch (error) {
    deps.log?.(
      `run status lookup threw: ${error instanceof Error ? error.message : String(error)}`,
    );
    value = { ok: false };
  }
  // Failures are cached too (briefly) so an outage is not hammered.
  runsCache = { at: now, value };
  return value;
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
  const listed = await recentRuns(env, pat, deps, now);
  if (!listed.ok) return { ok: false };
  const run = pickMatchingRun(listed.runs, requestId);
  if (run !== null && run.status !== "completed" && run.id !== null) {
    const hit = stageCache.get(run.id);
    if (hit && now - hit.at < RUN_STATUS_TTL_MS) {
      run.stage = hit.value;
    } else {
      run.stage = await lookupStage(run.id, env, pat, deps);
      if (stageCache.size >= MAX_CACHE_ENTRIES) stageCache.clear();
      stageCache.set(run.id, { at: now, value: run.stage });
    }
  }
  return { ok: true, run };
}

/** #457: the coarse stage of a running run, read from its jobs. Best effort:
 * null when GitHub cannot be asked (the page then shows a plain "checking"). */
async function lookupStage(
  runId: number,
  env: Env,
  pat: string,
  deps: RunStatusDeps,
): Promise<string | null> {
  try {
    const resp = await deps.fetch(
      `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/runs/${runId}/jobs?per_page=30`,
      {
        redirect: "manual",
        headers: {
          authorization: `Bearer ${pat}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "paperpilot-theme-status",
        },
      },
    );
    if (!resp.ok) return null;
    const body = (await resp.json()) as { jobs?: unknown };
    return stageFromJobs(body.jobs);
  } catch {
    return null;
  }
}

/** A run that ended without publishing: re-submitting may dispatch again. */
export function runEndedBadly(run: PublicRun | null): boolean {
  if (run === null || run.status !== "completed") return false;
  return run.conclusion !== "success" && run.conclusion !== null;
}

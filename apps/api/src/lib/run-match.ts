// TS port of worker/run-match.js. Pure logic for picking the most recent
// workflow run that matches a server-generated request ID. Not wired to a
// route in this phase (no GitHub-runs-proxying route exists — status stays
// dormant per API-19 / §4.5), but ported per the task's module list so the
// behaviour and its tests travel together ready for when a real progress
// API needs it.

import { isRequestId } from "./request-id.js";

export interface RunFromApi {
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  run_started_at: string | null;
  display_title: string;
  [key: string]: unknown;
}

export interface PublicRun {
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  run_started_at: string | null;
  display_title: string;
}

/**
 * Find the most recent workflow run whose display_title ends with
 * " / <request_id>". Returns null when no match.
 */
export function pickMatchingRun(runs: unknown, requestId: unknown): PublicRun | null {
  if (!Array.isArray(runs) || !isRequestId(requestId)) return null;
  const requestMarker = ` / ${requestId}`;
  for (const r of runs as Array<Partial<RunFromApi> | null | undefined>) {
    if (r && typeof r.display_title === "string" && r.display_title.endsWith(requestMarker)) {
      // Project an explicit public shape — do not return the raw object,
      // which can carry head SHA / actor / repo / check-suite metadata.
      return {
        status: typeof r.status === "string" ? r.status : "",
        conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
        html_url: typeof r.html_url === "string" ? r.html_url : "",
        created_at: typeof r.created_at === "string" ? r.created_at : "",
        run_started_at: typeof r.run_started_at === "string" ? r.run_started_at : null,
        display_title: r.display_title,
      };
    }
  }
  return null;
}

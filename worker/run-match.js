// Pure logic for picking the most recent workflow run that matches a
// server-generated request ID. Extracted from `findRecentRun` in `index.ts` so
// the matching rules can be exercised in a Node test runner without
// also having to stub fetch / GitHub API state.
//
// The rule (kept narrow on purpose — operators can change it knowing
// what they're touching):
//   1. GitHub returns `workflow_runs` sorted by `created_at` desc.
//   2. We walk that list and pick the first item whose `display_title`
//      ends with " / <request_id>" — the literal marker the workflow's
//      `run-name:` line writes on every dispatch.
//   3. No theme/title fallback: two identical-theme requests remain distinct.

import { isRequestId } from "./request-id.js";

/**
 * @typedef {object} RunFromApi
 * @property {string} status            // "queued" | "in_progress" | "completed"
 * @property {string|null} conclusion   // "success" | "failure" | ...
 * @property {string} html_url
 * @property {string} created_at
 * @property {string|null} run_started_at
 * @property {string} display_title
 */

/**
 * Find the most recent workflow run whose display_title ends with
 * " / <request_id>". Returns null when no match — the caller surfaces this
 * to the frontend as "no run yet, keep polling".
 *
 * @param {RunFromApi[]} runs   - workflow_runs array from GitHub API
 * @param {string} requestId    - server-generated correlation ID
 * @returns {RunFromApi|null}
 */
export function pickMatchingRun(runs, requestId) {
  if (!Array.isArray(runs) || !isRequestId(requestId)) return null;
  const requestMarker = ` / ${requestId}`;
  for (const r of runs) {
    if (r && typeof r.display_title === "string" && r.display_title.endsWith(requestMarker)) {
      // Project an explicit public shape. TypeScript casts do not remove the
      // many additional fields returned by GitHub (head SHA, actor, repo,
      // check-suite metadata), so returning the raw object would leak them.
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

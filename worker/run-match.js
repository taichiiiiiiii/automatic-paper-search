// Pure logic for picking the most recent workflow run that matches a
// user-supplied theme. Extracted from `findRecentRun` in `index.ts` so
// the matching rules can be exercised in a Node test runner without
// also having to stub fetch / GitHub API state.
//
// The rule (kept narrow on purpose — operators can change it knowing
// what they're touching):
//   1. GitHub returns `workflow_runs` sorted by `created_at` desc.
//   2. We walk that list and pick the first item whose `display_title`
//      ends with ": <theme>" — the literal marker the workflow's
//      `run-name:` line writes on every dispatch.
//   3. No fallback to substring-anywhere matching: a theme called
//      "Optim" must not match a "Hyperparam Optim" run.

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
 * ": <theme>". Returns null when no match — the caller surfaces this
 * to the frontend as "no run yet, keep polling".
 *
 * @param {RunFromApi[]} runs   - workflow_runs array from GitHub API
 * @param {string} theme        - verbatim user-typed theme
 * @returns {RunFromApi|null}
 */
export function pickMatchingRun(runs, theme) {
  if (!Array.isArray(runs) || typeof theme !== "string") return null;
  const trimmed = theme.trim();
  if (!trimmed) return null;
  const themeMarker = `: ${trimmed}`;
  for (const r of runs) {
    if (r && typeof r.display_title === "string" && r.display_title.endsWith(themeMarker)) {
      return r;
    }
  }
  return null;
}

/**
 * P5 tier-A review round 2, N1/N2: a literal ` -- --` in a `run:` step
 * is always a bug in this workflow set. pnpm forwards a bare `--`
 * separator to the underlying command, but vitest (N1,
 * `pages-release.yml`'s "Full test suite with no skips" step) and the
 * shell itself (N2, `legacy-redirects.yml`'s "Generate the redirect
 * site" step, via `pnpm --filter X run <script> -- <args>`) both treat
 * everything AFTER that separator in ways that silently swallowed the
 * flags meant to follow it:
 *
 * - vitest 3 ignores a second `--` entirely (confirmed by probe:
 *   `pnpm -r --if-present test -- --reporter=json --outputFile=x.json`
 *   wrote no report at all), so `no-skip-gate` died on empty argv.
 * - `pnpm run <script> -- --source <path>` runs with cwd set to the
 *   filtered package's directory, so a path meant to be relative to the
 *   repo root (or resolved by the script's own default) silently
 *   resolved against the wrong directory instead.
 *
 * Neither failure mode is specific to one workflow, so this is a
 * standing invariant over every staged workflow, not a one-off pin on
 * the two files that happened to regress this way.
 */
import { describe, expect, it } from "vitest";
import { allRunStrings, EXPECTED_WORKFLOW_FILES, readAllWorkflows } from "./helpers.js";

describe("no staged workflow's run: step passes ` -- --` to pnpm", () => {
  const docs = readAllWorkflows();

  for (const file of EXPECTED_WORKFLOW_FILES) {
    it(`${file}: no run: string contains a literal " -- --"`, () => {
      const doc = docs.get(file);
      for (const run of allRunStrings(doc)) {
        expect(run, `${file} has a run: step forwarding through " -- --":\n${run}`).not.toMatch(
          /\s--\s--/,
        );
      }
    });
  }
});

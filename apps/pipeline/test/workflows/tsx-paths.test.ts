/**
 * Contract: every `tsx <path>` a staged workflow's `run:` step invokes
 * must exist in the repo (docs/migration/p5-plan.md §2 A7's "contract
 * test that every tsx <path> ... exists").
 *
 * Several of these paths were owned by OTHER concurrent P5 agents (A2:
 * missing CLIs; A4: release/cli.ts subcommands — though those are
 * subcommands of a file that already exists, so a file-existence check
 * cannot see them missing; A9: dataMove, not referenced by any staged
 * workflow). At various points while writing this changeset,
 * `slugCli.ts`, `conference/arxiv/cli.ts` and
 * `conference/scaffold/cli.ts` were each missing, listed here as
 * PENDING, and then removed from this list the moment A2 landed each
 * one and this test started failing on the stale-entry check — proving
 * this test self-cleans rather than silently staying green forever
 * (see the task's final report for the play-by-play).
 *
 * `apps/pipeline/src/release/derived/identityLiteCli.ts` is ALSO
 * missing today, but no staged workflow invokes it directly via
 * `tsx <path>` — the plan's §3 refresh table runs it from inside
 * promoteHooks.ts/promote.ts, behind `release/cli.ts promote`, never
 * from a workflow YAML `run:` string — so it is out of scope for THIS
 * contract test and intentionally not listed here.
 *
 * As of finishing this changeset, EVERY tsx <path> referenced by a
 * staged workflow exists, so this set is empty. Per this task's brief:
 * this assertion is a REAL test (not `it.todo`) that lists the missing
 * files in its failure message if any ever go missing again — kept as
 * an empty, explicit allowlist (rather than deleting the mechanism)
 * so a future regression is caught the same way.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot } from "@paperpilot/core";
import { describe, expect, it } from "vitest";
import { allRunStrings, EXPECTED_WORKFLOW_FILES, readAllWorkflows, tsxPathsIn } from "./helpers.js";

/**
 * PENDING (verify at next run): paths referenced by a staged workflow
 * that do not exist in the repo as of this changeset, because another
 * concurrent P5 agent owns creating them (p5-plan.md §2 A2 — missing
 * CLIs).
 *
 * `apps/pipeline/src/conference/scaffold/cli.ts` was in this list when
 * this file was first written; the A2 changeset has since landed it
 * (plus `writeConferenceCopy.ts`), so it is removed here — exactly the
 * self-cleaning this file's own module doc describes.
 *
 * `apps/pipeline/src/release/derived/identityLiteCli.ts` is ALSO
 * missing today, but no staged workflow invokes it directly via
 * `tsx <path>` — the plan's §3 refresh table runs it from inside
 * promoteHooks.ts/promote.ts, behind `release/cli.ts promote`, never
 * from a workflow YAML `run:` string — so it is out of scope for THIS
 * contract test and intentionally not listed here.
 *
 * Every other tsx <path> referenced by a staged workflow already
 * exists.
 */
const PENDING_MISSING_TSX_PATHS: ReadonlySet<string> = new Set([]);

function allTsxPathsReferenced(): Set<string> {
  const docs = readAllWorkflows();
  const paths = new Set<string>();
  for (const file of EXPECTED_WORKFLOW_FILES) {
    for (const run of allRunStrings(docs.get(file))) {
      for (const p of tsxPathsIn(run)) paths.add(p);
    }
  }
  return paths;
}

describe("every tsx <path> referenced by a staged workflow exists (or is an explicit, commented PENDING entry)", () => {
  const repoRoot = getRepoRoot();
  const referenced = [...allTsxPathsReferenced()].sort();

  it("found a non-trivial number of tsx invocations (sanity: the extractor isn't silently matching nothing)", () => {
    expect(referenced.length).toBeGreaterThan(10);
  });

  it("no referenced path is missing without being in the PENDING list", () => {
    const missing = referenced.filter((p) => !existsSync(join(repoRoot, p)));
    const unexplained = missing.filter((p) => !PENDING_MISSING_TSX_PATHS.has(p));
    expect(
      unexplained,
      `missing tsx path(s) not covered by PENDING_MISSING_TSX_PATHS: ${JSON.stringify(unexplained)}`,
    ).toEqual([]);
  });

  it("PENDING_MISSING_TSX_PATHS has no stale entries (every listed path is both still referenced AND still actually missing)", () => {
    for (const pending of PENDING_MISSING_TSX_PATHS) {
      expect(
        referenced,
        `PENDING lists ${pending}, which no staged workflow references any more — remove it`,
      ).toContain(pending);
      expect(
        existsSync(join(repoRoot, pending)),
        `PENDING lists ${pending}, which now exists — remove it from PENDING_MISSING_TSX_PATHS`,
      ).toBe(false);
    }
  });
});

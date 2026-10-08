import { getRepoRoot } from "@paperpilot/core";
import { layoutFor } from "@paperpilot/core/layout";
import { describe, expect, it } from "vitest";
import { compareTrees } from "../../src/parity/compare-trees.js";

// (a)-class invariant (p5-plan.md §2 A1, risk R9): this test's claim --
// "comparing the published tree to itself is equal" -- holds regardless of
// what the published data actually contains, so it stays pointed at the
// REAL repo tree via layoutFor(getRepoRoot()) rather than a frozen fixture.
// Under LAYOUT_MODE "legacy" this still resolves to <repoRoot>/docs, so the
// behaviour is byte-identical to the previous hardcoded path; once commit B
// flips LAYOUT_MODE to "p5" it follows the move to data/published with no
// code change here.
const docsRoot = layoutFor(getRepoRoot()).published;

/**
 * Self-check (docs/design/39 §7.2): the parity tool must agree with itself on the real
 * repo tree it will eventually be pointed at. docs/ vs docs/ must compare equal, and we
 * record the wall-clock runtime on the real tree (several hundred JSON/CSV/HTML/MD files,
 * tens of MB) so a future regression that makes the tool slow is visible in test output.
 */
describe("self-check: docs/ vs docs/", () => {
  it("compares equal to itself and completes in a reasonable time", async () => {
    const start = Date.now();
    const report = await compareTrees({ expectedRoot: docsRoot, actualRoot: docsRoot });
    const wallClockMs = Date.now() - start;

    expect(report.equal).toBe(true);
    expect(report.missingFiles).toEqual([]);
    expect(report.extraFiles).toEqual([]);
    expect(report.summary.filesDiffering).toBe(0);
    expect(report.summary.filesCompared).toBeGreaterThan(0);

    console.log(
      `[parity self-check] docs/ vs docs/: ${report.summary.filesCompared} files, ` +
        `reported durationMs=${report.durationMs}, wall-clock=${wallClockMs}ms`,
    );
  }, 30_000);
});

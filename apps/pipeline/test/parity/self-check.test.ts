import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareTrees } from "../../src/parity/compare-trees.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/pipeline/test/parity -> apps/pipeline/test -> apps/pipeline -> apps -> <repo root>
const repoRoot = path.resolve(here, "../../../..");
const docsRoot = path.join(repoRoot, "docs");

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

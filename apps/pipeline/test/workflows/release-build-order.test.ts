/**
 * H2 (pages-release.yml's validate job) and the tests.yml half of M5
 * of the P5 tier-A review (pass 1): a web build must run BEFORE the
 * package tests in both places. `apps/web/test/**` has many
 * `it.skipIf(!existsSync(OUT_DIR/PUBLIC_DIR/BUILT_*))` tests (CSP,
 * head-metadata, sitemap, redirects, paper-links build safety,
 * copy-data, ...); on a clean runner with no prior build those report
 * "skipped" rather than actually running, and in pages-release.yml that
 * then makes `no-skip-gate` fail every single release.
 */
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

function stepOrder(
  steps: YamlDoc[],
  buildName: string,
  testName: string,
): { buildIdx: number; testIdx: number } {
  const buildIdx = steps.findIndex((s) => s.name === buildName);
  const testIdx = steps.findIndex((s) => s.name === testName);
  return { buildIdx, testIdx };
}

describe("H2: pages-release.yml's validate job builds apps/web before running the test suite", () => {
  it("'Build web' precedes 'Full test suite with no skips'", () => {
    const doc = readWorkflow("pages-release.yml");
    const [, job] = jobsOf(doc).find(([id]) => id === "validate") as [string, YamlDoc];
    const { buildIdx, testIdx } = stepOrder(
      job.steps,
      "Build web",
      "Full test suite with no skips",
    );
    expect(buildIdx, "'Build web' step not found").toBeGreaterThanOrEqual(0);
    expect(testIdx, "'Full test suite with no skips' step not found").toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeLessThan(testIdx);
  });
});

describe("M5: tests.yml builds apps/web before running the test suite", () => {
  it("'Build web' precedes 'Test'", () => {
    const doc = readWorkflow("tests.yml");
    const [, job] = jobsOf(doc).find(([id]) => id === "test") as [string, YamlDoc];
    const { buildIdx, testIdx } = stepOrder(job.steps, "Build web", "Test");
    expect(buildIdx, "'Build web' step not found").toBeGreaterThanOrEqual(0);
    expect(testIdx, "'Test' step not found").toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeLessThan(testIdx);
  });
});

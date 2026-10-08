/**
 * P5 tier-A review round 3, L1: `pages-release.yml`'s "No skipped tests"
 * step used to pass whatever `find apps packages -name
 * .vitest-release-report.json` returned. A package whose `test` script
 * wrote no report (a non-vitest `test`, or a dropped reporter flag) then
 * silently dropped out of the gate, and a step that passed only one report
 * (`"${reports[0]}"`) checked one package and passed.
 *
 * The release gate now names one report per workspace package with a test
 * script. This pins:
 *  - the test command is exactly the one `dataMove rehearse` runs (one
 *    source of truth: `rehearseSteps`), so every package writes
 *    `VITEST_REPORT_NAME` into its own directory;
 *  - the gate's argv is exactly `findTestPackageDirs(repo root)` (the list
 *    rehearse derives) mapped to that report, in order, with no shell
 *    expansion, so a new package fails here until it is added to the
 *    workflow, and a missing report fails the gate itself.
 */
import { getRepoRoot } from "@paperpilot/core";
import { describe, expect, it } from "vitest";
import {
  findTestPackageDirs,
  rehearseSteps,
  VITEST_REPORT_NAME,
} from "../../src/release/dataMove/rehearse.js";
import { readWorkflow, type YamlDoc } from "./helpers.js";

function validateSteps(): YamlDoc[] {
  const doc = readWorkflow("pages-release.yml");
  return doc.jobs.validate.steps as YamlDoc[];
}

function stepRun(name: string): string {
  const step = validateSteps().find((s) => s.name === name);
  if (step === undefined || typeof step.run !== "string") {
    throw new Error(`pages-release.yml validate step "${name}" with a run: not found`);
  }
  return step.run;
}

/** The run: text as logical shell lines (backslash continuations joined), without `set -euo pipefail`. */
function commandLines(run: string): string[] {
  return run
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0 && line !== "set -euo pipefail");
}

describe("pages-release.yml no-skip gate gets one explicit report per test package (L1)", () => {
  const packageDirs = findTestPackageDirs(getRepoRoot());

  it("sanity: findTestPackageDirs sees the workspace's test packages", () => {
    expect(packageDirs).toContain("apps/pipeline");
    expect(packageDirs.length).toBeGreaterThanOrEqual(4);
  });

  it("the test step runs exactly the command rehearse runs", () => {
    const rehearseTest = rehearseSteps("/clone", packageDirs).find(
      (argv) => argv.slice(0, 4).join(" ") === "pnpm -r --if-present test",
    );
    expect(rehearseTest).toBeDefined();
    expect(commandLines(stepRun("Full test suite with no skips"))).toEqual([
      (rehearseTest as readonly string[]).join(" "),
    ]);
    expect(rehearseTest).toContain(`--outputFile.json=${VITEST_REPORT_NAME}`);
  });

  it("the gate step passes exactly findTestPackageDirs' reports, literally, in order", () => {
    const lines = commandLines(stepRun("No skipped tests"));
    expect(lines).toHaveLength(1);
    const prefix = "pnpm exec tsx apps/pipeline/src/release/cli.ts no-skip-gate ";
    expect(lines[0]?.startsWith(prefix)).toBe(true);
    const args = (lines[0] as string).slice(prefix.length).split(" ");
    expect(args).toEqual(packageDirs.map((dir) => `${dir}/${VITEST_REPORT_NAME}`));
  });

  it("the gate step runs after the test step, in the same job", () => {
    const names = validateSteps().map((s) => s.name);
    const testIdx = names.indexOf("Full test suite with no skips");
    const gateIdx = names.indexOf("No skipped tests");
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(gateIdx).toBe(testIdx + 1);
  });

  it("the gate list matches rehearse's own gate argv (one source of truth)", () => {
    const rehearseGate = rehearseSteps("/clone", packageDirs).find((argv) =>
      argv.includes("no-skip-gate"),
    ) as readonly string[];
    const lines = commandLines(stepRun("No skipped tests"));
    expect(lines[0]?.split(/\s+/)).toEqual([...rehearseGate]);
  });
});

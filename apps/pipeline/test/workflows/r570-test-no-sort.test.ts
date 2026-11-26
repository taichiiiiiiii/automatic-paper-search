/**
 * #570 candidate B: every full-suite test command runs `pnpm -r --no-sort`,
 * so pnpm does not wait for packages/core's tests (30-39 s alone on CI)
 * before starting api/pipeline/web. Safe because no package's tests read
 * a build output or a file written by another package's tests: core's
 * exports all point at `./src/*.ts`, nothing references `core/dist`, no
 * package has a `pretest`, and core's tests write no files.
 *
 * Pins the four places together (promote validate, release validate,
 * the rehearsal that mirrors release validate, and tests.yml) so they
 * cannot drift; the vitest arguments after `test` are pinned elsewhere
 * (promoteHooks.test.ts, release-no-skip-gate-reports.test.ts,
 * rehearse.test.ts).
 */
import { describe, expect, it } from "vitest";
import { rehearseSteps } from "../../src/release/dataMove/rehearse.js";
import { validateCommandsFor } from "../../src/release/promoteHooks.js";
import { readWorkflow, type YamlDoc } from "./helpers.js";

function runOf(file: string, job: string, stepName: string): string {
  const steps = readWorkflow(file).jobs[job].steps as YamlDoc[];
  const step = steps.find((s) => s.name === stepName);
  if (step === undefined || typeof step.run !== "string") {
    throw new Error(`${file} ${job} step "${stepName}" with a run: not found`);
  }
  return step.run;
}

/** Every `pnpm -r ... test` invocation in a run: text. */
function recursiveTestLines(run: string): string[] {
  return run
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^pnpm -r\b.*\btest\b/.test(line));
}

describe("full test suites run without topological ordering (#570 B)", () => {
  it("promote validate runs `pnpm -r --no-sort test`", () => {
    for (const kind of ["themes", "conference"] as const) {
      const tests = validateCommandsFor(kind, "/tree").filter(
        (cmd) => cmd[0] === "pnpm" && cmd[1] === "-r",
      );
      expect(tests).toEqual([["pnpm", "-r", "--no-sort", "test"]]);
    }
  });

  it("the release rehearsal runs `pnpm -r --no-sort --if-present test`", () => {
    const tests = rehearseSteps("/x", ["apps/pipeline"]).filter(
      (s) => s[0] === "pnpm" && s[1] === "-r",
    );
    expect(tests).toHaveLength(1);
    expect(tests[0]?.slice(0, 5)).toEqual(["pnpm", "-r", "--no-sort", "--if-present", "test"]);
  });

  it("pages-release.yml validate runs `pnpm -r --no-sort --if-present test`", () => {
    const lines = recursiveTestLines(
      runOf("pages-release.yml", "validate", "Full test suite with no skips"),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^pnpm -r --no-sort --if-present test /);
  });

  it("tests.yml Test runs `pnpm -r --no-sort --if-present test`", () => {
    const lines = recursiveTestLines(runOf("tests.yml", "test", "Test"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^pnpm -r --no-sort --if-present test 2>&1 \| tee /);
  });
});

/**
 * Inventory checks for the P5 staged workflows (docs/migration/p5-plan.md
 * §2 A7): the exact 12 files exist under the staged directory (nothing
 * missing, nothing extra), the composite action exists, and `tests.yml`
 * keeps the file name + job id (`test`) branch-protection may require
 * (R17), plus its push branches.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compositeActionPath,
  EXPECTED_WORKFLOW_FILES,
  jobsOf,
  listWorkflowFiles,
  readCompositeAction,
  readWorkflow,
} from "./helpers.js";

describe("staged workflow inventory", () => {
  it("contains exactly the 12 files the plan names, nothing more or less", () => {
    expect(listWorkflowFiles()).toEqual(EXPECTED_WORKFLOW_FILES);
  });
});

describe("composite action", () => {
  it("setup-pnpm/action.yml exists", () => {
    expect(existsSync(compositeActionPath())).toBe(true);
  });

  it("is a composite action using Node 22 setup-node, corepack enable, then a frozen-lockfile install", () => {
    const action = readCompositeAction();
    expect(action.runs.using).toBe("composite");
    const steps: Array<Record<string, unknown>> = action.runs.steps;
    const usesNodeSetup = steps.some(
      (s) => typeof s.uses === "string" && s.uses.startsWith("actions/setup-node@"),
    );
    expect(usesNodeSetup).toBe(true);
    const runSteps = steps.filter((s): s is { run: string } => typeof s.run === "string");
    expect(runSteps.some((s) => s.run.includes("corepack enable"))).toBe(true);
    expect(runSteps.some((s) => s.run.includes("pnpm install --frozen-lockfile"))).toBe(true);
  });
});

describe("tests.yml (R17: required-check name stability)", () => {
  const doc = readWorkflow("tests.yml");

  it('keeps the job id "test"', () => {
    const jobIds = jobsOf(doc).map(([id]) => id);
    expect(jobIds).toContain("test");
  });

  it("triggers on push to develop and main", () => {
    expect(doc.on.push.branches).toEqual(["develop", "main"]);
  });

  it("also triggers on pull_request and workflow_dispatch", () => {
    expect(Object.keys(doc.on)).toEqual(
      expect.arrayContaining(["pull_request", "push", "workflow_dispatch"]),
    );
  });
});

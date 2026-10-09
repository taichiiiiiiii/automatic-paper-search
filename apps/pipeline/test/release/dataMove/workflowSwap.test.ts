import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyWorkflowSwap,
  DELETED_WORKFLOW_NAMES,
  listStagedWorkflowFiles,
  reverseWorkflowSwap,
  WorkflowSwapError,
} from "../../../src/release/dataMove/workflowSwap.js";
import { adapter, gitRun } from "./fixtures.js";

// This file runs real subprocesses (tsx/node/git). Each spawn is
// sub-second alone but can take seconds under `pnpm -r test`'s parallel
// load (or a loaded CI runner), so vitest's 5 s test / 10 s hook defaults
// flake. Raised for this file only; explicit per-test timeouts still win.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let base: string | undefined;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = undefined;
});

function write(repo: string, rel: string, content: string): void {
  const full = join(repo, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function initRepoWithWorkflows(includeStaged: boolean): string {
  base = mkdtempSync(join(tmpdir(), "paperpilot-workflow-swap-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  gitRun(repo, ["init", "--initial-branch=develop"]);
  write(repo, ".github/workflows/tests.yml", "name: tests (python)\n");
  for (const name of DELETED_WORKFLOW_NAMES) {
    write(repo, `.github/workflows/${name}`, `name: ${name}\n`);
  }
  if (includeStaged) {
    write(repo, ".github/workflows-p5/tests.yml", "name: tests (node)\n");
    write(repo, ".github/workflows-p5/legacy-redirects.yml", "name: legacy-redirects\n");
  }
  gitRun(repo, ["add", "."]);
  gitRun(repo, ["commit", "-m", "seed"]);
  return repo;
}

describe("listStagedWorkflowFiles", () => {
  it("is empty when .github/workflows-p5 does not exist", () => {
    const repo = initRepoWithWorkflows(false);
    expect(listStagedWorkflowFiles(repo)).toEqual([]);
  });

  it("lists every file when .github/workflows-p5 exists", () => {
    const repo = initRepoWithWorkflows(true);
    expect(listStagedWorkflowFiles(repo)).toEqual(["legacy-redirects.yml", "tests.yml"]);
  });
});

describe("applyWorkflowSwap", () => {
  it("skips gracefully (and does not delete anything) when workflows-p5 is missing", () => {
    const repo = initRepoWithWorkflows(false);
    const result = applyWorkflowSwap(adapter, repo);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/missing or empty/);
    for (const name of DELETED_WORKFLOW_NAMES) {
      expect(existsSync(join(repo, ".github/workflows", name))).toBe(true);
    }
  });

  it("moves every staged file onto workflows/ (overwriting) and deletes the three named files", () => {
    const repo = initRepoWithWorkflows(true);
    const result = applyWorkflowSwap(adapter, repo);
    expect(result.skipped).toBe(false);
    expect(result.movedNames).toEqual(["legacy-redirects.yml", "tests.yml"]);
    expect([...result.deletedNames].sort()).toEqual([...DELETED_WORKFLOW_NAMES].sort());

    expect(existsSync(join(repo, ".github/workflows-p5"))).toBe(false);
    expect(readFileSync(join(repo, ".github/workflows/tests.yml"), "utf-8")).toBe(
      "name: tests (node)\n",
    );
    expect(existsSync(join(repo, ".github/workflows/legacy-redirects.yml"))).toBe(true);
    for (const name of DELETED_WORKFLOW_NAMES) {
      expect(existsSync(join(repo, ".github/workflows", name))).toBe(false);
    }
  });

  it("RED: throws if a named deletion target is missing (would otherwise silently skip a delete)", () => {
    const repo = initRepoWithWorkflows(true);
    gitRun(repo, ["rm", ".github/workflows/ts-ci.yml"]);
    gitRun(repo, ["commit", "-m", "remove ts-ci.yml early"]);
    expect(() => applyWorkflowSwap(adapter, repo)).toThrow(WorkflowSwapError);
  });
});

describe("reverseWorkflowSwap", () => {
  it("round-trips: apply then reverse restores the original tree", () => {
    const repo = initRepoWithWorkflows(true);
    const beforeSha = gitRun(repo, ["rev-parse", "HEAD"]);
    applyWorkflowSwap(adapter, repo);
    gitRun(repo, ["commit", "-m", "swap"]);

    const result = reverseWorkflowSwap(adapter, repo, beforeSha);
    expect(result.skipped).toBe(false);
    expect(result.movedNames).toEqual(["legacy-redirects.yml", "tests.yml"]);
    gitRun(repo, ["commit", "-m", "unswap"]);
    const afterSha = gitRun(repo, ["rev-parse", "HEAD"]);

    expect(gitRun(repo, ["rev-parse", `${afterSha}^{tree}`])).toBe(
      gitRun(repo, ["rev-parse", `${beforeSha}^{tree}`]),
    );
  });

  it("skips gracefully when beforeRef had no staged workflows", () => {
    const repo = initRepoWithWorkflows(false);
    const beforeSha = gitRun(repo, ["rev-parse", "HEAD"]);
    const result = reverseWorkflowSwap(adapter, repo, beforeSha);
    expect(result.skipped).toBe(true);
  });
});

/**
 * `apply`-specific unit tests not already covered by the full round trip
 * in `roundTrip.test.ts`:
 *
 *  - L8: a missing/empty `.github/workflows-p5` makes forward `apply`
 *    *refuse* the whole operation (not silently skip the workflow swap
 *    while still moving data) unless `allowMissingWorkflows` is passed,
 *    and a refusal must leave the tree untouched.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplyError, apply } from "../../../src/release/dataMove/apply.js";
import {
  adapter,
  buildFixtureRepo,
  cleanupFixtureRepo,
  type FixtureRepo,
  gitRun,
} from "./fixtures.js";

// This file runs real subprocesses (tsx/node/git). Each spawn is
// sub-second alone but can take seconds under `pnpm -r test`'s parallel
// load (or a loaded CI runner), so vitest's 5 s test / 10 s hook defaults
// flake. Raised for this file only; explicit per-test timeouts still win.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let fixture: FixtureRepo | undefined;

afterEach(() => {
  if (fixture) cleanupFixtureRepo(fixture);
  fixture = undefined;
});

/** Removes the fixture repo's staged `.github/workflows-p5` tree entirely (tracked files + directory). */
function removeStagedWorkflows(repo: string): void {
  gitRun(repo, ["rm", "-r", "--", ".github/workflows-p5"]);
  gitRun(repo, ["commit", "-m", "simulate: .github/workflows-p5 not landed yet"]);
}

describe("apply: L8 missing-workflows-p5 gate", () => {
  it("RED/GREEN: refuses (throws ApplyError) when .github/workflows-p5 is missing, and leaves the tree untouched", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    removeStagedWorkflows(repo);
    const beforeSha = gitRun(repo, ["rev-parse", "HEAD"]);

    expect(() =>
      apply({ git: adapter, cwd: repo, confirmDelete: "docs/daily/papers.json" }),
    ).toThrow(ApplyError);
    expect(() =>
      apply({ git: adapter, cwd: repo, confirmDelete: "docs/daily/papers.json" }),
    ).toThrow(/workflows-p5 is missing or empty/);

    // Refusal must leave the tree untouched: no staged changes, HEAD unmoved.
    expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
    expect(gitRun(repo, ["rev-parse", "HEAD"])).toBe(beforeSha);
  }, 20_000);

  it("also refuses when .github/workflows-p5 exists but is empty (no tracked files under it)", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    removeStagedWorkflows(repo);
    // Recreate the directory on disk (untracked, empty) — not a git concept,
    // but `listStagedWorkflowFiles` reads the filesystem directly.
    mkdirSync(join(repo, ".github/workflows-p5"), { recursive: true });

    expect(() =>
      apply({ git: adapter, cwd: repo, confirmDelete: "docs/daily/papers.json" }),
    ).toThrow(ApplyError);
  }, 20_000);

  it("proceeds (and actually skips the swap) when allowMissingWorkflows is passed", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    removeStagedWorkflows(repo);

    const result = apply({
      git: adapter,
      cwd: repo,
      confirmDelete: "docs/daily/papers.json",
      allowMissingWorkflows: true,
    });
    expect(result.workflowSwap.skipped).toBe(true);
    // The three workflows named for deletion must still be present (the
    // swap's own atomicity: it skips the deletes along with the moves).
    for (const name of ["ts-ci.yml", "publish.yml", "paper-slides-on-demand.yml"]) {
      expect(existsSync(join(repo, ".github/workflows", name))).toBe(true);
    }
  }, 20_000);
});

/**
 * `applyReverse`-specific regression tests (p5-review1.md M3, probes P4
 * and P5): `apply --reverse` must refuse — atomically, before touching
 * anything — the instant `HEAD` is not *exactly* `beforeRef`'s
 * forward-`apply` result, instead of silently half-reversing (P4) or
 * crashing partway through after already mutating the tree (P5).
 *
 * The happy-path round trip itself (`apply` -> commit -> `applyReverse`
 * -> commit gives a byte-identical tree) is `roundTrip.test.ts`; this
 * file only covers the refusal paths that previously had no test
 * coverage at all (the review's "SURVIVED" mutants).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplyError, apply, applyReverse } from "../../../src/release/dataMove/apply.js";
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

/** `apply` the move and commit it, returning `{legacySha, p5Sha}`. */
function applyAndCommitCutover(repo: string): { legacySha: string; p5Sha: string } {
  const legacySha = gitRun(repo, ["rev-parse", "HEAD"]);
  apply({ git: adapter, cwd: repo, confirmDelete: "docs/daily/papers.json" });
  gitRun(repo, ["commit", "-m", "data(p5): cutover"]);
  const p5Sha = gitRun(repo, ["rev-parse", "HEAD"]);
  return { legacySha, p5Sha };
}

describe("applyReverse: P4 (post-B data commit before reverse)", () => {
  it("RED/GREEN: refuses instead of silently half-reversing when a post-B commit added a new data/** file", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const { legacySha } = applyAndCommitCutover(repo);

    // A post-B data commit: a brand-new theme's lineage.json, exactly the
    // kind of file `applyReverse`'s beforeRef-keyed entry loop never
    // visits (it didn't exist at B, so it's not in beforeRef's plan).
    const newThemeDir = join(repo, "data/published/themes/mixture-of-depths");
    mkdirSync(newThemeDir, { recursive: true });
    writeFileSync(join(newThemeDir, "lineage.json"), '{"nodes":[]}\n');
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-m", "theme-on-demand: mixture-of-depths"]);
    const driftedSha = gitRun(repo, ["rev-parse", "HEAD"]);
    const driftedTree = gitRun(repo, ["rev-parse", `${driftedSha}^{tree}`]);

    expect(() => applyReverse({ git: adapter, cwd: repo }, legacySha)).toThrow(ApplyError);
    expect(() => applyReverse({ git: adapter, cwd: repo }, legacySha)).toThrow(
      /not exactly .* forward-apply result/,
    );

    // Atomicity: the refusal must not have staged or moved anything.
    expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
    expect(gitRun(repo, ["rev-parse", "HEAD"])).toBe(driftedSha);
    expect(gitRun(repo, ["rev-parse", "HEAD^{tree}"])).toBe(driftedTree);
  }, 20_000);
});

describe("applyReverse: P5 (git revert of the cutover commit before reverse)", () => {
  it("RED/GREEN: refuses cleanly instead of throwing mid-mutation when the layout was already reverted", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const { legacySha, p5Sha } = applyAndCommitCutover(repo);

    // The bad runbook order the review's probe P5 exercises: revert the
    // cutover commit with plain git *first*, then try applyReverse.
    gitRun(repo, ["revert", "-m", "1", "--no-edit", p5Sha]);
    const revertedSha = gitRun(repo, ["rev-parse", "HEAD"]);

    expect(() => applyReverse({ git: adapter, cwd: repo }, legacySha)).toThrow(ApplyError);

    // No partial mutation from the failed attempt (previously this threw
    // LayoutFlipError only after the workflow swap had already run).
    expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
    expect(gitRun(repo, ["rev-parse", "HEAD"])).toBe(revertedSha);
  }, 20_000);
});

describe("applyReverse: the happy path is unaffected by the new pre-check", () => {
  it("still succeeds when HEAD is exactly beforeRef's forward-apply result (no drift)", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const { legacySha } = applyAndCommitCutover(repo);

    expect(() => applyReverse({ git: adapter, cwd: repo }, legacySha)).not.toThrow();
    gitRun(repo, ["commit", "-m", "revert(p5): back to legacy"]);
    const revertedSha = gitRun(repo, ["rev-parse", "HEAD"]);
    expect(gitRun(repo, ["rev-parse", `${revertedSha}^{tree}`])).toBe(
      gitRun(repo, ["rev-parse", `${legacySha}^{tree}`]),
    );
  }, 20_000);
});

describe("applyReverse: clean-worktree precondition (review round 2 LOW)", () => {
  it("RED/GREEN: refuses, untouched, when an untracked file sits at a legacy path", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const { legacySha } = applyAndCommitCutover(repo);
    mkdirSync(join(repo, "docs/cvpr-2026"), { recursive: true });
    writeFileSync(join(repo, "docs/cvpr-2026/papers.json"), "local scratch\n");
    const treeBefore = gitRun(repo, ["write-tree"]);

    expect(() => applyReverse({ git: adapter, cwd: repo }, legacySha)).toThrow(/not clean/);
    expect(gitRun(repo, ["write-tree"])).toBe(treeBefore);
    expect(gitRun(repo, ["status", "--porcelain"])).toBe("?? docs/cvpr-2026/");
  }, 20_000);
});

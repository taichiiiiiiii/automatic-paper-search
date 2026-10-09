/**
 * The core TDD acceptance test (p5-plan.md §5.2): `plan` -> `apply` ->
 * commit -> `verify` -> `apply --reverse` -> commit gives a tree
 * byte-identical to the one `apply` started from. Also: a tampered blob
 * fails `verify`, and a `moveEdit` that touches a disallowed key fails
 * `verify`. Runs against a real `git init` repo in `os.tmpdir()` built by
 * `buildFixtureRepo()` — never the real repository, never a mock adapter.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplyError, apply, applyReverse } from "../../../src/release/dataMove/apply.js";
import { buildPlan, planIsClean } from "../../../src/release/dataMove/plan.js";
import { verifyMove } from "../../../src/release/dataMove/verify.js";
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

function treeSha(repo: string, ref: string): string {
  return gitRun(repo, ["rev-parse", `${ref}^{tree}`]);
}

describe("plan -> apply -> verify -> apply --reverse round trip", () => {
  it("plan against the fixture tree is clean (no orphans, no collisions)", () => {
    fixture = buildFixtureRepo();
    const paths = gitRun(fixture.repo, ["ls-files"]).split("\n");
    const plan = buildPlan({ paths });
    expect(plan.problems).toEqual([]);
    expect(planIsClean(plan)).toBe(true);
  });

  it("apply refuses the gated delete without --confirm-delete", () => {
    fixture = buildFixtureRepo();
    expect(() => apply({ git: adapter, cwd: fixture!.repo })).toThrow(ApplyError);
    expect(() => apply({ git: adapter, cwd: fixture!.repo })).toThrow(/confirm-delete/);
    // Refusal must leave the tree untouched.
    expect(gitRun(fixture.repo, ["status", "--porcelain"])).toBe("");
  });

  // This test and the two below it do several real `git` subprocess
  // calls (buildFixtureRepo + apply/applyReverse's own `git mv`/`add`/
  // `commit`/`show` invocations); under `pnpm -r`'s parallel
  // workspace-package execution this has been observed to exceed
  // vitest's 5000ms default timeout from CPU contention alone (each
  // step is sub-second in isolation) -- an explicit timeout, not a
  // smaller fixture, is the fix, since the work itself is the real
  // cost, not a hang.
  it("apply, commit, verify, apply --reverse, commit: byte-identical tree", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const legacySha = gitRun(repo, ["rev-parse", "HEAD"]);

    const result = apply({
      git: adapter,
      cwd: repo,
      confirmDelete: "docs/daily/papers.json",
    });
    expect(result.workflowSwap.skipped).toBe(false);
    expect([...result.workflowSwap.movedNames].sort()).toEqual([
      "legacy-redirects.yml",
      "tests.yml",
    ]);
    expect([...result.workflowSwap.deletedNames].sort()).toEqual([
      "paper-slides-on-demand.yml",
      "publish.yml",
      "ts-ci.yml",
    ]);
    gitRun(repo, ["commit", "-m", "data(p5): cutover"]);
    const p5Sha = gitRun(repo, ["rev-parse", "HEAD"]);

    const report = verifyMove({ git: adapter, cwd: repo, before: legacySha, after: p5Sha });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts.deleted).toBe(2);
    expect(report.counts.moveEdited).toBe(2);

    // Spot-check the moved content and the moveEdit transform landed.
    expect(readFileSync(join(repo, "data/published/cvpr-2026/papers.json"), "utf-8")).toContain(
      "papers",
    );
    const movedConfig = readFileSync(join(repo, "data/config/config.yaml"), "utf-8");
    expect(movedConfig).toContain("dir: data/inputs");
    expect(movedConfig).toContain("seen_ids_file: data/state/seen_ids.json");
    expect(movedConfig).toContain("file: logs/paperpilot.log");
    // Comments/other lines untouched.
    expect(readFileSync(join(repo, ".gitignore"), "utf-8")).toContain("node_modules/");
    // .lighthouserc.json rewrite (p5-plan.md §4.1) landed too.
    const lighthouserc = readFileSync(join(repo, ".lighthouserc.json"), "utf-8");
    expect(lighthouserc).toContain('"staticDistDir": "./apps/web/out"');
    expect(lighthouserc).toContain('"http://localhost/iclr-2026/lineage/"');
    expect(lighthouserc).toContain("Lighthouse CI config fixture.");

    applyReverse({ git: adapter, cwd: repo }, legacySha);
    gitRun(repo, ["commit", "-m", "revert(p5): back to legacy"]);
    const revertedSha = gitRun(repo, ["rev-parse", "HEAD"]);

    expect(treeSha(repo, revertedSha)).toBe(treeSha(repo, legacySha));
  }, 20_000);

  it("verify fails when a moved blob was tampered with", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const legacySha = gitRun(repo, ["rev-parse", "HEAD"]);
    apply({ git: adapter, cwd: repo, confirmDelete: "docs/daily/papers.json" });
    // Tamper with a moved file's content before committing.
    writeFileSync(join(repo, "data/published/cvpr-2026/papers.json"), '{"papers":["tampered"]}\n');
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-m", "data(p5): cutover (tampered)"]);
    const tamperedSha = gitRun(repo, ["rev-parse", "HEAD"]);

    const report = verifyMove({ git: adapter, cwd: repo, before: legacySha, after: tamperedSha });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes("blob SHA changed"))).toBe(true);
  }, 20_000);

  it("verify fails when a moveEdit touches a key outside its allowlist", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const legacySha = gitRun(repo, ["rev-parse", "HEAD"]);
    apply({ git: adapter, cwd: repo, confirmDelete: "docs/daily/papers.json" });
    // Tamper with a disallowed key (max_age_days) on the moved config.
    const configPath = join(repo, "data/config/config.yaml");
    const tampered = readFileSync(configPath, "utf-8").replace(
      "max_age_days: 14",
      "max_age_days: 999",
    );
    writeFileSync(configPath, tampered);
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-m", "data(p5): cutover (disallowed key edit)"]);
    const tamperedSha = gitRun(repo, ["rev-parse", "HEAD"]);

    const report = verifyMove({ git: adapter, cwd: repo, before: legacySha, after: tamperedSha });
    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.includes("does not equal the allowed-key transform")),
    ).toBe(true);
  }, 20_000);
});

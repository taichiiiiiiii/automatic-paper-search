/**
 * `verifyMove`-specific regression tests (p5-review1.md L2, L11): targeted
 * coverage for the gates the review found had no test at all (each
 * mutation "SURVIVED"):
 *
 *  - L2: a moved/moveEdit/stay file's permission bits (`git ls-tree`
 *    mode) must match, not just its blob SHA.
 *  - L11: the "outside the allowlist" diff gate, the "source still
 *    present in <after>" gate, and the workflow-swap content-mismatch
 *    gate.
 *
 * `roundTrip.test.ts` already covers the happy path plus the two gates
 * that did have tests (tampered blob, disallowed moveEdit key).
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apply } from "../../../src/release/dataMove/apply.js";
import { verifyMove } from "../../../src/release/dataMove/verify.js";
import {
  adapter,
  buildFixtureRepo,
  cleanupFixtureRepo,
  type FixtureRepo,
  gitRun,
} from "./fixtures.js";

let fixture: FixtureRepo | undefined;

afterEach(() => {
  if (fixture) cleanupFixtureRepo(fixture);
  fixture = undefined;
});

function applyUncommitted(repo: string): string {
  const legacySha = gitRun(repo, ["rev-parse", "HEAD"]);
  apply({ git: adapter, cwd: repo, confirmDelete: "docs/daily/papers.json" });
  return legacySha;
}

describe("verifyMove: L2 file mode", () => {
  it("RED/GREEN: probe P3 — a moved file chmod'ed executable fails verify", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const legacySha = applyUncommitted(repo);
    chmodSync(join(repo, "data/published/cvpr-2026/papers.json"), 0o755);
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-m", "data(p5): cutover (chmod +x)"]);
    const afterSha = gitRun(repo, ["rev-parse", "HEAD"]);

    const report = verifyMove({ git: adapter, cwd: repo, before: legacySha, after: afterSha });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes("file mode changed"))).toBe(true);
  }, 20_000);

  it("RED/GREEN: a stay file chmod'ed executable fails verify with the stay-mode message", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const legacySha = applyUncommitted(repo);
    chmodSync(join(repo, "docs/design/39-x.md"), 0o755);
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-m", "data(p5): cutover (stay chmod)"]);
    const afterSha = gitRun(repo, ["rev-parse", "HEAD"]);

    const report = verifyMove({ git: adapter, cwd: repo, before: legacySha, after: afterSha });
    expect(report.ok).toBe(false);
    expect(report.problems).toContain(
      "stay docs/design/39-x.md: file mode changed unexpectedly (100644 -> 100755)",
    );
  }, 20_000);

  it("RED/GREEN: a moveEdit destination chmod'ed executable fails verify with the moveEdit-mode message", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const legacySha = applyUncommitted(repo);
    chmodSync(join(repo, "data/config/config.yaml"), 0o755);
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-m", "data(p5): cutover (moveEdit chmod)"]);
    const afterSha = gitRun(repo, ["rev-parse", "HEAD"]);

    const report = verifyMove({ git: adapter, cwd: repo, before: legacySha, after: afterSha });
    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) =>
        p.startsWith("moveEdit paperpilot/config.yaml: file mode changed (100644 -> 100755)"),
      ),
    ).toBe(true);
  }, 20_000);

  it("a move with unchanged mode passes (sanity: the new check isn't over-eager)", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const legacySha = applyUncommitted(repo);
    gitRun(repo, ["commit", "-m", "data(p5): cutover"]);
    const afterSha = gitRun(repo, ["rev-parse", "HEAD"]);

    const report = verifyMove({ git: adapter, cwd: repo, before: legacySha, after: afterSha });
    expect(report.ok).toBe(true);
  }, 20_000);
});

describe("verifyMove: L11 outside-allowlist diff gate", () => {
  it("RED/GREEN: an extra unrelated change in the same commit fails verify", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const legacySha = applyUncommitted(repo);
    // Tamper: an edit to a file entirely outside the data move's scope,
    // folded into the same commit.
    writeFileSync(join(repo, "apps/web/README.md"), "# web (tampered)\n");
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-m", "data(p5): cutover (plus a stray edit)"]);
    const afterSha = gitRun(repo, ["rev-parse", "HEAD"]);

    const report = verifyMove({ git: adapter, cwd: repo, before: legacySha, after: afterSha });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes("unexpected change outside the allowlist"))).toBe(
      true,
    );
  }, 20_000);
});

describe("verifyMove: L11 source-still-present gate", () => {
  it("RED/GREEN: a moved file whose legacy source was re-added fails verify", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const legacySha = applyUncommitted(repo);
    // Re-create the already-`git mv`'d-away legacy source path before
    // committing, simulating a half-reverted/duplicated tree.
    mkdirSync(join(repo, "docs/cvpr-2026"), { recursive: true });
    writeFileSync(join(repo, "docs/cvpr-2026/papers.json"), '{"papers":["stray copy"]}\n');
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-m", "data(p5): cutover (source resurrected)"]);
    const afterSha = gitRun(repo, ["rev-parse", "HEAD"]);

    const report = verifyMove({ git: adapter, cwd: repo, before: legacySha, after: afterSha });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes("source still present in <after>"))).toBe(true);
  }, 20_000);
});

describe("verifyMove: L11 workflow-swap content-mismatch gate", () => {
  it("RED/GREEN: a workflow destination that doesn't match its staged source fails verify", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const legacySha = applyUncommitted(repo);
    // Tamper with the swapped-in tests.yml content after `apply` staged it.
    writeFileSync(
      join(repo, ".github/workflows/tests.yml"),
      "name: tests (node, tampered)\non: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n",
    );
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-m", "data(p5): cutover (workflow tampered)"]);
    const afterSha = gitRun(repo, ["rev-parse", "HEAD"]);

    const report = verifyMove({ git: adapter, cwd: repo, before: legacySha, after: afterSha });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes("content does not match staged"))).toBe(true);
  }, 20_000);
});

describe("verifyMove: L8 mirror — missing workflows-p5 at <before>", () => {
  it("RED/GREEN: refuses by default when <before> has no staged workflows", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    // Remove the staged workflows and the three delete targets so the
    // legacy ("before") commit itself has nothing under workflows-p5 and
    // nothing to delete — a self-consistent "no swap happened" tree.
    gitRun(repo, [
      "rm",
      "-r",
      "--",
      ".github/workflows-p5",
      ".github/workflows/ts-ci.yml",
      ".github/workflows/publish.yml",
      ".github/workflows/paper-slides-on-demand.yml",
    ]);
    gitRun(repo, ["commit", "-m", "simulate: no workflows-p5, nothing to delete"]);
    const legacySha = gitRun(repo, ["rev-parse", "HEAD"]);

    apply({
      git: adapter,
      cwd: repo,
      confirmDelete: "docs/daily/papers.json",
      allowMissingWorkflows: true,
    });
    gitRun(repo, ["commit", "-m", "data(p5): cutover (no workflows to swap)"]);
    const afterSha = gitRun(repo, ["rev-parse", "HEAD"]);

    const defaultReport = verifyMove({
      git: adapter,
      cwd: repo,
      before: legacySha,
      after: afterSha,
    });
    expect(defaultReport.ok).toBe(false);
    expect(
      defaultReport.problems.some((p) => p.includes("no files under .github/workflows-p5")),
    ).toBe(true);

    const allowedReport = verifyMove({
      git: adapter,
      cwd: repo,
      before: legacySha,
      after: afterSha,
      allowMissingWorkflows: true,
    });
    expect(allowedReport.ok).toBe(true);
  }, 20_000);
});

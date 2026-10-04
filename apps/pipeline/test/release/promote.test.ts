/**
 * TS port of `paperpilot/tests/test_promote_generated_sh.py` — hermetic
 * tests for the fresh-tree generated-data promoter, run against real `git`
 * CLI repositories created with `git init` in a temp directory (never a
 * network remote, never a mock git adapter).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createGitAdapter, git } from "../../src/release/git/gitAdapter.js";
import { PromotionError, promote } from "../../src/release/promote.js";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const adapter = createGitAdapter();
function gitRun(cwd: string, args: string[]): string {
  return git(adapter, cwd, args, { env: GIT_ENV });
}

interface World {
  base: string;
  remote: string;
  checkout: string;
  candidate: string;
}

let world: World;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "paperpilot-promote-world-"));
  const remote = join(base, "remote.git");
  mkdirSync(remote);
  gitRun(remote, ["init", "--bare", "--initial-branch=develop"]);

  const checkout = join(base, "checkout");
  mkdirSync(checkout);
  gitRun(checkout, ["init", "--initial-branch=develop"]);
  gitRun(checkout, ["remote", "add", "origin", remote]);
  mkdirSync(join(checkout, "docs", "themes"), { recursive: true });
  writeFileSync(join(checkout, "docs", "themes", "manifest.json"), "{}\n");
  gitRun(checkout, ["add", "."]);
  gitRun(checkout, ["commit", "-m", "seed"]);
  gitRun(checkout, ["push", "-u", "origin", "develop"]);

  const candidate = join(base, "candidate");
  const target = join(candidate, "docs", "themes", "new-theme");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "lineage.json"), '{"nodes":[],"edges":[]}\n');

  world = { base, remote, checkout, candidate };
});

afterEach(() => {
  rmSync(world.base, { recursive: true, force: true });
});

function baseSha(): string {
  return gitRun(world.checkout, ["rev-parse", "HEAD"]);
}

function run(stagePaths: string[], options: { baseSha?: string } = {}) {
  return promote({
    kind: "test-only",
    candidateDir: world.candidate,
    commitMessage: "data(test): promote candidate",
    allowedPaths: stagePaths,
    git: adapter,
    cwd: world.checkout,
    promoteBaseSha: options.baseSha ?? baseSha(),
    promoteMaxAttempts: 2,
    promoteNoSleep: true,
    promotionTestMode: true,
  });
}

it("promotes a candidate from a fresh remote tip", async () => {
  const result = await run(["docs/themes"]);
  expect(result.changed).toBe(true);
  expect(result.sourceSha).toMatch(/^[0-9a-f]{40}$/);

  const verify = join(world.base, "verify");
  gitRun(world.base, ["clone", world.remote, verify]);
  expect(
    readFileSync(join(verify, "docs", "themes", "new-theme", "lineage.json"), "utf-8"),
  ).toContain("nodes");
});

it("rejects a candidate outside the allowlist", async () => {
  const bad = join(world.candidate, ".github", "workflows");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "pwn.yml"), "permissions: write-all\n");

  await expect(run(["docs/themes"])).rejects.toThrow(/allow/i);
});

it("rejects a candidate symlink", async () => {
  symlinkSync("/etc/passwd", join(world.candidate, "docs", "themes", "escape"));
  await expect(run(["docs/themes"])).rejects.toThrow(/symlink/i);
});

it("rejects a same-path change on develop since generation (CAS)", async () => {
  const base = baseSha();
  const writer = join(world.base, "writer");
  gitRun(world.base, ["clone", world.remote, writer]);
  const target = join(writer, "docs", "themes", "new-theme");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "lineage.json"), '{"remote":true}\n');
  gitRun(writer, ["add", "."]);
  gitRun(writer, ["commit", "-m", "concurrent same-path update"]);
  gitRun(writer, ["push", "origin", "develop"]);
  const before = gitRun(writer, ["rev-parse", "HEAD"]);

  await expect(run(["docs/themes"], { baseSha: base })).rejects.toThrow(
    /changed on develop after generation/,
  );

  expect(gitRun(writer, ["ls-remote", "origin", "refs/heads/develop"]).split(/\s+/)[0]).toBe(
    before,
  );
});

it("preserves an unrelated change on develop since generation", async () => {
  const base = baseSha();
  const writer = join(world.base, "writer");
  gitRun(world.base, ["clone", world.remote, writer]);
  writeFileSync(join(writer, "README.md"), "concurrent but unrelated\n");
  gitRun(writer, ["add", "README.md"]);
  gitRun(writer, ["commit", "-m", "unrelated update"]);
  gitRun(writer, ["push", "origin", "develop"]);

  const result = await run(["docs/themes"], { baseSha: base });
  expect(result.changed).toBe(true);

  const verify = join(world.base, "verify");
  gitRun(world.base, ["clone", world.remote, verify]);
  expect(readFileSync(join(verify, "README.md"), "utf-8")).toBe("concurrent but unrelated\n");
  expect(
    readFileSync(join(verify, "docs", "themes", "new-theme", "lineage.json"), "utf-8"),
  ).toContain("nodes");
});

it("an exact theme path preserves a concurrent different-theme update", async () => {
  const base = baseSha();
  const writer = join(world.base, "writer");
  gitRun(world.base, ["clone", world.remote, writer]);
  const other = join(writer, "docs", "themes", "other-theme");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "lineage.json"), '{"other":true}\n');
  gitRun(writer, ["add", "."]);
  gitRun(writer, ["commit", "-m", "concurrent different-theme update"]);
  gitRun(writer, ["push", "origin", "develop"]);

  const result = await run(["docs/themes/new-theme"], { baseSha: base });
  expect(result.changed).toBe(true);

  const verify = join(world.base, "verify-different-theme");
  gitRun(world.base, ["clone", world.remote, verify]);
  expect(
    readFileSync(join(verify, "docs", "themes", "new-theme", "lineage.json"), "utf-8"),
  ).toContain("nodes");
  expect(
    readFileSync(join(verify, "docs", "themes", "other-theme", "lineage.json"), "utf-8"),
  ).toContain("other");
});

it("a candidate producing no change reports changed=false without pushing", async () => {
  // Make the candidate byte-identical to what's already on develop by
  // staging exactly the committed manifest file, unchanged.
  const candidate2 = join(world.base, "candidate-noop");
  mkdirSync(join(candidate2, "docs", "themes"), { recursive: true });
  writeFileSync(join(candidate2, "docs", "themes", "manifest.json"), "{}\n");

  const result = await promote({
    kind: "test-only",
    candidateDir: candidate2,
    commitMessage: "data(test): noop",
    allowedPaths: ["docs/themes"],
    git: adapter,
    cwd: world.checkout,
    promoteBaseSha: baseSha(),
    promoteMaxAttempts: 2,
    promoteNoSleep: true,
    promotionTestMode: true,
  });
  expect(result.changed).toBe(false);
});

it("test-only mode is disabled without the explicit flag", async () => {
  await expect(
    promote({
      kind: "test-only",
      candidateDir: world.candidate,
      commitMessage: "x",
      allowedPaths: ["docs/themes"],
      git: adapter,
      cwd: world.checkout,
      promoteBaseSha: baseSha(),
      promotionTestMode: false,
    }),
  ).rejects.toThrow(PromotionError);
});

it("rejects a non-ancestor PROMOTE_BASE_SHA", async () => {
  await expect(run(["docs/themes"], { baseSha: "0".repeat(40) })).rejects.toThrow(/not available/);
});

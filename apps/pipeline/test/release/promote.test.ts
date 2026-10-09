/**
 * TS port of `paperpilot/tests/test_promote_generated_sh.py` — hermetic
 * tests for the fresh-tree generated-data promoter, run against real `git`
 * CLI repositories created with `git init` in a temp directory (never a
 * network remote, never a mock git adapter).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGitAdapter, git } from "../../src/release/git/gitAdapter.js";
import { PromotionError, promote } from "../../src/release/promote.js";

// This file runs real subprocesses (tsx/node/git). Each spawn is
// sub-second alone but can take seconds under `pnpm -r test`'s parallel
// load (or a loaded CI runner), so vitest's 5 s test / 10 s hook defaults
// flake. Raised for this file only; explicit per-test timeouts still win.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

// PUB-03: a base that EXISTS but is not an ancestor of the develop tip
// (distinct from the "0"*40 case above, which does not exist at all).
it("PUB-03: rejects a PROMOTE_BASE_SHA that exists but is not an ancestor of develop's tip", () => {
  // Commit locally on top of the checkout's develop WITHOUT pushing, so
  // this commit exists (fetchable by cat-file -e) but origin/develop's
  // tip is its ANCESTOR, not the other way around.
  writeFileSync(join(world.checkout, "docs", "themes", "unpushed.txt"), "local only\n");
  gitRun(world.checkout, ["add", "."]);
  gitRun(world.checkout, ["commit", "-m", "local-only, not pushed"]);
  const unpushedSha = gitRun(world.checkout, ["rev-parse", "HEAD"]);

  return expect(run(["docs/themes"], { baseSha: unpushedSha })).rejects.toThrow(
    /not an ancestor of the current develop tip/,
  );
});

// PUB-07: candidate folder absent, or present with zero files.
it("PUB-07: rejects a candidate directory that does not exist", async () => {
  await expect(
    promote({
      kind: "test-only",
      candidateDir: join(world.base, "no-such-candidate-dir"),
      commitMessage: "x",
      allowedPaths: ["docs/themes"],
      git: adapter,
      cwd: world.checkout,
      promoteBaseSha: baseSha(),
      promotionTestMode: true,
    }),
  ).rejects.toThrow(/candidate directory does not exist/);
});

it("PUB-07: rejects a candidate directory containing zero files", async () => {
  const empty = join(world.base, "empty-candidate");
  mkdirSync(empty, { recursive: true });
  await expect(
    promote({
      kind: "test-only",
      candidateDir: empty,
      commitMessage: "x",
      allowedPaths: ["docs/themes"],
      git: adapter,
      cwd: world.checkout,
      promoteBaseSha: baseSha(),
      promotionTestMode: true,
    }),
  ).rejects.toThrow(/candidate contains no files/);
});

// PUB-08: PROMOTE_AS_OF must be a strict UTC timestamp.
it("PUB-08: rejects a malformed PROMOTE_AS_OF", async () => {
  await expect(
    promote({
      kind: "test-only",
      candidateDir: world.candidate,
      commitMessage: "x",
      allowedPaths: ["docs/themes"],
      git: adapter,
      cwd: world.checkout,
      promoteBaseSha: baseSha(),
      promotionTestMode: true,
      promoteAsOf: "2026-08-30",
    }),
  ).rejects.toThrow(/PROMOTE_AS_OF must be a UTC timestamp/);
});

// PUB-09: unknown kind, and test-only mode must refuse a non-local remote.
it("PUB-09: rejects an unknown promotion kind", async () => {
  await expect(
    promote({
      kind: "bogus" as unknown as "test-only",
      candidateDir: world.candidate,
      commitMessage: "x",
      allowedPaths: ["docs/themes"],
      git: adapter,
      cwd: world.checkout,
      promoteBaseSha: baseSha(),
    }),
  ).rejects.toThrow(/unknown promotion kind/);
});

it("PUB-09: test-only mode refuses to run against a non-local (real) remote", async () => {
  gitRun(world.checkout, ["remote", "set-url", "origin", "https://example.invalid/repo.git"]);
  await expect(
    promote({
      kind: "test-only",
      candidateDir: world.candidate,
      commitMessage: "x",
      allowedPaths: ["docs/themes"],
      git: adapter,
      cwd: world.checkout,
      promoteBaseSha: baseSha(),
      promotionTestMode: true,
    }),
  ).rejects.toThrow(/requires a local filesystem remote/);
});

// PUB-12: a refresh that writes outside the allowlist/shared paths — either
// a tracked file it modifies, or a new untracked file — must stop the run.
it("PUB-12: a refresh that modifies a TRACKED file outside the allowlist is rejected", async () => {
  // Seed an extra tracked file at the repo root (outside docs/themes) from
  // a second clone, so the promotion worktree starts with it tracked.
  const writer = join(world.base, "writer-pub12-tracked");
  gitRun(world.base, ["clone", world.remote, writer]);
  writeFileSync(join(writer, "OTHER.txt"), "original\n");
  gitRun(writer, ["add", "OTHER.txt"]);
  gitRun(writer, ["commit", "-m", "seed an out-of-allowlist tracked file"]);
  gitRun(writer, ["push", "origin", "develop"]);

  await expect(
    promote({
      kind: "test-only",
      candidateDir: world.candidate,
      commitMessage: "x",
      allowedPaths: ["docs/themes"],
      git: adapter,
      cwd: world.checkout,
      promoteBaseSha: gitRun(writer, ["rev-parse", "HEAD"]),
      promotionTestMode: true,
      refreshSharedOutputs: async ({ tree }) => {
        writeFileSync(join(tree, "OTHER.txt"), "modified by refresh\n");
      },
    }),
  ).rejects.toThrow(/refresh produced tracked changes outside the promotion allowlist/);
});

it("PUB-12: a refresh that creates an UNTRACKED file outside the allowlist is rejected", async () => {
  await expect(
    promote({
      kind: "test-only",
      candidateDir: world.candidate,
      commitMessage: "x",
      allowedPaths: ["docs/themes"],
      git: adapter,
      cwd: world.checkout,
      promoteBaseSha: baseSha(),
      promotionTestMode: true,
      refreshSharedOutputs: async ({ tree }) => {
        writeFileSync(join(tree, "UNEXPECTED.txt"), "surprise\n");
      },
    }),
  ).rejects.toThrow(/refresh produced untracked files outside the promotion allowlist/);
});

// ---- M4: defaultRefreshSharedOutputs must throw rather than silently run a
// partial refresh (it used to run identity-lite + search-index for
// "conference" and call that success, skipping build_pages/lineage-quality/
// sitemap/asset-versions with no error at all). ----

function remoteDevelopSha(): string {
  return gitRun(world.remote, ["rev-parse", "develop"]).trim();
}

it("promote({kind:'conference'}) with the default hooks rejects and pushes nothing", async () => {
  const before = remoteDevelopSha();
  await expect(
    promote({
      kind: "conference",
      candidateDir: world.candidate,
      commitMessage: "data: promote conference candidate",
      allowedPaths: ["docs/themes"],
      git: adapter,
      cwd: world.checkout,
      promoteBaseSha: baseSha(),
      promoteMaxAttempts: 1,
      promoteNoSleep: true,
    }),
  ).rejects.toThrow(/refreshSharedOutputs for kind "conference" is not wired/);
  expect(remoteDevelopSha()).toBe(before);
});

it("promote({kind:'themes'}) with the default hooks rejects and pushes nothing", async () => {
  const before = remoteDevelopSha();
  await expect(
    promote({
      kind: "themes",
      candidateDir: world.candidate,
      commitMessage: "data: promote themes candidate",
      allowedPaths: ["docs/themes"],
      git: adapter,
      cwd: world.checkout,
      promoteBaseSha: baseSha(),
      promoteMaxAttempts: 1,
      promoteNoSleep: true,
    }),
  ).rejects.toThrow(/refreshSharedOutputs for kind "themes" is not wired/);
  expect(remoteDevelopSha()).toBe(before);
});

// LOW: `await refreshSharedOutputs(...)` must actually be awaited — a
// missing `await` would leave its rejection as a floating, unhandled
// promise rather than something `promote()` can catch, so execution
// would fall through to `validatePromotedTree`/commit/push as though the
// refresh had succeeded.
it("a refreshSharedOutputs rejection is awaited and propagates, pushing nothing", async () => {
  const before = remoteDevelopSha();
  let validateCalled = false;
  await expect(
    promote({
      kind: "test-only",
      candidateDir: world.candidate,
      commitMessage: "data(test): refresh-rejects",
      allowedPaths: ["docs/themes"],
      git: adapter,
      cwd: world.checkout,
      promoteBaseSha: baseSha(),
      promoteMaxAttempts: 1,
      promoteNoSleep: true,
      promotionTestMode: true,
      refreshSharedOutputs: async () => {
        throw new PromotionError("refresh failed");
      },
      validatePromotedTree: async () => {
        validateCalled = true;
      },
    }),
  ).rejects.toThrow(/refresh failed/);
  expect(validateCalled).toBe(false);
  expect(remoteDevelopSha()).toBe(before);
});

it("a validatePromotedTree rejection is awaited and propagates, pushing nothing", async () => {
  const before = remoteDevelopSha();
  await expect(
    promote({
      kind: "test-only",
      candidateDir: world.candidate,
      commitMessage: "data(test): validate-rejects",
      allowedPaths: ["docs/themes"],
      git: adapter,
      cwd: world.checkout,
      promoteBaseSha: baseSha(),
      promoteMaxAttempts: 1,
      promoteNoSleep: true,
      promotionTestMode: true,
      refreshSharedOutputs: async () => {},
      validatePromotedTree: async () => {
        throw new PromotionError("promoted tree failed validation");
      },
    }),
  ).rejects.toThrow(/promoted tree failed validation/);
  expect(remoteDevelopSha()).toBe(before);
});

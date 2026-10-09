/**
 * TS port of `paperpilot/tests/test_commit_and_push_sh.py` (the portable
 * subset — this module is a library, not a script invoked via subprocess,
 * so "script exists and executable" has no TS equivalent).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commitAndPush } from "../../src/release/commitAndPush.js";
import { createGitAdapter, git } from "../../src/release/git/gitAdapter.js";

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
  local: string;
}

let world: World;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "paperpilot-commit-push-"));
  const remote = join(base, "remote.git");
  mkdirSync(remote);
  gitRun(remote, ["init", "--bare", "--initial-branch=develop"]);

  const local = join(base, "local");
  mkdirSync(local);
  gitRun(local, ["init", "--initial-branch=develop"]);
  // commitAndPush itself runs git without GIT_ENV, exactly like the
  // workflows (which `git config user.*` first). A CI runner has no global
  // identity, so the repo must carry one or every commit fails there.
  gitRun(local, ["config", "user.name", "test"]);
  gitRun(local, ["config", "user.email", "test@example.com"]);
  gitRun(local, ["remote", "add", "origin", remote]);
  writeFileSync(join(local, "README.md"), "seed\n");
  gitRun(local, ["add", "README.md"]);
  gitRun(local, ["commit", "-m", "seed"]);
  gitRun(local, ["push", "-u", "origin", "develop"]);

  const themes = join(local, "docs", "themes", "test-theme");
  mkdirSync(themes, { recursive: true });
  writeFileSync(join(themes, "lineage.json"), '{"slug":"test-theme"}\n');

  world = { base, remote, local };
});

afterEach(() => {
  rmSync(world.base, { recursive: true, force: true });
});

it("simple push succeeds when no competitor", async () => {
  const outcome = await commitAndPush({
    message: 'data(themes): on-demand generation of "Test Theme"',
    stagePaths: ["docs/themes/"],
    git: adapter,
    cwd: world.local,
    noSleep: true,
  });
  expect(outcome).toEqual({ status: "pushed", attempts: 1 });
  const log = gitRun(world.remote, ["log", "--oneline"]).split("\n").filter(Boolean);
  expect(log.length).toBe(2);
  expect(log[0]).toContain('on-demand generation of "Test Theme"');
});

it("noop when nothing staged", async () => {
  rmSync(join(world.local, "docs"), { recursive: true, force: true });
  const outcome = await commitAndPush({
    message: "data(themes): noop",
    stagePaths: ["docs/themes/"],
    git: adapter,
    cwd: world.local,
    noSleep: true,
  });
  expect(outcome).toEqual({ status: "noop" });
  expect(gitRun(world.remote, ["log", "--oneline"]).split("\n").filter(Boolean).length).toBe(1);
});

it("recovers from a concurrent push via rebase retry", async () => {
  const competitor = join(world.base, "competitor");
  gitRun(world.base, ["clone", world.remote, "competitor"]);
  const otherTheme = join(competitor, "docs", "themes", "other-theme");
  mkdirSync(otherTheme, { recursive: true });
  writeFileSync(join(otherTheme, "lineage.json"), '{"slug":"other-theme"}\n');
  gitRun(competitor, ["add", "docs/themes/other-theme/lineage.json"]);
  gitRun(competitor, ["commit", "-m", "competitor commit"]);
  gitRun(competitor, ["push", "origin", "develop"]);

  const outcome = await commitAndPush({
    message: 'data(themes): on-demand generation of "Test Theme"',
    stagePaths: ["docs/themes/"],
    git: adapter,
    cwd: world.local,
    noSleep: true,
  });
  expect(outcome.status).toBe("pushed");

  const log = gitRun(world.remote, ["log", "--oneline"]).split("\n").filter(Boolean);
  expect(log.length).toBe(3);
  expect(log[0]).toContain('on-demand generation of "Test Theme"');
  expect(log[1]).toContain("competitor commit");
});

it("eventually fails after max retries when every push is rejected", async () => {
  const hooks = join(world.remote, "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-receive"), "#!/bin/sh\necho 'always reject for test'\nexit 1\n", {
    mode: 0o755,
  });

  await expect(
    commitAndPush({
      message: "data(themes): doomed push",
      stagePaths: ["docs/themes/"],
      git: adapter,
      cwd: world.local,
      noSleep: true,
      maxAttempts: 2,
    }),
  ).rejects.toThrow(/push failed/);
});

// PUB-23 (no Python test exists for this half — only the shell script's
// own comment documents it): a genuine rebase CONFLICT (not merely a
// rejected fast-forward) must `rebase --abort` so the retry loop — and the
// repo on disk after a final failure — are never left mid-rebase.
it("PUB-23: a genuine rebase conflict is aborted, leaving the repo usable and the error clean", async () => {
  const competitor = join(world.base, "competitor-conflict");
  gitRun(world.base, ["clone", world.remote, "competitor-conflict"]);
  const conflictFile = join(competitor, "docs", "themes", "test-theme", "lineage.json");
  mkdirSync(join(competitor, "docs", "themes", "test-theme"), { recursive: true });
  writeFileSync(conflictFile, '{"slug":"test-theme","from":"competitor"}\n');
  gitRun(competitor, ["add", "docs/themes/test-theme/lineage.json"]);
  gitRun(competitor, ["commit", "-m", "competitor also edits the same line"]);
  gitRun(competitor, ["push", "origin", "develop"]);

  // Our local side edits the SAME line of the SAME file differently, so
  // every rebase attempt against the competitor's commit conflicts the
  // same way every time (not just a non-fast-forward that a plain rebase
  // would resolve cleanly).
  writeFileSync(
    join(world.local, "docs", "themes", "test-theme", "lineage.json"),
    '{"slug":"test-theme","from":"local"}\n',
  );

  await expect(
    commitAndPush({
      message: "data(themes): conflicting edit",
      stagePaths: ["docs/themes/"],
      git: adapter,
      cwd: world.local,
      noSleep: true,
      maxAttempts: 2,
    }),
  ).rejects.toThrow(/push failed/);

  // The repo must be left clean — no rebase stuck in progress — proving
  // `rebase --abort` actually ran rather than leaving conflict markers.
  expect(existsSync(join(world.local, ".git", "rebase-merge"))).toBe(false);
  expect(existsSync(join(world.local, ".git", "rebase-apply"))).toBe(false);
  expect(gitRun(world.local, ["status", "--porcelain"]).trim()).toBe("");
});

// LOW: pin the exact jittered backoff formula
// `(attempt * 3 + floor(random() * 5)) * 1000` ms between retries — a
// test asserting only "it eventually fails"/"it eventually succeeds"
// can't catch a wrong coefficient or a dropped jitter term.
it("backs off with the exact jittered formula (attempt*3 + floor(random*5)) * 1000 ms", async () => {
  const hooks = join(world.remote, "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-receive"), "#!/bin/sh\necho 'always reject for test'\nexit 1\n", {
    mode: 0o755,
  });

  const delays: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };
  const random = () => 0.4; // floor(0.4 * 5) = 2

  await expect(
    commitAndPush({
      message: "data(themes): doomed push",
      stagePaths: ["docs/themes/"],
      git: adapter,
      cwd: world.local,
      maxAttempts: 3,
      sleep,
      random,
    }),
  ).rejects.toThrow(/push failed/);

  // maxAttempts=3: sleeps happen after attempts 1 and 2, never after the
  // final (3rd) attempt.
  expect(delays).toEqual([(1 * 3 + 2) * 1000, (2 * 3 + 2) * 1000]);
});

it("stages a commit message containing shell metacharacters literally", async () => {
  const payload = 'data(themes): "$(touch pwned)" `id`';
  const outcome = await commitAndPush({
    message: payload,
    stagePaths: ["docs/themes/"],
    git: adapter,
    cwd: world.local,
    noSleep: true,
  });
  expect(outcome.status).toBe("pushed");
  const log = gitRun(world.remote, ["log", "-1", "--pretty=%s"]);
  expect(log).toContain("$(touch");
  expect(log).toContain("`id`");
});

it("a stage path that exists but has no diff is a noop", async () => {
  gitRun(world.local, ["add", "docs/themes/test-theme/lineage.json"]);
  gitRun(world.local, ["commit", "-m", "pre-existing identical content"]);
  gitRun(world.local, ["push", "origin", "develop"]);

  const outcome = await commitAndPush({
    message: "data(themes): noop",
    stagePaths: ["docs/themes/"],
    git: adapter,
    cwd: world.local,
    noSleep: true,
  });
  expect(outcome).toEqual({ status: "noop" });
});

it("accepts multiple stage paths in one commit", async () => {
  const extra = join(world.local, "paperpilot", "output");
  mkdirSync(extra, { recursive: true });
  writeFileSync(join(extra, "summary.csv"), "title,year\nfoo,2026\n");

  const outcome = await commitAndPush({
    message: "data(weekly): summary + themes",
    stagePaths: ["docs/themes/", "paperpilot/output/"],
    git: adapter,
    cwd: world.local,
    noSleep: true,
  });
  expect(outcome.status).toBe("pushed");

  const files = gitRun(world.remote, ["show", "--name-only", "--pretty=", "HEAD"])
    .split("\n")
    .filter(Boolean);
  expect(files).toContain("docs/themes/test-theme/lineage.json");
  expect(files).toContain("paperpilot/output/summary.csv");
});

it("a missing stage path among several is skipped, not fatal", async () => {
  const outcome = await commitAndPush({
    message: "data(test): partial multi-path",
    stagePaths: [
      "docs/themes/",
      "paperpilot/data/nonexistent-cache.json",
      "some/other/missing/path",
    ],
    git: adapter,
    cwd: world.local,
    noSleep: true,
  });
  expect(outcome.status).toBe("pushed");
});

it("all stage paths missing is a noop, not an error", async () => {
  const outcome = await commitAndPush({
    message: "data(test): all missing",
    stagePaths: ["some/missing/a", "some/missing/b"],
    git: adapter,
    cwd: world.local,
    noSleep: true,
  });
  expect(outcome).toEqual({ status: "noop" });
  expect(gitRun(world.remote, ["log", "--oneline"]).split("\n").filter(Boolean).length).toBe(1);
});

it("respects an overridden push branch", async () => {
  gitRun(world.remote, ["branch", "-m", "develop", "main"]);
  gitRun(world.local, ["branch", "-m", "develop", "main"]);
  gitRun(world.local, ["fetch", "origin"]);
  gitRun(world.local, ["branch", "--set-upstream-to=origin/main", "main"]);

  const outcome = await commitAndPush({
    message: "data(weekly): to main branch",
    stagePaths: ["docs/themes/"],
    git: adapter,
    cwd: world.local,
    noSleep: true,
    branch: "main",
  });
  expect(outcome.status).toBe("pushed");
  expect(
    gitRun(world.remote, ["log", "--oneline", "main"]).split("\n").filter(Boolean).length,
  ).toBe(2);
});

// Explicit timeout: 5 real `git clone`+commit+push attempts (with rebase
// retries) can comfortably exceed the 5s default under CI/load contention.
it("five parallel runs against the same remote all publish", async () => {
  const remote = join(world.base, "remote5.git");
  mkdirSync(remote);
  gitRun(remote, ["init", "--bare", "--initial-branch=develop"]);
  const seeder = join(world.base, "seeder");
  mkdirSync(seeder);
  gitRun(seeder, ["init", "--initial-branch=develop"]);
  gitRun(seeder, ["remote", "add", "origin", remote]);
  writeFileSync(join(seeder, "README.md"), "seed\n");
  gitRun(seeder, ["add", "README.md"]);
  gitRun(seeder, ["commit", "-m", "seed"]);
  gitRun(seeder, ["push", "-u", "origin", "develop"]);

  const themes = [
    "vector-database",
    "state-space-model",
    "world-model",
    "flash-attention",
    "chain-of-thought",
  ];
  const results = await Promise.all(
    themes.map(async (slug) => {
      const local = join(world.base, `local-${slug}`);
      gitRun(world.base, ["clone", remote, local]);
      gitRun(local, ["config", "user.name", "test"]);
      gitRun(local, ["config", "user.email", "test@example.com"]);
      const dir = join(local, "docs", "themes", slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "lineage.json"), `{"slug":"${slug}"}\n`);
      return commitAndPush({
        message: `data(themes): on-demand generation of "${slug}"`,
        stagePaths: ["docs/themes/"],
        git: adapter,
        cwd: local,
        noSleep: true,
      });
    }),
  );
  for (const outcome of results) {
    expect(outcome.status).toBe("pushed");
  }
  const log = gitRun(remote, ["log", "--oneline"]);
  expect(log.match(/on-demand generation of/g)?.length).toBe(5);
  for (const slug of themes) {
    expect(log).toContain(slug);
  }
}, 30_000);

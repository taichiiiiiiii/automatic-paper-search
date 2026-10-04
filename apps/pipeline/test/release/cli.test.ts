/**
 * End-to-end smoke tests for `src/release/cli.ts`'s argv wiring, run via
 * `tsx` as a real child process (the way GitHub Actions would invoke it) —
 * not a unit test of the ported logic itself (covered by each module's
 * own test file).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "release", "cli.ts");
// tsx is a workspace-root devDependency (hoisted by pnpm), not installed
// per-package, so resolve it from the repo root rather than this package.
const TSX = join(__dirname, "..", "..", "..", "..", "node_modules", ".bin", "tsx");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function runCli(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(TSX, [CLI, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...GIT_ENV, ...env },
    timeout: 30_000,
  });
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperpilot-release-cli-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

it("commit-push subcommand pushes a staged change to a local remote", () => {
  const remote = join(base, "remote.git");
  mkdirSync(remote);
  runGit(remote, ["init", "--bare", "--initial-branch=develop"]);
  const local = join(base, "local");
  mkdirSync(local);
  runGit(local, ["init", "--initial-branch=develop"]);
  runGit(local, ["remote", "add", "origin", remote]);
  writeFileSync(join(local, "README.md"), "seed\n");
  runGit(local, ["add", "README.md"]);
  runGit(local, ["commit", "-m", "seed"]);
  runGit(local, ["push", "-u", "origin", "develop"]);
  mkdirSync(join(local, "docs", "themes", "t"), { recursive: true });
  writeFileSync(join(local, "docs", "themes", "t", "lineage.json"), "{}\n");

  const output = runCli(local, ["commit-push", "data(test): cli push", "docs/themes/"], {
    COMMIT_PUSH_NO_SLEEP: "1",
  });
  expect(output).toContain("push succeeded");
  const log = runGit(remote, ["log", "--oneline"]);
  expect(log.split("\n").length).toBe(2);
}, 30_000); // real tsx subprocess + git operations; the 5s default can flake under load

it("package subcommand copies only changed files under the included path", () => {
  const repo = join(base, "repo");
  mkdirSync(repo);
  runGit(repo, ["init", "--initial-branch=develop"]);
  mkdirSync(join(repo, "docs", "themes"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "baseline\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "seed"]);
  mkdirSync(join(repo, "docs", "themes", "new"), { recursive: true });
  writeFileSync(join(repo, "docs", "themes", "new", "lineage.json"), '{"new":true}\n');

  const candidate = join(base, "candidate");
  const output = runCli(repo, ["package", candidate, "docs/themes"]);
  expect(output).toContain("packaged 1 generated file");
  expect(readFileSync(join(candidate, "docs/themes/new/lineage.json"), "utf-8")).toContain("new");
});

// LOW: packageCandidate resolves included paths AND runs every git command
// against the repo root, so running it from a SUBDIRECTORY of the repo
// (process.cwd() !== the repo root) must not silently miscompute diffs —
// --repo-root makes the real root explicit instead of always trusting cwd.
it("package subcommand works when invoked from a subdirectory via --repo-root", () => {
  const repo = join(base, "repo");
  mkdirSync(repo);
  runGit(repo, ["init", "--initial-branch=develop"]);
  mkdirSync(join(repo, "docs", "themes"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "baseline\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "seed"]);
  mkdirSync(join(repo, "docs", "themes", "new"), { recursive: true });
  writeFileSync(join(repo, "docs", "themes", "new", "lineage.json"), '{"new":true}\n');

  const subdir = join(repo, "docs");
  const candidate = join(base, "candidate-subdir");
  const output = runCli(subdir, ["package", "--repo-root", repo, candidate, "docs/themes"]);
  expect(output).toContain("packaged 1 generated file");
  expect(readFileSync(join(candidate, "docs/themes/new/lineage.json"), "utf-8")).toContain("new");
});

it("promote subcommand prints source_sha and changed, and appends to GITHUB_OUTPUT", () => {
  const remote = join(base, "remote.git");
  mkdirSync(remote);
  runGit(remote, ["init", "--bare", "--initial-branch=develop"]);
  const checkout = join(base, "checkout");
  mkdirSync(checkout);
  runGit(checkout, ["init", "--initial-branch=develop"]);
  runGit(checkout, ["remote", "add", "origin", remote]);
  mkdirSync(join(checkout, "docs", "themes"), { recursive: true });
  writeFileSync(join(checkout, "docs", "themes", "manifest.json"), "{}\n");
  runGit(checkout, ["add", "."]);
  runGit(checkout, ["commit", "-m", "seed"]);
  runGit(checkout, ["push", "-u", "origin", "develop"]);
  const baseSha = runGit(checkout, ["rev-parse", "HEAD"]);

  const candidate = join(base, "candidate");
  mkdirSync(join(candidate, "docs", "themes", "new-theme"), { recursive: true });
  writeFileSync(join(candidate, "docs", "themes", "new-theme", "lineage.json"), "{}\n");

  const githubOutput = join(base, "github-output.txt");
  writeFileSync(githubOutput, "");

  const output = runCli(
    checkout,
    ["promote", "test-only", candidate, "data(test): cli promote", "docs/themes"],
    {
      PAPERPILOT_PROMOTION_TEST_MODE: "1",
      PROMOTE_NO_SLEEP: "1",
      PROMOTE_MAX_ATTEMPTS: "2",
      PROMOTE_BASE_SHA: baseSha,
      GITHUB_OUTPUT: githubOutput,
    },
  );
  expect(output).toContain("source_sha=");
  expect(output).toContain("changed=true");
  expect(readFileSync(githubOutput, "utf-8")).toContain("changed=true");
}, 30_000); // real tsx subprocess + a worktree-based promotion; the 5s default can flake under load

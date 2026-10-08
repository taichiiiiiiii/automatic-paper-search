/**
 * TS port of `paperpilot/tests/test_package_generated_candidate_sh.py`.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createGitAdapter, git } from "../../src/release/git/gitAdapter.js";
import { packageCandidate } from "../../src/release/packageCandidate.js";

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

let base: string;
let repo: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperpilot-package-"));
  repo = join(base, "repo");
  mkdirSync(repo);
  gitRun(repo, ["init", "--initial-branch=develop"]);
  mkdirSync(join(repo, "docs", "themes", "old"), { recursive: true });
  writeFileSync(join(repo, "docs", "themes", "old", "lineage.json"), '{"old":true}\n');
  writeFileSync(join(repo, "README.md"), "baseline\n");
  gitRun(repo, ["add", "."]);
  gitRun(repo, ["commit", "-m", "seed"]);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

it("packages only changed files below the included paths", () => {
  writeFileSync(join(repo, "docs", "themes", "old", "lineage.json"), '{"old":false}\n');
  mkdirSync(join(repo, "docs", "themes", "new"), { recursive: true });
  writeFileSync(join(repo, "docs", "themes", "new", "lineage.json"), '{"new":true}\n');
  writeFileSync(join(repo, "README.md"), "must not be packaged\n");
  const destination = join(base, "candidate");

  const result = packageCandidate({
    candidateDir: destination,
    includedPaths: ["docs/themes"],
    git: adapter,
    repoRoot: repo,
  });

  expect(result.copied).toBeGreaterThan(0);
  expect(existsSync(join(destination, "docs/themes/old/lineage.json"))).toBe(true);
  expect(existsSync(join(destination, "docs/themes/new/lineage.json"))).toBe(true);
  expect(existsSync(join(destination, "README.md"))).toBe(false);
});

it("rejects a symlink candidate", () => {
  symlinkSync("/etc/passwd", join(repo, "docs", "themes", "escape"));

  expect(() =>
    packageCandidate({
      candidateDir: join(base, "candidate"),
      includedPaths: ["docs/themes"],
      git: adapter,
      repoRoot: repo,
    }),
  ).toThrow(/symlink/i);
});

it("fails when no included file changed", () => {
  writeFileSync(join(repo, "README.md"), "outside allowlist\n");

  expect(() =>
    packageCandidate({
      candidateDir: join(base, "candidate"),
      includedPaths: ["docs/themes"],
      git: adapter,
      repoRoot: repo,
    }),
  ).toThrow(/no generated candidate files changed/);
});

it("snapshot mode preserves exactly the unchanged subtree given", () => {
  mkdirSync(join(repo, "docs", "themes", "other"), { recursive: true });
  writeFileSync(join(repo, "docs", "themes", "other", "lineage.json"), '{"other":true}\n');
  const destination = join(base, "candidate");

  const result = packageCandidate({
    candidateDir: destination,
    includedPaths: ["docs/themes/old"],
    git: adapter,
    repoRoot: repo,
    snapshotMode: true,
  });

  expect(result.copied).toBeGreaterThan(0);
  expect(existsSync(join(destination, "docs/themes/old/lineage.json"))).toBe(true);
  expect(existsSync(join(destination, "docs/themes/other"))).toBe(false);
});

it("rejects an included path outside the repository", () => {
  expect(() =>
    packageCandidate({
      candidateDir: join(base, "candidate"),
      includedPaths: ["../etc"],
      git: adapter,
      repoRoot: repo,
    }),
  ).toThrow(/invalid included path/);
});

it("rejects a candidate directory inside the repository", () => {
  expect(() =>
    packageCandidate({
      candidateDir: join(repo, "candidate"),
      includedPaths: ["docs/themes"],
      git: adapter,
      repoRoot: repo,
    }),
  ).toThrow(/outside the repository/);
});

it("copied file content matches the source exactly", () => {
  mkdirSync(join(repo, "docs", "themes", "new"), { recursive: true });
  writeFileSync(join(repo, "docs", "themes", "new", "lineage.json"), '{"new":true}\n');
  const destination = join(base, "candidate");

  packageCandidate({
    candidateDir: destination,
    includedPaths: ["docs/themes"],
    git: adapter,
    repoRoot: repo,
  });

  expect(readFileSync(join(destination, "docs/themes/new/lineage.json"), "utf-8")).toBe(
    '{"new":true}\n',
  );
});

#!/usr/bin/env node
/**
 * `dataMove rehearse` (p5-plan.md §5.3 "Rehearse ... on a throwaway local
 * branch from current develop, then run the full suite, web build,
 * `validate bundle` and `verify`. Repeat as often as needed, offline."):
 * runs that whole clone -> install -> apply -> verify -> build -> test
 * -> no-skip gate sequence in one shot (the test and gate steps are the
 * exact release-validate commands, review round 2 N1), inside a fresh temp directory, and exits non-zero
 * the instant any step fails. This is the automated form of the manual
 * loop the plan's own P1/P2 checkpoints (§6.2) describe by hand, wrapped
 * so CI (the `p5-rehearsal` job in `ts-ci.yml`, feat-branch only, no
 * secrets) and a developer's local rerun don't each have to remember —
 * and keep in sync — the exact command order.
 *
 * Step order deliberately differs from a literal "clone, then install,
 * then test, then build" reading, in two ways:
 *
 *  1. {@link rehearseSteps} runs `pnpm install` BEFORE `cli.ts apply`,
 *     because `apply` imports `@paperpilot/core/layout` (through
 *     `rules.ts`), which needs the workspace's `node_modules` already
 *     linked to resolve at all. Nothing `apply` touches (`package.json`,
 *     `pnpm-lock.yaml`, `apps/*`, `packages/*`) is itself moved or
 *     edited by the data move, so installing first is safe, and
 *     `--offline --frozen-lockfile` only works because the caller's own
 *     earlier `pnpm install --frozen-lockfile` (a CI job's setup step,
 *     or a developer's existing checkout) has already warmed the local
 *     store this clone shares.
 *  2. The web build runs BEFORE `pnpm -r test`, matching
 *     `.github/workflows/ts-ci.yml`'s own order (its "Build web" step
 *     comment: "Before the tests: the web contract tests (CSP, paper-links
 *     parity, lineage routes, sitemap) read the built apps/web/out").
 *     Running `pnpm -r test` first would fail those same apps/web tests
 *     on a fresh clone with no prior build -- not a p5 bug, just a
 *     missing `apps/web/out`.
 *
 * Usage: `tsx rehearse.ts [--repo <path>] [--keep]`. `--repo` (default:
 * `process.cwd()`) is the git repository/worktree to clone FROM — this
 * tool only ever reads it (`git clone --no-hardlinks`) and never mutates
 * it. `--keep` leaves the temp clone on disk for post-mortem inspection
 * (default: removed on exit, success or failure).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOrExit } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import { createGitAdapter, git } from "../git/gitAdapter.js";

/** One shell-free command, as an argv array (never a shell string). */
export type Command = readonly string[];

const CONFIRM_DELETE_PATH = "docs/daily/papers.json";
/** Same file name `.github/workflows-p5/pages-release.yml` uses for the release no-skip gate. */
export const VITEST_REPORT_NAME = ".vitest-release-report.json";
const WORKSPACE_GROUPS = ["apps", "packages"] as const;
const REHEARSAL_COMMIT_MESSAGE = "p5 rehearsal: apply data move (scratch commit, never pushed)";

/**
 * The ordered command table run inside the fresh clone at `clonePath`.
 * Pure (no spawning) so it is unit-testable on its own — see this
 * module's test file — independent of the slow, real-process-spawning
 * orchestration in {@link runRehearsal}.
 */
export function rehearseSteps(
  clonePath: string,
  testPackageDirs: readonly string[],
): readonly Command[] {
  if (testPackageDirs.length === 0) {
    throw new Error(
      "rehearse: no workspace package with a test script (the no-skip gate would check nothing)",
    );
  }
  return [
    ["pnpm", "install", "--offline", "--frozen-lockfile"],
    [
      "pnpm",
      "exec",
      "tsx",
      "apps/pipeline/src/release/dataMove/cli.ts",
      "apply",
      "--confirm-delete",
      CONFIRM_DELETE_PATH,
    ],
    [
      "git",
      "-C",
      clonePath,
      "-c",
      "user.name=p5-rehearsal",
      "-c",
      "user.email=p5-rehearsal@local",
      "commit",
      "-q",
      "-m",
      REHEARSAL_COMMIT_MESSAGE,
    ],
    [
      "pnpm",
      "exec",
      "tsx",
      "apps/pipeline/src/release/dataMove/cli.ts",
      "verify",
      "HEAD~1",
      "HEAD",
    ],
    ["pnpm", "--filter", "@paperpilot/web", "build"],
    // The exact release-validate command (review N1): no literal `--`
    // (pnpm 10 forwards it and vitest 3 ignores every flag after it, so no
    // report was ever written), and the JSON reporter alongside the default
    // one. Each package writes its report into its own directory.
    [
      "pnpm",
      "-r",
      "--if-present",
      "test",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${VITEST_REPORT_NAME}`,
    ],
    // The real release gate, over one explicit report per package with a
    // test script — a package that wrote no report fails the gate (the
    // file cannot be read) instead of silently dropping out of a `find`.
    [
      "pnpm",
      "exec",
      "tsx",
      "apps/pipeline/src/release/cli.ts",
      "no-skip-gate",
      ...testPackageDirs.map((dir) => `${dir}/${VITEST_REPORT_NAME}`),
    ],
  ];
}

/**
 * The workspace packages (per `pnpm-workspace.yaml`'s `apps/*` and
 * `packages/*` globs) whose `package.json` has a `test` script — exactly
 * the set `pnpm -r --if-present test` runs, so exactly the set of reports
 * the gate must see. Sorted, repo-relative.
 */
export function findTestPackageDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const group of WORKSPACE_GROUPS) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir).sort()) {
      const manifest = join(groupDir, name, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf-8")) as {
        scripts?: Record<string, unknown>;
      };
      if (typeof pkg.scripts?.test === "string") dirs.push(`${group}/${name}`);
    }
  }
  return dirs;
}

export interface RehearsalOptions {
  readonly repo: string;
  readonly keep: boolean;
  /** Overridable for tests; defaults to a real `mkdtempSync`-based temp dir under the OS tmpdir. */
  readonly makeTempDir?: () => string;
  readonly spawn?: (argv: Command, options: { cwd: string }) => { exitCode: number };
  readonly log?: (line: string) => void;
  /** Overridable for tests (to simulate a cleanup failure); defaults to a real `rmSync`. */
  readonly removeDir?: (path: string) => void;
}

function defaultMakeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "paperpilot-p5-rehearsal-"));
}

function defaultSpawn(argv: Command, options: { cwd: string }): { exitCode: number } {
  const [command, ...args] = argv;
  if (command === undefined) {
    throw new Error("rehearse: empty command");
  }
  const proc = spawnSync(command, args, { cwd: options.cwd, stdio: "inherit", env: process.env });
  if (proc.error) throw proc.error;
  return { exitCode: proc.status ?? 1 };
}

/**
 * Runs the full rehearsal. Returns `0` on success, `1` on the first
 * failing step (clone, any {@link rehearseSteps} command, or cleanup).
 * Never throws for an ordinary step failure — only for a programming
 * error (e.g. git adapter misuse) — so {@link main} can map the return
 * value straight to `process.exitCode`.
 */
export function runRehearsal(options: RehearsalOptions): number {
  const log = options.log ?? ((line: string) => console.log(line));
  const spawn = options.spawn ?? defaultSpawn;
  const makeTempDir = options.makeTempDir ?? defaultMakeTempDir;
  const removeDir =
    options.removeDir ?? ((path: string) => rmSync(path, { recursive: true, force: true }));

  const workDir = makeTempDir();
  const clonePath = join(workDir, "clone");
  let stepsExitCode = 1;
  let cleanupFailed = false;
  try {
    stepsExitCode = runSteps(options.repo, clonePath, workDir, spawn, log);
  } finally {
    if (!options.keep) {
      try {
        removeDir(workDir);
      } catch (error) {
        // Review LOW: a cleanup failure used to be logged and then dropped
        // (the in-flight return value won). It now fails the rehearsal.
        log(`[rehearse] FAILED to clean up ${workDir}: ${String(error)}`);
        cleanupFailed = true;
      }
    } else {
      log(`[rehearse] kept temp dir: ${workDir}`);
    }
  }
  return cleanupFailed ? 1 : stepsExitCode;
}

function runSteps(
  repo: string,
  clonePath: string,
  workDir: string,
  spawn: NonNullable<RehearsalOptions["spawn"]>,
  log: (line: string) => void,
): number {
  log(`[rehearse] cloning ${repo} -> ${clonePath}`);
  const adapter = createGitAdapter();
  const cloneResult = adapter.run(workDir, ["clone", "--no-hardlinks", "--quiet", repo, clonePath]);
  if (cloneResult.exitCode !== 0) {
    log(`[rehearse] git clone failed: ${cloneResult.stderr || cloneResult.stdout}`);
    return 1;
  }
  const headSha = git(adapter, clonePath, ["rev-parse", "HEAD"]);
  log(`[rehearse] cloned HEAD ${headSha}`);

  const testPackageDirs = findTestPackageDirs(clonePath);
  if (testPackageDirs.length === 0) {
    log(
      "[rehearse] FAILED: no workspace package has a test script (the no-skip gate would check nothing)",
    );
    return 1;
  }
  log(`[rehearse] packages under the no-skip gate: ${testPackageDirs.join(", ")}`);
  for (const argv of rehearseSteps(clonePath, testPackageDirs)) {
    log(`[rehearse] $ ${argv.join(" ")}`);
    const result = spawn(argv, { cwd: clonePath });
    if (result.exitCode !== 0) {
      log(`[rehearse] FAILED (exit ${result.exitCode}): ${argv.join(" ")}`);
      return 1;
    }
  }
  log("[rehearse] all steps passed");
  return 0;
}

function main(): void {
  const flags = parseOrExit(
    process.argv.slice(2),
    {
      repo: { type: "string", default: process.cwd() },
      keep: { type: "boolean" },
    },
    "rehearse",
  );
  const code = runRehearsal({ repo: flags.repo as string, keep: flags.keep as boolean });
  process.exitCode = code;
}

if (isMain(import.meta.url)) {
  main();
}

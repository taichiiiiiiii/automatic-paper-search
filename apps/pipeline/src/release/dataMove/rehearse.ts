#!/usr/bin/env node
/**
 * `dataMove rehearse` (p5-plan.md §5.3 "Rehearse ... on a throwaway local
 * branch from current develop, then run the full suite, web build,
 * `validate bundle` and `verify`. Repeat as often as needed, offline."):
 * runs that whole clone -> install -> apply -> verify -> build -> test
 * sequence in one shot, inside a fresh temp directory, and exits non-zero
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOrExit } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import { createGitAdapter, git } from "../git/gitAdapter.js";

/** One shell-free command, as an argv array (never a shell string). */
export type Command = readonly string[];

const CONFIRM_DELETE_PATH = "docs/daily/papers.json";
const REHEARSAL_COMMIT_MESSAGE = "p5 rehearsal: apply data move (scratch commit, never pushed)";

/**
 * The ordered command table run inside the fresh clone at `clonePath`.
 * Pure (no spawning) so it is unit-testable on its own — see this
 * module's test file — independent of the slow, real-process-spawning
 * orchestration in {@link runRehearsal}.
 */
export function rehearseSteps(clonePath: string): readonly Command[] {
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
    ["pnpm", "-r", "--no-bail", "test"],
  ];
}

export interface RehearsalOptions {
  readonly repo: string;
  readonly keep: boolean;
  /** Overridable for tests; defaults to a real `mkdtempSync`-based temp dir under the OS tmpdir. */
  readonly makeTempDir?: () => string;
  readonly spawn?: (argv: Command, options: { cwd: string }) => { exitCode: number };
  readonly log?: (line: string) => void;
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

  const workDir = makeTempDir();
  const clonePath = join(workDir, "clone");
  let exitCode = 0;
  try {
    log(`[rehearse] cloning ${options.repo} -> ${clonePath}`);
    const adapter = createGitAdapter();
    const cloneResult = adapter.run(workDir, [
      "clone",
      "--no-hardlinks",
      "--quiet",
      options.repo,
      clonePath,
    ]);
    if (cloneResult.exitCode !== 0) {
      log(`[rehearse] git clone failed: ${cloneResult.stderr || cloneResult.stdout}`);
      return 1;
    }
    const headSha = git(adapter, clonePath, ["rev-parse", "HEAD"]);
    log(`[rehearse] cloned HEAD ${headSha}`);

    for (const argv of rehearseSteps(clonePath)) {
      log(`[rehearse] $ ${argv.join(" ")}`);
      const result = spawn(argv, { cwd: clonePath });
      if (result.exitCode !== 0) {
        log(`[rehearse] FAILED (exit ${result.exitCode}): ${argv.join(" ")}`);
        return 1;
      }
    }
    log("[rehearse] all steps passed");
    return 0;
  } finally {
    if (!options.keep) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch (error) {
        log(`[rehearse] warning: failed to clean up ${workDir}: ${String(error)}`);
        exitCode = exitCode || 1;
      }
    } else {
      log(`[rehearse] kept temp dir: ${workDir}`);
    }
  }
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

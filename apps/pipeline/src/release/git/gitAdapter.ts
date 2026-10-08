/**
 * Thin, injectable `git` CLI adapter for the Node release scripts.
 *
 * The promoter, packager, commit-and-push helper, and release validator
 * all shell out to real `git` subcommands exactly like their bash
 * originals; this module is the one seam between "call git" and "which
 * git binary/environment runs it", so a test can swap in a different
 * adapter if it ever needs to without touching the scripts themselves.
 * Tests in this change exercise the *real* adapter against throwaway
 * repositories created with `git init` in a temp dir (never a mock),
 * matching `paperpilot/tests/test_promote_generated_sh.py`'s fixture
 * pattern (`.../promotion_world`).
 *
 * Every call uses `execFileSync`/`spawnSync` with an argv array — never a
 * shell string — so a value that reaches here (a commit message, a path)
 * can never be reinterpreted by a shell (PUB-22).
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitAdapter {
  /** Run `git <args>` in `cwd`. Never throws on a non-zero exit — callers decide what that means. */
  run(
    cwd: string,
    args: readonly string[],
    options?: { env?: Record<string, string> },
  ): GitCommandResult;
}

function toResult(proc: SpawnSyncReturns<string>): GitCommandResult {
  if (proc.error) {
    throw proc.error;
  }
  return {
    exitCode: proc.status ?? 1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

/** Bounds a single `git` subcommand so a hung/stuck process cannot block the promoter forever. */
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/**
 * Real adapter: shells out to the `git` binary on `PATH`.
 *
 * `GIT_TERMINAL_PROMPT=0` (default, overridable via `options.env`) stops a
 * failed-auth `fetch`/`push` from blocking on an interactive username/
 * password prompt with no terminal attached — this process has no operator
 * to answer it, so a credential prompt must fail fast, not hang. `timeout`
 * bounds the subprocess itself for the same reason (a wedged network call
 * or git hook that never exits must not block the promoter indefinitely);
 * on timeout `spawnSync` sets `proc.error` (an `ETIMEDOUT`-shaped error),
 * which {@link toResult} rethrows.
 */
export function createGitAdapter(timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS): GitAdapter {
  return {
    run(cwd, args, options) {
      const proc = spawnSync("git", args as string[], {
        cwd,
        encoding: "utf-8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options?.env },
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      return toResult(proc);
    },
  };
}

/** Thrown by {@link git} when a git command that was expected to succeed did not. */
export class GitCommandError extends Error {
  constructor(
    public readonly args: readonly string[],
    public readonly result: GitCommandResult,
  ) {
    super(
      `git ${args.join(" ")} failed (${result.exitCode}): ${(result.stderr || result.stdout).trim()}`,
    );
    this.name = "GitCommandError";
  }
}

/** Run `git <args>`, throwing {@link GitCommandError} on a non-zero exit. Returns trimmed stdout. */
export function git(
  adapter: GitAdapter,
  cwd: string,
  args: readonly string[],
  options?: { env?: Record<string, string> },
): string {
  const result = adapter.run(cwd, args, options);
  if (result.exitCode !== 0) {
    throw new GitCommandError(args, result);
  }
  return result.stdout.trim();
}

/** Run `git <args>`, returning whether it succeeded (never throws). */
export function gitOk(adapter: GitAdapter, cwd: string, args: readonly string[]): boolean {
  return adapter.run(cwd, args).exitCode === 0;
}

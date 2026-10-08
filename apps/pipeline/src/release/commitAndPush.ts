/**
 * Commit staged changes and push to `origin/<branch>` with retry on race —
 * TS port of `.github/scripts/commit-and-push.sh`.
 *
 * Implements PUB-21..24 of `docs/migration/safety-contracts.md`. See the
 * shell original's header comment for why this exists: concurrent
 * `workflow_dispatch` runs that finish their compute phase within seconds
 * of each other race to push `develop`, and only one wins without this
 * retry loop.
 */

import { existsSync } from "node:fs";
import { type GitAdapter, git, gitOk } from "./git/gitAdapter.js";

export class CommitAndPushError extends Error {}

export interface CommitAndPushOptions {
  message: string;
  /** At least one path to `git add`. A missing path is skipped (not a hard failure, PUB-21). */
  stagePaths: string[];
  git: GitAdapter;
  cwd: string;
  branch?: string;
  maxAttempts?: number;
  noSleep?: boolean;
  /** Defaults to `fs.existsSync`; injectable for tests that want a fake filesystem. */
  exists?: (path: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Injected randomness for the jittered backoff, so a test can make it deterministic without `noSleep`. */
  random?: () => number;
}

export type CommitAndPushOutcome = { status: "noop" } | { status: "pushed"; attempts: number };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve a stage path relative to `cwd` for existence checks, matching the shell's `[ -e "$path" ]`. */
function resolveUnder(cwd: string, path: string): string {
  return path.startsWith("/") ? path : `${cwd}/${path}`;
}

/**
 * Stage `options.stagePaths`, commit if there is anything staged, then
 * push to `origin/<branch>` with a fetch + rebase --autostash + push retry
 * loop. Never force-pushes.
 */
export async function commitAndPush(options: CommitAndPushOptions): Promise<CommitAndPushOutcome> {
  if (options.stagePaths.length === 0) {
    throw new CommitAndPushError("commit-and-push: at least one stage path required");
  }
  const branch = options.branch ?? "develop";
  const maxAttempts = options.maxAttempts ?? 5;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const exists = options.exists ?? existsSync;

  // We intentionally do not `git add -A` so that untracked files outside
  // the stage paths never leak into the public repo. `git add -- <path>`
  // on a non-existent pathspec is skipped rather than a hard failure, so a
  // workflow whose previous step produced only a subset of the expected
  // paths still exits cleanly.
  let stagedAny = false;
  for (const path of options.stagePaths) {
    if (!exists(resolveUnder(options.cwd, path))) {
      continue;
    }
    git(options.git, options.cwd, ["add", "--", path]);
    stagedAny = true;
  }
  if (!stagedAny) {
    return { status: "noop" };
  }

  if (gitOk(options.git, options.cwd, ["diff", "--cached", "--quiet"])) {
    return { status: "noop" };
  }

  // Commit via argv, not a shell string: a payload like `"$(rm -rf /)"`
  // from an upstream input lands in the commit subject verbatim and never
  // reaches a shell (PUB-22).
  git(options.git, options.cwd, ["commit", "-m", options.message]);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const fetched = gitOk(options.git, options.cwd, ["fetch", "origin", branch]);
    const rebased =
      fetched && gitOk(options.git, options.cwd, ["rebase", "--autostash", `origin/${branch}`]);
    const pushed = rebased && gitOk(options.git, options.cwd, ["push", "origin", `HEAD:${branch}`]);
    if (pushed) {
      return { status: "pushed", attempts: attempt };
    }

    // Recover from a failed rebase so the next iteration starts clean.
    gitOk(options.git, options.cwd, ["rebase", "--abort"]);

    if (attempt === maxAttempts) {
      break;
    }
    if (!options.noSleep) {
      const delay = (attempt * 3 + Math.floor(random() * 5)) * 1000;
      await sleep(delay);
    }
  }

  throw new CommitAndPushError(
    `push failed after ${maxAttempts} attempts — see attempt logs above`,
  );
}

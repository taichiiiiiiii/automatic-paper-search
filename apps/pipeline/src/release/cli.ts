#!/usr/bin/env node
/**
 * CLI entry point for the Node release scripts — argv-compatible with the
 * four shell originals this change ports (`promote-generated.sh`,
 * `package-generated-candidate.sh`, `commit-and-push.sh`,
 * `validate-pages-release.sh`). Each subcommand is a thin translation
 * from argv/env into the corresponding library call; all the actual
 * behaviour lives in the sibling modules (`./promote.ts`,
 * `./packageCandidate.ts`, `./commitAndPush.ts`, `./validateRelease.ts`),
 * which is what the test suite exercises directly.
 *
 * Usage:
 *   tsx cli.ts promote <themes|conference|test-only> <candidate-dir> <commit-message> <allowed-path>...
 *   tsx cli.ts package <candidate-dir> <included-path>...
 *   tsx cli.ts commit-push "<message>" <stage-path>...
 *   tsx cli.ts validate local <source-sha> <docs-root>
 *   tsx cli.ts validate smoke <page-url> <source-sha>
 */

import { appendFileSync } from "node:fs";
import { isMain } from "../shared/cli/isMain.js";
import { commitAndPush } from "./commitAndPush.js";
import { createGitAdapter } from "./git/gitAdapter.js";
import { packageCandidate } from "./packageCandidate.js";
import { type PromotionKind, promote } from "./promote.js";
import { smokeRemote, validateLocal } from "./validateRelease.js";

function die(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

/**
 * M3 of the P4 review: validates an optional positive-integer env var
 * the same way `promote-generated.sh` validates `PROMOTE_MAX_ATTEMPTS`
 * (`[[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] || die ...`) — no leading
 * zero, no sign, no decimal, at least 1. `commit-and-push.sh` never
 * actually validates `COMMIT_PUSH_MAX_ATTEMPTS` at all (it's used
 * unchecked in a bash `for` loop), but an unvalidated attempt count that
 * reaches `commitAndPush`/`promote` as `0`/negative/`NaN` would silently
 * skip every retry or loop forever depending on the caller, so this
 * applies the same regex to both env vars rather than reproducing that
 * gap.
 */
function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    die(`${name} must be positive`);
  }
  return Number.parseInt(raw, 10);
}

function emitPromoteOutputs(sourceSha: string, changed: boolean): void {
  const text = `source_sha=${sourceSha}\nchanged=${changed}\n`;
  process.stdout.write(text);
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, text);
  }
}

async function runPromote(args: string[]): Promise<void> {
  if (args.length < 4) {
    die(
      "usage: promote <themes|conference|test-only> <candidate-dir> <commit-message> <allowed-path>...",
    );
  }
  const [kind, candidateDir, commitMessage, ...allowedPaths] = args as [
    string,
    string,
    string,
    ...string[],
  ];
  const git = createGitAdapter();
  const result = await promote({
    kind: kind as PromotionKind,
    candidateDir,
    commitMessage,
    allowedPaths,
    git,
    cwd: process.cwd(),
    promoteAsOf: process.env.PROMOTE_AS_OF,
    promoteBaseSha: process.env.PROMOTE_BASE_SHA,
    promoteMaxAttempts: positiveIntEnv("PROMOTE_MAX_ATTEMPTS"),
    promoteNoSleep: process.env.PROMOTE_NO_SLEEP === "1",
    promotionTestMode: process.env.PAPERPILOT_PROMOTION_TEST_MODE === "1",
  });
  emitPromoteOutputs(result.sourceSha, result.changed);
}

/**
 * `packageCandidate` resolves every included path, and runs every `git`
 * command, against `repoRoot` — unlike `promote`/`commit-push` (which pass
 * their own `cwd` straight through to `git` for commands that don't care
 * where the repo root actually is), a WRONG repo root here does not fail
 * loudly: `git diff`/`ls-files` would just report paths relative to
 * whatever directory this was invoked from, and the packager would copy
 * the wrong files (or silently nothing) rather than error. An explicit
 * `--repo-root <path>` makes this overridable/testable instead of always
 * trusting `process.cwd()` to already be the repo root.
 */
function extractRepoRootOverride(argv: readonly string[]): { rest: string[]; repoRoot: string } {
  let repoRoot: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo-root") {
      repoRoot = argv[++i];
    } else {
      rest.push(argv[i] as string);
    }
  }
  return { rest, repoRoot: repoRoot ?? process.cwd() };
}

/**
 * M3: `package-generated-candidate.sh` requires the exact string `"0"`
 * or `"1"` (`[[ "$snapshot_mode" == "0" || "$snapshot_mode" == "1" ]] ||
 * die ...`) — anything else (e.g. `"true"`, `"2"`, a typo) dies, it does
 * not silently fall back to `false` the way `=== "1"` alone would.
 */
function packageIncludeUnchangedEnv(): boolean {
  const raw = process.env.PAPERPILOT_PACKAGE_INCLUDE_UNCHANGED;
  if (raw === undefined || raw === "0") return false;
  if (raw === "1") return true;
  die("PAPERPILOT_PACKAGE_INCLUDE_UNCHANGED must be 0 or 1");
}

/**
 * M3: `commit-and-push.sh` substitutes the default with `${COMMIT_PUSH_BRANCH:-develop}`,
 * which falls back on an EMPTY value too, not just an unset one — unlike
 * the `options.branch ?? "develop"` `??` in `commitAndPush.ts`, which
 * only falls back when the property is `undefined`. An explicitly empty
 * `COMMIT_PUSH_BRANCH=""` would otherwise reach `commitAndPush` as `""`
 * and build a bogus `origin/` ref instead of defaulting to `develop`.
 */
function commitPushBranchEnv(): string | undefined {
  const raw = process.env.COMMIT_PUSH_BRANCH;
  return raw === undefined || raw === "" ? undefined : raw;
}

async function runPackage(args: string[]): Promise<void> {
  const { rest, repoRoot } = extractRepoRootOverride(args);
  if (rest.length < 2) {
    die("usage: package [--repo-root <path>] <candidate-dir> <included-path>...");
  }
  const [candidateDir, ...includedPaths] = rest as [string, ...string[]];
  const git = createGitAdapter();
  const result = packageCandidate({
    candidateDir,
    includedPaths,
    git,
    repoRoot,
    snapshotMode: packageIncludeUnchangedEnv(),
  });
  console.log(`packaged ${result.copied} generated file(s) in ${candidateDir}`);
}

async function runCommitPush(args: string[]): Promise<void> {
  if (args.length < 2) {
    die('usage: commit-push "<message>" <stage-path>...');
  }
  const [message, ...stagePaths] = args as [string, ...string[]];
  const git = createGitAdapter();
  const outcome = await commitAndPush({
    message,
    stagePaths,
    git,
    cwd: process.cwd(),
    branch: commitPushBranchEnv(),
    maxAttempts: positiveIntEnv("COMMIT_PUSH_MAX_ATTEMPTS"),
    noSleep: process.env.COMMIT_PUSH_NO_SLEEP === "1",
  });
  if (outcome.status === "noop") {
    console.log("nothing changed — skipping commit");
  } else {
    console.log(`push succeeded on attempt ${outcome.attempts}`);
  }
}

async function runValidate(args: string[]): Promise<void> {
  const [mode, ...rest] = args;
  if (mode === "local") {
    if (rest.length !== 2) die("usage: validate local <source-sha> <docs-root>");
    const [sha, docsRoot] = rest as [string, string];
    const git = createGitAdapter();
    const actualHeadSha = git.run(docsRoot, ["rev-parse", "HEAD"]).stdout.trim();
    validateLocal({ expectedSha: sha, docsRoot, actualHeadSha });
    console.log(`local Pages bundle at ${docsRoot} validated against ${sha}`);
  } else if (mode === "smoke") {
    if (rest.length !== 2) die("usage: validate smoke <page-url> <source-sha>");
    const [pageUrl, sha] = rest as [string, string];
    const result = await smokeRemote({ baseUrl: pageUrl, expectedSha: sha, fetchImpl: fetch });
    console.log(`smoke-tested ${result.routes.length + 1} route(s) at ${pageUrl}`);
  } else {
    die("usage: validate {local <source-sha> <docs-root>|smoke <page-url> <source-sha>}");
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    switch (command) {
      case "promote":
        await runPromote(rest);
        break;
      case "package":
        await runPackage(rest);
        break;
      case "commit-push":
        await runCommitPush(rest);
        break;
      case "validate":
        await runValidate(rest);
        break;
      default:
        die(
          "usage: cli.ts {promote|package|commit-push|validate} ...\n" +
            "  promote <themes|conference|test-only> <candidate-dir> <commit-message> <allowed-path>...\n" +
            "  package <candidate-dir> <included-path>...\n" +
            '  commit-push "<message>" <stage-path>...\n' +
            "  validate local <source-sha> <docs-root>\n" +
            "  validate smoke <page-url> <source-sha>",
        );
    }
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
}

if (isMain(import.meta.url)) {
  void main();
}

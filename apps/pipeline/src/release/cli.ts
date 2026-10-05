#!/usr/bin/env node
/**
 * CLI entry point for the Node release scripts — argv-compatible with the
 * shell originals this change ports (`promote-generated.sh`,
 * `package-generated-candidate.sh`, `commit-and-push.sh`,
 * `validate-pages-release.sh`), plus the p5-plan.md §2 A4 extensions
 * (`validate bundle`, `marker`, the `validate smoke` flags, `cf-
 * deployment-id`, `cf-rollback`, `gh-record`, `no-skip-gate`). Each
 * subcommand is a thin translation from argv/env into the corresponding
 * library call; all the actual behaviour lives in the sibling modules
 * (`./promote.ts`, `./promoteHooks.ts`, `./packageCandidate.ts`,
 * `./commitAndPush.ts`, `./validateRelease.ts`, `./marker.ts`,
 * `./cloudflare/pagesApi.ts`, `./github/deploymentRecord.ts`,
 * `./noSkipGate.ts`), which is what the test suite exercises directly.
 *
 * Usage:
 *   tsx cli.ts promote <themes|conference|test-only> <candidate-dir> <commit-message> <allowed-path>...
 *   tsx cli.ts package <candidate-dir> <included-path>...
 *   tsx cli.ts commit-push "<message>" <stage-path>...
 *   tsx cli.ts validate bundle <out-dir>
 *   tsx cli.ts validate local <source-sha> <docs-root>
 *   tsx cli.ts validate smoke <page-url> <source-sha> [--wait-marker <seconds>] [--expect-bytes <out-dir>] [--expect-404 <path>]... [--expect-redirect <from>=<to>]...
 *   tsx cli.ts marker <out-dir>                      (env SOURCE_SHA, RELEASE_KIND, REQUEST_ID)
 *   tsx cli.ts cf-deployment-id                      (env CF_API_TOKEN, CF_ACCOUNT_ID, CF_PROJECT, SOURCE_SHA)
 *   tsx cli.ts cf-rollback <deployment-id>           (env CF_API_TOKEN, CF_ACCOUNT_ID, CF_PROJECT)
 *   tsx cli.ts cf-verify-deployment <deployment-id> <expected-sha>  (env CF_API_TOKEN, CF_ACCOUNT_ID, CF_PROJECT)
 *   tsx cli.ts gh-record                             (env GITHUB_TOKEN, GITHUB_REPOSITORY, SOURCE_SHA, CF_DEPLOYMENT_ID, RELEASE_KIND, REQUEST_ID, ARTIFACT_NAME)
 *   tsx cli.ts no-skip-gate <vitest-json-report>...
 */

import { appendFileSync } from "node:fs";
import { PUBLIC_ORIGIN } from "@paperpilot/core/site";
import { CliUsageError, parseArgs as parseFlags } from "../shared/cli/argparse.js";
import { isMain } from "../shared/cli/isMain.js";
import {
  type CfFetchFn,
  getDeploymentCommitHash,
  getProductionDeploymentId,
  rollbackDeployment,
} from "./cloudflare/pagesApi.js";
import { commitAndPush } from "./commitAndPush.js";
import { createGitAdapter } from "./git/gitAdapter.js";
import { type GhFetchFn, recordDeployment } from "./github/deploymentRecord.js";
import { writeMarker } from "./marker.js";
import { runNoSkipGate } from "./noSkipGate.js";
import { packageCandidate } from "./packageCandidate.js";
import { type PromotionKind, promote } from "./promote.js";
import { createRealSpawn, createRefreshHook, createValidateHook } from "./promoteHooks.js";
import { smokeRemote, validateBundle, validateLocal } from "./validateRelease.js";

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
  // p5-plan.md §2 A3 / §3: the promoter hooks spawn the PROMOTED TREE's
  // own CLIs (cwd = tree), never run in-process against this job's
  // checkout -- see promoteHooks.ts's module doc comment. `promote.ts`
  // itself keeps its throwing defaults for library callers that don't
  // pass hooks (docs/migration/p4-followups.md #3).
  const spawn = createRealSpawn();
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
    refreshSharedOutputs: createRefreshHook(spawn),
    validatePromotedTree: createValidateHook(spawn),
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

/** `<from>=<to>` -> `{from, to}` (p5-plan.md §2 A4 `--expect-redirect`). */
function parseExpectRedirect(raw: string): { from: string; to: string } {
  const eq = raw.indexOf("=");
  if (eq < 0) {
    die(`--expect-redirect must be <from>=<to>, got ${JSON.stringify(raw)}`);
  }
  return { from: raw.slice(0, eq), to: raw.slice(eq + 1) };
}

async function runValidate(args: string[]): Promise<void> {
  const [mode, ...rest] = args;
  if (mode === "bundle") {
    if (rest.length !== 1) die("usage: validate bundle <out-dir>");
    const [outDir] = rest as [string];
    validateBundle({ docsRoot: outDir });
    console.log(`bundle at ${outDir} validated`);
  } else if (mode === "local") {
    if (rest.length !== 2) die("usage: validate local <source-sha> <docs-root>");
    const [sha, docsRoot] = rest as [string, string];
    const git = createGitAdapter();
    const actualHeadSha = git.run(docsRoot, ["rev-parse", "HEAD"]).stdout.trim();
    validateLocal({ expectedSha: sha, docsRoot, actualHeadSha });
    console.log(`local Pages bundle at ${docsRoot} validated against ${sha}`);
  } else if (mode === "smoke") {
    if (rest.length < 2) {
      die(
        "usage: validate smoke <page-url> <source-sha> [--wait-marker <seconds>] " +
          "[--expect-bytes <out-dir>] [--expect-404 <path>]... [--expect-redirect <from>=<to>]...",
      );
    }
    const [pageUrl, sha, ...flagArgs] = rest as [string, string, ...string[]];
    let parsed: Record<string, unknown>;
    try {
      parsed = parseFlags(flagArgs, {
        "wait-marker": { type: "int" },
        "expect-bytes": { type: "string" },
        "expect-404": { type: "repeated-string" },
        "expect-redirect": { type: "repeated-string" },
      });
    } catch (e) {
      if (e instanceof CliUsageError) die(e.message);
      throw e;
    }
    const result = await smokeRemote({
      baseUrl: pageUrl,
      expectedSha: sha,
      fetchImpl: fetch,
      waitMarkerSeconds: parsed["wait-marker"] as number | undefined,
      expectBytesDir: parsed["expect-bytes"] as string | undefined,
      expect404Paths: parsed["expect-404"] as string[],
      expectRedirects: (parsed["expect-redirect"] as string[]).map(parseExpectRedirect),
    });
    console.log(`smoke-tested ${result.routes.length + 1} route(s) at ${pageUrl}`);
  } else {
    die(
      "usage: validate {bundle <out-dir>|local <source-sha> <docs-root>|smoke <page-url> <source-sha> ...}",
    );
  }
}

/**
 * A missing/empty required env var dies loudly (never silently reaches
 * `recordDeployment`/`getProductionDeploymentId`/etc. as `undefined` and
 * gets stringified into a URL or payload as `"undefined"`).
 */
function requiredEnv(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    die(`${name} is required`);
  }
  return raw as string;
}

const SOURCE_SHA_RE = /^[0-9a-f]{40}$/;

function requiredShaEnv(name: string): string {
  const raw = requiredEnv(name);
  if (!SOURCE_SHA_RE.test(raw)) {
    die(`${name} must be 40 lowercase hex characters`);
  }
  return raw;
}

/** Real fetch, narrowed to the shape `pagesApi.ts` needs — see its own module doc comment re: never printing `apiToken`. */
const cfFetch: CfFetchFn = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, json: () => response.json() };
};

/** Real fetch, narrowed to the shape `deploymentRecord.ts` needs. */
const ghFetch: GhFetchFn = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, text: () => response.text() };
};

async function runMarker(args: string[]): Promise<void> {
  if (args.length !== 1) die("usage: marker <out-dir>");
  const [outDir] = args as [string];
  const path = writeMarker({
    outDir,
    sourceSha: process.env.SOURCE_SHA ?? "",
    releaseKind: process.env.RELEASE_KIND ?? "",
    requestId: process.env.REQUEST_ID ?? "",
  });
  console.log(`wrote ${path}`);
}

function emitKeyValueOutputs(pairs: Record<string, string>): void {
  const text = `${Object.entries(pairs)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
  process.stdout.write(text);
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, text);
  }
}

async function runCfDeploymentId(): Promise<void> {
  const result = await getProductionDeploymentId({
    fetchImpl: cfFetch,
    accountId: requiredEnv("CF_ACCOUNT_ID"),
    project: requiredEnv("CF_PROJECT"),
    apiToken: requiredEnv("CF_API_TOKEN"),
    sourceSha: requiredShaEnv("SOURCE_SHA"),
  });
  emitKeyValueOutputs({
    cf_deployment_id: result.deploymentId,
    deployment_url: result.deploymentUrl,
  });
}

async function runCfRollback(args: string[]): Promise<void> {
  if (args.length !== 1) die("usage: cf-rollback <deployment-id>");
  const [deploymentId] = args as [string];
  const result = await rollbackDeployment({
    fetchImpl: cfFetch,
    accountId: requiredEnv("CF_ACCOUNT_ID"),
    project: requiredEnv("CF_PROJECT"),
    apiToken: requiredEnv("CF_API_TOKEN"),
    deploymentId,
  });
  emitKeyValueOutputs({ cf_deployment_id: result.deploymentId });
}

/**
 * `cf-verify-deployment` (M2 of the P5 tier-A review): confirms a
 * deployment id's own recorded `commit_hash` equals the SHA the caller
 * is about to roll back to, BEFORE pages-rollback.yml's `rollback` job
 * POSTs `.../rollback` against it. Dies (never silently proceeds) on any
 * mismatch or malformed input.
 */
async function runCfVerifyDeployment(args: string[]): Promise<void> {
  if (args.length !== 2) die("usage: cf-verify-deployment <deployment-id> <expected-sha>");
  const [deploymentId, expectedSha] = args as [string, string];
  if (!SOURCE_SHA_RE.test(expectedSha)) {
    die("expected-sha must be 40 lowercase hex characters");
  }
  const commitHash = await getDeploymentCommitHash({
    fetchImpl: cfFetch,
    accountId: requiredEnv("CF_ACCOUNT_ID"),
    project: requiredEnv("CF_PROJECT"),
    apiToken: requiredEnv("CF_API_TOKEN"),
    deploymentId,
  });
  if (commitHash !== expectedSha) {
    die(
      `Cloudflare deployment ${deploymentId} commit_hash ${commitHash} does not match expected ${expectedSha}`,
    );
  }
  console.log(`verified Cloudflare deployment ${deploymentId} matches ${expectedSha}`);
}

async function runGhRecord(): Promise<void> {
  const releaseKind = requiredEnv("RELEASE_KIND");
  if (releaseKind !== "normal" && releaseKind !== "rollback") {
    die("RELEASE_KIND must be normal or rollback");
  }
  const requestIdRaw = process.env.REQUEST_ID ?? "";
  const result = await recordDeployment({
    fetchImpl: ghFetch,
    token: requiredEnv("GITHUB_TOKEN"),
    repo: requiredEnv("GITHUB_REPOSITORY"),
    sourceSha: requiredShaEnv("SOURCE_SHA"),
    cfDeploymentId: requiredEnv("CF_DEPLOYMENT_ID"),
    releaseKind,
    requestId: requestIdRaw === "" ? null : requestIdRaw,
    artifactName: requiredEnv("ARTIFACT_NAME"),
    environmentUrl: PUBLIC_ORIGIN,
  });
  console.log(`recorded GitHub deployment ${result.deploymentId}`);
}

async function runNoSkipGateCommand(args: string[]): Promise<void> {
  runNoSkipGate(args);
  console.log(`no-skip-gate: ${args.length} report(s) clean (no skip/todo/pending)`);
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
      case "marker":
        await runMarker(rest);
        break;
      case "cf-deployment-id":
        await runCfDeploymentId();
        break;
      case "cf-rollback":
        await runCfRollback(rest);
        break;
      case "cf-verify-deployment":
        await runCfVerifyDeployment(rest);
        break;
      case "gh-record":
        await runGhRecord();
        break;
      case "no-skip-gate":
        await runNoSkipGateCommand(rest);
        break;
      default:
        die(
          "usage: cli.ts {promote|package|commit-push|validate|marker|cf-deployment-id|cf-rollback|cf-verify-deployment|gh-record|no-skip-gate} ...\n" +
            "  promote <themes|conference|test-only> <candidate-dir> <commit-message> <allowed-path>...\n" +
            "  package <candidate-dir> <included-path>...\n" +
            '  commit-push "<message>" <stage-path>...\n' +
            "  validate bundle <out-dir>\n" +
            "  validate local <source-sha> <docs-root>\n" +
            "  validate smoke <page-url> <source-sha> [--wait-marker <seconds>] [--expect-bytes <out-dir>] [--expect-404 <path>]... [--expect-redirect <from>=<to>]...\n" +
            "  marker <out-dir>\n" +
            "  cf-deployment-id\n" +
            "  cf-rollback <deployment-id>\n" +
            "  cf-verify-deployment <deployment-id> <expected-sha>\n" +
            "  gh-record\n" +
            "  no-skip-gate <vitest-json-report>...",
        );
    }
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
}

if (isMain(import.meta.url)) {
  void main();
}

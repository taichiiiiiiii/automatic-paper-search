#!/usr/bin/env node
/**
 * CLI entry point for {@link buildIdentityLite} — TS port of
 * `build_identity_lite.py`'s `main()` (`--docs-root`, `--coverage-path`,
 * `--as-of`, `--check`, `--report-only`). p5-plan.md §2 A2: "identity-lite:
 * `release/derived/identityLite.ts` has no CLI" — this file did not exist
 * at all before this change. Writes `identity-aliases-v1.json` (and each
 * conference's enriched `papers.json`) to `layout.published`, and
 * `identity-coverage-v1.json` to `layout.state` (via the
 * `identityCoverage()` layout helper) — matching §3's refresh-order table
 * row 2 ("`src/release/derived/identityLiteCli.ts --as-of $AS_OF`").
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { identityCoverage, layoutFor } from "@paperpilot/core/layout";
import { CliUsageError, parseArgs as parseFlags } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import { buildIdentityLite, loadConferenceNames } from "./identityLite.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/release/derived -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export function defaultDocsRoot(repoRoot: string = DEFAULT_REPO_ROOT): string {
  return layoutFor(repoRoot).published;
}

export function defaultCoveragePath(repoRoot: string = DEFAULT_REPO_ROOT): string {
  return identityCoverage(layoutFor(repoRoot));
}

export interface IdentityLiteCliArgs {
  docsRoot: string;
  coveragePath: string;
  asOf: string;
  check: boolean;
  reportOnly: boolean;
}

/** Mirrors `build_identity_lite.py`'s argparse flags through the shared
 * strict parser. `--as-of` is required (Python: `required=True`). */
export function parseIdentityLiteCliArgs(
  argv: readonly string[],
  repoRoot: string = DEFAULT_REPO_ROOT,
): IdentityLiteCliArgs {
  const parsed = parseFlags(argv, {
    "docs-root": { type: "string", default: defaultDocsRoot(repoRoot) },
    "coverage-path": { type: "string", default: defaultCoveragePath(repoRoot) },
    "as-of": { type: "string", required: true },
    check: { type: "boolean" },
    "report-only": { type: "boolean" },
  });
  return {
    docsRoot: parsed["docs-root"] as string,
    coveragePath: parsed["coverage-path"] as string,
    asOf: parsed["as-of"] as string,
    check: parsed.check as boolean,
    reportOnly: parsed["report-only"] as boolean,
  };
}

export interface IdentityLiteCliResult {
  exitCode: number;
  message: string;
}

/** Pure: runs the projection/gate/write for already-parsed `args`.
 * Mirrors `build_identity_lite.py`'s `main()` body — any thrown error
 * (bad `--as-of`, a stale `--check`, the CAT-32 validity gate) maps to
 * exit 1 with the error's own message, matching Python's bare
 * `raise SystemExit(str(exc))`. */
export function runIdentityLiteCliArgs(args: IdentityLiteCliArgs): IdentityLiteCliResult {
  try {
    const conferenceNames = loadConferenceNames(args.docsRoot);
    const projection = buildIdentityLite({
      docsRoot: args.docsRoot,
      conferenceNames,
      asOf: args.asOf,
      coveragePath: args.coveragePath,
      check: args.check,
      reportOnly: args.reportOnly,
    });
    const pct = (projection.coverage.coverage * 100).toFixed(1);
    const lines = [
      `coverage: ${pct}% (${projection.coverage.resolved_rows}/${projection.coverage.input_rows} rows)`,
      `valid: ${projection.coverage.valid}`,
      `aliases: ${projection.aliases.length}`,
    ];
    return { exitCode: 0, message: lines.join("\n") };
  } catch (e) {
    return { exitCode: 1, message: `error: ${(e as Error).message}` };
  }
}

export const HELP_TEXT = `usage: build_identity_lite [--docs-root DIR] [--coverage-path FILE] --as-of ISO8601 [--check] [--report-only]`;

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/** argv -> process exit code, matching every other CLI's shape in this
 * package (`searchIndexCli.ts`'s `runSearchIndexCli`). */
export function runIdentityLiteCli(
  argv: readonly string[],
  repoRoot: string = DEFAULT_REPO_ROOT,
): number {
  if (isHelpRequest(argv)) {
    console.log(HELP_TEXT);
    return 0;
  }
  let args: IdentityLiteCliArgs;
  try {
    args = parseIdentityLiteCliArgs(argv, repoRoot);
  } catch (e) {
    if (e instanceof CliUsageError) {
      process.stderr.write(`build_identity_lite: error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const result = runIdentityLiteCliArgs(args);
  if (result.exitCode === 0) {
    console.log(result.message);
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.exitCode;
}

if (isMain(import.meta.url)) {
  process.exitCode = runIdentityLiteCli(process.argv.slice(2));
}

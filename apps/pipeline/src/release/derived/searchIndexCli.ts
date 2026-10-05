/**
 * CLI entry point for {@link writeSearchIndexes} / {@link checkSearchIndexes}
 * — mirrors `paperpilot/scripts/build_search_index.py`'s `main()` flags
 * (`--docs-root`, `--check`). CAT-31: the Python script's `--check` mode
 * (raise if committed `search-index.json` / `search-index-v2.json` /
 * `search-paper-ids-v1/*.json` are stale) had no TS CLI wiring at all —
 * `checkSearchIndexes` existed in `./searchIndex.ts` but nothing called it
 * outside tests.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutFor } from "@paperpilot/core/layout";
import { CliUsageError, parseArgs as parseFlags } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import { checkSearchIndexes, writeSearchIndexes } from "./searchIndex.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/release/derived -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export interface SearchIndexCliArgs {
  docsRoot: string;
  check: boolean;
}

export function defaultDocsRoot(repoRoot: string = DEFAULT_REPO_ROOT): string {
  return layoutFor(repoRoot).published;
}

/**
 * Mirrors `build_search_index.py`'s argparse flags (`--docs-root`,
 * `--check`) through the shared strict parser.
 */
export function parseSearchIndexCliArgs(
  argv: readonly string[],
  repoRoot: string = DEFAULT_REPO_ROOT,
): SearchIndexCliArgs {
  const parsed = parseFlags(argv, {
    "docs-root": { type: "string", default: defaultDocsRoot(repoRoot) },
    check: { type: "boolean" },
  });
  return {
    docsRoot: parsed["docs-root"] as string,
    check: parsed.check as boolean,
  };
}

export interface SearchIndexCliResult {
  exitCode: number;
  message?: string;
}

/**
 * `--check`: raise (here, return a non-zero exit with a message) if the
 * committed indexes/blocks are stale, matching Python's
 * `raise SystemExit("...")` — a clean message, no write, no traceback.
 * Otherwise: write v1, blocks, v2, then prune (the non-`--check` body of
 * `main()`).
 */
export function runSearchIndexCliArgs(args: SearchIndexCliArgs): SearchIndexCliResult {
  if (args.check) {
    try {
      checkSearchIndexes(args.docsRoot);
    } catch (e) {
      return { exitCode: 1, message: (e as Error).message };
    }
    return { exitCode: 0, message: "Search indexes are current" };
  }

  const result = writeSearchIndexes(args.docsRoot);
  const lines = [
    `Wrote ${result.entries.length.toLocaleString()} entries -> ${result.outV1}`,
    `Wrote ${result.entriesV2.length.toLocaleString()} entries -> ${result.outV2}`,
    `Wrote ${result.idBlocks.length} canonical-ID blocks`,
  ];
  if (result.skipped) {
    lines.push(`  skipped ${result.skipped.toLocaleString()} row(s) with no title`);
  }
  return { exitCode: 0, message: lines.join("\n") };
}

export function runSearchIndexCli(
  argv: readonly string[],
  repoRoot: string = DEFAULT_REPO_ROOT,
): number {
  let args: SearchIndexCliArgs;
  try {
    args = parseSearchIndexCliArgs(argv, repoRoot);
  } catch (e) {
    if (e instanceof CliUsageError) {
      process.stderr.write(`build_search_index: error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const result = runSearchIndexCliArgs(args);
  if (result.message) {
    if (result.exitCode === 0) {
      console.log(result.message);
    } else {
      process.stderr.write(`${result.message}\n`);
    }
  }
  return result.exitCode;
}

if (isMain(import.meta.url)) {
  process.exitCode = runSearchIndexCli(process.argv.slice(2));
}

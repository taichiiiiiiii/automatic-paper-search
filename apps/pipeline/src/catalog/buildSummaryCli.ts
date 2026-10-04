/**
 * CLI entry point for {@link buildSummary} — mirrors
 * `paperpilot/scripts/build_summary_csv.py`'s `main()` flags
 * (`--conference`, `--input`).
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliUsageError, parseArgs as parseFlags } from "../shared/cli/argparse.js";
import { isMain } from "../shared/cli/isMain.js";
import { buildSummary } from "./buildSummary.js";
import { validateConferenceSlug } from "./slug.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/catalog -> repo root (4 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

export interface BuildSummaryCliArgs {
  conference: string;
  input?: string;
  outputRoot?: string;
  root?: string;
}

/**
 * M3 of the P4 review: `--conference`/`--input` mirror
 * `build_summary_csv.py`'s argparse flags through the shared strict
 * parser; `--output-root`/`--root` are TS-only test seams (no Python
 * equivalent) kept in the same spec so they get the same strictness
 * (unknown-flag/missing-value errors) rather than a separate ad-hoc loop.
 */
export function parseBuildSummaryCliArgs(argv: readonly string[]): BuildSummaryCliArgs {
  const parsed = parseFlags(argv, {
    conference: { type: "string", default: "iclr-2026" },
    input: { type: "string" },
    "output-root": { type: "string" },
    root: { type: "string" },
  });
  return {
    conference: parsed.conference as string,
    input: parsed.input as string | undefined,
    outputRoot: parsed["output-root"] as string | undefined,
    root: parsed.root as string | undefined,
  };
}

export function runBuildSummaryCli(
  argv: readonly string[],
  repoRootDefault: string = DEFAULT_REPO_ROOT,
): number {
  let args: BuildSummaryCliArgs;
  try {
    args = parseBuildSummaryCliArgs(argv);
  } catch (e) {
    if (e instanceof CliUsageError) {
      process.stderr.write(`build_summary_csv: error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  validateConferenceSlug(args.conference);
  const repoRoot = args.root ?? repoRootDefault;
  const outputRoot = args.outputRoot ?? join(repoRoot, "paperpilot", "output");
  const confDir = join(outputRoot, args.conference);
  const result = buildSummary({ conferenceDir: confDir, inputCsv: args.input ?? null });

  console.log(`Source: ${result.sourceCsv}`);
  console.log(`Wrote ${result.rowsWritten} papers to ${result.summaryCsv}`);
  console.log(`  Oral: ${result.oralCount}`);
  console.log(`  Poster: ${result.rowsWritten - result.oralCount}`);
  console.log("  Top tags:");
  const topTags = [...result.tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [tag, n] of topTags) console.log(`    ${tag}: ${n}`);
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = runBuildSummaryCli(process.argv.slice(2));
}

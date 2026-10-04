/**
 * CLI entry point for {@link buildSummary} — mirrors
 * `paperpilot/scripts/build_summary_csv.py`'s `main()` flags
 * (`--conference`, `--input`).
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

export function parseBuildSummaryCliArgs(argv: readonly string[]): BuildSummaryCliArgs {
  const args: BuildSummaryCliArgs = { conference: "iclr-2026" };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    switch (tok) {
      case "--conference":
        args.conference = argv[++i] as string;
        break;
      case "--input":
        args.input = argv[++i] as string;
        break;
      case "--output-root":
        args.outputRoot = argv[++i] as string;
        break;
      case "--root":
        args.root = argv[++i] as string;
        break;
      default:
        break;
    }
  }
  return args;
}

export function runBuildSummaryCli(
  argv: readonly string[],
  repoRootDefault: string = DEFAULT_REPO_ROOT,
): number {
  const args = parseBuildSummaryCliArgs(argv);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runBuildSummaryCli(process.argv.slice(2));
}

/**
 * CLI entry point for {@link writeManifest} — TS port of
 * `paperpilot/scripts/generate_themes_manifest.py`'s `main()`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { CliUsageError, parseArgs as parseFlags } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import type { ManifestEntry } from "./generateThemesManifest.js";
import { writeManifest } from "./generateThemesManifest.js";

export class CliArgError extends Error {}

/**
 * M3 of the P4 review: mirrors `generate_themes_manifest.py`'s argparse
 * (`--themes-dir`, required) through the shared strict parser —
 * `CliArgError` (this file's own public error type, kept for
 * compatibility) now wraps the shared parser's {@link CliUsageError}
 * rather than being thrown from a hand-rolled loop that treated any
 * non-`--themes-dir` flag as unrecognized but never supported
 * `--themes-dir=value` or prefix abbreviation.
 */
export function parseArgs(argv: readonly string[]): { themesDir: string } {
  try {
    const parsed = parseFlags(argv, { "themes-dir": { type: "string", required: true } });
    return { themesDir: parsed["themes-dir"] as string };
  } catch (e) {
    if (e instanceof CliUsageError) throw new CliArgError(e.message);
    throw e;
  }
}

export function runGenerateThemesManifestCli(argv: readonly string[]): number {
  let args: { themesDir: string };
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof CliArgError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  if (!existsSync(args.themesDir) || !statSync(args.themesDir).isDirectory()) {
    process.stderr.write(`error: ${args.themesDir} does not exist or is not a directory\n`);
    return 1;
  }

  const out = writeManifest(args.themesDir, { warn: (msg) => process.stderr.write(`${msg}\n`) });
  const entries = JSON.parse(readFileSync(out, "utf-8")) as ManifestEntry[];
  process.stdout.write(`✓ Wrote ${out} (${entries.length} entries)\n`);
  for (const e of entries) {
    const rngStr = e.year_range ? `${e.year_range[0]}-${e.year_range[1]}` : "no-year";
    process.stdout.write(
      `    ${e.slug.padEnd(30)}  ${String(e.paper_count).padStart(4)} papers  ${rngStr.padStart(9)}  ${e.theme.slice(0, 40)}\n`,
    );
  }
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = runGenerateThemesManifestCli(process.argv.slice(2));
}

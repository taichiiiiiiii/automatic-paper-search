/**
 * CLI entry point for {@link writeManifest} — TS port of
 * `paperpilot/scripts/generate_themes_manifest.py`'s `main()`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import type { ManifestEntry } from "./generateThemesManifest.js";
import { writeManifest } from "./generateThemesManifest.js";

export class CliArgError extends Error {}

export function parseArgs(argv: readonly string[]): { themesDir: string } {
  let themesDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--themes-dir") {
      themesDir = argv[++i];
    } else {
      throw new CliArgError(`unrecognized argument: ${argv[i]}`);
    }
  }
  if (themesDir === undefined) {
    throw new CliArgError("--themes-dir is required");
  }
  return { themesDir };
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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runGenerateThemesManifestCli(process.argv.slice(2));
}

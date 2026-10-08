/**
 * CLI entry point for {@link writeManifest} — mirrors
 * `paperpilot/scripts/generate_deep_manifest.py`'s `main()` (`--docs-dir`).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { CliUsageError, parseArgs as parseFlags } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import { type generateManifest, writeManifest } from "./generateDeepManifest.js";

/**
 * M3 of the P4 review: mirrors `generate_deep_manifest.py`'s argparse
 * (`--docs-dir`, required) through the shared strict parser — an
 * unrecognized flag used to be silently ignored by the old hand-rolled
 * `if (argv[i] === "--docs-dir")` loop.
 */
export function runGenerateDeepManifestCli(argv: readonly string[]): number {
  let docsDir: string;
  try {
    const parsed = parseFlags(argv, { "docs-dir": { type: "string", required: true } });
    docsDir = parsed["docs-dir"] as string;
  } catch (e) {
    if (e instanceof CliUsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  if (!existsSync(docsDir) || !statSync(docsDir).isDirectory()) {
    process.stderr.write(`error: ${docsDir} does not exist or is not a directory\n`);
    return 1;
  }
  try {
    const out = writeManifest(docsDir);
    const manifest = JSON.parse(readFileSync(out, "utf8")) as ReturnType<typeof generateManifest>;
    process.stdout.write(`✓ Wrote ${out} (${manifest.entries.length} entries)\n`);
    for (const entry of manifest.entries) {
      process.stdout.write(`    ${entry.arxiv_id.padEnd(12)}  ${entry.title.slice(0, 60)}\n`);
    }
    return 0;
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message}\n`);
    return 1;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = runGenerateDeepManifestCli(process.argv.slice(2));
}

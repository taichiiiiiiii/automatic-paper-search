/**
 * CLI entry point for {@link writeManifest} — mirrors
 * `paperpilot/scripts/generate_deep_manifest.py`'s `main()` (`--docs-dir`).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { type generateManifest, writeManifest } from "./generateDeepManifest.js";

export function runGenerateDeepManifestCli(argv: readonly string[]): number {
  let docsDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--docs-dir") docsDir = argv[++i];
  }
  if (docsDir === undefined) {
    process.stderr.write("error: --docs-dir is required\n");
    return 1;
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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runGenerateDeepManifestCli(process.argv.slice(2));
}

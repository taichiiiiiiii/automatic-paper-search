/**
 * CLI entry point mirroring
 * `paperpilot/scripts/audit_lineage_classification_breakdown.py`'s `main()`
 * (`--json`). Always exits 0 — read-only audit, not a CI gate.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pyJsonDumps } from "@paperpilot/core";
import {
  auditClassificationsCache,
  auditPublishedThemes,
  printHuman,
} from "./auditLineageClassificationBreakdown.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/lineage/quality -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export function runAuditLineageClassificationBreakdownCli(
  argv: readonly string[],
  repoRoot: string = DEFAULT_REPO_ROOT,
): number {
  const asJson = argv.includes("--json");
  const themesDir = join(repoRoot, "docs", "themes");
  const cachePath = join(repoRoot, "paperpilot", "data", "lineage-cache", "classifications.json");
  const published = auditPublishedThemes(themesDir, (value) => {
    process.stderr.write(
      `WARNING: unknown provenance value ${JSON.stringify(value)} — forward-compat passthrough; ` +
        "update NEW_ENUMS if this is a new intentional enum.\n",
    );
  });
  const cache = auditClassificationsCache(cachePath);

  if (asJson) {
    process.stdout.write(
      `${pyJsonDumps({ published, cache }, { ensureAscii: false, indent: 2 })}\n`,
    );
  } else {
    printHuman(published, cache, (line) => process.stdout.write(`${line}\n`));
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runAuditLineageClassificationBreakdownCli(process.argv.slice(2));
}

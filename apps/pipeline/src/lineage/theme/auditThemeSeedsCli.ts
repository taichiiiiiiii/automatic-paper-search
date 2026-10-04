/**
 * CLI entry point for {@link auditThemeSeeds} — TS port of
 * `paperpilot/scripts/audit_theme_seeds.py`'s `audit()`/`__main__`
 * print formatting.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../../shared/cli/isMain.js";
import { auditThemeSeeds } from "./auditThemeSeeds.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/lineage/theme -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export function runAuditThemeSeedsCli(
  themesDir: string = join(DEFAULT_REPO_ROOT, "docs", "themes"),
): number {
  const result = auditThemeSeeds(themesDir, { warn: (msg) => process.stdout.write(`${msg}\n`) });

  process.stdout.write(`=== audited ${result.seenThemes} themes ===\n`);
  if (result.problems.length === 0) {
    process.stdout.write("all clean.\n");
    return 0;
  }
  process.stdout.write(`\n${result.problems.length} themes have off-topic seeds:\n\n`);
  for (const { slug, theme, titles } of result.problems) {
    process.stdout.write(`  ${slug}  (${JSON.stringify(theme)})\n`);
    for (const t of titles) process.stdout.write(`    - ${t.slice(0, 80)}\n`);
    process.stdout.write("\n");
  }
  process.stdout.write("Operator action: open each flagged paper, decide if it's truly\n");
  process.stdout.write("                 off-topic (production filter saw the full\n");
  process.stdout.write("                 abstract; audit only saw the tldr). If yes,\n");
  process.stdout.write("                 re-dispatch theme-on-demand.yml for that slug.\n");
  process.stdout.write("                 If no (foundational paper whose title omits\n");
  process.stdout.write("                 the theme name), leave it — regen would pick\n");
  process.stdout.write("                 the same seed again and waste Groq quota.\n");
  return 1;
}

if (isMain(import.meta.url)) {
  process.exitCode = runAuditThemeSeedsCli();
}

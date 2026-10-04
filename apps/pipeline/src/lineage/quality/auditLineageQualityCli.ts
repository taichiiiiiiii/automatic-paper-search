/**
 * CLI entry point for the audit logic in `auditLineageQuality.ts` — mirrors
 * `paperpilot/scripts/audit_lineage_quality.py`'s `main()` (`--min-year`,
 * `--include-themes`, `--themes-only`). LIN-49, LIN-50.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLineage,
  collectTargets,
  effectiveMinYear,
  isEmptyStub,
} from "./auditLineageQuality.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/lineage/quality -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export interface AuditLineageQualityCliArgs {
  docsDir: string;
  minYear: number | null;
  includeThemes: boolean;
  themesOnly: boolean;
}

export function parseArgs(
  argv: readonly string[],
  repoRoot: string = DEFAULT_REPO_ROOT,
): AuditLineageQualityCliArgs {
  let docsDir = resolve(repoRoot, "docs");
  let minYear: number | null = null;
  let includeThemes = false;
  let themesOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--min-year") minYear = Number(argv[++i]);
    else if (tok === "--include-themes") includeThemes = true;
    else if (tok === "--themes-only") themesOnly = true;
    else if (tok === "--docs-dir") docsDir = argv[++i] as string;
  }
  return { docsDir, minYear, includeThemes, themesOnly };
}

function isThemePath(path: string): boolean {
  return path.split(/[\\/]/).includes("themes");
}

export function runAuditLineageQualityCli(args: AuditLineageQualityCliArgs): number {
  const wallClockFallback = new Date().getUTCFullYear() - 1;
  let targets = collectTargets(args.docsDir);
  if (args.themesOnly) {
    targets = targets.filter(isThemePath);
  } else if (!args.includeThemes) {
    targets = targets.filter((p) => !isThemePath(p));
  }
  if (targets.length === 0) {
    process.stdout.write("no lineage.json found.\n");
    return 0;
  }

  let anyFailed = false;
  for (const path of targets) {
    const theme = isThemePath(path);
    const slug = theme ? `themes/${basename(dirname(path))}` : basename(dirname(path));
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch (exc) {
      process.stdout.write(`\nFAIL  ${slug}:\n`);
      process.stdout.write(`  - unreadable: ${(exc as Error).message}\n`);
      anyFailed = true;
      continue;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      process.stdout.write(`\nFAIL  ${slug}:\n`);
      process.stdout.write("  - unreadable: not an object\n");
      anyFailed = true;
      continue;
    }
    const record = data as Record<string, unknown>;
    if (isEmptyStub(record)) {
      process.stdout.write(`SKIP  ${slug} (no lineage generated yet)\n`);
      continue;
    }
    const effective = effectiveMinYear(path, theme, args.minYear, wallClockFallback);
    const { warnings, failures } = auditLineage(path, effective, record, theme);
    if (warnings.length === 0 && failures.length === 0) {
      process.stdout.write(`OK    ${slug}\n`);
      continue;
    }
    if (failures.length > 0) {
      anyFailed = true;
      process.stdout.write(`\nFAIL  ${slug}:\n`);
      for (const p of failures) process.stdout.write(`  - ${p}\n`);
    }
    if (warnings.length > 0) {
      process.stdout.write(`\nWARN  ${slug}:\n`);
      for (const p of warnings) process.stdout.write(`  - ${p}\n`);
    }
  }

  if (anyFailed) {
    process.stdout.write(
      "\nOperator action: investigate failures above. " +
        "Themes failing the template_rationale_ratio threshold need " +
        "regeneration via theme-on-demand.yml (the edge-fabrication " +
        "fix in PR #210 + cache purge make follow-up runs converge " +
        "well below the hard-fail threshold).\n",
    );
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runAuditLineageQualityCli(parseArgs(process.argv.slice(2)));
}

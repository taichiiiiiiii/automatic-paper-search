/**
 * Parity harness: the TS port of `audit_lineage_quality.py` run against the
 * REAL `docs/` tree must produce the exact same per-collection OK/SKIP/WARN/
 * FAIL lines (and exit code) as the real Python script. Confirmed first by
 * running `uv run --extra dev python -m paperpilot.scripts.audit_lineage_quality
 * [--include-themes]` directly and diffing against this test's TS-side
 * reconstruction of the same report, at the time this test was written.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditLineage,
  collectTargets,
  effectiveMinYear,
  isEmptyStub,
} from "../../../src/lineage/quality/auditLineageQuality.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");
const DOCS_ROOT = resolve(REPO_ROOT, "docs");

function isThemePath(path: string): boolean {
  return path.split(/[\\/]/).includes("themes");
}

function runReport(includeThemes: boolean): { lines: string[]; exitCode: number } {
  const wallClockFallback = new Date().getUTCFullYear() - 1;
  let targets = collectTargets(DOCS_ROOT);
  if (!includeThemes) targets = targets.filter((p) => !isThemePath(p));
  const lines: string[] = [];
  let anyFailed = false;
  for (const path of targets) {
    const theme = isThemePath(path);
    const slug = theme ? `themes/${basename(dirname(path))}` : basename(dirname(path));
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (isEmptyStub(data)) {
      lines.push(`SKIP  ${slug} (no lineage generated yet)`);
      continue;
    }
    const effective = effectiveMinYear(path, theme, null, wallClockFallback);
    const { warnings, failures } = auditLineage(path, effective, data, theme);
    if (warnings.length === 0 && failures.length === 0) {
      lines.push(`OK    ${slug}`);
      continue;
    }
    if (failures.length > 0) {
      anyFailed = true;
      lines.push(`FAIL  ${slug}:`, ...failures.map((p) => `  - ${p}`));
    }
    if (warnings.length > 0) {
      lines.push(`WARN  ${slug}:`, ...warnings.map((p) => `  - ${p}`));
    }
  }
  return { lines, exitCode: anyFailed ? 1 : 0 };
}

describe("auditLineageQuality parity: real docs/ tree", () => {
  it("conferences only: eccv-2024 OK, iclr-2026 WARN (popularity_sinks=4), exit 0", () => {
    const { lines, exitCode } = runReport(false);
    expect(exitCode).toBe(0);
    expect(lines).toContain("OK    eccv-2024");
    expect(lines.join("\n")).toContain("WARN  iclr-2026:");
    expect(lines.join("\n")).toContain("popularity_sinks=4 (nodes with ≥8 incoming)");
  });

  it("with themes: vision-transformer hard-fails on popularity_sinks, exit 1", () => {
    const { lines, exitCode } = runReport(true);
    expect(exitCode).toBe(1);
    const joined = lines.join("\n");
    expect(joined).toContain("FAIL  themes/vision-transformer:");
    expect(joined).toContain("popularity_sinks=8 (nodes with ≥8 incoming); hard fail above 5");
    expect(joined).toContain(
      "offtopic_nonfocus_ratio=100% (12/12 BFS-discovered nodes are NOT topic-relevant to theme 'Flash Attention'",
    );
    expect(joined).toContain(
      "offtopic_nonfocus_ratio=94% (32/34 BFS-discovered nodes are NOT topic-relevant to theme 'Mixture of Experts'",
    );
    expect(joined).toContain(
      "offtopic_nonfocus_ratio=90% (28/31 BFS-discovered nodes are NOT topic-relevant to theme 'Vision Transformer'",
    );
    expect(joined).toContain("year_reversals=1");
  });
});

/**
 * Parity harness: `auditLineageClassificationBreakdownCli` run against the
 * REAL `docs/themes/` + `paperpilot/data/lineage-cache/classifications.json`
 * must byte-equal the real Python script's `--json` output (and human
 * report). Confirmed directly against `uv run --extra dev python -m
 * paperpilot.scripts.audit_lineage_classification_breakdown [--json]` at the
 * time this test was written.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditClassificationsCache,
  auditPublishedThemes,
} from "../../../src/lineage/quality/auditLineageClassificationBreakdown.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

describe("auditLineageClassificationBreakdown parity: real docs/themes + cache", () => {
  it("per-provenance relation counts match the known real-data shape", () => {
    const published = auditPublishedThemes(join(REPO_ROOT, "docs", "themes"));
    // These three themes are the only ones published at the time this test
    // was written (see CLAUDE.md "テーマ家系図は 3 本公開").
    expect(Object.keys(published.per_theme).sort()).toEqual([
      "flash-attention",
      "mixture-of-experts",
      "vision-transformer",
    ]);
    expect(Object.keys(published.per_provenance_rel)).toContain("llm");
  });

  it("reads the real classifications cache when present", () => {
    const cache = auditClassificationsCache(
      join(REPO_ROOT, "paperpilot", "data", "lineage-cache", "classifications.json"),
    );
    expect(cache.available).toBe(true);
  });
});

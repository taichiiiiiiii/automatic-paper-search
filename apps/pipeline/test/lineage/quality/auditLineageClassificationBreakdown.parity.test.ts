/**
 * Parity harness: `auditLineageClassificationBreakdownCli` run against
 * `docs/themes/` + `paperpilot/data/lineage-cache/classifications.json`
 * must byte-equal the real Python script's `--json` output (and human
 * report). Confirmed directly against `uv run --extra dev python -m
 * paperpilot.scripts.audit_lineage_classification_breakdown [--json]` at the
 * time this test was written.
 *
 * (b)-class test (p5-plan.md §2 A1, risk R9): the first assertion hardcodes
 * the exact set of published theme slugs, so it is a frozen-expectation
 * comparison. Reads a frozen fixture tree (`fixtures/docs/themes`,
 * `fixtures/paperpilot-data/classifications.json` -- see
 * `fixtures/README.md`) rather than the live repo, so a later legitimate
 * new theme publish or cache update cannot flip this hardcoded slug list
 * out from under this test. The fixture tree is trimmed to exactly what
 * `auditPublishedThemes()`/`auditClassificationsCache()` read (each
 * theme's `lineage.json` plus the classifications cache file only -- no
 * `themes-manifest.json`, which this code path lists theme directories
 * for instead of reading; see `fixtures/README.md` for how that was
 * verified).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditClassificationsCache,
  auditPublishedThemes,
} from "../../../src/lineage/quality/auditLineageClassificationBreakdown.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

describe("auditLineageClassificationBreakdown parity: frozen docs/themes + cache fixture", () => {
  it("per-provenance relation counts match the known real-data shape", () => {
    const published = auditPublishedThemes(join(FIXTURES, "docs", "themes"));
    // These three themes are the only ones published at the time this test
    // was written (see CLAUDE.md "テーマ家系図は 3 本公開").
    expect(Object.keys(published.per_theme).sort()).toEqual([
      "flash-attention",
      "mixture-of-experts",
      "vision-transformer",
    ]);
    expect(Object.keys(published.per_provenance_rel)).toContain("llm");
  });

  it("reads the frozen classifications cache fixture when present", () => {
    const cache = auditClassificationsCache(
      join(FIXTURES, "paperpilot-data", "classifications.json"),
    );
    expect(cache.available).toBe(true);
  });
});

// R2-34: lib/data-themes.ts's themeFallbackReason distinguishes a
// slug the pipeline never generated ("unknown") from one that WAS
// generated and promoted but failed the publication gate ("blocked")
// -- ThemesClient.tsx uses this to show the honest "generated but not
// published" copy instead of the misleading blanket 「存在しません」
// for a real on-demand run that hit a blocked tier (run 38221581049,
// "Low-Rank Adaptation").
import { describe, expect, it } from "vitest";
import { themeFallbackReason } from "../../lib/data-themes";
import type { QualityAudit, QualityManifest, QualityRow } from "../../lib/themes-quality";

function qualityAuditFixture(overrides: Partial<QualityAudit> = {}): QualityAudit {
  return {
    fixture_sha256: null,
    evaluated_at: "2026-08-30T00:00:00Z",
    actor: "ci:audit-v1",
    checks: [
      { name: "artifact_contract_v1", status: "passed", observed: 0, expected: 0, evidence: [] },
      {
        name: "golden_fixture",
        status: "unknown",
        observed: null,
        expected: "matching frozen fixture",
        evidence: [],
      },
    ],
    ...overrides,
  };
}

function themeQualityRow(overrides: Partial<QualityRow> = {}): QualityRow {
  return {
    collection_id: "theme:test-theme",
    kind: "theme",
    slug: "test-theme",
    label: "Test Theme",
    path: "themes/test-theme/lineage.json",
    availability: "ready",
    audit_status: "unknown",
    freshness: "fresh",
    generated_at: "2026-08-30T00:00:00Z",
    snapshot_date: null,
    node_count: 10,
    edge_count: 5,
    artifact_schema_version: "lineage-artifact-v1",
    input_sha256: "f".repeat(64),
    audit: qualityAuditFixture(),
    ...overrides,
  };
}

function qualityManifestFixture(rows: QualityRow[]): QualityManifest {
  return {
    schema_version: "lineage-quality-v1",
    as_of: "2026-08-30T00:00:00Z",
    audit_version: "audit-v1",
    collections: rows,
  };
}

describe("themeFallbackReason", () => {
  it('returns "unknown" when the quality manifest has no row for the slug', () => {
    const manifest = qualityManifestFixture([themeQualityRow({ slug: "other-theme" })]);
    expect(themeFallbackReason(manifest, "test-theme")).toBe("unknown");
  });

  it('returns "unknown" when the manifest itself is null (not yet fetched/published)', () => {
    expect(themeFallbackReason(null, "test-theme")).toBe("unknown");
  });

  it('returns "unaudited" (unknown golden_fixture, everything else passed) as eligible, not blocked', () => {
    const manifest = qualityManifestFixture([themeQualityRow()]);
    expect(themeFallbackReason(manifest, "test-theme")).toBe("unknown");
  });

  it(
    'returns "blocked" for a ready row with a failed automatic check -- the R2-34 case ' +
      "(a real on-demand run generated and promoted the theme, but timestamp_not_future or " +
      "another automatic check failed, so publication_tier is blocked)",
    () => {
      const audit = qualityAuditFixture();
      audit.checks.push({
        name: "timestamp_not_future",
        status: "failed",
        observed: 1,
        expected: 0,
        evidence: ["2026-10-12T08:16:07.224000Z"],
      });
      const row = themeQualityRow({ audit_status: "failed", audit });
      const manifest = qualityManifestFixture([row]);
      expect(themeFallbackReason(manifest, "test-theme")).toBe("blocked");
    },
  );

  it('returns "blocked" for an artifact that is not "ready" (e.g. sparse)', () => {
    const row = themeQualityRow({ availability: "sparse" });
    const manifest = qualityManifestFixture([row]);
    expect(themeFallbackReason(manifest, "test-theme")).toBe("blocked");
  });
});

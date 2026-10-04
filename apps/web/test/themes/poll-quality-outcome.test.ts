// Mocked-fetch tests for lib/data-themes.ts's pollThemeQualityOutcome
// (P2 review M6, themes half): the generation-progress poll loop's
// re-check that landing in themes-manifest.json does NOT itself mean
// the slug is eligible (SCR-39) -- it must re-read the shared
// lineage-quality-v1.json gate every time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { pollThemeQualityOutcome } from "../../lib/data-themes";
import type { QualityAudit, QualityManifest, QualityRow } from "../../lib/themes-quality";

function qualityAuditFixture(): QualityAudit {
  return {
    fixture_sha256: "9".repeat(64),
    evaluated_at: "2026-08-30T00:00:00Z",
    actor: "ci:audit-v1",
    checks: [
      { name: "artifact_contract_v1", status: "passed", observed: 0, expected: 0, evidence: [] },
      {
        name: "golden_fixture",
        status: "passed",
        observed: "fixture-sha",
        expected: "matching frozen fixture",
        evidence: [],
      },
    ],
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
    audit_status: "passed",
    freshness: "fresh",
    generated_at: "2026-08-30T00:00:00Z",
    snapshot_date: null,
    node_count: 3,
    edge_count: 2,
    artifact_schema_version: "lineage-artifact-v1",
    input_sha256: "f".repeat(64),
    audit: qualityAuditFixture(),
    ...overrides,
  };
}

function qualityManifestFixture(row: QualityRow): QualityManifest {
  return {
    schema_version: "lineage-quality-v1",
    as_of: "2026-08-30T00:00:00Z",
    audit_version: "audit-v1",
    collections: [row],
  };
}

function jsonResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
}

function stubFetch(routes: Record<string, Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (input: string | URL) =>
        routes[String(input)] ?? new Response("not found", { status: 404 }),
    ),
  );
}

describe("pollThemeQualityOutcome", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns "ready" for an eligible (ready+passed) row', async () => {
    const manifest = qualityManifestFixture(themeQualityRow());
    stubFetch({ "/lineage-quality-v1.json": jsonResponse(JSON.stringify(manifest)) });
    expect(await pollThemeQualityOutcome("test-theme")).toBe("ready");
  });

  it('returns "failed" for a row whose audit did not pass (audit-failed)', async () => {
    const failedAudit = qualityAuditFixture();
    failedAudit.checks[1] = { ...failedAudit.checks[1]!, status: "failed" };
    const row = themeQualityRow({ audit_status: "failed", audit: failedAudit });
    const manifest = qualityManifestFixture(row);
    stubFetch({ "/lineage-quality-v1.json": jsonResponse(JSON.stringify(manifest)) });
    expect(await pollThemeQualityOutcome("test-theme")).toBe("failed");
  });

  it('returns "pending" when the quality manifest 404s (not yet published)', async () => {
    stubFetch({});
    expect(await pollThemeQualityOutcome("test-theme")).toBe("pending");
  });

  it('returns "pending" when the quality manifest is malformed (fails strict parse)', async () => {
    const manifest = qualityManifestFixture(themeQualityRow());
    (manifest as { audit_version: string }).audit_version = "audit-v2";
    stubFetch({ "/lineage-quality-v1.json": jsonResponse(JSON.stringify(manifest)) });
    expect(await pollThemeQualityOutcome("test-theme")).toBe("pending");
  });

  it('returns "pending" when the manifest is valid but has no row for this slug yet', async () => {
    const manifest = qualityManifestFixture(themeQualityRow({ slug: "other-theme" }));
    (manifest.collections[0] as QualityRow).collection_id = "theme:other-theme";
    (manifest.collections[0] as QualityRow).path = "themes/other-theme/lineage.json";
    stubFetch({ "/lineage-quality-v1.json": jsonResponse(JSON.stringify(manifest)) });
    expect(await pollThemeQualityOutcome("test-theme")).toBe("pending");
  });
});

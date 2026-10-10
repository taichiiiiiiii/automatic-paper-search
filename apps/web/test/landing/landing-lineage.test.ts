import { describe, expect, it } from "vitest";
import {
  CONFERENCE_LINEAGE_VIEWERS,
  lineageShelfHref,
  lineageShelfMeta,
  lineageShelfStaleNote,
  lineageShelfTier,
  selectLineageShelfRows,
} from "../../lib/landing-lineage";
import {
  parseQualityManifest,
  type QualityManifest,
  type QualityRow,
} from "../../lib/lineage/core";

// Behavioural port of docs/assets/landing.js's `#s0-lineages` fetch
// handler (SCR-11): which rows the shelf may show, and their link/meta
// text. Mirrors the fixture shapes paperpilot/tests/viewer's Python
// contract test and apps/web/test/lineage/core.test.ts's "quality gate"
// describe block use, so a row that is valid-and-eligible there is
// valid-and-eligible here too.

function qualityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    collection_id: "conference:iclr-2026",
    kind: "conference",
    slug: "iclr-2026",
    label: "ICLR 2026",
    path: "iclr-2026/lineage.json",
    availability: "ready",
    audit_status: "passed",
    freshness: "fresh",
    generated_at: "2026-08-30T00:00:00Z",
    snapshot_date: null,
    node_count: 12,
    edge_count: 20,
    artifact_schema_version: "lineage-artifact-v1",
    input_sha256: "b".repeat(64),
    audit: {
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
    },
    ...overrides,
  };
}

function themeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return qualityRow({
    collection_id: "theme:test-theme",
    kind: "theme",
    slug: "test-theme",
    label: "Test Theme",
    path: "themes/test-theme/lineage.json",
    input_sha256: "f".repeat(64),
    ...overrides,
  });
}

function qualityManifest(
  rows: unknown[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "lineage-quality-v1",
    as_of: "2026-08-30T00:00:00Z",
    audit_version: "audit-v1",
    collections: rows,
    ...overrides,
  };
}

function parse(rows: unknown[]): QualityManifest {
  const parsed = parseQualityManifest(qualityManifest(rows));
  if (!parsed) throw new Error("fixture failed to parse -- fix the fixture, not the assertion");
  return parsed;
}

describe("selectLineageShelfRows", () => {
  it("returns an empty array for null input (initial/unresolved state)", () => {
    expect(selectLineageShelfRows(null)).toEqual([]);
  });

  it("shows an eligible conference row on the CONFERENCE_LINEAGE_VIEWERS allowlist", () => {
    const quality = parse([qualityRow()]); // slug: iclr-2026
    const rows = selectLineageShelfRows(quality);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe("iclr-2026");
  });

  it("shows an eligible theme row regardless of the conference allowlist", () => {
    const quality = parse([themeRow()]);
    const rows = selectLineageShelfRows(quality);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("theme");
  });

  it("hides an otherwise-eligible conference row not on CONFERENCE_LINEAGE_VIEWERS", () => {
    const quality = parse([
      qualityRow({
        collection_id: "conference:test-2026",
        slug: "test-2026",
        path: "test-2026/lineage.json",
      }),
    ]);
    expect(selectLineageShelfRows(quality)).toEqual([]);
  });

  it("hides a row that is not ready+passed (ineligible)", () => {
    const quality = parse([qualityRow({ availability: "sparse" })]);
    expect(selectLineageShelfRows(quality)).toEqual([]);
  });

  it("hides a row with node_count 0 even if otherwise eligible", () => {
    const quality = parse([qualityRow({ node_count: 0 })]);
    expect(selectLineageShelfRows(quality)).toEqual([]);
  });

  it("hides a deep row even when it is independently eligible", () => {
    const deepRow = qualityRow({
      collection_id: `deep:test-2026:${"1".repeat(40)}`,
      kind: "deep",
      slug: "test-2026",
      conference: "test-2026",
      paper_id: "1".repeat(40),
      arxiv_id: "2602.18473",
      label: "Deep",
      path: "test-2026/deep-2602.18473.json",
      manifest_path: "test-2026/deep-manifest.json",
      manifest_input_sha256: "c".repeat(64),
      input_sha256: "d".repeat(64),
    });
    const quality = parse([qualityRow(), deepRow, themeRow()]);
    const rows = selectLineageShelfRows(quality);
    expect(rows.map((row) => row.kind).sort()).toEqual(["conference", "theme"]);
  });

  it("lists audited rows before unaudited ones (design doc 41 D1)", () => {
    const unauditedAudit = {
      fixture_sha256: null,
      evaluated_at: "2026-08-30T00:00:00Z",
      actor: "ci:audit-v1",
      checks: [
        { name: "artifact_contract_v1", status: "passed", observed: 0, expected: 0, evidence: [] },
        { name: "golden_fixture", status: "unknown", observed: null, expected: "x", evidence: [] },
      ],
    };
    const quality = parse([
      themeRow({
        collection_id: "theme:a-theme",
        slug: "a-theme",
        path: "themes/a-theme/lineage.json",
        audit_status: "unknown",
        audit: unauditedAudit,
      }),
      themeRow(),
    ]);
    const rows = selectLineageShelfRows(quality);
    expect(rows.map((row) => row.slug)).toEqual(["test-theme", "a-theme"]);
    expect(rows.map((row) => lineageShelfTier(row))).toEqual(["audited", "unaudited"]);
  });

  it("does not re-sort rows within a tier (preserves the manifest's own collection_id order)", () => {
    // parseQualityManifest itself enforces collection_id ascending order
    // (rejects anything else), so "conference:" before "theme:" is the
    // only order a parsed manifest can ever have here; this just pins
    // that selectLineageShelfRows passes that order through unchanged.
    const ordered = parse([qualityRow(), themeRow()]);
    const rows = selectLineageShelfRows(ordered);
    expect(rows.map((row) => row.collection_id)).toEqual([
      "conference:iclr-2026",
      "theme:test-theme",
    ]);
  });
});

describe("lineageShelfHref", () => {
  it("links a conference row straight to its /<slug>/lineage/ route", () => {
    const row = parse([qualityRow()]).collections[0] as QualityRow;
    expect(lineageShelfHref(row)).toBe("/iclr-2026/lineage/");
  });

  it("links a theme row into the /themes/ picker with ?theme=", () => {
    const row = parse([themeRow()]).collections[0] as QualityRow;
    expect(lineageShelfHref(row)).toBe("/themes/?theme=test-theme");
  });

  it("percent-encodes a hostile slug (defence in depth)", () => {
    // SLUG_RE in parseQualityManifest already rejects this at parse
    // time; exercise the encoder directly against a row-shaped object
    // to confirm it never emits a raw path separator.
    const row = { kind: "theme", slug: "../evil" } as unknown as QualityRow;
    expect(lineageShelfHref(row)).not.toContain("/../");
  });
});

describe("lineageShelfMeta", () => {
  it("formats a conference row as '学会 · N 論文 · M 関係'", () => {
    const row = parse([qualityRow()]).collections[0] as QualityRow;
    expect(lineageShelfMeta(row)).toBe("学会 · 12 論文 · 20 関係");
  });

  it("formats a theme row as 'テーマ · N 論文 · M 関係'", () => {
    const row = parse([themeRow()]).collections[0] as QualityRow;
    expect(lineageShelfMeta(row)).toBe("テーマ · 12 論文 · 20 関係");
  });
});

describe("lineageShelfStaleNote", () => {
  it("is null for a fresh row", () => {
    const row = parse([qualityRow()]).collections[0] as QualityRow;
    expect(lineageShelfStaleNote(row)).toBeNull();
  });

  it("surfaces the snapshot date (sliced to 10 chars) for a stale row", () => {
    const quality = parse([qualityRow({ freshness: "stale", snapshot_date: "2026-01-02" })]);
    const row = quality.collections[0] as QualityRow;
    expect(lineageShelfStaleNote(row)).toBe("更新確認が必要 · 2026-01-02");
  });

  it("falls back to generated_at, then '日付不明', when snapshot_date is null", () => {
    const quality = parse([
      qualityRow({ freshness: "stale", generated_at: "2026-02-03T04:05:06Z" }),
    ]);
    const row = quality.collections[0] as QualityRow;
    expect(lineageShelfStaleNote(row)).toBe("更新確認が必要 · 2026-02-03");
  });
});

describe("CONFERENCE_LINEAGE_VIEWERS", () => {
  it("is exactly the two conferences that ship a /lineage/ route today", () => {
    expect(CONFERENCE_LINEAGE_VIEWERS).toEqual(new Set(["eccv-2024", "iclr-2026"]));
  });
});

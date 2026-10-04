import { describe, expect, it } from "vitest";
import {
  conferenceLineageIsEligible,
  lineageDataIsNonStub,
} from "../../app/[conf]/lineage/route-eligibility";

describe("lineageDataIsNonStub", () => {
  it("is false for the intentionally-empty stub lineage.json", () => {
    expect(
      lineageDataIsNonStub(JSON.stringify({ root: null, nodes: [], edges: [], meta: {} })),
    ).toBe(false);
  });

  it("is true once nodes is non-empty", () => {
    expect(
      lineageDataIsNonStub(JSON.stringify({ root: "a", nodes: [{ id: "a" }], edges: [] })),
    ).toBe(true);
  });

  it("is false for malformed JSON", () => {
    expect(lineageDataIsNonStub("not json")).toBe(false);
    expect(lineageDataIsNonStub("")).toBe(false);
  });

  it("is false when nodes is missing or not an array", () => {
    expect(lineageDataIsNonStub(JSON.stringify({}))).toBe(false);
    expect(lineageDataIsNonStub(JSON.stringify({ nodes: "x" }))).toBe(false);
    expect(lineageDataIsNonStub(JSON.stringify({ nodes: null }))).toBe(false);
  });
});

/**
 * MEDIUM-2 (P2 review round 2): `conferenceLineageIsEligible` used to
 * check only `availability`/`audit_status` directly off the raw JSON --
 * a row with `audit_status: "passed"` but an internally inconsistent or
 * incomplete audit contract (something the client's
 * `qualityRowIsEligible` already rejects) could still read as eligible
 * here, so the built page would stay indexable while the client-side
 * gate in `page.tsx` renders the "監査待ち" pending shell for the exact
 * same row. These fixtures mirror `test/lineage/core.test.ts`'s
 * "quality gate" describe block, so a row eligible there is eligible
 * here too.
 */
describe("conferenceLineageIsEligible", () => {
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
          {
            name: "artifact_contract_v1",
            status: "passed",
            observed: 0,
            expected: 0,
            evidence: [],
          },
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

  function manifest(rows: unknown[]): string {
    return JSON.stringify({
      schema_version: "lineage-quality-v1",
      as_of: "2026-08-30T00:00:00Z",
      audit_version: "audit-v1",
      collections: rows,
    });
  }

  it("is false when the manifest is missing", () => {
    expect(conferenceLineageIsEligible(null, "iclr-2026")).toBe(false);
  });

  it("is false when the manifest is malformed", () => {
    expect(conferenceLineageIsEligible("{}", "iclr-2026")).toBe(false);
    expect(conferenceLineageIsEligible("not json", "iclr-2026")).toBe(false);
    expect(conferenceLineageIsEligible(JSON.stringify({ collections: "nope" }), "iclr-2026")).toBe(
      false,
    );
  });

  it("is false when the manifest otherwise parses but has one malformed, unrelated row (fail-closed, not partial)", () => {
    // Two rows with the same `collection_id` violate
    // `parseQualityManifest`'s strictly-ascending-order requirement,
    // which fails the WHOLE manifest -- not just the offending row --
    // so even the first, otherwise-valid row stops being eligible.
    const raw = manifest([qualityRow(), qualityRow()]);
    expect(conferenceLineageIsEligible(raw, "iclr-2026")).toBe(false);
  });

  it("is false when the row is ready but not passed (today's real manifest state)", () => {
    const raw = manifest([qualityRow({ audit_status: "failed" })]);
    expect(conferenceLineageIsEligible(raw, "iclr-2026")).toBe(false);
  });

  it("is false when the row is passed but not ready", () => {
    const raw = manifest([qualityRow({ availability: "unavailable" })]);
    expect(conferenceLineageIsEligible(raw, "iclr-2026")).toBe(false);
  });

  it("is false when audit_status is passed but the audit contract itself is inconsistent", () => {
    // The old loose (availability/audit_status string-only) check would
    // have accepted this row; audit_status: "passed" requires every
    // check in `audit.checks` to report "passed" too.
    const base = qualityRow();
    const inconsistent = {
      ...base,
      audit: {
        ...(base.audit as Record<string, unknown>),
        checks: [
          {
            name: "artifact_contract_v1",
            status: "passed",
            observed: 0,
            expected: 0,
            evidence: [],
          },
          { name: "golden_fixture", status: "failed", observed: "x", expected: "y", evidence: [] },
        ],
      },
    };
    expect(conferenceLineageIsEligible(manifest([inconsistent]), "iclr-2026")).toBe(false);
  });

  it("is true only for the matching ready+passed conference row with a fully-consistent audit", () => {
    const raw = manifest([
      qualityRow(),
      qualityRow({
        collection_id: "theme:iclr-2026",
        kind: "theme",
        slug: "iclr-2026",
        path: "themes/iclr-2026/lineage.json",
        input_sha256: "f".repeat(64),
      }),
    ]);
    expect(conferenceLineageIsEligible(raw, "iclr-2026")).toBe(true);
    expect(conferenceLineageIsEligible(raw, "eccv-2024")).toBe(false);
    expect(conferenceLineageIsEligible(raw, "cvpr-2026")).toBe(false);
  });
});

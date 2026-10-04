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

describe("conferenceLineageIsEligible", () => {
  const manifest = (rows: unknown[]): string => JSON.stringify({ collections: rows });

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

  it("is false when the row is ready but not passed (today's real manifest state)", () => {
    const raw = manifest([
      { kind: "conference", slug: "iclr-2026", availability: "ready", audit_status: "failed" },
    ]);
    expect(conferenceLineageIsEligible(raw, "iclr-2026")).toBe(false);
  });

  it("is false when the row is passed but not ready", () => {
    const raw = manifest([
      {
        kind: "conference",
        slug: "iclr-2026",
        availability: "unavailable",
        audit_status: "passed",
      },
    ]);
    expect(conferenceLineageIsEligible(raw, "iclr-2026")).toBe(false);
  });

  it("is true only for the matching ready+passed conference row", () => {
    const raw = manifest([
      { kind: "conference", slug: "iclr-2026", availability: "ready", audit_status: "passed" },
      {
        kind: "conference",
        slug: "eccv-2024",
        availability: "unavailable",
        audit_status: "unknown",
      },
      { kind: "theme", slug: "iclr-2026", availability: "ready", audit_status: "passed" },
    ]);
    expect(conferenceLineageIsEligible(raw, "iclr-2026")).toBe(true);
    expect(conferenceLineageIsEligible(raw, "eccv-2024")).toBe(false);
    expect(conferenceLineageIsEligible(raw, "cvpr-2026")).toBe(false);
  });
});

/**
 * Vitest port of the edge-provenance tests in
 * `paperpilot/tests/test_build_theme_lineage_p2t.py` (closed,
 * endpoint-bound structured provenance) plus `_is_trending`
 * (`test_build_theme_lineage.py::test_is_trending_threshold`).
 */
import { describe, expect, it } from "vitest";
import { deriveRelation } from "../../../src/lineage/classify/classify.js";
import {
  classificationProvenance,
  isTrending,
  makeEdge,
} from "../../../src/lineage/theme/edges.js";

function paper(graphId: string, arxivId: string | null, opts: { year?: number } = {}) {
  return {
    paperId: graphId,
    title: "A paper",
    year: opts.year ?? 2024,
    venue: "arXiv",
    citationCount: 10,
    abstract: "A sufficiently specific abstract for deterministic tests.",
    authors: [],
    externalIds: arxivId === null ? {} : { ArXiv: arxivId },
  };
}

describe("makeEdge / classificationProvenance", () => {
  it("produces closed, endpoint-bound structured provenance", async () => {
    const parent = {
      ...paper("parent", "2301.00001", { year: 2023 }),
      _is_influential: true,
      _intents: ["methodology"],
      _contexts: ["B extends the parent method"],
    };
    const child = paper("child", "2401.00001", { year: 2024 });
    const derived = await deriveRelation(parent, { parent, child });
    expect(derived).not.toBeNull();

    const edge = makeEdge(derived!, {
      srcId: "parent",
      dstId: "child",
      parent,
      child,
      intentRecord: parent,
      provider: null,
    });
    expect(edge.rel).toBe(edge.relation);
    expect(edge.conf).toBe(edge.confidence);
    expect(new Set(Object.keys(edge.provenance))).toEqual(
      new Set(["producer", "evidence", "classification"]),
    );
    expect((edge.provenance.classification as Record<string, unknown>).provider).toBeNull();

    const originalHash = (edge.provenance.evidence as Record<string, unknown>).sha256;
    const changed = makeEdge(derived!, {
      srcId: "different-parent",
      dstId: "child",
      parent,
      child,
      intentRecord: parent,
      provider: null,
    });
    expect((changed.provenance.evidence as Record<string, unknown>).sha256).not.toBe(originalHash);
  });

  it("rejects an unsupported heuristic provenance method", () => {
    const parent = paper("a", "2301.00001");
    const child = paper("b", "2401.00001");
    expect(() =>
      classificationProvenance(
        { relation: "extends", confidence: 0.8, rationale: "x", provenance: "not-a-real-method" },
        { srcId: "a", dstId: "b", parent, child, intentRecord: parent, provider: null },
      ),
    ).toThrow(/unsupported heuristic provenance method/);
  });
});

describe("isTrending (#68)", () => {
  it("applies the velocity threshold and the 3-year recency window", () => {
    expect(isTrending({ citationCount: 600, year: 2024 }, 2026)).toBe(true);
    expect(isTrending({ citationCount: 100, year: 2024 }, 2026)).toBe(false);
    expect(isTrending({ citationCount: 200, year: 2026 }, 2026)).toBe(true); // 0.5y floor
    expect(isTrending({ citationCount: 226_000, year: 2015 }, 2026)).toBe(false); // too old
    expect(isTrending({ citationCount: 700, year: 2023 }, 2026)).toBe(true); // exactly 3y boundary
    expect(isTrending({ citationCount: 9999 }, 2026)).toBe(false); // missing year
    expect(isTrending({ citationCount: 9999, year: 2030 }, 2026)).toBe(false); // future year
  });
});

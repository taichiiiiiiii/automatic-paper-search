/**
 * Vitest port of the edge-provenance tests in
 * `paperpilot/tests/test_build_theme_lineage_p2t.py` (closed,
 * endpoint-bound structured provenance) plus `_is_trending`
 * (`test_build_theme_lineage.py::test_is_trending_threshold`).
 */

import { pyJsonDumps } from "@paperpilot/core";
import { describe, expect, it } from "vitest";
import { deriveRelation } from "../../../src/lineage/classify/classify.js";
import {
  classificationProvenance,
  heuristicEvidenceInput,
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

  it("heuristicEvidenceInput coerces every absent optional field to null, never bare undefined (Python's dict.get(key) is always None, never an omitted key)", () => {
    // `parent`/`child`/`intentRecord` here deliberately lack title/year/
    // citationCount AND the `_intents`/`_contexts`/`_is_influential`
    // bookkeeping fields entirely — property access on a missing key
    // yields JS `undefined`, whereas Python's `dict.get(key)` always
    // yields `None`. `pyJsonDumps` throws on a bare `undefined` (Python
    // has no equivalent); this pins the fix that coerces every one of
    // these optional reads with `?? null`.
    const bareParent = { paperId: "p" };
    const bareChild = { paperId: "c" };
    const input = heuristicEvidenceInput({
      srcId: "p",
      dstId: "c",
      parent: bareParent,
      child: bareChild,
      intentRecord: bareParent,
    });
    expect(() => pyJsonDumps(input)).not.toThrow();
    const parsed = JSON.parse(pyJsonDumps(input)) as Record<string, unknown>;
    expect(parsed.parent).toEqual({ title: null, year: null, citations: null });
    expect(parsed.child).toEqual({ title: null, year: null, citations: null });
    expect(parsed.intent_record).toEqual({
      title: null,
      year: null,
      citations: null,
      intents: null,
      contexts: null,
      is_influential: null,
    });
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

// Unit tests for the chronological-tree layout logic ported from
// docs/assets/theme.js into lib/themes-tree.ts (Y = year rows,
// X = one of 6 selectable encodings). Not a 1:1 port of any single
// paperpilot/tests/viewer/*.mjs file (the brief lists only the
// request-progress / submit-contract / lineage-contract / init-callees
// suites for porting) -- these are fresh coverage for the newly
// extracted pure layout module, per CLAUDE.md's "write tests first"
// rule for ported logic.
import { describe, expect, it } from "vitest";
import type { LineageEdge, LineageNode } from "../../lib/themes-quality";
import {
  ALL_RELATIONS,
  bucketYear,
  CITATION_HEAT_CEILING,
  computeCitationHeat,
  computeHubSet,
  computeModeData,
  computeOrphanSet,
  computePagerank,
  DEFAULT_RELATIONS,
  HEAT_BUCKET_COUNT,
  heatBucket,
  hiddenEdgeCount,
  isSparseLineage,
  layoutChronological,
  MAX_PLAUSIBLE_YEAR,
  matchesSearch,
  matchesYear,
  SPARSE_EDGE_THRESHOLD,
  SPARSE_EDGES_PER_NODE,
  sparseLineageNotice,
  UNKNOWN_YEAR,
  venueTierBucket,
} from "../../lib/themes-tree";

function node(partial: Partial<LineageNode> & { id: string }): LineageNode {
  return { is_focus: false, ...partial };
}

function edge(src: string, dst: string, relation: string): LineageEdge {
  return {
    src,
    dst,
    relation,
    confidence: 0.9,
    rationale: "r",
    provenance: {
      producer: { name: "x", version: "1" },
      evidence: { source: "x", kind: "citation", sha256: "a".repeat(64) },
      classification: {
        method: "citation_heuristic",
        provider: null,
        model: null,
        prompt_version: null,
        schema_version: "v1",
      },
    },
  };
}

describe("bucketYear", () => {
  it("returns the year for a finite integer in range", () => {
    expect(bucketYear(2022)).toBe(2022);
  });
  it("returns UNKNOWN_YEAR for non-integers, NaN, and out-of-range years", () => {
    expect(bucketYear(2022.5)).toBe(UNKNOWN_YEAR);
    expect(bucketYear(Number.NaN)).toBe(UNKNOWN_YEAR);
    expect(bucketYear(1899)).toBe(UNKNOWN_YEAR);
    expect(bucketYear(MAX_PLAUSIBLE_YEAR + 1)).toBe(UNKNOWN_YEAR);
    expect(bucketYear(null)).toBe(UNKNOWN_YEAR);
    expect(bucketYear(undefined)).toBe(UNKNOWN_YEAR);
  });
});

describe("matchesSearch", () => {
  const n = node({ id: "a", title: "Flash Attention", authors: ["Tri Dao"], venue: "NeurIPS" });
  it("empty query always matches", () => {
    expect(matchesSearch(n, "")).toBe(true);
  });
  it("matches title/author/venue case-insensitively", () => {
    expect(matchesSearch(n, "flash")).toBe(true);
    expect(matchesSearch(n, "dao")).toBe(true);
    expect(matchesSearch(n, "neurips")).toBe(true);
  });
  it("no match returns false", () => {
    expect(matchesSearch(n, "transformer")).toBe(false);
  });
});

describe("matchesYear", () => {
  it("null bounds always pass", () => {
    expect(matchesYear(node({ id: "a", year: 2020 }), null, null)).toBe(true);
  });
  it("unknown (non-numeric) years always pass", () => {
    expect(matchesYear(node({ id: "a" }), 2020, 2022)).toBe(true);
  });
  it("enforces min/max inclusive bounds", () => {
    expect(matchesYear(node({ id: "a", year: 2021 }), 2020, 2022)).toBe(true);
    expect(matchesYear(node({ id: "a", year: 2019 }), 2020, 2022)).toBe(false);
    expect(matchesYear(node({ id: "a", year: 2023 }), 2020, 2022)).toBe(false);
  });
});

describe("venueTierBucket", () => {
  it("maps known string tiers", () => {
    expect(venueTierBucket("A+")).toBe(1);
    expect(venueTierBucket("A")).toBe(2);
    expect(venueTierBucket("preprint")).toBe(3);
    expect(venueTierBucket("")).toBe(3);
  });
  it("maps numeric tiers 1-3 through, others to 99", () => {
    expect(venueTierBucket(1)).toBe(1);
    expect(venueTierBucket(4)).toBe(99);
  });
  it("unknown shapes map to 99", () => {
    expect(venueTierBucket(undefined)).toBe(99);
    expect(venueTierBucket("mystery")).toBe(99);
  });
});

describe("computePagerank", () => {
  it("returns an empty map for zero nodes", () => {
    expect(computePagerank([], []).size).toBe(0);
  });
  it("a seed with many descendants outranks a childless leaf", () => {
    const nodes = [
      node({ id: "seed" }),
      node({ id: "child1" }),
      node({ id: "child2" }),
      node({ id: "leaf" }),
    ];
    const edges = [edge("seed", "child1", "extends"), edge("seed", "child2", "extends")];
    const rank = computePagerank(nodes, edges);
    expect(rank.get("seed")!).toBeGreaterThan(rank.get("leaf")!);
  });
});

describe("computeHubSet", () => {
  it("returns an empty set for small/sparse graphs", () => {
    const nodes = [node({ id: "a" }), node({ id: "b" })];
    expect(computeHubSet(nodes, [edge("a", "b", "extends")]).size).toBe(0);
  });
});

describe("computeOrphanSet", () => {
  it("flags nodes with no incident edge", () => {
    const nodes = [node({ id: "a" }), node({ id: "b" }), node({ id: "orphan" })];
    const edges = [edge("a", "b", "extends")];
    const orphans = computeOrphanSet(nodes, edges);
    expect(orphans.has("orphan")).toBe(true);
    expect(orphans.has("a")).toBe(false);
    expect(orphans.has("b")).toBe(false);
  });
});

describe("computeCitationHeat", () => {
  it("is 0 for no/zero/negative/non-numeric citations", () => {
    expect(computeCitationHeat(undefined)).toBe(0);
    expect(computeCitationHeat(null)).toBe(0);
    expect(computeCitationHeat(0)).toBe(0);
    expect(computeCitationHeat(-5)).toBe(0);
  });
  it("is monotonically increasing with citation count", () => {
    expect(computeCitationHeat(10)).toBeGreaterThan(computeCitationHeat(1));
    expect(computeCitationHeat(1000)).toBeGreaterThan(computeCitationHeat(10));
    expect(computeCitationHeat(226000)).toBeGreaterThan(computeCitationHeat(1000));
  });
  it("saturates at 1 at/above the 500k ceiling, never exceeding it", () => {
    expect(computeCitationHeat(CITATION_HEAT_CEILING)).toBe(1);
    expect(computeCitationHeat(CITATION_HEAT_CEILING * 10)).toBe(1);
  });
  it("matches the log10(c+1)/log10(500001) formula below the ceiling", () => {
    // ~226k citations (ResNet-scale) -> well under 1, well above 0.
    const heat = computeCitationHeat(226_000);
    expect(heat).toBeCloseTo(Math.log10(226_001) / Math.log10(CITATION_HEAT_CEILING), 10);
    expect(heat).toBeGreaterThan(0.9);
    expect(heat).toBeLessThan(1);
  });
});

describe("heatBucket", () => {
  it("is bucket 0 for no citations and the top bucket at/above the ceiling", () => {
    expect(heatBucket(0)).toBe(0);
    expect(heatBucket(null)).toBe(0);
    expect(heatBucket(CITATION_HEAT_CEILING)).toBe(HEAT_BUCKET_COUNT - 1);
  });
  it("never returns a bucket outside [0, HEAT_BUCKET_COUNT - 1]", () => {
    for (const c of [0, 1, 10, 100, 1000, 10_000, 100_000, 500_000, 5_000_000]) {
      const b = heatBucket(c);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(HEAT_BUCKET_COUNT - 1);
    }
  });
  it("is non-decreasing as citation count grows", () => {
    const counts = [0, 1, 10, 100, 1000, 10_000, 100_000, 226_000, 500_000];
    let prev = -1;
    for (const c of counts) {
      const b = heatBucket(c);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });
});

describe("layoutChronological", () => {
  const nodes = [
    node({ id: "old", year: 2020, citation_count: 5 }),
    node({ id: "new-hi", year: 2022, citation_count: 100 }),
    node({ id: "new-lo", year: 2022, citation_count: 1 }),
    node({ id: "unknown-year" }),
  ];
  const edges = [edge("old", "new-hi", "extends")];

  it("groups nodes into one row per year, unknown year last", () => {
    const { yearLabels } = layoutChronological(nodes, edges, "rank");
    expect(yearLabels.map((l) => l.label)).toEqual(["2020", "2022", "Unknown"]);
  });

  it("rank mode sorts each year row by citation_count descending", () => {
    const { positioned } = layoutChronological(nodes, edges, "rank");
    const row2022 = positioned.filter((p) => p.year === 2022);
    expect(row2022[0]!.id).toBe("new-hi");
    expect(row2022[0]!._x).toBeLessThan(row2022[1]!._x);
  });

  it("every positioned node gets numeric _x/_y", () => {
    const { positioned } = layoutChronological(nodes, edges, "rank");
    for (const p of positioned) {
      expect(Number.isFinite(p._x)).toBe(true);
      expect(Number.isFinite(p._y)).toBe(true);
    }
  });

  it("falls back to the default mode for an unrecognised mode string", () => {
    const a = layoutChronological(nodes, edges, "rank");
    // @ts-expect-error -- intentionally passing an invalid mode to exercise the defensive fallback
    const b = layoutChronological(nodes, edges, "not-a-real-mode");
    expect(b.yearLabels).toEqual(a.yearLabels);
  });

  it("genealogy mode places children at their parents' average X", () => {
    const { positioned } = layoutChronological(nodes, edges, "genealogy");
    const parent = positioned.find((p) => p.id === "old")!;
    const child = positioned.find((p) => p.id === "new-hi")!;
    expect(Math.abs(parent._x - child._x)).toBeLessThan(400);
  });
});

describe("ALL_RELATIONS / DEFAULT_RELATIONS", () => {
  it("DEFAULT_RELATIONS is a subset of ALL_RELATIONS and excludes contrasts", () => {
    for (const r of DEFAULT_RELATIONS) expect(ALL_RELATIONS).toContain(r);
    expect(DEFAULT_RELATIONS).not.toContain("contrasts");
    expect(ALL_RELATIONS).toContain("contrasts");
  });
  it("shows baseline_only (S2 background citations) by default (R2 UX P0-1)", () => {
    expect(DEFAULT_RELATIONS).toContain("baseline_only");
  });
});

describe("hiddenEdgeCount", () => {
  it("counts edges whose relation is filtered out", () => {
    const es = [{ relation: "extends" }, { relation: "contrasts" }, { relation: "contrasts" }];
    expect(hiddenEdgeCount(es, new Set(DEFAULT_RELATIONS))).toBe(2);
    expect(hiddenEdgeCount(es, new Set(ALL_RELATIONS))).toBe(0);
    expect(hiddenEdgeCount([], new Set())).toBe(0);
  });
});

describe("computeModeData", () => {
  const nodes = [
    node({ id: "root", venue_tier: "A+" }),
    node({ id: "child-a", venue_tier: "A" }),
    node({ id: "child-b", venue_tier: "preprint" }),
  ];

  it("venue mode: buckets 1-3 from venue_tier, unknown tiers get null", () => {
    const meta = computeModeData(nodes, [], "venue");
    expect(meta.get("root")).toEqual({ kind: "tier", value: 1 });
    expect(meta.get("child-a")).toEqual({ kind: "tier", value: 2 });
    expect(meta.get("child-b")).toEqual({ kind: "tier", value: 3 });
  });

  it("venue mode: an out-of-range bucket (99) maps to a null value", () => {
    const meta = computeModeData([node({ id: "x", venue_tier: "mystery" })], [], "venue");
    expect(meta.get("x")).toEqual({ kind: "tier", value: null });
  });

  it("novelty mode: supersedes/contrasts incoming edges disrupt, successor/extends/ablation incremental", () => {
    const edges = [edge("root", "child-a", "supersedes"), edge("root", "child-b", "extends")];
    const meta = computeModeData(nodes, edges, "novelty");
    expect(meta.get("child-a")).toEqual({ kind: "novelty", value: "disrupt" });
    expect(meta.get("child-b")).toEqual({ kind: "novelty", value: "incremental" });
    expect(meta.get("root")).toEqual({ kind: "novelty", value: "neutral" });
  });

  it("genealogy mode: nodes sharing the same root ancestor get the same hue", () => {
    const edges = [edge("root", "child-a", "extends"), edge("root", "child-b", "extends")];
    const meta = computeModeData(nodes, edges, "genealogy");
    const hueA = meta.get("child-a");
    const hueB = meta.get("child-b");
    expect(hueA?.kind).toBe("lineage");
    expect(hueA).toEqual(hueB);
  });

  it("modes without a visual hook (rank/citation_log/centrality) return an empty map", () => {
    expect(computeModeData(nodes, [], "rank").size).toBe(0);
    expect(computeModeData(nodes, [], "citation_log").size).toBe(0);
    expect(computeModeData(nodes, [], "centrality").size).toBe(0);
  });
});

describe("isSparseLineage", () => {
  it("is sparse with few relations or fewer relations than papers", () => {
    expect(isSparseLineage(4, 4)).toBe(true); // Flash Attention shape
    expect(isSparseLineage(30, SPARSE_EDGE_THRESHOLD - 1)).toBe(true);
    expect(isSparseLineage(20, 12)).toBe(true);
  });
  it("is not sparse when relations per paper reach the threshold", () => {
    // Graph Neural Network shape: 13 papers / 40 relations (was flagged
    // by the old 15-paper threshold).
    expect(isSparseLineage(13, 40)).toBe(false);
    expect(isSparseLineage(10, 13)).toBe(false);
    expect(
      isSparseLineage(SPARSE_EDGE_THRESHOLD, SPARSE_EDGE_THRESHOLD * SPARSE_EDGES_PER_NODE),
    ).toBe(false);
  });
  it("an empty theme is not flagged as thin", () => {
    expect(isSparseLineage(0, 0)).toBe(false);
  });
});

describe("sparseLineageNotice", () => {
  it("states the counts in Japanese and does not promise a scheduled regeneration", () => {
    const text = sparseLineageNotice(7, 3);
    expect(text).toContain("（7 論文 / 3 関係）");
    expect(text).not.toMatch(/edges|件/);
    expect(text).toContain(
      "論文が少ないうちは家系図が薄くなります。作り直しで密になることがあります。",
    );
    // There is no weekly (Sunday) regeneration of themes.
    expect(text).not.toMatch(/毎週|日曜|熟成/);
  });
});

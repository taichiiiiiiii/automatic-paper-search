/**
 * Tests the pure render-model function (`buildDeepGraphModel`) against
 * a fixture artifact that satisfies `lineage-artifact-v1` strict
 * parsing for kind "deep" (lib/lineage/core.ts `parseArtifact`) -- the
 * shape `app/[conf]/deep/page.tsx` holds once a deep quality row
 * passes. Mirrors test/lineage/graph/view-model.test.ts's structure,
 * scoped to deep's single tree layout.
 *
 * Fixture topology (ids already in `parseArtifact`'s required ascending
 * sort order):
 *
 *   ancestor --successor--> root --extends--> child
 *   root --contrasts--> rival (reachable ONLY via a comparison edge --
 *     proves deep's BFS walks contrasts/baseline_only too, unlike the
 *     conference viewer's genealogy-only walk)
 *   isolated-paper (no edges at all)
 */
import { describe, expect, it } from "vitest";
import { parseArtifact } from "../../../lib/lineage/core";
import {
  type BuildDeepGraphModelState,
  buildDeepGraphModel,
} from "../../../lib/lineage/layout/deep-view-model";

const provenance = {
  producer: { name: "fixture", version: "1" },
  evidence: { source: "fixture", kind: "citation", sha256: "a".repeat(64) },
  classification: {
    method: "citation_heuristic",
    provider: null,
    model: null,
    prompt_version: null,
    schema_version: "fixture-v1",
  },
};

function rawEdge(src: string, dst: string, relation: string, confidence: number) {
  return {
    src,
    dst,
    rel: relation,
    relation,
    conf: confidence,
    confidence,
    rationale: "fixture",
    provenance,
  };
}

function rawArtifact() {
  return {
    schema_version: "lineage-artifact-v1",
    root: "root",
    nodes: [
      { id: "ancestor", title: "Ancestor", is_focus: false, year: 2023 },
      { id: "child", title: "Child", is_focus: false, year: 2026 },
      { id: "isolated-paper", title: "Isolated Paper", is_focus: false, year: 2020 },
      {
        id: "rival",
        title: "Rival",
        is_focus: false,
        year: 2024,
        citation_count: 42,
        authors: ["A", "B", "C", "D"],
      },
      {
        id: "root",
        title: "Root Paper",
        is_focus: true,
        seed_paper_id: "1".repeat(40),
        year: 2026,
      },
    ],
    edges: [
      // Must already be in parseArtifact's required ascending
      // src\0dst\0relation sort order.
      rawEdge("ancestor", "root", "successor", 0.9),
      rawEdge("root", "child", "extends", 0.7),
      rawEdge("root", "rival", "contrasts", 0.5),
    ],
    clusters: [],
    meta: { kind: "deep", seed_paper_id: "1".repeat(40), generated_at: "2026-08-30T00:00:00Z" },
  };
}

const artifact = parseArtifact(rawArtifact(), { kind: "deep" });
if (!artifact)
  throw new Error("fixture artifact failed parseArtifact -- fix the fixture, not the test");

function state(overrides: Partial<BuildDeepGraphModelState>): BuildDeepGraphModelState {
  return {
    focusId: "root",
    visibleRelations: new Set(["supersedes", "successor", "extends", "ablation", "contrasts"]),
    ...overrides,
  };
}

describe("buildDeepGraphModel", () => {
  it("walks contrasts/baseline_only edges too -- 'rival' is reachable only through one", () => {
    const model = buildDeepGraphModel(artifact, state({}));
    const ids = model.positioned.map((n) => n.id).sort();
    expect(ids).toEqual(["ancestor", "child", "rival", "root"]);
    expect(model.positioned.find((n) => n.id === "isolated-paper")).toBeUndefined();
  });

  it("is unbounded depth (no MAX_DEPTH): still reaches 'rival' and 'child' from a non-root focus", () => {
    const model = buildDeepGraphModel(artifact, state({ focusId: "ancestor" }));
    const ids = model.positioned.map((n) => n.id).sort();
    expect(ids).toEqual(["ancestor", "child", "rival", "root"]);
  });

  it("only draws edges whose relation is visible and whose endpoints are positioned", () => {
    const model = buildDeepGraphModel(
      artifact,
      state({ visibleRelations: new Set(["contrasts"]) }),
    );
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]?.markerClass).toBe("contrasts");
    expect(model.edges[0]?.label).toBe("対立");
  });

  it("defaults every node's rendered height to deep's own 180px fallback, not lineage's 150px", () => {
    const model = buildDeepGraphModel(artifact, state({}));
    for (const node of model.positioned) expect(node._h).toBe(180);
  });

  it("honours measured heights when provided, same contract as the lineage view model", () => {
    const model = buildDeepGraphModel(artifact, state({}), new Map([["root", 220]]));
    expect(model.positioned.find((n) => n.id === "root")?._h).toBe(220);
    expect(model.positioned.find((n) => n.id === "child")?._h).toBe(180);
  });

  it("sizes the SVG canvas using deep's own 240px card width and 48px padding", () => {
    const model = buildDeepGraphModel(artifact, state({}));
    const maxX = Math.max(...model.positioned.map((p) => p._x));
    expect(model.svgSize.width).toBe(maxX + 240 + 48);
  });

  it("returns no edges and a focus-only positioned set for an unknown focusId", () => {
    const model = buildDeepGraphModel(artifact, state({ focusId: "no-such-node" }));
    expect(model.positioned).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.svgSize).toEqual({ width: 0, height: 0 });
  });
});

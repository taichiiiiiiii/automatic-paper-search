/**
 * Tests the pure render-model function (`buildLineageViewModel`)
 * against a fixture artifact that satisfies `lineage-artifact-v1`
 * strict parsing (lib/lineage/core.ts `parseArtifact`) -- i.e. exactly
 * the shape a gated conference route would hold in its `{ phase:
 * "ready", artifact }` state once a quality row passes (see
 * app/[conf]/lineage/page.tsx). React Testing Library is not
 * installed in this repo, so this is how the "ready" render path gets
 * exercised even though 0 conference rows are eligible today: build
 * the model a real `<LineageGraph>` would receive, and assert on its
 * shape instead of on rendered HTML.
 *
 * Fixture topology (ids chosen to already be in the ascending sort
 * order `parseArtifact` requires):
 *
 *   ancestor-parent --successor--> root --extends--> descendant-child --extends--> ancestor-sibling
 *   ancestor-parent --baseline_only--> descendant-child
 *   isolated-paper (no edges at all)
 *
 * `root` is the sole `is_focus: true` node (seed_paper_id required by
 * `parseArtifact` for kind "conference").
 */
import { describe, expect, it } from "vitest";
import { parseArtifact } from "../../../lib/lineage/core";
import {
  buildLineageViewModel,
  getClusters,
  type LineageGraphState,
} from "../../../lib/lineage/layout/view-model";

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
      { id: "ancestor-parent", title: "Ancestor Parent", is_focus: false, year: 2024 },
      { id: "ancestor-sibling", title: "Ancestor Sibling", is_focus: false, year: 2025 },
      { id: "descendant-child", title: "Descendant Child", is_focus: false, year: 2027 },
      { id: "isolated-paper", title: "Isolated Paper", is_focus: false, year: 2022 },
      {
        id: "root",
        title: "Root Paper",
        is_focus: true,
        seed_paper_id: "1".repeat(40),
        year: 2026,
      },
    ],
    edges: [
      // Genealogy chain from root: ancestor-parent (up) <- root -> descendant-child
      // (down) -> ancestor-sibling (down, depth 2). `layoutTree`'s BFS only
      // follows parent links upward and child links downward from the
      // focus -- it does NOT pull in an ancestor's *other* children -- so
      // ancestor-sibling is reachable here via descendant-child, not via
      // ancestor-parent (a sibling edge there would never be visited).
      rawEdge("ancestor-parent", "descendant-child", "baseline_only", 0.4),
      rawEdge("ancestor-parent", "root", "successor", 0.9),
      rawEdge("descendant-child", "ancestor-sibling", "extends", 0.6),
      rawEdge("root", "descendant-child", "extends", 0.7),
    ],
    clusters: [
      { id: "cluster-llm", label: "LLM", focus_ids: ["root", "ancestor-parent"] },
      {
        id: "cluster-vision",
        label: "Vision",
        focus_ids: ["descendant-child", "isolated-paper", "ghost-id-not-a-real-node"],
      },
    ],
    meta: { kind: "conference", generated_at: "2026-08-30T00:00:00Z" },
  };
}

const artifact = parseArtifact(rawArtifact(), { kind: "conference" });
if (!artifact)
  throw new Error("fixture artifact failed parseArtifact -- fix the fixture, not the test");

function state(overrides: Partial<LineageGraphState>): LineageGraphState {
  return {
    layout: "tree",
    view: "graph",
    focusId: "root",
    currentCluster: null,
    visibleRelations: new Set(["supersedes", "successor", "extends", "ablation", "contrasts"]),
    ...overrides,
  };
}

describe("getClusters", () => {
  it("parses well-formed cluster rows", () => {
    expect(getClusters(artifact)).toEqual([
      { id: "cluster-llm", label: "LLM", focus_ids: ["root", "ancestor-parent"] },
      {
        id: "cluster-vision",
        label: "Vision",
        focus_ids: ["descendant-child", "isolated-paper", "ghost-id-not-a-real-node"],
      },
    ]);
  });
});

describe("buildLineageViewModel: list view", () => {
  it("is list regardless of layout, and the crumb still reflects layout=tree", () => {
    const model = buildLineageViewModel(artifact, state({ view: "list", layout: "tree" }));
    expect(model.isList).toBe(true);
    expect(model.isTopics).toBe(false);
    expect(model.isGraphSvg).toBe(false);
    expect(model.graph).toBeNull();
    expect(model.topics).toBeNull();
    expect(model.legendVisible).toBe(false);
    expect(model.footerHint).toContain("読み上げ可能な一覧");
    // root's cluster is cluster-llm; crumb shows it even in list view.
    expect(model.crumb).toEqual({
      visible: true,
      clusterId: "cluster-llm",
      clusterLabel: "LLM",
      focusTitle: "Root Paper",
    });
  });

  it("hides the crumb when layout=timeline even in list view", () => {
    const model = buildLineageViewModel(artifact, state({ view: "list", layout: "timeline" }));
    expect(model.crumb.visible).toBe(false);
  });
});

describe("buildLineageViewModel: topics view", () => {
  it("builds one gallery section per cluster, skipping unknown focus_ids", () => {
    const model = buildLineageViewModel(artifact, state({ view: "graph", layout: "topics" }));
    expect(model.isTopics).toBe(true);
    expect(model.isGraphSvg).toBe(false);
    expect(model.legendVisible).toBe(false);
    // layout===topics && !isList -> filter bar hidden.
    expect(model.filterBarVisible).toBe(false);
    expect(model.crumb.visible).toBe(false);
    expect(model.topics?.totalPapers).toBe(2 + 3); // focus_ids.length, not resolved-node count
    expect(model.topics?.clusters).toHaveLength(2);
    expect(model.topics?.clusters[0]).toMatchObject({
      id: "cluster-llm",
      subtitle: "大規模言語モデル",
      count: 2,
    });
    expect(model.topics?.clusters[0]?.nodes.map((n) => n.id)).toEqual(["root", "ancestor-parent"]);
    // cluster-vision's "ghost-id-not-a-real-node" is dropped (no matching node).
    expect(model.topics?.clusters[1]?.nodes.map((n) => n.id)).toEqual([
      "descendant-child",
      "isolated-paper",
    ]);
  });
});

describe("buildLineageViewModel: tree graph view", () => {
  it("positions the genealogy-connected nodes and drops the isolated one", () => {
    const model = buildLineageViewModel(
      artifact,
      state({ view: "graph", layout: "tree", focusId: "root" }),
    );
    expect(model.isGraphSvg).toBe(true);
    expect(model.legendVisible).toBe(true);
    expect(model.filterBarVisible).toBe(true);
    const ids = model.graph?.positioned.map((n) => n.id).sort();
    expect(ids).toEqual(["ancestor-parent", "ancestor-sibling", "descendant-child", "root"]);
    expect(model.graph?.positioned.find((n) => n.id === "isolated-paper")).toBeUndefined();
  });

  it("only draws edges whose relation is visible and whose endpoints are positioned", () => {
    const onlyBaseline = state({
      view: "graph",
      layout: "tree",
      focusId: "root",
      visibleRelations: new Set(["baseline_only"]),
    });
    const model = buildLineageViewModel(artifact, onlyBaseline);
    // ancestor-parent -> descendant-child (baseline_only) has both
    // endpoints positioned (both reachable from root via genealogy).
    expect(model.graph?.edges).toHaveLength(1);
    expect(model.graph?.edges[0]?.markerClass).toBe("baseline");
    expect(model.graph?.edges[0]?.label).toBe("参照（背景）");
  });

  it("drops the crumb's cluster when currentCluster does not exist", () => {
    const model = buildLineageViewModel(
      artifact,
      state({ view: "graph", layout: "tree", currentCluster: "no-such-cluster" }),
    );
    expect(model.crumb.visible).toBe(false);
  });
});

describe("buildLineageViewModel: timeline graph view", () => {
  it("positions every node (including the isolated one) by year", () => {
    const model = buildLineageViewModel(artifact, state({ view: "graph", layout: "timeline" }));
    expect(model.isGraphSvg).toBe(true);
    expect(model.graph?.positioned).toHaveLength(5);
    expect(model.graph?.positioned.find((n) => n.id === "isolated-paper")).toBeDefined();
    expect(model.crumb.visible).toBe(false); // crumb hides for layout=timeline
  });
});

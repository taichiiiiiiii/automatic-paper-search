/**
 * Ports the PURE geometry subset of
 * paperpilot/tests/viewer/test_lineage_focus_app.mjs's cases against
 * lib/lineage/v2/layout.ts (not the JS): `placeEdgeLabel`, `routeEdge`,
 * `segmentHitsCard`, `rectangleEdgePoints`, `layeredLayout`,
 * `nodeLanes`, `laneLayout`. The DOM-driving parts of that mjs file
 * (`start()`, `activate()`, `openInspector`/`closeInspector`,
 * `renderGraph`/`renderNodeCards`/`renderList`) are NOT ported here --
 * they build real `<svg>`/DOM nodes imperatively, which this port
 * replaces with React components in components/lineage/focus/* (see
 * this page agent's final report for the rendering-test gap: no RTL/
 * jsdom is installed, so those components are exercised only via the
 * pure layout functions they call, plus a build-output HTML check).
 */
import { describe, expect, it } from "vitest";
import {
  laneLayout,
  layeredLayout,
  nodeLanes,
  placeEdgeLabel,
  rectangleEdgePoints,
  routeEdge,
  segmentHitsCard,
} from "../../../lib/lineage/v2/layout";
import type { LineageV2Claim, LineageV2Node } from "../../../lib/lineage/v2/types";

function node(id: string): LineageV2Node {
  return {
    id,
    title: id,
    first_published_at: "2024-01-01",
    is_focus: false,
    seed_paper_id: null,
    aliases: [],
  };
}

function laneEdge(src: string, dst: string, extra: Partial<LineageV2Claim> = {}): LineageV2Claim {
  return {
    id: `${src}->${dst}`,
    src,
    dst,
    claim_family: "genealogy",
    relation: "extends",
    decision: "accepted",
    trust_tier: "verified",
    raw_score: null,
    calibrated_probability: null,
    calibration_id: null,
    evidence_ids: [],
    rationale: "",
    classification: {
      method: "human_review",
      provider: null,
      model: null,
      prompt_version: null,
      schema_version: "test",
    },
    reason_codes: [],
    review_binding: null,
    ...extra,
  };
}

describe("placeEdgeLabel", () => {
  const labelPath = [
    { x: 100, y: 100 },
    { x: 400, y: 100 },
  ];

  it("a label exactly inside the canvas remains available", () => {
    expect(placeEdgeLabel(labelPath, "拡張", new Map(), [], { width: 268, height: 96 })).toEqual({
      x: 250,
      y: 92,
    });
  });

  it("labels do not escape the right canvas boundary", () => {
    expect(
      placeEdgeLabel(labelPath, "拡張", new Map(), [], { width: 260, height: 200 }),
    ).toBeNull();
  });

  it("labels do not escape the bottom canvas boundary", () => {
    expect(placeEdgeLabel(labelPath, "拡張", new Map(), [], { width: 500, height: 95 })).toBeNull();
  });

  it("labels do not escape the top or left canvas boundary", () => {
    expect(
      placeEdgeLabel(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        "要確認",
        new Map(),
        [],
      ),
    ).toBeNull();
  });

  it("a coincident label is omitted instead of overprinted", () => {
    const labelBoxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    const first = placeEdgeLabel(labelPath, "拡張", new Map(), labelBoxes);
    expect(first).not.toBeNull();
    expect(labelBoxes.length).toBe(1);
    expect(placeEdgeLabel(labelPath, "拡張", new Map(), labelBoxes)).toBeNull();
  });

  it("labels do not cover a card", () => {
    expect(
      placeEdgeLabel(labelPath, "拡張", new Map([["card", { x: 250, y: 92 }]]), []),
    ).toBeNull();
  });

  it("a blocked longest segment falls back to another segment, preserving the edge route", () => {
    const alternatePath = [
      { x: 100, y: 100 },
      { x: 400, y: 100 },
      { x: 400, y: 300 },
    ];
    const before = JSON.stringify(alternatePath);
    expect(
      placeEdgeLabel(alternatePath, "拡張", new Map([["card", { x: 250, y: 92 }]]), []),
    ).toEqual({
      x: 400,
      y: 192,
    });
    expect(JSON.stringify(alternatePath)).toBe(before);
  });

  it("an empty route has no label spot", () => {
    expect(placeEdgeLabel([], "拡張", new Map(), [])).toBeNull();
  });
});

describe("routeEdge / segmentHitsCard", () => {
  it("an intervening card requires a detour that never crosses it", () => {
    const routingNodes = new Map([
      ["a", { x: 100, y: 100 }],
      ["blocker", { x: 350, y: 100 }],
      ["b", { x: 600, y: 100 }],
    ]);
    const a = routingNodes.get("a") as { x: number; y: number };
    const b = routingNodes.get("b") as { x: number; y: number };
    const blocker = routingNodes.get("blocker") as { x: number; y: number };
    const routed = routeEdge(a, b, routingNodes);
    expect(routed.length).toBeGreaterThan(2);
    for (let i = 1; i < routed.length; i++) {
      expect(
        segmentHitsCard(
          routed[i - 1] as { x: number; y: number },
          routed[i] as { x: number; y: number },
          blocker,
        ),
      ).toBe(false);
    }
    expect(routeEdge(a, b, routingNodes)).toEqual(routed);
    expect([...routingNodes.values()]).toEqual([
      { x: 100, y: 100 },
      { x: 350, y: 100 },
      { x: 600, y: 100 },
    ]);
  });
});

describe("rectangleEdgePoints", () => {
  it("horizontal arrows meet the left/right rectangle borders", () => {
    expect(rectangleEdgePoints({ x: 0, y: 0 }, { x: 300, y: 0 })).toEqual({
      start: { x: 65, y: 0 },
      end: { x: 235, y: 0 },
    });
  });

  it("vertical arrows meet the top/bottom rectangle borders", () => {
    expect(rectangleEdgePoints({ x: 0, y: 0 }, { x: 0, y: 200 })).toEqual({
      start: { x: 0, y: 31 },
      end: { x: 0, y: 169 },
    });
  });

  it("a steep arrowhead lies on, rather than floats outside, the target rectangle", () => {
    const steep = rectangleEdgePoints({ x: 0, y: 0 }, { x: 40, y: 200 });
    expect(steep).toEqual({ start: { x: 6.2, y: 31 }, end: { x: 33.8, y: 169 } });
    expect(Math.max(Math.abs((steep.end.x - 40) / 65), Math.abs((steep.end.y - 200) / 31))).toBe(1);
  });
});

describe("layeredLayout", () => {
  it("rejected, unknown-trust and comparison edges cannot imply genealogy rank", () => {
    const isolatedNodes = [node("a"), node("b")];
    for (const extra of [
      { decision: "rejected" as const },
      { trust_tier: "tentative" as const },
      { claim_family: "comparison" as const },
    ]) {
      const ignoredLayout = layeredLayout(isolatedNodes, [laneEdge("a", "b", extra)]);
      expect(ignoredLayout.positions.get("a")?.x).toBe(ignoredLayout.positions.get("b")?.x);
    }
  });

  it("a trusted parent -> child genealogy determines the visible generation rank, and node order never matters", () => {
    const cycleNodes = ["root", "a", "b", "tail"].map(node);
    const cycleClaims = [
      laneEdge("root", "a"),
      laneEdge("a", "b"),
      laneEdge("b", "a"),
      laneEdge("b", "tail"),
    ];
    const cycleLayout = layeredLayout(cycleNodes, cycleClaims);
    for (const n of cycleNodes) {
      expect(cycleLayout.positions.get(n.id)?.x).toBe(cycleLayout.positions.get("root")?.x);
    }
    expect(layeredLayout([...cycleNodes].reverse(), [...cycleClaims].reverse())).toEqual(
      cycleLayout,
    );

    const chainNodes = ["parent", "child"].map(node);
    const chainLayout = layeredLayout(chainNodes, [laneEdge("parent", "child")]);
    expect((chainLayout.positions.get("parent") as { x: number }).x).toBeLessThan(
      (chainLayout.positions.get("child") as { x: number }).x,
    );
  });
});

describe("nodeLanes / laneLayout", () => {
  const laneNodes = [
    "focus",
    "parent",
    "grandparent",
    "child",
    "compare",
    "tentative",
    "other",
  ].map(node);
  const laneClaims = [
    laneEdge("parent", "focus"),
    laneEdge("grandparent", "parent"),
    laneEdge("focus", "child"),
    laneEdge("compare", "focus", { claim_family: "comparison" }),
    laneEdge("tentative", "focus", { trust_tier: "tentative" }),
  ];

  it("positional grouping must not imply that every other node is unverified", () => {
    const lanes = nodeLanes(laneNodes, laneClaims, "focus");
    expect(lanes.find((lane) => lane.key === "other")?.label).toBe("その他の関連論文");
  });

  it("partitions into exactly the expected lanes and is input-order independent", () => {
    const before = JSON.stringify([laneNodes, laneClaims]);
    const lanes = nodeLanes(laneNodes, laneClaims, "focus");
    expect(lanes.map((lane) => lane.nodes.map((n) => n.id))).toEqual([
      ["focus"],
      ["grandparent", "parent"],
      ["child"],
      ["compare"],
      ["other", "tentative"],
    ]);
    expect(nodeLanes([...laneNodes].reverse(), [...laneClaims].reverse(), "focus")).toEqual(lanes);
    expect(JSON.stringify([laneNodes, laneClaims])).toBe(before);
    const total = new Set(lanes.flatMap((lane) => lane.nodes.map((n) => n.id))).size;
    expect(total).toBe(laneNodes.length);
  });

  it("a rejected or dangling (missing-node) edge cannot move lane membership", () => {
    const lanes = nodeLanes(laneNodes, laneClaims, "focus");
    const withNoise = nodeLanes(
      laneNodes,
      [
        ...laneClaims,
        laneEdge("other", "focus", { decision: "rejected" }),
        laneEdge("missing", "focus"),
      ],
      "focus",
    );
    expect(withNoise).toEqual(lanes);
  });

  it("an additional edge touching 'other' moves that node into the right lane", () => {
    const withExtra = nodeLanes(laneNodes, [...laneClaims, laneEdge("focus", "parent")], "focus");
    expect(
      withExtra.find((lane) => lane.key === "other")?.nodes.some((n) => n.id === "parent"),
    ).toBe(true);
  });

  it("lays out prior < focus < child left-to-right, and comparison/tentative below the genealogy band", () => {
    const layout = laneLayout(laneNodes, laneClaims, "focus");
    const at = (id: string) => layout.positions.get(id) as { x: number; y: number };
    expect(at("grandparent").x).toBeLessThan(at("parent").x);
    expect(at("parent").x).toBeLessThan(at("focus").x);
    expect(at("focus").x).toBeLessThan(at("child").x);
    expect(at("compare").y).toBeGreaterThan(at("child").y);
    expect(at("other").y).toBeGreaterThan(at("compare").y);
    expect(laneLayout([...laneNodes].reverse(), [...laneClaims].reverse(), "focus")).toEqual(
      layout,
    );
  });

  it("every placed node stays within the canvas and never overlaps another card's footprint", () => {
    const samples = [
      [],
      [node("focus")],
      laneNodes,
      Array.from({ length: 50 }, (_, i) => node(i === 0 ? "focus" : `node-${i}`)),
    ];
    for (const sample of samples) {
      const placed = laneLayout(sample, laneClaims, "focus");
      expect(placed.positions.size).toBe(sample.length);
      const points = [...placed.positions.values()];
      points.forEach((point, i) => {
        expect(
          point.x >= 65 &&
            point.y >= 31 &&
            point.x + 65 < placed.width &&
            point.y + 31 < placed.height,
        ).toBe(true);
        for (const other of points.slice(i + 1)) {
          expect(Math.abs(point.x - other.x) >= 130 || Math.abs(point.y - other.y) >= 62).toBe(
            true,
          );
        }
      });
    }
  });

  it("a 50-node mixed projection exercises every lane without overlap, and routes avoid every other card", () => {
    const mixedNodes = [node("focus"), ...Array.from({ length: 49 }, (_, i) => node(`mixed-${i}`))];
    const mixedClaims = mixedNodes
      .slice(1)
      .map((n, i) =>
        i < 15
          ? laneEdge(n.id, "focus")
          : i < 30
            ? laneEdge("focus", n.id)
            : laneEdge(
                "focus",
                n.id,
                i < 40 ? { claim_family: "comparison" } : { trust_tier: "tentative" },
              ),
      );
    const before = JSON.stringify([mixedNodes, mixedClaims]);
    const mixedLayout = laneLayout(mixedNodes, mixedClaims, "focus");
    expect(mixedLayout.positions.size).toBe(50);
    expect(nodeLanes(mixedNodes, mixedClaims, "focus").map((lane) => lane.nodes.length)).toEqual([
      1, 15, 15, 10, 9,
    ]);
    expect(laneLayout([...mixedNodes].reverse(), [...mixedClaims].reverse(), "focus")).toEqual(
      mixedLayout,
    );
    const mixedPoints = [...mixedLayout.positions.values()];
    for (const claim of mixedClaims) {
      const from = mixedLayout.positions.get(claim.src) as { x: number; y: number };
      const to = mixedLayout.positions.get(claim.dst) as { x: number; y: number };
      const path = routeEdge(from, to, mixedLayout.positions);
      expect(path.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < path.length; i++) {
        for (const card of mixedPoints.filter((p) => p !== from && p !== to)) {
          expect(
            segmentHitsCard(
              path[i - 1] as { x: number; y: number },
              path[i] as { x: number; y: number },
              card,
            ),
          ).toBe(false);
        }
      }
    }
    mixedPoints.forEach((point, i) => {
      expect(
        point.x >= 65 &&
          point.y >= 31 &&
          point.x + 65 < mixedLayout.width &&
          point.y + 31 < mixedLayout.height,
      ).toBe(true);
      for (const other of mixedPoints.slice(i + 1)) {
        expect(Math.abs(point.x - other.x) >= 130 || Math.abs(point.y - other.y) >= 62).toBe(true);
      }
    });
    const familyBottom = Math.max(
      ...mixedNodes
        .slice(0, 31)
        .map((n) => (mixedLayout.positions.get(n.id) as { y: number }).y + 31),
    );
    const comparisonTop = Math.min(
      ...mixedNodes
        .slice(31, 41)
        .map((n) => (mixedLayout.positions.get(n.id) as { y: number }).y - 31),
    );
    expect(comparisonTop).toBeGreaterThan(familyBottom);
    expect(JSON.stringify([mixedNodes, mixedClaims])).toBe(before);
  });
});

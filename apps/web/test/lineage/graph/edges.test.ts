/**
 * Parity test: lib/lineage/layout/edges.ts `fanOffsets`/`edgeStyle`
 * against docs/assets/utils.js's `PP.fanOffsets`/`PP.edgeStyle` (run
 * under node:vm via ./oracle.ts, since lineage.js loads utils.js
 * first and both viewers share these). `buildEdgePath`/`computeSvgSize`
 * have no JS counterpart to diff against (they replace DOM-measuring
 * code inline in `drawSvg`), so those get direct unit tests instead.
 */
import { describe, expect, it } from "vitest";
import type { LineageEdge } from "../../../lib/lineage/core";
import { NODE_H, NODE_W, PADDING } from "../../../lib/lineage/layout/constants";
import {
  buildEdgePath,
  computeSvgSize,
  edgeStyle,
  fanOffsets,
} from "../../../lib/lineage/layout/edges";
import { loadLineageOracle } from "./oracle";

const oracle = loadLineageOracle();

function edge(
  src: string,
  dst: string,
  relation: LineageEdge["relation"],
  confidence: number,
): LineageEdge {
  return {
    src,
    dst,
    relation,
    confidence,
    rationale: "",
    provenance: {} as LineageEdge["provenance"],
  };
}

describe("edgeStyle matches PP.edgeStyle", () => {
  const cases: [string, unknown][] = [
    ["supersedes", 0.9],
    ["successor", 0.5],
    ["extends", 0.0],
    ["ablation", 1],
    ["baseline", 0.42],
    ["baseline_only", 0.42],
    ["contrasts", 0.73],
    ["unknown-relation", 0.6],
    ["supersedes", "not-a-number"],
    ["supersedes", null],
  ];
  for (const [mc, conf] of cases) {
    it(`mc=${mc} conf=${JSON.stringify(conf)}`, () => {
      expect(edgeStyle(mc, conf)).toEqual(oracle.edgeStyle(mc, conf));
    });
  }
});

describe("fanOffsets matches PP.fanOffsets", () => {
  it("spreads a single parent's multiple children left-to-right", () => {
    const edges = [
      edge("parent", "left", "extends", 0.6),
      edge("parent", "right", "successor", 0.9),
      edge("parent", "middle", "ablation", 0.3),
      edge("other-parent", "orphan-child", "extends", 0.5),
      edge("parent", "unknown-dst", "extends", 0.5), // dropped: dst not in posById
    ];
    const posById = new Map([
      ["parent", { id: "parent", _x: 100, _y: 0 }],
      ["left", { id: "left", _x: 0, _y: 200 }],
      ["middle", { id: "middle", _x: 100, _y: 200 }],
      ["right", { id: "right", _x: 300, _y: 200 }],
      ["other-parent", { id: "other-parent", _x: 500, _y: 0 }],
      ["orphan-child", { id: "orphan-child", _x: 500, _y: 200 }],
    ]);

    const expectedMap = oracle.fanOffsets(edges, posById as never, NODE_W);
    const actualMap = fanOffsets(edges, posById, NODE_W);

    expect(actualMap.size).toBe(expectedMap.size);
    for (const e of edges) {
      expect(actualMap.get(e)).toBe(expectedMap.get(e));
    }
  });

  it("returns 0 offset for a parent with a single child", () => {
    const edges = [edge("p", "only-child", "extends", 0.5)];
    const posById = new Map([
      ["p", { id: "p", _x: 0, _y: 0 }],
      ["only-child", { id: "only-child", _x: 0, _y: 200 }],
    ]);
    expect(fanOffsets(edges, posById, NODE_W).get(edges[0] as LineageEdge)).toBe(0);
  });
});

describe("buildEdgePath", () => {
  it("draws a cubic bezier from the parent's bottom-center to the child's top-center", () => {
    const a = { id: "a", _x: 0, _y: 0 };
    const b = { id: "b", _x: 100, _y: 230 };
    const geo = buildEdgePath(a, b, 15);
    const ax = 0 + NODE_W / 2 + 15;
    const ay = 0 + NODE_H;
    const bx = 100 + NODE_W / 2;
    const by = 230;
    const midY = (ay + by) / 2;
    expect(geo.d).toBe(`M ${ax} ${ay} C ${ax} ${midY}, ${bx} ${midY}, ${bx} ${by}`);
    expect(geo.labelX).toBe((ax + bx) / 2);
    expect(geo.labelY).toBe(midY);
  });

  it("accepts a custom height function instead of the static NODE_H", () => {
    const a = { id: "a", _x: 0, _y: 0 };
    const b = { id: "b", _x: 0, _y: 300 };
    const geo = buildEdgePath(a, b, 0, () => 260);
    expect(geo.d.startsWith(`M ${NODE_W / 2} 260`)).toBe(true);
  });
});

describe("computeSvgSize", () => {
  it("returns zero size for an empty layout", () => {
    expect(computeSvgSize([])).toEqual({ width: 0, height: 0 });
  });

  it("bounds width/height to the farthest node plus padding", () => {
    const positioned = [
      { id: "a", _x: 0, _y: 0 },
      { id: "b", _x: 400, _y: 50 },
    ];
    const size = computeSvgSize(positioned);
    expect(size.width).toBe(400 + NODE_W + PADDING);
    expect(size.height).toBe(50 + NODE_H + PADDING);
  });
});

// @vitest-environment jsdom
//
// Conference lineage graph arrow markers (lineage.js colours).
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GraphCanvas } from "../../../components/lineage/graph/graph-canvas";
import type { LineageEdge, LineageNode } from "../../../lib/lineage/core";
import type { GraphModel } from "../../../lib/lineage/layout/view-model";

afterEach(() => {
  cleanup();
});

function makeGraph(relation: LineageEdge["relation"]): GraphModel {
  const a: LineageNode & { _x: number; _y: number; _h: number } = {
    id: "a",
    is_focus: true,
    title: "A",
    _x: 0,
    _y: 0,
    _h: 150,
  };
  const b: LineageNode & { _x: number; _y: number; _h: number } = {
    id: "b",
    is_focus: false,
    title: "B",
    _x: 0,
    _y: 200,
    _h: 150,
  };
  const edge: LineageEdge = {
    src: "a",
    dst: "b",
    relation,
    confidence: 0.9,
    rationale: "because",
    provenance: {
      producer: { name: "fixture", version: "1" },
      evidence: { source: "fixture", kind: "test", sha256: "0".repeat(64) },
      classification: {
        method: "heuristic",
        provider: null,
        model: null,
        prompt_version: null,
        schema_version: "1",
      },
    },
  };
  return {
    focusId: "a",
    positioned: [a, b],
    edges: [
      {
        edge,
        markerClass: relation,
        label: null,
        path: { d: "M0,0 L0,200", labelX: 0, labelY: 100 },
        style: null,
      },
    ],
    svgSize: { width: 400, height: 400 },
  };
}

function markerFill(container: HTMLElement, markerId: string): string | null {
  const marker = container.querySelector(`marker#${markerId} path`);
  return marker?.getAttribute("fill") ?? null;
}

describe("GraphCanvas default marker lightness", () => {
  it("uses lineage.js's lightness (55%/72%) by default", () => {
    const { container } = render(
      <GraphCanvas graph={makeGraph("supersedes")} onSelect={() => {}} registerCard={() => {}} />,
    );
    expect(markerFill(container, "arrow-supersedes")).toBe("oklch(55% 0.14 75)");
  });
});

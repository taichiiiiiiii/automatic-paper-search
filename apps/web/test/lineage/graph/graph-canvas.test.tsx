// @vitest-environment jsdom
//
// P2 review: the deep-lineage graph must use deep.js's own
// `supersedes`/`successor` arrow-marker lightness (50%/64%), not the
// conference lineage viewer's (lineage.js's 55%/72%) -- the two assets'
// `drawSvg` ship genuinely different `markers` arrays for just those
// two relations (components/lineage/graph/graph-canvas.tsx's header).
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

describe("GraphCanvas marker lightness (deep variant)", () => {
  it("uses lineage.js's lightness (55%/72%) by default", () => {
    const { container } = render(
      <GraphCanvas graph={makeGraph("supersedes")} onSelect={() => {}} registerCard={() => {}} />,
    );
    expect(markerFill(container, "arrow-supersedes")).toBe("oklch(55% 0.14 75)");
  });

  it('uses deep.js\'s own lightness (50%/64%) when cardVariant="deep"', () => {
    const { container } = render(
      <GraphCanvas
        graph={makeGraph("supersedes")}
        onSelect={() => {}}
        registerCard={() => {}}
        cardVariant="deep"
      />,
    );
    expect(markerFill(container, "arrow-supersedes")).toBe("oklch(50% 0.14 75)");
  });

  it("successor marker also differs between variants", () => {
    const defaultRender = render(
      <GraphCanvas graph={makeGraph("successor")} onSelect={() => {}} registerCard={() => {}} />,
    );
    expect(markerFill(defaultRender.container, "arrow-successor")).toBe("oklch(72% 0.13 80)");
    defaultRender.unmount();

    const deepRender = render(
      <GraphCanvas
        graph={makeGraph("successor")}
        onSelect={() => {}}
        registerCard={() => {}}
        cardVariant="deep"
      />,
    );
    expect(markerFill(deepRender.container, "arrow-successor")).toBe("oklch(64% 0.13 80)");
  });

  it("other relations' marker colors are unaffected by cardVariant", () => {
    const { container } = render(
      <GraphCanvas
        graph={makeGraph("extends")}
        onSelect={() => {}}
        registerCard={() => {}}
        cardVariant="deep"
      />,
    );
    expect(markerFill(container, "arrow-extends")).toBe("oklch(62% 0.14 145)");
  });
});

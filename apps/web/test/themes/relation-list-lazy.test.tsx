// @vitest-environment jsdom
//
// #515: "関係の一覧" starts closed above 30 relations, but its rows (an <li>
// with titles, method, confidence, an evidence button and a prefilled
// GitHub report link per edge) were rendered inside the closed <details>
// anyway. On a 588-relation theme (Neural Radiance Fields) that was 6,488 of
// the page's 9,466 elements, and WebKit spent ~3 s per action serialising
// that hidden subtree for the Playwright trace, so the WebKit e2e job ran
// past its 40-minute budget. The rows are now rendered only while the list
// is open; opening it renders them, closing it drops them again.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EdgeRelationList } from "../../components/themes/EdgeEvidence";
import type { LineageEdge, LineageNode } from "../../lib/themes-quality";

function graph(edgeCount: number): {
  edges: LineageEdge[];
  nodeById: Map<string, LineageNode>;
} {
  const nodeCount = 80;
  const nodes: LineageNode[] = Array.from({ length: nodeCount }, (_, i) => ({
    id: `p${i}`,
    is_focus: i === 0,
    title: `Paper ${i}`,
    year: 2015 + (i % 10),
  }));
  const edges: LineageEdge[] = Array.from({ length: edgeCount }, (_, i) => ({
    src: `p${i % nodeCount}`,
    dst: `p${(i * 7 + 1) % nodeCount}`,
    relation: i % 5 === 0 ? "extends" : "baseline_only",
    confidence: 0.6,
    rationale: `edge ${i} の根拠。引用文: "We build on prior work [${i}]."`,
  })) as LineageEdge[];
  return { edges, nodeById: new Map(nodes.map((n) => [n.id, n])) };
}

const THEME = { name: "Synthetic", slug: "synthetic" };

function details(): HTMLDetailsElement {
  const el = screen.getByText(/^関係の一覧（/).closest("details");
  if (!el) throw new Error("relation list <details> not found");
  return el;
}

function toggle(open: boolean): void {
  const el = details();
  el.open = open;
  fireEvent(el, new Event("toggle"));
}

afterEach(cleanup);

describe("relation list renders its rows only while open (#515)", () => {
  it("a closed 600-relation list keeps its rows out of the DOM", () => {
    const { edges, nodeById } = graph(600);
    render(
      <EdgeRelationList
        edges={edges}
        nodeById={nodeById}
        selectedKey={null}
        onSelect={() => {}}
        theme={THEME}
      />,
    );
    expect(screen.getByText("関係の一覧（600 件）")).toBeTruthy();
    expect(details().open).toBe(false);
    expect(screen.queryByTestId("edge-relation-list")).toBeNull();
    // Summary only: the hidden subtree no longer grows with the edge count.
    expect(details().querySelectorAll("*").length).toBeLessThan(10);
  });

  it("opening renders every row, closing drops them again", () => {
    const { edges, nodeById } = graph(600);
    render(
      <EdgeRelationList
        edges={edges}
        nodeById={nodeById}
        selectedKey={null}
        onSelect={() => {}}
        theme={THEME}
      />,
    );
    toggle(true);
    const list = screen.getByTestId("edge-relation-list");
    expect(list.querySelectorAll("li")).toHaveLength(600);
    expect(list.querySelectorAll("a[data-report-edge]")).toHaveLength(600);
    toggle(false);
    expect(screen.queryByTestId("edge-relation-list")).toBeNull();
  });

  it("30 or fewer relations still start open with their rows", () => {
    const { edges, nodeById } = graph(30);
    render(
      <EdgeRelationList edges={edges} nodeById={nodeById} selectedKey={null} onSelect={() => {}} />,
    );
    expect(details().open).toBe(true);
    expect(screen.getByTestId("edge-relation-list").querySelectorAll("li")).toHaveLength(30);
  });

  it("a filter crossing the 30-relation line still opens / closes the list", () => {
    const big = graph(600);
    const small = graph(12);
    const { rerender } = render(
      <EdgeRelationList
        edges={big.edges}
        nodeById={big.nodeById}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    expect(details().open).toBe(false);
    rerender(
      <EdgeRelationList
        edges={small.edges}
        nodeById={small.nodeById}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    expect(details().open).toBe(true);
    expect(screen.getByTestId("edge-relation-list").querySelectorAll("li")).toHaveLength(12);
    rerender(
      <EdgeRelationList
        edges={big.edges}
        nodeById={big.nodeById}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    expect(details().open).toBe(false);
    expect(screen.queryByTestId("edge-relation-list")).toBeNull();
  });
});

// @vitest-environment jsdom
//
// #521 U7: on a phone the family-tree cards were 200 layout units tall
// (173px at the one-card-per-line fit zoom) around 128-146 units of
// content, and the tree's scroll box used `overscroll-contain`, so a
// vertical swipe that reached the box's end never handed over to the page.
// Phones now get a compact card height that still holds the tallest
// possible card content (every text line is clamped), wide screens keep
// NODE_H, and only horizontal overscroll stays contained.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineageTree } from "../../components/themes/LineageTree";
import { ARTIFACT_VERSION } from "../../lib/lineage/core";
import type { LineageArtifact, LineageEdge } from "../../lib/themes-quality";
import {
  cardHeightFor,
  LINE_GAP,
  layoutChronological,
  NODE_H,
  NODE_H_COMPACT,
  PADDING,
  PHONE_BOX_WIDTH,
  ROW_GAP,
} from "../../lib/themes-tree";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("") }));

function edge(src: string, dst: string): LineageEdge {
  return {
    src,
    dst,
    relation: "extends",
    confidence: 0.8,
    rationale: `${dst} cites ${src}`,
    provenance: {
      producer: { name: "test", version: "1" },
      evidence: { source: "semantic_scholar", kind: "citation-context", sha256: "a".repeat(64) },
      classification: {
        method: "s2_context_rule",
        provider: null,
        model: null,
        prompt_version: null,
        schema_version: "relation-classification-v1",
      },
    },
  } as LineageEdge;
}

const ARTIFACT: LineageArtifact = {
  schema_version: ARTIFACT_VERSION,
  root: null,
  nodes: [
    { id: "a", is_focus: true, title: "Alpha", year: 2015, citation_count: 5000 },
    { id: "b", is_focus: false, title: "Beta", year: 2017, citation_count: 800 },
    { id: "c", is_focus: false, title: "Gamma", year: 2017, citation_count: 40 },
  ],
  // Edges keep every card on screen (orphans are hidden by default).
  edges: [edge("a", "b"), edge("a", "c")],
  clusters: [],
  meta: { generated_at: "2026-10-11T00:00:00Z" },
};

/** Tallest card content in layout units: py-2 (8+8) + 1px borders, the venue
 * row (16), and title / tldr (each mt-1 + two clamped 16px lines), authors
 * and citations (each mt-1 + one 16px line). */
const MAX_CARD_CONTENT = 8 + 16 + (4 + 32) + (4 + 32) + (4 + 16) + (4 + 16) + 8 + 2;

const originalWidth = window.innerWidth;
function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/themes/?theme=t");
  localStorage.setItem("pp.theme.onboarded", "1");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  setViewport(originalWidth);
});

describe("compact card height on phones (#521 U7)", () => {
  it("picks the compact height below the phone box width and NODE_H above it", () => {
    expect(NODE_H).toBe(200);
    expect(cardHeightFor(412 - 34)).toBe(NODE_H_COMPACT);
    expect(cardHeightFor(PHONE_BOX_WIDTH - 1)).toBe(NODE_H_COMPACT);
    expect(cardHeightFor(PHONE_BOX_WIDTH)).toBe(NODE_H);
    expect(cardHeightFor(1240)).toBe(NODE_H);
    // Unknown width (not measured yet): keep the wide-screen height.
    expect(cardHeightFor(Number.NaN)).toBe(NODE_H);
  });

  it("keeps the compact height above the tallest clamped card content, within 24 units", () => {
    expect(NODE_H_COMPACT).toBeGreaterThanOrEqual(MAX_CARD_CONTENT);
    expect(NODE_H_COMPACT - MAX_CARD_CONTENT).toBeLessThanOrEqual(24);
  });

  it("lays rows and wrapped lines out with the given card height", () => {
    const { positioned, yearLabels, totalH } = layoutChronological(ARTIFACT.nodes, [], "rank", {
      maxPerLine: 1,
      nodeH: NODE_H_COMPACT,
    });
    const y = (id: string) => positioned.find((p) => p.id === id)?._y as number;
    expect(y("a")).toBe(PADDING);
    // 2017 starts one compact band + ROW_GAP lower; its second line one compact card + LINE_GAP lower.
    expect(y("b")).toBe(PADDING + NODE_H_COMPACT + ROW_GAP);
    expect(Math.abs(y("c") - y("b"))).toBe(NODE_H_COMPACT + LINE_GAP);
    const y2017 = yearLabels.find((l) => l.label === "2017");
    expect(y2017?.bottom).toBe((y2017?.top as number) + 2 * NODE_H_COMPACT + LINE_GAP);
    // PADDING + 2015 band + ROW_GAP + 2017 band (two lines) + ROW_GAP + PADDING.
    expect(totalH).toBe(
      PADDING + NODE_H_COMPACT + ROW_GAP + (2 * NODE_H_COMPACT + LINE_GAP) + ROW_GAP + PADDING,
    );
  });

  it("defaults to NODE_H when no card height is given (wide screens unchanged)", () => {
    const { positioned } = layoutChronological(ARTIFACT.nodes, [], "rank", { maxPerLine: 1 });
    const b = positioned.find((p) => p.id === "b")?._y as number;
    expect(b).toBe(PADDING + NODE_H + ROW_GAP);
  });

  it("renders compact cards at a 412px viewport and NODE_H cards at 1280px", () => {
    setViewport(412);
    const { unmount } = render(<LineageTree artifact={ARTIFACT} slug="t" themeName="T" />);
    const fo = () =>
      [...document.querySelectorAll("g[data-node-id] > *")]
        .filter((el) => el.localName === "foreignObject")
        .map((f) => Number(f.getAttribute("height")));
    expect(fo().length).toBe(3);
    expect(new Set(fo())).toEqual(new Set([NODE_H_COMPACT]));
    unmount();

    setViewport(1280);
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="T" />);
    expect(new Set(fo())).toEqual(new Set([NODE_H]));
  });
});

describe("tree scroll box hands vertical overscroll to the page (#521 U7)", () => {
  it("contains only horizontal overscroll", () => {
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="T" />);
    const svg = document.querySelector("svg[data-zoom]") as SVGSVGElement;
    const box = svg.parentElement as HTMLElement;
    const classes = box.className.split(/\s+/);
    expect(classes).toContain("overflow-auto");
    expect(classes).toContain("overscroll-x-contain");
    expect(classes).not.toContain("overscroll-contain");
    expect(classes).not.toContain("overscroll-y-contain");
  });
});

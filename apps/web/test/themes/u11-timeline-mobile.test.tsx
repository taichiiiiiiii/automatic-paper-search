// @vitest-environment jsdom
//
// #521 U11: the year × citation view on a phone.
// (i) A touch screen cannot "put the pointer on a line", so the note under
//     the chart must say what a tap does instead (decided after mount via
//     matchMedia("(hover: none)"), while mouse users keep the old note.
// (ii) In a box narrower than the default 640 px chart, the chart is laid
//     out at the box width so the whole span of years is visible without
//     side-scrolling; a wide box keeps the old 640 px chart.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineageTree } from "../../components/themes/LineageTree";
import { ARTIFACT_VERSION } from "../../lib/lineage/core";
import { layoutYearCitationTimeline, timelineFitOptions } from "../../lib/lineage/theme-timeline";
import type { LineageArtifact, LineageEdge } from "../../lib/themes-quality";

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));

function e(src: string, dst: string, relation: string): LineageEdge {
  return {
    src,
    dst,
    relation,
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

// Five publication years (2020-2024), like the NeRF theme.
const ARTIFACT: LineageArtifact = {
  schema_version: ARTIFACT_VERSION,
  root: null,
  nodes: [
    { id: "a", is_focus: true, title: "Alpha", year: 2020, citation_count: 9000 },
    { id: "b", is_focus: false, title: "Beta", year: 2021, citation_count: 800 },
    { id: "c", is_focus: false, title: "Gamma", year: 2021, citation_count: 40 },
    { id: "d", is_focus: false, title: "Delta", year: 2022, citation_count: 300 },
    { id: "e", is_focus: false, title: "Epsilon", year: 2023, citation_count: 12 },
    { id: "f", is_focus: false, title: "Phi", year: 2024, citation_count: 3 },
  ],
  edges: [
    e("a", "b", "extends"),
    e("b", "d", "extends"),
    e("a", "c", "baseline_only"),
    e("d", "e", "baseline_only"),
    e("e", "f", "baseline_only"),
  ],
  clusters: [],
  meta: { generated_at: "2026-10-11T00:00:00Z" },
};

function stubHover(noHover: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({
      matches: q.includes("hover: none") ? noHover : false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

function stubBoxWidth(w: number): void {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(w);
}

function note(): string {
  return document.getElementById("theme-after-tree")?.textContent ?? "";
}

function timelineWidth(): number {
  const svg = document.querySelector("[data-theme-timeline]") as SVGSVGElement;
  return Number(svg.getAttribute("width"));
}

beforeEach(() => {
  search = "theme=t&view=timeline";
  window.history.replaceState(null, "", "/themes/?theme=t&view=timeline");
  localStorage.clear();
  localStorage.setItem("pp.theme.onboarded", "1");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("#521 U11 note under the year × citation view", () => {
  it("tells touch users to tap, not to put the pointer on a line", () => {
    stubHover(true);
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect(note()).not.toContain("置くと");
    expect(note()).toContain("タップ");
    expect(note()).toContain("関係の一覧");
  });

  it("keeps the mouse note unchanged", () => {
    stubHover(false);
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect(note()).toBe(
      "点を選ぶと、その論文の土台と発展を下に表示します。線の上に置くと関係が出ます。",
    );
  });

  it("does not change the family-tree note on touch", () => {
    stubHover(true);
    search = "theme=t";
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect(note()).toContain("カードを選ぶと土台と発展");
  });
});

describe("#521 U11 chart width in a narrow box", () => {
  it("lays the chart out at the box width on a 412 px phone (box 378 px)", () => {
    stubHover(true);
    stubBoxWidth(378);
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect(timelineWidth()).toBeLessThanOrEqual(378);
    expect(timelineWidth()).toBeGreaterThan(300);
    // Every year still gets a tick.
    const labels = [...document.querySelectorAll("[data-theme-timeline] text")].map(
      (t) => t.textContent,
    );
    for (const y of ["2020", "2021", "2022", "2023", "2024"]) expect(labels).toContain(y);
  });

  it("keeps the 640 px chart in a wide box", () => {
    stubHover(false);
    stubBoxWidth(1230);
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect(timelineWidth()).toBe(640);
  });

  it("keeps the 640 px chart before the box is measured", () => {
    stubHover(false);
    stubBoxWidth(0);
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect(timelineWidth()).toBe(640);
  });

  it("refits when switching to the timeline from the tree", () => {
    stubHover(true);
    stubBoxWidth(378);
    search = "theme=t";
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const toggle = document.querySelector("[data-view-toggle]") as HTMLElement;
    fireEvent.click(within(toggle).getByRole("button", { name: /年×被引用/ }));
    expect(timelineWidth()).toBeLessThanOrEqual(378);
    expect(screen.getByRole("group", { name: /年（横）と被引用数/ })).toBeTruthy();
  });
});

describe("timelineFitOptions (#521 U11)", () => {
  it("keeps the desktop chart for wide or unmeasured boxes", () => {
    for (const w of [null, 0, -5, 640, 1230]) {
      expect(timelineFitOptions(w)).toEqual({ minWidth: 640, minColW: 64 });
    }
  });

  it("fits a phone box with 40 px columns", () => {
    expect(timelineFitOptions(378.6)).toEqual({ minWidth: 378, minColW: 40 });
  });

  it("still scrolls inside the box when the years cannot fit at 40 px", () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, year: 2010 + i }));
    const layout = layoutYearCitationTimeline(nodes, timelineFitOptions(378));
    expect(layout.width).toBe(56 + 24 + 12 * 40);
  });
});

describe("tap areas sit below every dot (#521 U11)", () => {
  it("draws all invisible tap circles before the first dot", () => {
    stubHover(true);
    stubBoxWidth(378);
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const circles = [...document.querySelectorAll("[data-theme-timeline] circle")];
    const lastTap = Math.max(
      ...circles.map((c, i) => (c.getAttribute("role") === "button" ? -1 : i)),
    );
    const firstDot = circles.findIndex((c) => c.getAttribute("role") === "button");
    expect(circles.filter((c) => c.getAttribute("role") !== "button")).toHaveLength(6);
    expect(firstDot).toBeGreaterThan(lastTap);
  });

  it("selects the paper when its tap area is clicked", () => {
    stubHover(true);
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const taps = document.querySelectorAll("[data-timeline-tap-areas] circle");
    fireEvent.click(taps[0] as Element);
    const pressed = document.querySelectorAll('[data-theme-timeline] [aria-pressed="true"]');
    expect(pressed).toHaveLength(1);
  });
});

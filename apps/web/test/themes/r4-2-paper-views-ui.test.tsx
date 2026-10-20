// @vitest-environment jsdom
//
// Design doc 48 P0-5 / P1-3 / P1-5 on the theme viewer and the catalog
// card: the Prior / Derivative panel (selected via ?focus= or the picker),
// the two-paper path, the year × citation timeline toggle, and the
// catalog's "系譜での位置" section.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogPaperCard } from "../../components/catalog/catalog-paper-card";
import { ThemePositionSection } from "../../components/catalog/catalog-theme-position";
import { LineageTree } from "../../components/themes/LineageTree";
import { ARTIFACT_VERSION } from "../../lib/lineage/core";
import type { ThemePosition } from "../../lib/lineage/theme-position";
import type { LineageArtifact, LineageEdge } from "../../lib/themes-quality";

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));

function e(src: string, dst: string, relation: string, confidence = 0.8): LineageEdge {
  return {
    src,
    dst,
    relation,
    confidence,
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

// a → b → d strong; a → c → d references; d → f extends; e → d reference.
const ARTIFACT: LineageArtifact = {
  schema_version: ARTIFACT_VERSION,
  root: null,
  nodes: [
    { id: "a", is_focus: true, title: "Alpha", year: 2015, citation_count: 5000 },
    { id: "b", is_focus: false, title: "Beta", year: 2017, citation_count: 800 },
    { id: "c", is_focus: false, title: "Gamma", year: 2018, citation_count: 40 },
    { id: "d", is_focus: false, title: "Delta", year: 2020, citation_count: 300 },
    { id: "e", is_focus: false, title: "Epsilon", year: 2019, citation_count: 1 },
    { id: "f", is_focus: false, title: "Phi", year: 2022, citation_count: 12 },
  ],
  edges: [
    e("a", "b", "extends"),
    e("b", "d", "supersedes", 0.9),
    e("d", "f", "extends"),
    e("a", "c", "baseline_only", 0.5),
    e("c", "d", "baseline_only", 0.5),
    e("e", "d", "baseline_only", 0.5),
  ],
  clusters: [],
  meta: { generated_at: "2026-10-11T00:00:00Z" },
};

beforeEach(() => {
  search = "";
  window.history.replaceState(null, "", "/themes/?theme=t");
  localStorage.clear();
  localStorage.setItem("pp.theme.onboarded", "1");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function panel(): HTMLElement {
  return document.querySelector("[data-prior-derivative]") as HTMLElement;
}
function side(name: "prior" | "derivative"): HTMLElement {
  return panel().querySelector(`[data-neighbor-side="${name}"]`) as HTMLElement;
}

describe("Prior / Derivative panel (P0-5)", () => {
  it("is empty until a paper is picked, then lists 土台 and 発展 with relation labels", () => {
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect(panel().textContent).toContain("論文ごとの土台と発展");
    expect(panel().querySelector("[data-neighbor-side]")).toBeNull();

    const select = panel().querySelector("[data-neighbor-select]") as HTMLSelectElement;
    // Options are sorted by year.
    expect([...select.options].map((o) => o.value)).toEqual(["", "a", "b", "c", "e", "d", "f"]);
    fireEvent.change(select, { target: { value: "d" } });

    const prior = side("prior");
    const items = [...prior.querySelectorAll("li")];
    expect(items.map((li) => li.getAttribute("data-neighbor-kind"))).toEqual([
      "strong",
      "strong-indirect",
      "reference",
      "reference",
    ]);
    expect(items[0]?.textContent).toContain("置換（候補）");
    expect(items[0]?.textContent).toContain("Beta");
    expect(items[1]?.textContent).toContain("拡張（候補）・2 段");
    expect(items[1]?.textContent).toContain("経由: Beta");
    expect(items[2]?.textContent).toContain("参照（背景）");
    expect(within(side("derivative")).getByText("Phi")).toBeTruthy();
    expect(window.location.search).toContain("focus=d");
  });

  it("selects from ?focus=, opens the evidence of a row, and moves to a neighbour", () => {
    search = "theme=t&focus=b";
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect(
      panel().querySelector("[data-neighbor-selected]")?.getAttribute("data-neighbor-selected"),
    ).toBe("b");
    // The selected card gets a ring (the card is a button since the UX audit).
    const card = document.querySelector('g[data-node-id="b"] [data-node-card]') as HTMLElement;
    expect(card.className).toContain("ring-2");
    expect(card.getAttribute("aria-pressed")).toBe("true");

    const evidence = side("derivative").querySelector("[data-neighbor-evidence]") as HTMLElement;
    fireEvent.click(evidence);
    const ev = screen.getByTestId("edge-evidence-panel");
    expect(ev.textContent).toContain("Delta");

    fireEvent.click(within(side("prior")).getByRole("button", { name: "Alpha" }));
    expect(
      panel().querySelector("[data-neighbor-selected]")?.getAttribute("data-neighbor-selected"),
    ).toBe("a");
    expect(window.location.search).toContain("focus=a");
  });

  it("ignores an unknown ?focus=", () => {
    search = "theme=t&focus=nope";
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect(panel().querySelector("[data-neighbor-selected]")).toBeNull();
  });
});

describe("two-paper path (P1-5)", () => {
  it("finds the strong path, highlights it, and reports unconnected pairs", () => {
    search = "theme=t&focus=a&to=d";
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const result = document.querySelector("[data-lineage-path-result]") as HTMLElement;
    expect(result.textContent).toContain("2 段（強い関係 2 本");
    const titles = [...result.querySelectorAll("li > button")].map((b) => b.textContent);
    expect(titles.map((t) => t?.replace(/^\d{4}\s*/, ""))).toEqual(["Alpha", "Beta", "Delta"]);
    expect(document.querySelectorAll('g[data-lineage-path="1"]')).toHaveLength(2);

    const sel = document.querySelector("[data-path-select]") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "e" } });
    const r2 = document.querySelector("[data-lineage-path-result]") as HTMLElement;
    expect(r2.textContent).toContain("↑");
    expect(window.location.search).toContain("to=e");
  });

  it("says when two papers are not connected", () => {
    const art = {
      ...ARTIFACT,
      nodes: [...ARTIFACT.nodes, { id: "z", is_focus: false, title: "Zeta", year: 2021 }],
    };
    search = "theme=t&focus=a&to=z";
    render(<LineageTree artifact={art} slug="t" themeName="Test" />);
    expect(document.querySelector("[data-lineage-path-none]")?.textContent).toContain(
      "つながっていません",
    );
  });
});

describe("year × citation timeline (P1-5)", () => {
  it("toggles the view, draws one dot per paper, and selects a paper on click", () => {
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect(document.querySelector("[data-theme-timeline]")).toBeNull();
    const toggle = document.querySelector("[data-view-toggle]") as HTMLElement;
    fireEvent.click(within(toggle).getByRole("button", { name: /年×被引用/ }));
    const svg = document.querySelector("[data-theme-timeline]") as SVGSVGElement;
    expect(svg).toBeTruthy();
    expect(svg.querySelectorAll("[data-timeline-node]")).toHaveLength(6);
    expect(svg.getAttribute("style")).toBeNull();
    expect(window.location.search).toContain("view=timeline");

    const dot = svg.querySelector(
      '[data-timeline-node="d"] circle[role="button"]',
    ) as SVGCircleElement;
    fireEvent.click(dot);
    expect(
      panel().querySelector("[data-neighbor-selected]")?.getAttribute("data-neighbor-selected"),
    ).toBe("d");
    expect(dot.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(toggle).getByRole("button", { name: /家系図/ }));
    expect(document.querySelector("[data-theme-timeline]")).toBeNull();
    expect(window.location.search).not.toContain("view=");
  });

  it("opens straight in the timeline with ?view=timeline", () => {
    search = "theme=t&view=timeline";
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect(document.querySelector("[data-theme-timeline]")).toBeTruthy();
  });
});

describe("系譜での位置 on the catalog card (P1-3)", () => {
  const pos: ThemePosition = {
    slug: "graph-neural-network",
    theme: "Graph Neural Network",
    tier: "unaudited",
    nodeId: "openalex:W1",
    title: "GCN",
    year: 2017,
    derivedBy: { extends: 2, baseline_only: 5 },
    buildsOn: { baseline_only: 1 },
    derivativeCount: 7,
    priorCount: 1,
    strongDerivativeCount: 2,
    onMainPath: true,
  };

  it("links to the theme page focused on the paper and summarises its role", () => {
    render(<ThemePositionSection positions={[pos]} />);
    const section = document.querySelector("[data-theme-position]") as HTMLElement;
    expect(section.textContent).toContain("系譜での位置");
    const a = section.querySelector("a[data-theme-position-link]") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("/themes/?theme=graph-neural-network&focus=openalex%3AW1");
    expect(section.textContent).toContain("発展 7 本（拡張（候補） 2・参照（背景） 5）");
    expect(section.textContent).toContain("土台 1 本");
    expect(section.textContent).toContain("本流");
    expect(section.textContent).toContain("未監査");
  });

  it("renders nothing for a paper in no published theme", () => {
    const { container } = render(<ThemePositionSection positions={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows on the selected catalog card only", () => {
    const paper = {
      paper_id: "f".repeat(40),
      title: "GCN",
      authors: ["T. Kipf"],
      tags: [],
      abstract: "",
      type: "Poster",
      arxiv_id: "1609.02907",
    };
    const props = {
      paper,
      searchQuery: "",
      activeTags: new Set<string>(),
      onAddTagFromCard: () => {},
      onSelect: () => {},
      onClose: () => {},
      fullAbstract: undefined,
      pilotLineage: undefined,
      pilotLineageHref: "/lineage/",
      themePositions: [pos],
      revealIndex: null,
    };
    const { rerender } = render(
      <ul>
        <CatalogPaperCard {...props} isSelected={false} />
      </ul>,
    );
    expect(document.querySelector("[data-theme-position]")).toBeNull();
    rerender(
      <ul>
        <CatalogPaperCard {...props} isSelected={true} />
      </ul>,
    );
    expect(document.querySelector("[data-theme-position]")).toBeTruthy();
  });
});

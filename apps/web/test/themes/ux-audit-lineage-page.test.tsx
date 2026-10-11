// @vitest-environment jsdom
//
// UX audit of the theme lineage page (design 53 §系譜ページ): one toolbar
// with export/share folded into a disclosure, a <select> for the ordering,
// a reading guide that defines 本流・土台・発展・根拠 once with a legend
// of the line colours, zoom controls for the tree, cards that select a
// paper (instead of leaving the site), focus returning to the opener when
// the evidence panel closes, and a skip link past the graph.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineageTree } from "../../components/themes/LineageTree";
import {
  ThemeCodeLinksSection,
  ThemeNewPapersSection,
} from "../../components/themes/ThemeFeedSections";
import { ARTIFACT_VERSION } from "../../lib/lineage/core";
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

const ARTIFACT: LineageArtifact = {
  schema_version: ARTIFACT_VERSION,
  root: null,
  nodes: [
    { id: "a", is_focus: true, title: "Alpha", year: 2018, arxiv_id: "1801.00001" },
    { id: "b", is_focus: false, title: "Beta", year: 2019 },
    { id: "c", is_focus: false, title: "Gamma", year: 2020 },
  ],
  edges: [e("a", "b", "extends"), e("b", "c", "supersedes"), e("a", "c", "baseline_only")],
  clusters: [],
  meta: {},
};

beforeEach(() => {
  search = "";
  localStorage.clear();
  window.history.replaceState(null, "", "/themes/?theme=t");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("toolbar", () => {
  it("folds export and share into one closed disclosure", () => {
    localStorage.setItem("pp.theme.onboarded", "1");
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const menu = document.querySelector("[data-export-menu]") as HTMLDetailsElement;
    expect(menu.tagName).toBe("DETAILS");
    expect(menu.open).toBe(false);
    for (const sel of ['[data-export="bibtex"]', '[data-export="nodes-csv"]', "[data-share-url]"]) {
      expect(menu.querySelector(sel), sel).toBeTruthy();
    }
    // Nothing exported sits loose in the toolbar any more.
    const toolbar = document.querySelector("[data-theme-toolbar]") as HTMLElement;
    const loose = [...toolbar.querySelectorAll("[data-export]")].filter((el) => !menu.contains(el));
    expect(loose).toHaveLength(0);
  });

  it("orders the tree with a labelled <select>, keeps ?xaxis= and explains the choice", () => {
    localStorage.setItem("pp.theme.onboarded", "1");
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const select = screen.getByRole("combobox", { name: "並べ方" }) as HTMLSelectElement;
    expect(select.value).toBe("rank");
    expect([...select.options].map((o) => o.textContent)).toContain("研究の流れでまとめる");
    fireEvent.change(select, { target: { value: "genealogy" } });
    expect(window.location.search).toContain("xaxis=genealogy");
    expect(document.getElementById("theme-xaxis-hint")?.textContent).toContain("研究の流れ");
  });

  it("restores ?xaxis= from the URL into the select", () => {
    localStorage.setItem("pp.theme.onboarded", "1");
    search = "theme=t&xaxis=venue";
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect((screen.getByRole("combobox", { name: "並べ方" }) as HTMLSelectElement).value).toBe(
      "venue",
    );
  });
});

describe("reading guide", () => {
  it("is open on the first visit, defines the terms once and lists every relation colour", () => {
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const guide = document.querySelector("[data-reading-guide]") as HTMLDetailsElement;
    expect(guide.open).toBe(true);
    for (const term of ["本流", "土台", "発展", "根拠"]) {
      expect(within(guide).getAllByText(term, { selector: "dt" })).toHaveLength(1);
    }
    const legend = guide.querySelector("[data-relation-legend]") as HTMLElement;
    expect(legend.querySelectorAll("li")).toHaveLength(6);
    expect(legend.textContent).toContain("参照（背景）");
    expect(legend.textContent).not.toMatch(/baseline_only|supersedes/);
  });

  it("stays closed once the reader has closed it", () => {
    const first = render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const guide = document.querySelector("[data-reading-guide]") as HTMLDetailsElement;
    guide.open = false;
    fireEvent(guide, new Event("toggle"));
    expect(localStorage.getItem("pp.theme.onboarded")).toBe("1");
    first.unmount();
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect((document.querySelector("[data-reading-guide]") as HTMLDetailsElement).open).toBe(false);
  });
});

describe("tree interaction", () => {
  it("exposes cards and edges to assistive tech (no role=img on the graph)", () => {
    localStorage.setItem("pp.theme.onboarded", "1");
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const graph = screen.getByRole("group", { name: /時系列家系図/ });
    expect(graph.tagName.toLowerCase()).toBe("svg");
    expect(within(graph).getAllByRole("button", { name: /土台と発展を表示/ })).toHaveLength(3);
    const skip = screen.getByRole("link", { name: "家系図を飛ばして一覧へ" });
    expect(skip.getAttribute("href")).toBe("#theme-after-tree");
    expect(document.getElementById("theme-after-tree")).toBeTruthy();
  });

  it("selecting a card shows the selection bar and the 土台／発展 panel and writes ?focus=", () => {
    localStorage.setItem("pp.theme.onboarded", "1");
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const card = document.querySelector('g[data-node-id="b"] [data-node-card]') as HTMLElement;
    expect(card.tagName).toBe("BUTTON");
    fireEvent.click(card);
    const bar = document.querySelector("[data-selected-paper-bar]") as HTMLElement;
    expect(bar.textContent).toContain("Beta");
    expect(bar.textContent).toContain("土台 1 本・発展 1 本");
    expect(window.location.search).toContain("focus=b");
    // Clicking the selected card again clears the selection.
    fireEvent.click(card);
    expect(document.querySelector("[data-selected-paper-bar]")).toBeNull();
  });

  it("zooms the tree by resizing the svg while keeping its viewBox", () => {
    localStorage.setItem("pp.theme.onboarded", "1");
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const svg = screen.getByRole("group", { name: /時系列家系図/ });
    const viewBox = svg.getAttribute("viewBox");
    const w0 = Number(svg.getAttribute("width"));
    fireEvent.click(screen.getByRole("button", { name: "縮小" }));
    const w1 = Number(svg.getAttribute("width"));
    expect(w1).toBeLessThan(w0);
    expect(svg.getAttribute("viewBox")).toBe(viewBox);
    expect(svg.getAttribute("style")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "拡大" }));
    expect(Number(svg.getAttribute("width"))).toBe(w0);
  });

  it("returns focus to the edge that opened the evidence panel when it closes", () => {
    localStorage.setItem("pp.theme.onboarded", "1");
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const line = document.querySelector('line[role="button"]') as SVGLineElement;
    line.focus();
    fireEvent.keyDown(line, { key: "Enter" });
    const panel = screen.getByTestId("edge-evidence-panel");
    expect(document.activeElement).toBe(within(panel).getByRole("heading"));
    fireEvent.click(within(panel).getByRole("button", { name: "根拠パネルを閉じる" }));
    expect(screen.queryByTestId("edge-evidence-panel")).toBeNull();
    expect(document.activeElement).toBe(line);
  });
});

describe("secondary sections", () => {
  it("新着 and コードとモデル are closed disclosures with a count in the summary", () => {
    const nodes = ARTIFACT.nodes;
    const { container } = render(
      <>
        <ThemeNewPapersSection
          slug="t"
          nodes={nodes}
          data={
            {
              window: { from: "2026-07-01", to: "2026-10-01" },
              minLineageCites: 2,
              items: [],
            } as never
          }
        />
        <ThemeCodeLinksSection
          nodes={nodes}
          links={
            {
              a: { code: { url: "https://github.com/x/y", stars: 10, source: "paper_repos" } },
            } as never
          }
        />
      </>,
    );
    const details = [...container.querySelectorAll("details")];
    expect(details).toHaveLength(2);
    expect(details.every((d) => !d.open)).toBe(true);
    expect(details[0]?.querySelector("summary")?.textContent).toContain("0 本");
    expect(details[1]?.querySelector("summary")?.textContent).toContain("1 本");
  });
});

describe("hover boxes are mouse / keyboard only", () => {
  it("a touch enter does not open the edge tooltip; a mouse enter does", () => {
    localStorage.setItem("pp.theme.onboarded", "1");
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const group = document.querySelector('line[role="button"]')?.parentElement as Element;
    fireEvent.pointerEnter(group, { pointerType: "touch" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(group, { pointerType: "mouse" });
    expect(screen.getByRole("tooltip").textContent).toContain("クリックで根拠を表示");
    fireEvent.pointerLeave(group, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

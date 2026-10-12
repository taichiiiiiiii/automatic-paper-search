// @vitest-environment jsdom
//
// UX audit of the theme page shell (design 53 §系譜ページ),
// components/themes/ThemesClient.tsx + ThemeGallery + ThemeTimeline +
// the keyboard-help dialog: the theme name is the h1, the stats are one
// line with the actual keywords, the picker links every theme, the
// secondary sections are closed disclosures that open from the UI, the
// timeline dots have a larger tap area, and the keyboard help dialog
// keeps focus inside and returns it on close.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineageTree } from "../../components/themes/LineageTree";
import { ThemesClient } from "../../components/themes/ThemesClient";
import { ThemeTimeline } from "../../components/themes/ThemeTimeline";
import * as dataThemes from "../../lib/data-themes";
import { ARTIFACT_VERSION, QUALITY_VERSION, type QualityRow } from "../../lib/lineage/core";
import * as themesFeed from "../../lib/themes-feed";
import type { LineageArtifact, LineageEdge } from "../../lib/themes-quality";

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));

function row(slug: string, label: string): QualityRow {
  return {
    collection_id: `theme:${slug}`,
    kind: "theme",
    slug,
    label,
    path: `themes/${slug}/lineage.json`,
    availability: "ready",
    audit_status: "passed",
    freshness: "fresh",
    generated_at: "2026-08-30T00:00:00Z",
    snapshot_date: null,
    node_count: 2,
    edge_count: 1,
    artifact_schema_version: "lineage-artifact-v1",
    input_sha256: "b".repeat(64),
    audit: {
      fixture_sha256: "9".repeat(64),
      evaluated_at: "2026-08-30T00:00:00Z",
      actor: "ci:audit-v1",
      checks: [
        { name: "artifact_contract_v1", status: "passed", observed: 0, expected: 0, evidence: [] },
        {
          name: "golden_fixture",
          status: "passed",
          observed: "fixture-sha",
          expected: "matching frozen fixture",
          evidence: [],
        },
      ],
    },
  } as QualityRow;
}

function edge(src: string, dst: string, relation: string): LineageEdge {
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
    { id: "a", is_focus: true, title: "Alpha", year: 2018, citation_count: 100 },
    { id: "b", is_focus: false, title: "Beta", year: 2020, citation_count: 10 },
  ],
  edges: [edge("a", "b", "extends")],
  clusters: [],
  meta: { generated_at: "2026-10-11T00:00:00Z", keywords: ["graph neural network", "GNN"] },
};

function mockData() {
  vi.spyOn(dataThemes, "fetchThemesManifest").mockResolvedValue({
    status: "ok",
    data: [
      { slug: "gnn", theme: "Graph Neural Network", paper_count: 2, year_range: [2018, 2020] },
      { slug: "moe", theme: "Mixture of Experts", paper_count: 2, year_range: [2018, 2020] },
    ],
  });
  vi.spyOn(dataThemes, "fetchThemeQualityRollup").mockResolvedValue({});
  vi.spyOn(dataThemes, "fetchLineageQualityManifest").mockResolvedValue({
    schema_version: QUALITY_VERSION,
    as_of: "2026-08-30T00:00:00Z",
    audit_version: "audit-v1",
    collections: [row("gnn", "Graph Neural Network"), row("moe", "Mixture of Experts")],
  });
  vi.spyOn(dataThemes, "fetchThemeArtifact").mockResolvedValue(ARTIFACT);
  vi.spyOn(dataThemes, "fetchThemeApiAccepting").mockResolvedValue(false);
  vi.spyOn(themesFeed, "fetchThemeNewPapers").mockResolvedValue({
    window: { from: "2026-07-01", to: "2026-10-01" },
    minLineageCites: 2,
    items: [],
  } as never);
  vi.spyOn(themesFeed, "fetchThemeCodeLinks").mockResolvedValue({
    a: { code: { url: "https://github.com/x/y", stars: 10, source: "paper_repos" }, hf: null },
  } as never);
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  search = "theme=gnn";
  localStorage.clear();
  localStorage.setItem("pp.theme.onboarded", "1");
  window.history.replaceState(null, "", "/themes/?theme=gnn");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ThemesClient page shell", () => {
  it("shows the theme name as the h1, one stats line with the keywords, and links every theme", async () => {
    mockData();
    render(<ThemesClient />);
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1.textContent).toContain("Graph Neural Network");
    expect(h1.textContent).toContain("の系譜");
    const stats = document.querySelector("[data-theme-stats]") as HTMLElement;
    expect(stats.textContent).toContain("2018–2020・2 論文・1 関係");
    expect(stats.textContent).toContain("検索キーワード: graph neural network, GNN");
    expect(stats.querySelector("[data-data-date]")?.getAttribute("data-data-date")).toBe(
      "2026-10-11",
    );
    const picker = screen.getByRole("region", { name: "テーマ一覧" });
    const links = within(picker).getAllByRole("link");
    // next/link drops the trailing slash outside the Next build (trailingSlash).
    expect(links.map((a) => a.getAttribute("href")?.replace("/themes/?", "/themes?"))).toEqual([
      "/themes?theme=gnn",
      "/themes?theme=moe",
    ]);
    expect(links[0]?.getAttribute("aria-current")).toBe("page");
  });

  it("keeps the theme in document.title when the static <title> is re-committed later", async () => {
    mockData();
    render(<ThemesClient />);
    await screen.findByRole("heading", { level: 1 });
    await flush();
    const themed = document.title;
    expect(themed).toMatch(/^.+ — テーマ別の系譜 \| PaperPilot$/);
    // What Next's late metadata commit does after hydration.
    let el = document.head.querySelector("title");
    if (!el) {
      el = document.createElement("title");
      document.head.append(el);
    }
    el.textContent = "テーマ別の系譜 | PaperPilot";
    await flush();
    expect(document.title).toBe(themed);
  });

  it("opens the closed 新着 / コードとモデル disclosures from their summaries", async () => {
    mockData();
    render(<ThemesClient />);
    await screen.findByRole("heading", { level: 1 });
    await flush();
    const newPapers = screen.getByRole("region", { name: /新着/ });
    const details = newPapers.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(details.querySelector("summary") as HTMLElement);
    // jsdom toggles <details> on a summary click like a browser does.
    expect(details.open).toBe(true);
    expect(
      within(newPapers).getByRole("link", { name: "Atom フィード" }).getAttribute("href"),
    ).toBe("/themes/gnn/feed.xml");
    const code = screen.getByRole("region", { name: "コードとモデル" });
    expect(code.querySelector("details")?.open).toBe(false);
    // The node card carries the コード badge.
    expect(document.querySelector('[data-node-id="a"] [data-badge="code"]')).toBeTruthy();
  });

  it("the request button toggles the about panel (aria-expanded)", async () => {
    mockData();
    render(<ThemesClient />);
    await screen.findByRole("heading", { level: 1 });
    const btn = screen.getByRole("button", { name: /新しいテーマを依頼/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("hero-details")).toBeTruthy();
  });
});

describe("ThemeTimeline tap area", () => {
  it("a click on the enlarged invisible circle selects the paper", () => {
    const onSelect = vi.fn();
    render(
      <ThemeTimeline
        nodes={ARTIFACT.nodes}
        edges={ARTIFACT.edges}
        selectedId={null}
        onSelectPaper={onSelect}
        mainPathKeys={null}
        mainPathNodeIds={null}
        pathKeys={new Set()}
        pathNodeIds={new Set()}
        matchSet={null}
      />,
    );
    const group = document.querySelector('[data-timeline-node="b"]') as SVGGElement;
    const circles = group.querySelectorAll("circle");
    expect(circles).toHaveLength(2);
    const hit = circles[0] as SVGCircleElement;
    expect(Number(hit.getAttribute("r"))).toBeGreaterThanOrEqual(14);
    expect(hit.getAttribute("role")).toBeNull();
    fireEvent.click(hit);
    expect(onSelect).toHaveBeenCalledWith("b");
  });
});

describe("keyboard help dialog", () => {
  it("opens from the toolbar, keeps Tab inside, closes on Esc and returns focus", () => {
    render(<LineageTree artifact={ARTIFACT} slug="gnn" themeName="GNN" />);
    const opener = screen.getByRole("button", { name: "キーボード操作の一覧" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: /キーボードショートカット/ });
    const close = within(dialog).getByRole("button", { name: "閉じる" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /キーボードショートカット/ })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("returns focus to the toolbar button after a mouse click that did not focus it (Safari)", () => {
    // Safari / macOS Firefox do not focus a button on click: activeElement
    // stays <body> while the dialog opens.
    render(<LineageTree artifact={ARTIFACT} slug="gnn" themeName="GNN" />);
    const opener = screen.getByRole("button", { name: "キーボード操作の一覧" });
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: /キーボードショートカット/ });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /キーボードショートカット/ })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("year rail", () => {
  it("pins the year labels to the left edge and scales them with the zoom", () => {
    render(<LineageTree artifact={ARTIFACT} slug="gnn" themeName="GNN" />);
    const rail = document.querySelector("[data-year-rail]") as SVGSVGElement;
    expect(rail.getAttribute("aria-hidden")).toBe("true");
    expect([...rail.querySelectorAll("text")].map((t) => t.textContent)).toEqual(
      expect.arrayContaining(["2018", "2020"]),
    );
    const g = rail.querySelector("g") as SVGGElement;
    expect(g.getAttribute("transform")).toBe("translate(0 0) scale(1)");
    fireEvent.click(screen.getByRole("button", { name: "縮小" }));
    expect(g.getAttribute("transform")).toBe("translate(0 0) scale(0.8)");
  });
});

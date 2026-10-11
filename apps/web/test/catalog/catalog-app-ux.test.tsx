// @vitest-environment jsdom
/**
 * Design doc 53 「学会の論文一覧」: rendered behaviour of the UX-audit
 * changes (conference switcher, single-type chips hidden, 要旨あり toggle
 * with `abs=1`, the Japanese-query empty state, the result-count line).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogApp } from "../../components/catalog/catalog-app";
import type { CatalogCopy } from "../../lib/catalog-copy";
import type { CatalogPaper } from "../../lib/catalog-core";
import * as catalogData from "../../lib/catalog-data";

const COPY: CatalogCopy = {
  display: "Test Conf",
  description: "desc",
  tagline: "tagline",
  lede: "lede",
  source: "source",
};

function paper(key: string, title: string, abstract: string, type = "Poster"): CatalogPaper {
  return { paper_id: key.repeat(40), title, authors: ["Alice"], tags: ["nlp"], abstract, type };
}

const PAPERS = [
  paper("a", "Paper A video diffusion", "About diffusion."),
  paper("b", "Paper B", ""),
  paper("c", "Paper C", "About retrieval."),
];

function mockDataLayer(papers: CatalogPaper[]) {
  vi.spyOn(catalogData, "fetchCatalogPapers").mockResolvedValue({
    status: "ok",
    papers,
    byId: new Map(papers.map((p) => [p.paper_id, p])),
  });
  vi.spyOn(catalogData, "fetchFullAbstract").mockResolvedValue({ status: "ready", text: "" });
  vi.spyOn(catalogData, "fetchPilotLineageIndex").mockResolvedValue(null);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/test-conf/");
});

async function renderLoaded(papers = PAPERS) {
  mockDataLayer(papers);
  render(
    <CatalogApp
      conf="test-conf"
      generated="2026-01-01"
      copy={COPY}
      conferences={[
        { slug: "test-conf", display: "Test Conf" },
        { slug: "other-2026", display: "Other 2026" },
      ]}
    />,
  );
  await screen.findByText("Paper B");
}

describe("CatalogApp UX audit (design doc 53)", () => {
  it("offers a conference switcher that links every other catalog", async () => {
    await renderLoaded();
    const nav = screen.getByRole("navigation", { name: "学会を切り替え", hidden: true });
    const link = nav.querySelector('a[href="/other-2026/"]');
    expect(link?.textContent).toBe("Other 2026");
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Test Conf");
  });

  it("hides the acceptance-type chips and the 0 Oral stat when every row is a Poster", async () => {
    await renderLoaded();
    expect(document.querySelector("button[data-type]")).toBeNull();
    expect(screen.queryByText(/Oral$/)).toBeNull();
  });

  it("keeps the type chips (labelled すべて) when Oral and Poster both exist", async () => {
    await renderLoaded([...PAPERS, paper("d", "Paper D", "x", "Oral")]);
    expect(screen.getByRole("button", { name: /すべて/ })).toBeTruthy();
    expect(document.querySelector('button[data-type="Oral"]')).not.toBeNull();
  });

  it("filters to rows with an abstract and writes abs=1 to the URL", async () => {
    await renderLoaded();
    expect(screen.getByText("全 3 件")).toBeTruthy();
    const toggle = document.querySelector("button[data-has-abstract]") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(await screen.findByText("2 件が該当（全 3 件）")).toBeTruthy();
    expect(screen.queryByText("Paper B")).toBeNull();
    expect(new URL(window.location.href).searchParams.get("abs")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: /フィルタ解除/ }));
    expect(await screen.findByText("Paper B")).toBeTruthy();
    expect(new URL(window.location.href).searchParams.has("abs")).toBe(false);
  });

  it("restores abs=1 from the URL on load", async () => {
    window.history.replaceState(null, "", "/test-conf/?abs=1");
    mockDataLayer(PAPERS);
    render(<CatalogApp conf="test-conf" generated="2026-01-01" copy={COPY} />);
    await screen.findByText("Paper C");
    expect(screen.queryByText("Paper B")).toBeNull();
  });

  it("explains a Japanese query that matches nothing", async () => {
    await renderLoaded();
    vi.useFakeTimers();
    fireEvent.change(document.getElementById("search") as HTMLInputElement, {
      target: { value: "拡散モデル" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    vi.useRealTimers();
    expect(await screen.findByText("「拡散モデル」に一致する論文はありません。")).toBeTruthy();
    expect(screen.getByText(/タイトルと要旨は英語です/)).toBeTruthy();
  });

  it("matches multi-word queries in any order", async () => {
    await renderLoaded();
    vi.useFakeTimers();
    fireEvent.change(document.getElementById("search") as HTMLInputElement, {
      target: { value: "diffusion video" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    vi.useRealTimers();
    expect(await screen.findByText("1 件が該当（全 3 件）")).toBeTruthy();
  });
});

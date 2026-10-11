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
import * as exportFormats from "../../lib/export-formats";

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

  it("finds papers from full-width Latin typed with a Japanese IME", async () => {
    await renderLoaded();
    vi.useFakeTimers();
    fireEvent.change(document.getElementById("search") as HTMLInputElement, {
      target: { value: "ｄｉｆｆｕｓｉｏｎ" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    vi.useRealTimers();
    expect(await screen.findByText("1 件が該当（全 3 件）")).toBeTruthy();
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

  it("sort select reorders the list and writes sort= to the URL", async () => {
    await renderLoaded();
    const titles = () => [...document.querySelectorAll("#paper-list h2")].map((h) => h.textContent);
    expect(titles()[0]).toBe("Paper A video diffusion");
    fireEvent.change(screen.getByRole("combobox", { name: "並び替え" }), {
      target: { value: "title" },
    });
    expect(new URL(window.location.href).searchParams.get("sort")).toBe("title");
    fireEvent.change(screen.getByRole("combobox", { name: "並び替え" }), {
      target: { value: "default" },
    });
    expect(new URL(window.location.href).searchParams.has("sort")).toBe(false);
  });

  it("フィルタ解除 clears search, tags, type and 要旨あり together", async () => {
    window.history.replaceState(null, "", "/test-conf/?q=paper&tags=nlp&abs=1");
    mockDataLayer(PAPERS);
    render(<CatalogApp conf="test-conf" generated="2026-01-01" copy={COPY} />);
    expect(await screen.findByText("2 件が該当（全 3 件）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /フィルタ解除/ }));
    expect(await screen.findByText("全 3 件")).toBeTruthy();
    expect((document.getElementById("search") as HTMLInputElement).value).toBe("");
    expect(window.location.search).toBe("");
  });

  it("BibTeX / CSV export the filtered rows; URLをコピー reports success", async () => {
    const download = vi.spyOn(exportFormats, "downloadText").mockImplementation(() => {});
    const copy = vi.spyOn(exportFormats, "copyText").mockResolvedValue(true);
    await renderLoaded();
    fireEvent.click(document.querySelector("button[data-has-abstract]") as HTMLButtonElement);
    fireEvent.click(await screen.findByRole("button", { name: /2 件を BibTeX で書き出す/ }));
    expect(download).toHaveBeenCalledTimes(1);
    const [bibName, bibText, bibMime] = download.mock.calls[0] as [string, string, string];
    expect(bibName).toMatch(/^test-conf-papers.*\.bib$/);
    expect(bibMime).toBe("application/x-bibtex");
    expect((bibText.match(/^@/gm) ?? []).length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: /2 件を CSV で書き出す/ }));
    const [csvName, csvText] = download.mock.calls[1] as [string, string, string];
    expect(csvName).toMatch(/\.csv$/);
    expect(csvText).toContain("Paper C");
    expect(csvText).not.toContain("Paper B");
    fireEvent.click(screen.getByRole("button", { name: "URLをコピー" }));
    expect(await screen.findByText("URL をコピーしました")).toBeTruthy();
    expect(copy).toHaveBeenCalledWith(expect.stringContaining("abs=1"));
  });

  it("Esc closes a directly opened detail and returns focus to its 詳細を開く button", async () => {
    const id = "c".repeat(40);
    window.history.replaceState(null, "", `/test-conf/?paper=${id}`);
    mockDataLayer(PAPERS);
    render(<CatalogApp conf="test-conf" generated="2026-01-01" copy={COPY} />);
    expect(await screen.findByRole("button", { name: "詳細を閉じる" })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(screen.queryByRole("button", { name: "詳細を閉じる" })).toBeNull();
    expect(window.location.search).toBe("");
    expect(document.activeElement).toBe(document.querySelector(`[data-select-paper="${id}"]`));
  });

  it("Esc inside the search box does not close the detail", async () => {
    const id = "c".repeat(40);
    window.history.replaceState(null, "", `/test-conf/?paper=${id}`);
    mockDataLayer(PAPERS);
    render(<CatalogApp conf="test-conf" generated="2026-01-01" copy={COPY} />);
    await screen.findByRole("button", { name: "詳細を閉じる" });
    fireEvent.keyDown(document.getElementById("search") as HTMLInputElement, { key: "Escape" });
    expect(screen.getByRole("button", { name: "詳細を閉じる" })).toBeTruthy();
  });

  it("詳細を開く pushes ?paper= and shows the full abstract; 詳細を閉じる goes back", async () => {
    await renderLoaded();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const id = "c".repeat(40);
    const open = document.querySelector(`[data-select-paper="${id}"]`) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(open);
    });
    expect(new URL(window.location.href).searchParams.get("paper")).toBe(id);
    expect(await screen.findByRole("button", { name: "詳細を閉じる" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "詳細を閉じる" }));
    expect(back).toHaveBeenCalled();
  });

  it("Back/Forward (popstate) restores the filters from the URL", async () => {
    await renderLoaded();
    await act(async () => {
      window.history.replaceState(null, "", "/test-conf/?q=retrieval");
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(await screen.findByText("1 件が該当（全 3 件）")).toBeTruthy();
    expect((document.getElementById("search") as HTMLInputElement).value).toBe("retrieval");
  });

  it("shows the expected paper count and download progress while loading", async () => {
    let finish: (v: Awaited<ReturnType<typeof catalogData.fetchCatalogPapers>>) => void = () => {};
    vi.spyOn(catalogData, "fetchCatalogPapers").mockImplementation((_slug, onProgress) => {
      onProgress?.(3 * 1_048_576);
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    render(<CatalogApp conf="test-conf" generated="2026-01-01" copy={COPY} expectedTotal={6552} />);
    expect(await screen.findByText(/6,552 本の論文一覧を読み込み中/)).toBeTruthy();
    expect(screen.getByText("3.0 MB")).toBeTruthy();
    await act(async () => {
      finish({ status: "ok", papers: PAPERS, byId: new Map(PAPERS.map((p) => [p.paper_id, p])) });
    });
    expect(await screen.findByText("Paper B")).toBeTruthy();
  });
});

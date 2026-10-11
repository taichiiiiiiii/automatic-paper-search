// @vitest-environment jsdom
//
// User-level interaction tests for the top page (UX audit, design 53,
// トップ・共通): what a visitor sees and can do -- read the counts, open a
// conference catalog, try an example query, open/close the suggestion list
// with the keyboard, expand 「検索した後は？」, and reach a theme lineage.
// Selectors are roles + accessible names, the same ones the Playwright
// suite under apps/web/e2e relies on.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Landing } from "../../components/landing/landing";
import * as dataLineage from "../../lib/data-lineage";
import * as dataSearch from "../../lib/data-search";
import { deriveLandingConferenceState } from "../../lib/landing";
import * as landingLineage from "../../lib/landing-lineage";
import type { QualityManifest, QualityRow } from "../../lib/lineage/core";
import type { SearchRow } from "../../lib/search-core";

const CONFERENCES = deriveLandingConferenceState([
  { name: "icml-2026", papers: 6552 },
  { name: "cvpr-2026", papers: 4068 },
]);

const ROWS: SearchRow[] = [
  ["Diffusion Models Beat GANs", "cvpr-2026", 0, ["Alice"], ["diffusion"], 2026, "Poster"],
  ["Reasoning with Diffusion", "icml-2026", 1, ["Bob"], ["reasoning"], 2026, "Oral"],
];
const IDS = { start: 0, paper_ids: ["a".repeat(40), "b".repeat(40)] };

function manifestWithTheme(): QualityManifest {
  // Only the fields the shelf reads; eligibility itself is covered by
  // landing-lineage.test.ts, so stub the selector's input via the real
  // module and assert on the rendered outcome.
  return { collections: [] } as unknown as QualityManifest;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(dataSearch, "loadSearchIndex").mockResolvedValue({ status: "ok", data: ROWS });
  vi.spyOn(dataSearch, "fetchSearchIdBlock").mockResolvedValue({
    status: "ok",
    data: IDS as never,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Landing (top page) interactions", () => {
  it("shows the build-time counts in the h1 and links every conference catalog", () => {
    vi.spyOn(dataLineage, "fetchLineageQualityManifest").mockResolvedValue({
      status: "ok",
      data: manifestWithTheme(),
    });
    render(<Landing initialConferences={CONFERENCES} />);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toContain("2");
    expect(h1.textContent).toContain("10,620");
    const catalogs = screen.getByRole("region", { name: "学会カタログ (2)" });
    const links = within(catalogs).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["ICML 20266,552 本", "/icml-2026/"],
      ["CVPR 20264,068 本", "/cvpr-2026/"],
    ]);
    // The intro links jump to both entry points.
    expect(screen.getByRole("link", { name: "学会カタログ" }).getAttribute("href")).toBe(
      "#s0-confs",
    );
    expect(screen.getByRole("link", { name: "テーマ別の系譜" }).getAttribute("href")).toBe(
      "#s0-lineages",
    );
  });

  it("an example chip fills the search box, updates ?q= and shows suggestions; Esc closes them", async () => {
    vi.spyOn(dataLineage, "fetchLineageQualityManifest").mockResolvedValue({
      status: "ok",
      data: manifestWithTheme(),
    });
    render(<Landing initialConferences={CONFERENCES} />);
    const input = screen.getByRole("combobox", { name: "タイトル・著者・タグで横断検索" });

    fireEvent.click(screen.getByRole("button", { name: "diffusion" }));
    expect((input as HTMLInputElement).value).toBe("diffusion");
    expect(document.activeElement).toBe(input);
    expect(new URL(window.location.href).searchParams.get("q")).toBe("diffusion");

    const listbox = await screen.findByRole("listbox", { name: "検索結果" });
    await waitFor(() => expect(within(listbox).getAllByRole("option").length).toBe(2));
    expect(input.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("site-search-opt-0");

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(input.getAttribute("aria-expanded")).toBe("false"));
  });

  it("typing a one-letter query asks for two characters instead of searching", async () => {
    vi.spyOn(dataLineage, "fetchLineageQualityManifest").mockResolvedValue({
      status: "ok",
      data: manifestWithTheme(),
    });
    render(<Landing initialConferences={CONFERENCES} />);
    const input = screen.getByRole("combobox", { name: "タイトル・著者・タグで横断検索" });
    fireEvent.change(input, { target: { value: "d" } });
    await waitFor(() => expect(screen.getByText("2 文字以上で検索します。")).toBeTruthy());
    expect(dataSearch.loadSearchIndex).not.toHaveBeenCalled();
  });

  it("arriving at /#s0-confs scrolls to the catalogs instead of focusing the search box", () => {
    vi.spyOn(dataLineage, "fetchLineageQualityManifest").mockResolvedValue({
      status: "ok",
      data: manifestWithTheme(),
    });
    window.history.replaceState(null, "", "/#s0-confs");
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("matchMedia", matchMedia);
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      render(<Landing initialConferences={CONFERENCES} />);
      const input = screen.getByRole("combobox", { name: "タイトル・著者・タグで横断検索" });
      expect(document.activeElement).not.toBe(input);
      expect(scroll.mock.contexts.some((el) => (el as Element).id === "s0-confs")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("focuses the search box on load for fine pointers when there is no section hash", () => {
    vi.spyOn(dataLineage, "fetchLineageQualityManifest").mockResolvedValue({
      status: "ok",
      data: manifestWithTheme(),
    });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    try {
      render(<Landing initialConferences={CONFERENCES} />);
      expect(document.activeElement).toBe(
        screen.getByRole("combobox", { name: "タイトル・著者・タグで横断検索" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("「検索した後は？」 opens and closes from its summary", () => {
    vi.spyOn(dataLineage, "fetchLineageQualityManifest").mockResolvedValue({
      status: "ok",
      data: manifestWithTheme(),
    });
    render(<Landing initialConferences={CONFERENCES} />);
    const summary = screen.getByText("検索した後は？");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    fireEvent.click(summary);
    expect(details.open).toBe(false);
  });

  it("the theme shelf says it failed (and points at the catalogs) when the manifest cannot be read", async () => {
    vi.spyOn(dataLineage, "fetchLineageQualityManifest").mockResolvedValue({
      status: "error",
      error: "HTTP 500",
    });
    render(<Landing initialConferences={CONFERENCES} />);
    const shelf = screen.getByRole("region", { name: "テーマ別の系譜" });
    const list = document.getElementById("s0-lineages-list") as HTMLElement;
    await waitFor(() => expect(list.textContent).toContain("系譜一覧を読み込めませんでした"));
    expect(list.textContent).toContain("学会カタログから論文を探せます");
    expect(
      within(shelf)
        .getByRole("link", { name: /テーマの一覧・依頼/ })
        .getAttribute("href"),
    ).toBe("/themes/");
    expect(
      within(shelf)
        .getByRole("link", { name: /線の色の意味/ })
        .getAttribute("href"),
    ).toBe("/how-it-works/");
  });

  it("lists the published themes as links into /themes/ with their badge", async () => {
    vi.spyOn(dataLineage, "fetchLineageQualityManifest").mockResolvedValue({
      status: "ok",
      data: manifestWithTheme(),
    });
    const row = {
      collection_id: "theme:flash-attention",
      kind: "theme",
      slug: "flash-attention",
      label: "Flash Attention",
      node_count: 14,
      edge_count: 46,
      freshness: "fresh",
    } as unknown as QualityRow;
    vi.spyOn(landingLineage, "selectLineageShelfRows").mockReturnValue([row]);
    vi.spyOn(landingLineage, "lineageShelfTier").mockReturnValue("audited");
    render(<Landing initialConferences={CONFERENCES} />);
    const shelf = screen.getByRole("region", { name: "テーマ別の系譜" });
    const link = await within(shelf).findByRole("link", { name: "Flash Attention" });
    expect(link.getAttribute("href")).toBe("/themes/?theme=flash-attention");
    expect(within(shelf).getByText("監査済み")).toBeTruthy();
    expect(within(shelf).getByText("テーマ · 14 論文 · 46 関係")).toBeTruthy();
    expect(document.getElementById("s0-lineages-status")?.textContent).toBe(
      "1 件の系譜を表示しています。",
    );
  });

  it("defers the lineage manifest until the shelf nears the viewport", async () => {
    const fetchManifest = vi
      .spyOn(dataLineage, "fetchLineageQualityManifest")
      .mockResolvedValue({ status: "ok", data: manifestWithTheme() });
    let trigger: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    class FakeObserver {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        trigger = cb;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    try {
      render(<Landing initialConferences={CONFERENCES} />);
      expect(fetchManifest).not.toHaveBeenCalled();
      const list = document.getElementById("s0-lineages-list") as HTMLElement;
      expect(list.textContent).toContain("系譜一覧を読み込んでいます");
      await act(async () => {
        trigger?.([{ isIntersecting: true }]);
      });
      expect(fetchManifest).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(list.textContent).toContain("公開できる系譜は準備中です"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetches the lineage manifest after 4 s even if the observer never reports", async () => {
    vi.useFakeTimers();
    const fetchManifest = vi
      .spyOn(dataLineage, "fetchLineageQualityManifest")
      .mockResolvedValue({ status: "ok", data: manifestWithTheme() });
    class SilentObserver {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", SilentObserver);
    try {
      render(<Landing initialConferences={CONFERENCES} />);
      await act(async () => {
        vi.advanceTimersByTime(3999);
      });
      expect(fetchManifest).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(fetchManifest).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to the runtime conferences fetch when the build could not read the list", async () => {
    vi.spyOn(dataLineage, "fetchLineageQualityManifest").mockResolvedValue({
      status: "ok",
      data: manifestWithTheme(),
    });
    const data = await import("../../lib/data");
    const fetchConferences = vi
      .spyOn(data, "fetchConferences")
      .mockResolvedValue({ status: "ok", data: [{ name: "aaai-2026", papers: 762 }] as never });
    render(<Landing initialConferences={{ kind: "unknown" }} />);
    expect(fetchConferences).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("link", { name: /AAAI 2026/ })).toBeTruthy();
  });

  it("does not refetch conferences.json when the build embedded the list", () => {
    vi.spyOn(dataLineage, "fetchLineageQualityManifest").mockResolvedValue({
      status: "ok",
      data: manifestWithTheme(),
    });
    return import("../../lib/data").then((data) => {
      const fetchConferences = vi.spyOn(data, "fetchConferences");
      render(<Landing initialConferences={CONFERENCES} />);
      expect(fetchConferences).not.toHaveBeenCalled();
    });
  });
});

/**
 * Page objects: the ONLY place that knows how to find things on the site.
 * Selectors are by role + accessible name (+ URL), falling back to the
 * stable `data-*` hooks the UI exposes on purpose (design 53), never by
 * CSS class, so a visual redesign that keeps the names keeps these
 * working. When a redesign renames something, update the matching getter
 * here -- specs should not need to change.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/** Header nav + footer, present on every page. */
export class SiteChrome {
  constructor(readonly page: Page) {}

  get banner(): Locator {
    return this.page.getByRole("banner");
  }
  get globalNav(): Locator {
    return this.page.getByRole("navigation", { name: "グローバル" });
  }
  globalNavLink(name: "探す" | "学会" | "系譜" | "仕組み"): Locator {
    return this.globalNav.getByRole("link", { name, exact: true });
  }
  get brandLink(): Locator {
    return this.banner.getByRole("link", { name: /PaperPilot/ }).first();
  }
  get footer(): Locator {
    return this.page.getByRole("contentinfo");
  }
  get footerNav(): Locator {
    return this.footer.getByRole("navigation", { name: "サイト情報" });
  }
  get skipLink(): Locator {
    return this.page.getByRole("link", { name: "本文へスキップ" });
  }
  /** Same-origin hrefs of every link in the header and footer. */
  async internalHrefs(): Promise<string[]> {
    const origin = new URL(this.page.url()).origin;
    const hrefs = await this.page
      .locator("header a[href], footer a[href]")
      .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
    return [...new Set(hrefs.filter((h) => h.startsWith(origin)))];
  }
}

export class LandingPage {
  readonly chrome: SiteChrome;
  constructor(readonly page: Page) {
    this.chrome = new SiteChrome(page);
  }
  async goto(): Promise<void> {
    await this.page.goto("/");
  }
  get heading(): Locator {
    return this.page.getByRole("heading", { level: 1 });
  }
  get searchBox(): Locator {
    return this.page.getByRole("combobox", { name: "タイトル・著者・タグで横断検索" });
  }
  get searchResults(): Locator {
    return this.page.getByRole("listbox", { name: "検索結果" });
  }
  get conferencesSection(): Locator {
    return this.page.getByRole("region", { name: /^学会カタログ/ });
  }
  get lineagesSection(): Locator {
    return this.page.getByRole("region", { name: "テーマ別の系譜" });
  }
  /** Links to published theme lineages (the shelf; it lazy-loads when
   * scrolled near, or after 4 s). */
  get themeLinks(): Locator {
    return this.lineagesSection.locator("a[href*='/themes/?theme=']");
  }
  /** Conference catalog links (`/<conf>/`). */
  get conferenceLinks(): Locator {
    return this.conferencesSection.getByRole("link");
  }
  /** Scrolls the theme shelf into view so its manifest loads. */
  async revealThemeShelf(): Promise<void> {
    await this.lineagesSection.scrollIntoViewIfNeeded();
  }
  get howItWorksLink(): Locator {
    return this.chrome.globalNavLink("仕組み");
  }
}

/** /themes/?theme=<slug> */
export class ThemePage {
  readonly chrome: SiteChrome;
  constructor(readonly page: Page) {
    this.chrome = new SiteChrome(page);
  }

  /** Marks the reading guide as seen so it starts collapsed. */
  async skipOnboarding(): Promise<void> {
    await this.page.addInitScript(() => {
      try {
        localStorage.setItem("pp.theme.onboarded", "1");
      } catch {
        /* storage disabled */
      }
    });
  }

  async goto(slug: string, query = ""): Promise<void> {
    await this.page.goto(`/themes/?theme=${encodeURIComponent(slug)}${query ? `&${query}` : ""}`);
    await this.waitForTree();
  }
  async waitForTree(): Promise<void> {
    await expect(this.tree.or(this.timeline)).toBeVisible({ timeout: 20_000 });
  }

  get heading(): Locator {
    return this.page.getByRole("heading", { level: 1 });
  }
  get gallery(): Locator {
    return this.page.getByRole("region", { name: "テーマ一覧" });
  }
  galleryLink(themeName: string): Locator {
    return this.gallery.getByRole("link", { name: new RegExp(`^${escapeRe(themeName)}`) });
  }
  /** The family-tree SVG (a labelled group of card and edge buttons). */
  get tree(): Locator {
    return this.page.getByRole("group", { name: /時系列家系図/ });
  }
  get timeline(): Locator {
    return this.page.locator("svg[data-theme-timeline]");
  }
  /** Paper points in the timeline view (SVG role=button, aria-pressed). */
  get timelinePoints(): Locator {
    return this.timeline.locator("[role='button']");
  }
  /** Relation lines inside the tree (SVG <line role=button>). */
  get edgeButtons(): Locator {
    return this.tree.locator("line[role='button']");
  }
  /** Paper cards inside the tree (buttons: select -> 土台と発展). */
  get nodeCards(): Locator {
    return this.tree.getByRole("button", { name: /土台と発展を表示/ });
  }
  get selectedPaperBar(): Locator {
    return this.page.locator("[data-selected-paper-bar]");
  }
  get evidencePanel(): Locator {
    return this.page.getByTestId("edge-evidence-panel");
  }
  get evidenceHeading(): Locator {
    return this.evidencePanel.getByRole("heading", { name: /関係の根拠/ });
  }
  get evidenceCloseButton(): Locator {
    return this.page.getByRole("button", { name: "根拠パネルを閉じる" });
  }
  get reportErrorLink(): Locator {
    return this.evidencePanel.getByRole("link", { name: /誤りを報告/ });
  }

  // ---- toolbar -----------------------------------------------------------
  get viewGroup(): Locator {
    return this.page.locator("[data-view-toggle]");
  }
  viewButton(label: "家系図" | "年×被引用"): Locator {
    return this.viewGroup.getByRole("button", { name: label, exact: true });
  }
  get mainPathGroup(): Locator {
    return this.page.locator("[data-main-path-toggle]");
  }
  mainPathButton(label: "強調" | "本流だけ" | "オフ"): Locator {
    return this.mainPathGroup.getByRole("button", { name: label, exact: true });
  }
  get orderSelect(): Locator {
    return this.page.getByRole("combobox", { name: "並べ方" });
  }
  zoomButton(label: "縮小" | "拡大" | "全体"): Locator {
    return this.page.locator("[data-zoom-controls]").getByRole("button", { name: label });
  }
  /** Current zoom factor (the tree SVG's data-zoom). */
  async zoom(): Promise<number> {
    return Number(await this.tree.getAttribute("data-zoom"));
  }
  /** Cards per line of the family tree (crowded years wrap, R4-5). */
  async perLine(): Promise<number> {
    return Number(await this.tree.getAttribute("data-per-line"));
  }
  /** One year band per year in the tree (data-year-band = the year label). */
  get yearBands(): Locator {
    return this.tree.locator("[data-year-band]");
  }
  /** Card layout in DOM (= Tab) order: id, year band and layout x/y. */
  async cardLayout(): Promise<Array<{ id: string; x: number; y: number }>> {
    return this.tree.locator("g[data-node-id]").evaluateAll((gs) =>
      gs.map((g) => {
        const fo = g.querySelector("foreignObject");
        return {
          id: g.getAttribute("data-node-id") ?? "",
          x: Number(fo?.getAttribute("x")),
          y: Number(fo?.getAttribute("y")),
        };
      }),
    );
  }
  /** A paper card's group in the tree, by node id. */
  cardGroup(id: string): Locator {
    return this.tree.locator(`g[data-node-id="${id.replace(/["\\]/g, "\\$&")}"]`);
  }
  get keyboardHelpButton(): Locator {
    return this.page.getByRole("button", { name: "キーボード操作の一覧" });
  }
  get keyboardHelpDialog(): Locator {
    return this.page.getByRole("dialog", { name: /キーボードショートカット/ });
  }
  get readingGuide(): Locator {
    return this.page.locator("[data-reading-guide]");
  }

  // ---- Prior / Derivative panel -----------------------------------------
  get neighborsPanel(): Locator {
    return this.page.getByRole("region", { name: "論文ごとの土台と発展" });
  }
  get paperSelect(): Locator {
    return this.page.locator("[data-neighbor-select]");
  }
  get pathToSelect(): Locator {
    return this.page.locator("[data-path-select]");
  }
  neighborHeading(side: "土台" | "発展"): Locator {
    return this.neighborsPanel.getByRole("heading", { name: new RegExp(`^${side}`) });
  }
  /** "<n> 段（強い関係 …）" summary, or the "not connected" message. */
  get pathResult(): Locator {
    return this.neighborsPanel.getByText(/\d+ 段（強い関係|つながっていません/);
  }

  // ---- export / share (one disclosure) -----------------------------------
  get exportMenu(): Locator {
    return this.page.locator("[data-export-menu]");
  }
  async openExportMenu(): Promise<void> {
    if ((await this.exportMenu.getAttribute("open")) === null) {
      await this.exportMenu.locator("summary").click();
    }
    await expect(this.exportMenu).toHaveAttribute("open", "");
  }
  exportButton(
    kind: "bibtex" | "nodes-csv" | "edges-csv" | "画像（SVG）" | "画像（PNG）",
  ): Locator {
    return kind.startsWith("画像")
      ? this.exportMenu.getByRole("button", { name: kind, exact: true })
      : this.exportMenu.locator(`[data-export='${kind}']`);
  }
  get copyUrlButton(): Locator {
    return this.page.locator("[data-share-url]");
  }
  get shareStatus(): Locator {
    return this.page.locator("[data-share-status]");
  }

  // ---- feed sections (collapsed <details>) -------------------------------
  get newPapersSection(): Locator {
    return this.page.getByRole("region", { name: /新着/ });
  }
  get codeLinksSection(): Locator {
    return this.page.getByRole("region", { name: "コードとモデル" });
  }
  get feedLink(): Locator {
    return this.newPapersSection.locator("[data-feed-link]");
  }
  async expand(section: Locator): Promise<void> {
    const details = section.locator("details").first();
    if ((await details.getAttribute("open")) === null) {
      await details.locator("summary").first().click();
    }
    await expect(details).toHaveAttribute("open", "");
  }

  searchParam(name: string): string | null {
    return new URL(this.page.url()).searchParams.get(name);
  }
}

/** /<conf>/ catalog */
export class CatalogPage {
  readonly chrome: SiteChrome;
  constructor(
    readonly page: Page,
    readonly conf: string,
  ) {
    this.chrome = new SiteChrome(page);
  }
  async goto(query = ""): Promise<void> {
    await this.page.goto(`/${this.conf}/${query ? `?${query}` : ""}`);
  }
  get heading(): Locator {
    return this.page.getByRole("heading", { level: 1 });
  }
  get searchBox(): Locator {
    return this.page.getByRole("searchbox", { name: /^論文をタイトル・著者・要旨で検索/ });
  }
  /** "全 5,286 件" / "487 件が該当（全 5,286 件） · 先頭 30 件を表示中". */
  get resultSummary(): Locator {
    return this.page.locator("p[aria-live='polite']").filter({ hasText: /全 [\d,]+ 件/ });
  }
  get results(): Locator {
    return this.page.locator("#paper-list > li[data-paper-id]");
  }
  get noResults(): Locator {
    return this.page.getByText(/に一致する論文はありません。$/);
  }
  /** "フィルタ解除" in the result bar (or "フィルタを解除" in the empty state). */
  get clearFiltersButton(): Locator {
    return this.page.getByRole("button", { name: /^フィルタを?解除/ }).first();
  }
  typeButton(value: "Oral" | "Poster"): Locator {
    return this.page.locator(`button[data-type='${value}']`);
  }
  get abstractToggle(): Locator {
    return this.page.locator("button[data-has-abstract]");
  }
  /** Filter-bar tag chips (not the ones on the cards). */
  get tagChips(): Locator {
    return this.page.getByRole("group", { name: "トピックタグで絞り込み" }).locator("[data-tag]");
  }
  get sortSelect(): Locator {
    return this.page.getByRole("combobox", { name: "並び替え" });
  }
  get exportGroup(): Locator {
    return this.page.locator("[data-catalog-export]");
  }
  exportButton(label: "BibTeX" | "CSV"): Locator {
    return this.exportGroup.getByRole("button", { name: new RegExp(`${label} で書き出す$`) });
  }
  get copyUrlButton(): Locator {
    return this.exportGroup.getByRole("button", { name: "URLをコピー" });
  }
  /** "詳細を開く" on the n-th result. */
  openDetailButton(index = 0): Locator {
    return this.results.nth(index).locator("[data-select-paper]");
  }
  get closeDetailButton(): Locator {
    return this.page.locator("[data-close-paper]");
  }
  get selectedCard(): Locator {
    return this.results.filter({ has: this.page.locator("[data-close-paper]") });
  }
  get conferenceSwitcher(): Locator {
    return this.page.locator("[data-conference-switcher]");
  }
  get conferenceSwitcherNav(): Locator {
    return this.page.getByRole("navigation", { name: "学会を切り替え" });
  }
  async firstResultTitle(): Promise<string> {
    return (await this.results.first().getByRole("heading", { level: 2 }).innerText()).trim();
  }
  /** Parses the live summary: `shown` rows on screen, `matched` rows that
   * pass the current search/filters. */
  async shownCount(): Promise<{ shown: number; matched: number }> {
    const text = (await this.resultSummary.innerText()).replace(/,/g, "");
    const all = /全 (\d+) 件/.exec(text);
    const hit = /(\d+) 件が該当/.exec(text);
    let matched: number;
    if (hit) matched = Number(hit[1]);
    else if (all) matched = Number(all[1]);
    else throw new Error(`unrecognised result summary: ${text}`);
    const head = /先頭 (\d+) 件を表示中/.exec(text);
    return { shown: head ? Number(head[1]) : matched, matched };
  }
  searchParam(name: string): string | null {
    return new URL(this.page.url()).searchParams.get(name);
  }
}

/** /<conf>/paper-links/[<n>/] -- the no-JavaScript list. */
export class PaperLinksPage {
  constructor(readonly page: Page) {}
  async goto(conf: string, n = 1): Promise<void> {
    await this.page.goto(n === 1 ? `/${conf}/paper-links/` : `/${conf}/paper-links/${n}/`);
  }
  get heading(): Locator {
    return this.page.getByRole("heading", { level: 1 });
  }
  get paperTitles(): Locator {
    return this.page.getByRole("main").getByRole("heading", { level: 2 });
  }
  get pager(): Locator {
    return this.page.getByRole("navigation", { name: "ページ" }).first();
  }
  pagerLink(n: number): Locator {
    return this.pager.getByRole("link", { name: `${n} ページ目`, exact: true });
  }
  get fullCatalogLink(): Locator {
    return this.page.getByRole("main").getByRole("link", { name: /の通常版$/ });
  }
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

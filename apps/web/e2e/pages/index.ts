/**
 * Page objects: the ONLY place that knows how to find things on the site.
 * Selectors are by role + accessible name (+ URL), never by CSS class, so
 * a visual redesign that keeps the names keeps these working. When a
 * redesign renames something, update the matching getter here -- specs
 * should not need to change.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/** Header nav + footer, present on every page. */
export class SiteChrome {
  constructor(readonly page: Page) {}

  get globalNav(): Locator {
    return this.page.getByRole("navigation", { name: "グローバル" });
  }
  get footer(): Locator {
    return this.page.getByRole("contentinfo");
  }
  get footerNav(): Locator {
    return this.footer.getByRole("navigation", { name: "関連ドキュメント" });
  }
  get skipLink(): Locator {
    return this.page.getByRole("link", { name: "本文へスキップ" });
  }
  /** Same-origin hrefs of every link in the header nav and footer. */
  async internalHrefs(): Promise<string[]> {
    const origin = new URL(this.page.url()).origin;
    const hrefs = await this.page
      .locator("nav[aria-label='グローバル'] a[href], footer a[href]")
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
    return this.page.getByRole("combobox", { name: /横断検索/ });
  }
  /** Links to published theme lineages (the "系譜の公開状況" shelf, or any
   * link into /themes/?theme=). */
  get themeLinks(): Locator {
    return this.page.getByRole("main").locator("a[href*='/themes/?theme=']");
  }
  /** The "学会から探す" disclosure (collapsed by default). */
  get conferencesToggle(): Locator {
    return this.page.getByRole("button", { name: /学会から探す/ });
  }
  /** Conference catalog links (`/<conf>/`). */
  conferenceLink(label: string | RegExp): Locator {
    return this.page.getByRole("main").getByRole("link", { name: label });
  }
  async openConferenceList(): Promise<void> {
    const toggle = this.conferencesToggle;
    if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "false") {
      await toggle.click();
    }
  }
  get howItWorksLink(): Locator {
    return this.chrome.globalNav.getByRole("link", { name: "仕組み" });
  }
}

/** /themes/?theme=<slug> */
export class ThemePage {
  readonly chrome: SiteChrome;
  constructor(readonly page: Page) {
    this.chrome = new SiteChrome(page);
  }

  /** Skips the first-visit onboarding popover so it never covers controls. */
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
  /** The family-tree SVG (role=img). */
  get tree(): Locator {
    return this.page.getByRole("img", { name: /時系列家系図/ });
  }
  get timeline(): Locator {
    return this.page.getByRole("img", { name: /被引用数.*分布/ });
  }
  /** Paper points in the timeline view (SVG role=button, aria-pressed). */
  get timelinePoints(): Locator {
    return this.timeline.getByRole("button");
  }
  /** Relation lines inside the tree (SVG role=button). */
  get edgeButtons(): Locator {
    return this.tree.getByRole("button");
  }
  /** Paper cards inside the tree (each links to the paper). */
  get nodeLinks(): Locator {
    return this.tree.getByRole("link", { name: /論文を新しいタブで開く/ });
  }
  get evidencePanel(): Locator {
    return this.page.getByRole("region", { name: /関係の根拠/ });
  }
  get evidenceHeading(): Locator {
    return this.evidencePanel.getByRole("heading", { name: /関係の根拠/ });
  }
  get evidenceCloseButton(): Locator {
    return this.page.getByRole("button", { name: "根拠パネルを閉じる" });
  }
  get reportErrorLink(): Locator {
    return this.evidencePanel.getByRole("link", { name: "誤りを報告" });
  }

  // ---- toggles (aria-pressed buttons inside named groups) ----------------
  get viewGroup(): Locator {
    return this.page.getByRole("group", { name: "表示" });
  }
  viewButton(label: "家系図" | "年×被引用"): Locator {
    return this.viewGroup.getByRole("button", { name: new RegExp(escapeRe(label)) });
  }
  get mainPathGroup(): Locator {
    return this.page.getByRole("group", { name: /本流/ });
  }
  mainPathButton(label: "強調" | "本流だけ" | "切"): Locator {
    return this.mainPathGroup.getByRole("button", { name: label, exact: true });
  }

  // ---- Prior / Derivative panel -----------------------------------------
  get neighborsPanel(): Locator {
    return this.page.getByRole("region", { name: "論文ごとの土台と発展" });
  }
  get paperSelect(): Locator {
    return this.neighborsPanel.getByRole("combobox", { name: /^論文/ });
  }
  get pathToSelect(): Locator {
    return this.neighborsPanel.getByRole("combobox", { name: /つなぐ先/ });
  }
  neighborHeading(side: "土台" | "発展"): Locator {
    return this.neighborsPanel.getByRole("heading", { name: new RegExp(`^${side}`) });
  }
  /** "<n> 段（強い関係 …）" summary, or the "not connected" message. */
  get pathResult(): Locator {
    return this.neighborsPanel.getByText(/\d+ 段（強い関係|つながっていません/);
  }

  // ---- export / share ----------------------------------------------------
  get exportGroup(): Locator {
    return this.page.getByRole("group", { name: "書き出し" });
  }
  exportButton(label: "SVG" | "PNG" | "BibTeX" | "CSV（論文）" | "CSV（関係）"): Locator {
    return this.exportGroup.getByRole("button", { name: new RegExp(`${escapeRe(label)}$`) });
  }
  get copyUrlButton(): Locator {
    return this.exportGroup.getByRole("button", { name: /URLをコピー/ });
  }
  get shareStatus(): Locator {
    return this.page.getByRole("status").filter({ hasText: /コピー/ });
  }

  // ---- feed sections -----------------------------------------------------
  get newPapersSection(): Locator {
    return this.page.getByRole("region", { name: /新着/ });
  }
  get feedLink(): Locator {
    return this.newPapersSection.getByRole("link", { name: /Atom|フィード/ });
  }

  async dismissOnboardingIfShown(): Promise<void> {
    const ok = this.page.getByRole("button", { name: /わかった/ });
    if (await ok.isVisible()) await ok.click();
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
    return this.page.getByRole("searchbox", { name: /論文を.*検索/ });
  }
  /** "30 / 5286 件を表示" / "0 件" live summary. */
  get resultSummary(): Locator {
    return this.page.getByText(/^(«.*»)?\s*(\d[\d,]* \/ \d[\d,]* 件|0 件)/);
  }
  get results(): Locator {
    return this.page
      .getByRole("main")
      .getByRole("listitem")
      .filter({
        has: this.page.getByRole("heading", { level: 2 }),
      });
  }
  get noResults(): Locator {
    return this.page.getByText("条件に一致する論文がありません。");
  }
  get clearFiltersButton(): Locator {
    return this.page.getByRole("button", { name: /フィルタ(を)?解除/ }).first();
  }
  typeButton(label: "all" | "Oral" | "Poster"): Locator {
    return this.page
      .getByRole("group", { name: /採択形式/ })
      .getByRole("button", { name: new RegExp(`^${label}\\b`) });
  }
  tagButton(tag: string): Locator {
    return this.page
      .getByRole("group", { name: /トピックタグ/ })
      .getByRole("button", { name: new RegExp(`^${escapeRe(tag)}\\b`) });
  }
  get sortSelect(): Locator {
    return this.page.getByRole("combobox", { name: "並び替え" });
  }
  get exportGroup(): Locator {
    return this.page.getByRole("group", { name: /書き出し/ });
  }
  exportButton(label: "BibTeX" | "CSV"): Locator {
    return this.exportGroup.getByRole("button", { name: label, exact: true });
  }
  /** "内容を見る" on the n-th result. */
  openDetailButton(index = 0): Locator {
    return this.results.nth(index).getByRole("button", { name: "内容を見る" });
  }
  get closeDetailButton(): Locator {
    return this.page.getByRole("button", { name: "詳細を閉じる" });
  }
  get selectedCard(): Locator {
    return this.results.filter({ hasText: "選択中" });
  }
  async firstResultTitle(): Promise<string> {
    return (await this.results.first().getByRole("heading", { level: 2 }).innerText()).trim();
  }
  /** Parses the live summary: `shown` rows on screen, `matched` rows that
   * pass the current search/filters. Formats: "30 / 487 件を表示（全 5286
   * 件）" (more to load), "487 / 5286 件" (all shown), "0 件". */
  async shownCount(): Promise<{ shown: number; matched: number }> {
    const text = (await this.resultSummary.innerText()).replace(/,/g, "");
    const m = /(\d+) \/ (\d+) 件(を表示)?/.exec(text);
    if (!m) {
      if (/(^|\s|»)0 件/.test(text)) return { shown: 0, matched: 0 };
      throw new Error(`unrecognised result summary: ${text}`);
    }
    return m[3]
      ? { shown: Number(m[1]), matched: Number(m[2]) }
      : { shown: Number(m[1]), matched: Number(m[1]) };
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
    return this.pager.getByRole("link", { name: String(n), exact: true });
  }
  get fullCatalogLink(): Locator {
    return this.page.getByRole("link", { name: "通常版" });
  }
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

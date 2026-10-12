import { readFile } from "node:fs/promises";
import { CatalogPage } from "./pages";
import { prepareClipboard, readClipboard } from "./support/clipboard";
import { expect, PROD, test } from "./support/fixtures";
import { conferencePaperCount, conferences } from "./support/site";

/** First page of results must be on screen within this budget (ms) from
 * the start of navigation; generous because CI runners are slow and the
 * biggest catalogs parse ~5-7 MB of JSON. */
const FIRST_RESULTS_BUDGET_MS = Number(process.env.E2E_CATALOG_BUDGET_MS ?? 10_000);

/** A big catalog (5k+ papers) and an ICLR one (some rows without abstract). */
const CATALOGS = ["neurips-2025", "iclr-2025"] as const;

/** Same key as lib/catalog-sort.ts titleSortKey: leading symbols/TeX ignored. */
function titleSortKey(title: string): string {
  return title.replace(/^(?:[^\p{L}\p{N}\\]|\\[a-zA-Z]+\{?)+/u, "");
}

for (const conf of CATALOGS) {
  test.describe(`catalog ${conf}`, () => {
    let catalog: CatalogPage;
    test.beforeEach(({ page }) => {
      catalog = new CatalogPage(page, conf);
    });

    test("first results render within the budget", PROD, async ({ page }) => {
      const t0 = Date.now();
      await catalog.goto();
      await expect(catalog.results.first()).toBeVisible({ timeout: FIRST_RESULTS_BUDGET_MS });
      const elapsed = Date.now() - t0;
      test.info().annotations.push({ type: "first-results-ms", description: String(elapsed) });
      expect(elapsed).toBeLessThan(FIRST_RESULTS_BUDGET_MS);
      await expect(catalog.heading).toBeVisible();
      const counts = await catalog.shownCount();
      expect(counts.matched).toBe(conferencePaperCount(conf));
      expect(counts.shown).toBeGreaterThan(0);
      expect(counts.shown).toBeLessThanOrEqual(counts.matched);
      await expect(page).toHaveTitle(/PaperPilot/);
    });

    test("English search narrows results (debounced) and is kept in the URL", PROD, async () => {
      await catalog.goto();
      await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
      await catalog.searchBox.pressSequentially("diffusion", { delay: 20 });
      await expect.poll(() => catalog.searchParam("q")).toBe("diffusion");
      await expect(catalog.resultSummary).toContainText("件が該当");
      await expect(catalog.resultSummary).toContainText("diffusion");
      const counts = await catalog.shownCount();
      expect(counts.matched).toBeGreaterThan(0);
      expect(counts.matched).toBeLessThan(conferencePaperCount(conf));
      // Highlighted match is visible on the first result.
      await expect(catalog.results.first()).toContainText(/diffusion/i);
      await expect(catalog.results.first().locator("mark").first()).toBeVisible();
    });

    test("Japanese query: no crash, clean no-result state and recovery", async () => {
      await catalog.goto();
      await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
      await catalog.searchBox.fill("拡散モデルによる画像生成");
      await expect.poll(() => catalog.searchParam("q")).toBe("拡散モデルによる画像生成");
      await expect(catalog.noResults).toBeVisible();
      await expect(catalog.page.getByText(/英語のキーワード/)).toBeVisible();
      await expect(catalog.resultSummary).toContainText("0 件");
      await catalog.page.getByRole("button", { name: "フィルタを解除" }).click();
      await expect(catalog.results.first()).toBeVisible();
      await expect.poll(() => catalog.searchParam("q")).toBeNull();
      await expect(catalog.searchBox).toHaveValue("");
    });

    test("full-width (IME) Latin query matches like half-width", async () => {
      await catalog.goto();
      await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
      await catalog.searchBox.fill("diffusion");
      await expect.poll(() => catalog.searchParam("q")).toBe("diffusion");
      await expect(catalog.resultSummary).toContainText("件が該当");
      const half = (await catalog.shownCount()).matched;
      await catalog.searchBox.fill("ｄｉｆｆｕｓｉｏｎ");
      await expect.poll(() => catalog.searchParam("q")).toBe("ｄｉｆｆｕｓｉｏｎ");
      await expect(catalog.resultSummary).toContainText("ｄｉｆｆｕｓｉｏｎ");
      await expect(catalog.noResults).toBeHidden();
      expect((await catalog.shownCount()).matched).toBe(half);
    });

    test("type/tag filters and sort update results and the URL", async ({ page }) => {
      await catalog.goto();
      await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });

      // Type filter, when the catalog distinguishes Oral (some only list
      // Posters/unknown types).
      const oral = catalog.typeButton("Oral");
      const hasOral = (await oral.count()) > 0;
      let typed = (await catalog.shownCount()).matched;
      if (hasOral) {
        typed = Number((await oral.innerText()).replace(/[^\d]/g, ""));
        await oral.click();
        await expect(oral).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => catalog.searchParam("type")).toBe("Oral");
        await expect.poll(async () => (await catalog.shownCount()).matched).toBe(typed);
      }

      const firstTag = catalog.tagChips.first();
      const tagName = (await firstTag.getAttribute("data-tag"))!;
      await firstTag.click();
      await expect(catalog.tagChips.filter({ hasText: tagName }).first()).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect.poll(() => catalog.searchParam("tags")).toBe(tagName);
      const tagged = (await catalog.shownCount()).matched;
      expect(tagged).toBeGreaterThan(0);
      expect(tagged).toBeLessThanOrEqual(typed);

      await catalog.sortSelect.selectOption({ label: "タイトル A→Z" });
      await expect.poll(() => catalog.searchParam("sort")).toBe("title");
      const titles = await catalog.results
        .getByRole("heading", { level: 2 })
        .evaluateAll((hs) => hs.slice(0, 10).map((h) => (h.textContent ?? "").trim()));
      const sorted = [...titles].sort((a, b) => titleSortKey(a).localeCompare(titleSortKey(b)));
      expect(titles).toEqual(sorted);

      // State survives a reload.
      await page.reload();
      await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
      if (hasOral) {
        await expect(catalog.typeButton("Oral")).toHaveAttribute("aria-pressed", "true");
      }
      await expect(catalog.sortSelect).toHaveValue("title");
      expect((await catalog.shownCount()).matched).toBe(tagged);

      // フィルタ解除 clears everything but the sort.
      await catalog.clearFiltersButton.click();
      await expect.poll(() => catalog.searchParam("tags")).toBeNull();
      await expect
        .poll(async () => (await catalog.shownCount()).matched)
        .toBe(conferencePaperCount(conf));
    });

    test("要旨あり filter (abs=1) keeps only rows with an abstract", async ({ page }) => {
      await catalog.goto();
      await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
      const toggle = catalog.abstractToggle;
      test.skip((await toggle.count()) === 0, "every row of this catalog has an abstract");
      const expected = Number((await toggle.innerText()).replace(/[^\d]/g, ""));
      expect(expected).toBeLessThan(conferencePaperCount(conf));
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => catalog.searchParam("abs")).toBe("1");
      await expect.poll(async () => (await catalog.shownCount()).matched).toBe(expected);
      // No visible row says its abstract is missing.
      await expect(catalog.results.locator("[data-abstract-source='none']")).toHaveCount(0);
      await page.reload();
      await expect(catalog.abstractToggle).toHaveAttribute("aria-pressed", "true", {
        timeout: 20_000,
      });
      await catalog.abstractToggle.click();
      await expect.poll(() => catalog.searchParam("abs")).toBeNull();
    });

    test("URL state is applied on load", async () => {
      await catalog.goto("q=diffusion&sort=title");
      await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
      await expect(catalog.searchBox).toHaveValue("diffusion");
      await expect(catalog.sortSelect).toHaveValue("title");
      await expect(catalog.resultSummary).toContainText("diffusion");
    });

    test("no-result state offers a way back", async () => {
      await catalog.goto("q=zzqx-no-such-paper-e2e");
      await expect(catalog.noResults).toBeVisible({ timeout: 20_000 });
      await expect(catalog.exportGroup).toHaveCount(0);
      await catalog.page.getByRole("button", { name: "フィルタを解除" }).click();
      await expect(catalog.results.first()).toBeVisible();
    });

    test(
      "detail view opens and closes, with ?paper=, Esc focus return and Back",
      PROD,
      async ({ page }) => {
        await catalog.goto();
        await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
        const title = await catalog.firstResultTitle();
        await expect(catalog.openDetailButton(0)).toHaveText("詳細を開く");
        await catalog.openDetailButton(0).click();
        await expect(catalog.selectedCard).toHaveCount(1);
        await expect(catalog.selectedCard).toContainText(title);
        await expect(catalog.selectedCard).toContainText("選択中");
        await expect.poll(() => catalog.searchParam("paper")).toBeTruthy();
        await expect(catalog.closeDetailButton).toBeVisible();
        await expect(catalog.closeDetailButton).toHaveText("詳細を閉じる");

        await catalog.closeDetailButton.click();
        await expect(catalog.selectedCard).toHaveCount(0);
        await expect.poll(() => catalog.searchParam("paper")).toBeNull();
        // Focus goes back to the card's 詳細を開く.
        await expect(catalog.openDetailButton(0)).toBeFocused();

        // Esc closes too, also with focus return.
        await catalog.openDetailButton(0).click();
        await expect(catalog.selectedCard).toHaveCount(1);
        await page.keyboard.press("Escape");
        await expect(catalog.selectedCard).toHaveCount(0);
        await expect(catalog.openDetailButton(0)).toBeFocused();

        // Opening pushes a history entry; Back closes the detail again.
        await catalog.openDetailButton(0).click();
        await expect(catalog.selectedCard).toHaveCount(1);
        const paperId = catalog.searchParam("paper");
        await page.goBack();
        await expect(catalog.selectedCard).toHaveCount(0);
        await page.goForward();
        await expect.poll(() => catalog.searchParam("paper")).toBe(paperId);
        await expect(catalog.selectedCard).toHaveCount(1);

        // A deep link opens the same paper.
        await catalog.goto(`paper=${encodeURIComponent(paperId!)}`);
        await expect(catalog.selectedCard).toHaveCount(1, { timeout: 20_000 });
      },
    );

    test(
      "BibTeX / CSV export the filtered results; URL copy",
      PROD,
      async ({ page, context, baseURL, browserName }) => {
        await prepareClipboard(context, browserName, baseURL);
        await catalog.goto("q=diffusion");
        await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
        // The ?q= filter is applied after the first (unfiltered) render: the
        // search state is restored from the URL in an effect and filtered
        // as a deferred update. Read the count only once the summary shows
        // the filtered result, or `total` is the whole catalog (CI Firefox,
        // 44028f7: expected 3,703 = every ICLR 2025 paper, exported 373).
        await expect(catalog.resultSummary).toContainText("件が該当", { timeout: 20_000 });
        await expect(catalog.resultSummary).toContainText("diffusion");
        const total = (await catalog.shownCount()).matched;
        expect(total).toBeLessThan(conferencePaperCount(conf));

        const [bib] = await Promise.all([
          page.waitForEvent("download"),
          catalog.exportButton("BibTeX").click(),
        ]);
        expect(bib.suggestedFilename()).toMatch(/\.bib$/);
        const bibText = await readFile(await bib.path(), "utf8");
        expect(bibText.match(/^@\w+\{/gm)?.length).toBe(total);

        const [csv] = await Promise.all([
          page.waitForEvent("download"),
          catalog.exportButton("CSV").click(),
        ]);
        expect(csv.suggestedFilename()).toMatch(/\.csv$/);
        const csvText = await readFile(await csv.path(), "utf8");
        expect(csvText.length).toBeGreaterThan(0);
        expect(csvText.split("\n")[0]).toMatch(/title/i);

        await catalog.copyUrlButton.click();
        await expect(catalog.exportGroup.getByRole("status")).toContainText(/コピー/);
        const copied = await readClipboard(page);
        expect(new URL(copied).searchParams.get("q")).toBe("diffusion");
      },
    );

    test("conference switcher lists every catalog and navigates", async ({ page }) => {
      await catalog.goto();
      await expect(catalog.conferenceSwitcher).toBeVisible();
      await expect(catalog.conferenceSwitcherNav).toBeHidden();
      await catalog.conferenceSwitcher.locator("summary").click();
      await expect(catalog.conferenceSwitcherNav).toBeVisible();
      const nav = catalog.conferenceSwitcherNav;
      await expect(nav.locator("[aria-current='page']")).toHaveCount(1);
      const links = nav.getByRole("link");
      await expect(links).toHaveCount(conferences().length - 1);
      const href = (await links.first().getAttribute("href"))!;
      await links.first().click();
      await expect(page).toHaveURL(new RegExp(`${href.replace(/\//g, "\\/")}$`));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    });
  });
}

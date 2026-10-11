import { readFile } from "node:fs/promises";
import { CatalogPage } from "./pages";
import { expect, test } from "./support/fixtures";
import { conferencePaperCount } from "./support/site";

/** First page of results must be on screen within this budget (ms) from
 * the start of navigation; generous because CI runners are slow and the
 * biggest catalogs parse ~5-7 MB of JSON. */
const FIRST_RESULTS_BUDGET_MS = Number(process.env.E2E_CATALOG_BUDGET_MS ?? 10_000);

/** A big catalog (5k+ papers) and an ICLR one. */
const CATALOGS = ["neurips-2025", "iclr-2025"] as const;

for (const conf of CATALOGS) {
  test.describe(`catalog ${conf}`, () => {
    let catalog: CatalogPage;
    test.beforeEach(({ page }) => {
      catalog = new CatalogPage(page, conf);
    });

    test("first results render within the budget", async ({ page }) => {
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
      await expect(page).toHaveTitle(/PaperPilot/);
    });

    test("English search narrows results and is kept in the URL", async () => {
      await catalog.goto();
      await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
      await catalog.searchBox.fill("diffusion");
      await expect.poll(() => catalog.searchParam("q")).toBe("diffusion");
      await expect(catalog.resultSummary).toContainText("diffusion");
      const counts = await catalog.shownCount();
      expect(counts.matched).toBeGreaterThan(0);
      expect(counts.matched).toBeLessThan(conferencePaperCount(conf));
      // Highlighted match is visible on the first result.
      await expect(catalog.results.first()).toContainText(/diffusion/i);
    });

    test("Japanese query: no crash, clean no-result state and recovery", async () => {
      await catalog.goto();
      await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
      await catalog.searchBox.fill("拡散モデルによる画像生成");
      await expect.poll(() => catalog.searchParam("q")).toBe("拡散モデルによる画像生成");
      await expect(catalog.noResults).toBeVisible();
      await expect(catalog.resultSummary).toContainText("0 件");
      await catalog.page.getByRole("button", { name: "フィルタを解除" }).click();
      await expect(catalog.results.first()).toBeVisible();
      await expect.poll(() => catalog.searchParam("q")).toBeNull();
      await expect(catalog.searchBox).toHaveValue("");
    });

    // BUG (catalog search, JA input): the catalog filter lowercases but does
    // not NFKC-normalise (lib/catalog-sort.ts getFiltered), so full-width
    // Latin typed with a Japanese IME ("ｄｉｆｆｕｓｉｏｎ", "ＬＬＭ") matches
    // nothing, while the landing cross-search (lib/search-core.ts
    // normalizeText) does normalise. Expected: same hits as "diffusion".
    test.fixme("full-width (IME) Latin query matches like half-width", async () => {
      await catalog.goto();
      await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
      await catalog.searchBox.fill("diffusion");
      await expect.poll(() => catalog.searchParam("q")).toBe("diffusion");
      const half = (await catalog.shownCount()).matched;
      await catalog.searchBox.fill("ｄｉｆｆｕｓｉｏｎ");
      await expect.poll(() => catalog.searchParam("q")).toBe("ｄｉｆｆｕｓｉｏｎ");
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

      const tagButtons = page.getByRole("group", { name: /トピックタグ/ }).getByRole("button");
      const firstTag = tagButtons.first();
      const tagName = (await firstTag.innerText()).trim().split(/\s+/)[0]!;
      await firstTag.click();
      await expect(firstTag).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => catalog.searchParam("tags")).toBe(tagName);
      const tagged = (await catalog.shownCount()).matched;
      expect(tagged).toBeGreaterThan(0);
      expect(tagged).toBeLessThanOrEqual(typed);

      await catalog.sortSelect.selectOption({ label: "タイトル A→Z" });
      await expect.poll(() => catalog.searchParam("sort")).toBe("title");
      const titles = await catalog.results
        .getByRole("heading", { level: 2 })
        .evaluateAll((hs) => hs.slice(0, 10).map((h) => (h.textContent ?? "").trim()));
      const sorted = [...titles].sort((a, b) => a.localeCompare(b));
      expect(titles).toEqual(sorted);

      // State survives a reload.
      await page.reload();
      await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
      if (hasOral) {
        await expect(catalog.typeButton("Oral")).toHaveAttribute("aria-pressed", "true");
      }
      await expect(catalog.sortSelect).toHaveValue("title");
      expect((await catalog.shownCount()).matched).toBe(tagged);
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

    test("detail view opens and closes, with ?paper= and Back", async ({ page }) => {
      await catalog.goto();
      await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
      const title = await catalog.firstResultTitle();
      await catalog.openDetailButton(0).click();
      await expect(catalog.selectedCard).toHaveCount(1);
      await expect(catalog.selectedCard).toContainText(title);
      await expect.poll(() => catalog.searchParam("paper")).toBeTruthy();
      await expect(catalog.closeDetailButton).toBeVisible();

      await catalog.closeDetailButton.click();
      await expect(catalog.selectedCard).toHaveCount(0);
      await expect.poll(() => catalog.searchParam("paper")).toBeNull();

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
    });

    test("BibTeX / CSV export the filtered results", async ({ page }) => {
      await catalog.goto("q=diffusion");
      await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
      const total = (await catalog.shownCount()).matched;

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
    });
  });
}

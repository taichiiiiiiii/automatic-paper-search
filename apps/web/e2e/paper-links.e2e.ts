import { CatalogPage, PaperLinksPage } from "./pages";
import { expect, PROD, test } from "./support/fixtures";
import { paperLinksPages } from "./support/site";

/** A catalog whose no-JS list is split over several pages. */
const CONF = "neurips-2025";

test.describe("no-JavaScript paper links", () => {
  test.use({ javaScriptEnabled: false });

  test("every paper-links page renders titles with outbound links", PROD, async ({ page }) => {
    const pages = paperLinksPages(CONF);
    const links = new PaperLinksPage(page);
    for (const n of pages) {
      const res = await page.goto(n === 1 ? `/${CONF}/paper-links/` : `/${CONF}/paper-links/${n}/`);
      expect(res?.status()).toBe(200);
      await expect(links.heading).toContainText("論文リンク一覧");
      expect(await links.paperTitles.count()).toBeGreaterThan(0);
      const hrefs = await links.paperTitles
        .locator("a[href]")
        .evaluateAll((as) => as.slice(0, 50).map((a) => a.getAttribute("href") ?? ""));
      expect(hrefs.length).toBeGreaterThan(0);
      for (const h of hrefs) expect(h).toMatch(/^https?:\/\//);
      if (pages.length > 1) {
        await expect(links.pager.locator("[aria-current='page']")).toHaveText(String(n));
      }
    }
  });

  test("pager links navigate between pages without JavaScript", PROD, async ({ page }) => {
    const pages = paperLinksPages(CONF);
    test.skip(pages.length < 2, "single-page list");
    const links = new PaperLinksPage(page);
    await links.goto(CONF);
    await links.pagerLink(2).click();
    await expect(page).toHaveURL(new RegExp(`/${CONF}/paper-links/2/$`));
    await expect(links.pager.locator("[aria-current='page']")).toHaveText("2");
    await links.pagerLink(1).click();
    await expect(page).toHaveURL(new RegExp(`/${CONF}/paper-links/$`));
    await links.fullCatalogLink.click();
    await expect(page).toHaveURL(new RegExp(`/${CONF}/$`));
  });

  test("the catalog points no-JS readers at the paper-links list", PROD, async ({ page }) => {
    const catalog = new CatalogPage(page, CONF);
    await catalog.goto();
    const fallback = page.getByRole("link", { name: /JavaScript なしの論文リンク一覧/ }).first();
    await expect(fallback).toBeVisible();
    await fallback.click();
    await expect(page).toHaveURL(new RegExp(`/${CONF}/paper-links/$`));
    await expect(new PaperLinksPage(page).heading).toBeVisible();
  });
});

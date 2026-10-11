import { SiteChrome } from "./pages";
import { expect, test } from "./support/fixtures";

test.describe("404 page", () => {
  // The document itself is a 404; the browser logs that as a console error.
  test.use({
    allowedProblems:
      /^(http: 404 .*\/no-such-page-e2e\/$|console: Failed to load resource: .*404.*no-such-page-e2e)/,
  });

  test("unknown URL returns 404 with the site chrome and a way home", async ({ page }) => {
    const res = await page.goto("/no-such-page-e2e/");
    expect(res?.status()).toBe(404);
    await expect(page).toHaveTitle(/404/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("404");
    const chrome = new SiteChrome(page);
    await expect(chrome.globalNav).toBeVisible();
    await expect(chrome.footer).toBeVisible();
    await chrome.brandLink.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeAttached();
  });

  test("the 404 body links to the top, the catalog list and the themes", async ({
    page,
    request,
  }) => {
    await page.goto("/no-such-page-e2e/");
    const main = page.getByRole("main");
    const expected: [RegExp, string][] = [
      [/トップページ/, "/"],
      [/学会カタログの一覧/, "/#s0-confs"],
      [/テーマ別の系譜/, "/themes/"],
    ];
    for (const [name, href] of expected) {
      const link = main.getByRole("link", { name });
      await expect(link).toHaveAttribute("href", href);
      const res = await request.get(href.replace(/#.*$/, ""));
      expect(res.status(), href).toBe(200);
    }
    await main.getByRole("link", { name: /学会カタログの一覧/ }).click();
    await expect(page).toHaveURL(/\/#s0-confs$/);
    await expect(page.getByRole("region", { name: /^学会カタログ/ })).toBeInViewport();
  });

  test("the 404 page is not indexable", async ({ page }) => {
    await page.goto("/no-such-page-e2e/");
    await expect(page.locator("meta[name='robots']").first()).toHaveAttribute("content", /noindex/);
    await expect(page.locator("link[rel='canonical']")).toHaveCount(0);
  });
});

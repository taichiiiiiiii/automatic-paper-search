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
    await chrome.globalNav.getByRole("link", { name: "PaperPilot" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeAttached();
  });

  test("the 404 page is not indexable", async ({ page }) => {
    await page.goto("/no-such-page-e2e/");
    await expect(page.locator("meta[name='robots']").first()).toHaveAttribute("content", /noindex/);
    await expect(page.locator("link[rel='canonical']")).toHaveCount(0);
  });
});

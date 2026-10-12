import { SiteChrome } from "./pages";
import { expect, test } from "./support/fixtures";

/** Pages whose header/footer links are checked (one per page family). */
const PAGES = ["/", "/themes/", "/how-it-works/", "/neurips-2025/", "/neurips-2025/paper-links/"];

test.describe("global nav and footer", () => {
  for (const path of PAGES) {
    test(`links on ${path} resolve (no 404)`, async ({ page, request }) => {
      await page.goto(path);
      const chrome = new SiteChrome(page);
      await expect(chrome.globalNav).toBeVisible();
      await expect(chrome.footer).toBeVisible();
      const hrefs = await chrome.internalHrefs();
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        const url = new URL(href);
        const res = await request.get(url.pathname + url.search);
        expect(res.status(), href).toBe(200);
        if (url.hash) {
          const body = await res.text();
          expect(body, `${href}: #${url.hash.slice(1)} target exists`).toContain(
            `id="${url.hash.slice(1)}"`,
          );
        }
      }
    });
  }

  test("global nav links navigate and mark the current page", async ({ page }) => {
    await page.goto("/");
    const chrome = new SiteChrome(page);
    for (const [name, path] of [
      ["系譜", "/themes/"],
      ["仕組み", "/how-it-works/"],
      ["探す", "/"],
    ] as const) {
      await chrome.globalNavLink(name).click();
      await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, "\\/")}(\\?.*)?$`));
      await expect(chrome.globalNav.getByRole("link", { name, exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(page.getByRole("heading", { level: 1 })).toBeAttached();
    }
  });

  test("header 学会 link is current on a catalog and lands on the catalog section", async ({
    page,
  }) => {
    await page.goto("/neurips-2025/");
    const chrome = new SiteChrome(page);
    await expect(chrome.globalNavLink("学会")).toHaveAttribute("aria-current", "page");
    await chrome.globalNavLink("学会").click();
    await expect(page).toHaveURL(/\/#s0-confs$/);
    await expect(page.getByRole("region", { name: /^学会カタログ/ })).toBeInViewport();
    await expect(chrome.globalNavLink("探す")).toHaveAttribute("aria-current", "page");
  });

  test("footer site-info nav links navigate", async ({ page }) => {
    await page.goto("/");
    const chrome = new SiteChrome(page);
    await expect(chrome.footerNav).toBeVisible();
    const first = chrome.footerNav.locator("a[href^='/']").first();
    const href = (await first.getAttribute("href"))!;
    await first.click();
    await expect(page).toHaveURL(
      new RegExp(`${href.replace(/[?#].*$/, "").replace(/\//g, "\\/")}`),
    );
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("skip link targets the main landmark", async ({ page }) => {
    await page.goto("/how-it-works/");
    const chrome = new SiteChrome(page);
    const href = await chrome.skipLink.getAttribute("href");
    expect(href).toBe("#main-content");
    await expect(page.locator("#main-content")).toHaveCount(1);
  });

  test("trailing-slash and legacy .html URLs redirect", async ({ page }) => {
    await page.goto("/how-it-works");
    await expect(page).toHaveURL(/\/how-it-works\/$/);
    // Let Next's viewport prefetches of the nav links finish first: WebKit
    // reports a fetch cancelled by the next page.goto as an error ("Fetch
    // API cannot load … due to access control checks" / "Failed to fetch
    // RSC payload … Load failed"), which the page guard would count.
    await page.waitForLoadState("networkidle");
    await page.goto("/index.html");
    await expect(page).toHaveURL(/\/$/);
  });
});

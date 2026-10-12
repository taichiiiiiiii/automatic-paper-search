import { LandingPage } from "./pages";
import { expect, PROD, test } from "./support/fixtures";
import { conferences, publishedThemes } from "./support/site";

test.describe("landing", () => {
  test("loads with search, conference catalog and published lineages", PROD, async ({ page }) => {
    const landing = new LandingPage(page);
    await landing.goto();
    await expect(page).toHaveTitle(/PaperPilot/);
    await expect(landing.heading).toBeVisible();
    await expect(landing.searchBox).toBeVisible();
    await expect(landing.chrome.banner).toBeVisible();
    await expect(landing.chrome.globalNav).toBeVisible();
    await expect(landing.chrome.footer).toBeVisible();
    await expect(landing.chrome.footerNav).toBeVisible();
    // The catalog section is server-rendered and always open.
    await expect(landing.conferencesSection).toBeVisible();
    await expect(landing.conferenceLinks).toHaveCount(conferences().length);
    // The theme shelf lazy-loads once scrolled near (fail-closed: it
    // resolves to exactly the published themes).
    await landing.revealThemeShelf();
    await expect(landing.themeLinks).toHaveCount(publishedThemes().length);
  });

  test("theme shelf loads without scrolling (4 s fallback)", async ({ page }) => {
    const landing = new LandingPage(page);
    await landing.goto();
    await expect(landing.themeLinks).toHaveCount(publishedThemes().length, { timeout: 15_000 });
  });

  test("theme links open the theme lineage", PROD, async ({ page }) => {
    const landing = new LandingPage(page);
    await landing.goto();
    await landing.revealThemeShelf();
    const first = landing.themeLinks.first();
    const href = await first.getAttribute("href");
    expect(href).toMatch(/\/themes\/\?theme=[a-z0-9-]+/);
    await first.click();
    await expect(page).toHaveURL(/\/themes\/\?theme=/);
    await expect(page.getByRole("group", { name: /時系列家系図/ })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("の系譜");
  });

  test("conference catalog links resolve and navigate", PROD, async ({ page, request }) => {
    const landing = new LandingPage(page);
    await landing.goto();
    const confs = conferences().map((c) => c.name);
    const hrefs = await landing.conferenceLinks.evaluateAll((as) =>
      as.map((a) => a.getAttribute("href") ?? ""),
    );
    const confHrefs = hrefs.filter((h) =>
      confs.some((c) => h.replace(/\/$/, "").endsWith(`/${c}`)),
    );
    expect(new Set(confHrefs).size, "every conference is linked from the landing").toBe(
      confs.length,
    );
    for (const href of new Set(confHrefs)) {
      const res = await request.get(href);
      expect(res.status(), href).toBe(200);
    }
    const target = confHrefs[0]!;
    await landing.conferencesSection.locator(`a[href="${target}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`${target.replace(/\/?$/, "/")}$`));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("how-it-works link navigates", async ({ page }) => {
    const landing = new LandingPage(page);
    await landing.goto();
    await landing.howItWorksLink.click();
    await expect(page).toHaveURL(/\/how-it-works\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("cross-search lists matching papers in the listbox", PROD, async ({ page }) => {
    const landing = new LandingPage(page);
    await landing.goto();
    await landing.searchBox.fill("diffusion");
    await expect(landing.searchResults.getByRole("option").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(landing.searchBox).toHaveAttribute("aria-expanded", "true");
  });

  test("choosing a search result opens it in the catalog (click and Enter)", async ({ page }) => {
    const landing = new LandingPage(page);
    await landing.goto();
    await landing.searchBox.fill("diffusion");
    const option = landing.searchResults.getByRole("option").first();
    await expect(option).toBeVisible({ timeout: 15_000 });
    // Options are not links (no interactive control nested in an option).
    await expect(option.locator("a, button")).toHaveCount(0);
    await option.click();
    await expect(page).toHaveURL(/\/[a-z0-9-]+-\d{4}\/\?(.*&)?paper=/);
    await expect(page.locator("[data-close-paper]")).toBeVisible({ timeout: 20_000 });

    await landing.goto();
    await landing.searchBox.fill("diffusion");
    await expect(landing.searchResults.getByRole("option").first()).toBeVisible({
      timeout: 15_000,
    });
    await landing.searchBox.press("ArrowDown");
    await expect(landing.searchBox).toHaveAttribute("aria-activedescendant", "site-search-opt-0");
    await landing.searchBox.press("Enter");
    await expect(page).toHaveURL(/\/[a-z0-9-]+-\d{4}\/\?(.*&)?paper=/);
  });

  test("in-page links jump to the catalog and lineage sections", async ({ page }) => {
    const landing = new LandingPage(page);
    await landing.goto();
    const main = page.getByRole("main");
    await main.getByRole("link", { name: "学会カタログ", exact: true }).click();
    await expect(page).toHaveURL(/#s0-confs$/);
    await expect(page.locator("#s0-confs")).toBeInViewport();
    await main.getByRole("link", { name: "テーマ別の系譜", exact: true }).first().click();
    await expect(page).toHaveURL(/#s0-lineages$/);
    await expect(page.locator("#s0-lineages")).toBeInViewport();
  });
});

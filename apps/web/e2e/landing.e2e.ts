import { LandingPage } from "./pages";
import { expect, test } from "./support/fixtures";
import { conferences, publishedThemes } from "./support/site";

test.describe("landing", () => {
  test("loads with search, counts and published lineages", async ({ page }) => {
    const landing = new LandingPage(page);
    await landing.goto();
    await expect(page).toHaveTitle(/PaperPilot/);
    await expect(landing.heading).toBeVisible();
    await expect(landing.searchBox).toBeVisible();
    await expect(landing.chrome.globalNav).toBeVisible();
    await expect(landing.chrome.footer).toBeVisible();
    // Fail-closed shelf resolves to the published themes.
    await expect(landing.themeLinks).toHaveCount(publishedThemes().length);
  });

  test("theme links open the theme lineage", async ({ page }) => {
    const landing = new LandingPage(page);
    await landing.goto();
    const first = landing.themeLinks.first();
    const href = await first.getAttribute("href");
    expect(href).toMatch(/\/themes\/\?theme=[a-z0-9-]+/);
    await first.click();
    await expect(page).toHaveURL(/\/themes\/\?theme=/);
    await expect(page.getByRole("img", { name: /時系列家系図/ })).toBeVisible({ timeout: 20_000 });
  });

  test("conference catalog links resolve and navigate", async ({ page, request }) => {
    const landing = new LandingPage(page);
    await landing.goto();
    await landing.openConferenceList();
    const confs = conferences().map((c) => c.name);
    const hrefs = await page
      .getByRole("main")
      .locator("a[href]")
      .evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
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
    await page.locator(`main a[href="${target}"]`).first().click();
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

  test("cross-search finds papers from the landing", async ({ page }) => {
    const landing = new LandingPage(page);
    await landing.goto();
    await landing.searchBox.fill("diffusion");
    await expect(
      page
        .getByRole("option")
        .or(page.getByRole("link", { name: /diffusion/i }))
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});

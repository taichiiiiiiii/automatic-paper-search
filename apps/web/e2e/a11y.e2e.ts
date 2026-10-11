import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { CatalogPage, LandingPage, PaperLinksPage, ThemePage } from "./pages";
import { expect, test } from "./support/fixtures";
import { publishedThemes, themeHasCodeLinks, themeHasFeed } from "./support/site";

/**
 * axe-core audit of every page family. Any serious/critical violation of a
 * WCAG 2.x A/AA rule fails the test (no allow-list); minor/moderate ones
 * are only attached to the report.
 */
async function blockingViolations(page: Page, label: string): Promise<string[]> {
  // Let entrance animations (e.g. the catalog's staggered row fade-in)
  // finish: axe would otherwise measure contrast on half-transparent text.
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every(
          (a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity,
        ),
    undefined,
    { timeout: 10_000 },
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  await test.info().attach(`axe-${label}.json`, {
    body: JSON.stringify(results.violations, null, 2),
    contentType: "application/json",
  });
  const out: string[] = [];
  for (const v of results.violations) {
    if (v.impact !== "serious" && v.impact !== "critical") continue;
    const sample = v.nodes
      .slice(0, 3)
      .map((n) => n.target.join(" "))
      .join(" | ");
    const why = (v.nodes[0]?.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 300);
    out.push(`${v.impact} ${v.id}: ${v.help} (${v.nodes.length}x, e.g. ${sample}) -- ${why}`);
  }
  return out;
}

const PAGES: Record<string, (page: Page) => Promise<void>> = {
  landing: async (page) => {
    const landing = new LandingPage(page);
    await landing.goto();
    await landing.revealThemeShelf();
    await expect(landing.themeLinks.first()).toBeVisible();
    // Also audit the open search listbox.
    await landing.searchBox.fill("diffusion");
    await expect(landing.searchResults.getByRole("option").first()).toBeVisible({
      timeout: 15_000,
    });
  },
  theme: async (page) => {
    const theme = new ThemePage(page);
    await theme.goto(publishedThemes()[0]!.slug);
    await expect(theme.nodeCards.first()).toBeVisible();
    // Open everything that is collapsed by default, and the evidence panel.
    await expect(theme.readingGuide).toHaveAttribute("open", "");
    const slug = publishedThemes()[0]!.slug;
    if (themeHasFeed(slug)) await theme.expand(theme.newPapersSection);
    if (themeHasCodeLinks(slug)) await theme.expand(theme.codeLinksSection);
    await theme.openExportMenu();
    await theme.edgeButtons.first().focus();
    await page.keyboard.press("Enter");
    await expect(theme.evidencePanel).toBeVisible();
  },
  "theme-timeline": async (page) => {
    const theme = new ThemePage(page);
    await theme.skipOnboarding();
    await theme.goto(publishedThemes()[0]!.slug, "view=timeline");
    await expect(theme.timeline).toBeVisible();
  },
  catalog: async (page) => {
    const catalog = new CatalogPage(page, "iclr-2025");
    await catalog.goto();
    await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
    await catalog.conferenceSwitcher.locator("summary").click();
    await catalog.openDetailButton(0).click();
    await expect(catalog.selectedCard).toHaveCount(1);
  },
  "catalog-search": async (page) => {
    const catalog = new CatalogPage(page, "neurips-2025");
    await catalog.goto("q=diffusion");
    await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
  },
  "how-it-works": async (page) => {
    await page.goto("/how-it-works/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  },
  "404": async (page) => {
    await page.goto("/no-such-page-e2e/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("404");
  },
  "paper-links": async (page) => {
    const links = new PaperLinksPage(page);
    await links.goto("neurips-2025");
    await expect(links.heading).toBeVisible();
  },
};

test.describe("accessibility (axe)", () => {
  test.use({
    allowedProblems:
      /^(http: 404 .*\/no-such-page-e2e\/$|console: Failed to load resource: .*404.*no-such-page-e2e)/,
  });
  for (const [label, open] of Object.entries(PAGES)) {
    test(`${label}: no serious/critical violations`, async ({ page }) => {
      await open(page);
      const found = await blockingViolations(page, label);
      expect(found, `serious/critical axe violations on ${label}`).toEqual([]);
    });
  }
});

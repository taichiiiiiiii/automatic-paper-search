import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { CatalogPage, LandingPage, ThemePage } from "./pages";
import { expect, test } from "./support/fixtures";
import { publishedThemes } from "./support/site";

/**
 * axe-core audit of the three page families. Serious/critical violations
 * (WCAG 2.x A/AA rules) fail; minor/moderate ones are only attached to the
 * report.
 *
 * KNOWN lists rule ids already violated on develop (2026-10-12, found by
 * this suite) so the gating test still catches NEW serious rules on that
 * page; the matching `test.fixme` below asserts the page is fully clean
 * and should be un-fixme'd once the redesign fixes them:
 *  - theme: color-contrast (Atom feed link, HF/code links in コードとモデル),
 *    link-in-text-block (仕組み / 計算のしかた / Hugging Face Papers links
 *    styled only by colour), nested-interactive (the tree <svg role="img">
 *    contains focusable edge buttons and paper links).
 *  - catalog: color-contrast (~300 nodes: breadcrumb link, title links,
 *    OpenReview/PDF links, tag chips), link-in-text-block (abstract
 *    licence link "CC0 1.0" / "CC BY 4.0").
 */
const KNOWN: Record<string, string[]> = {
  landing: [],
  theme: ["color-contrast", "link-in-text-block", "nested-interactive"],
  catalog: ["color-contrast", "link-in-text-block"],
};

async function blockingViolations(page: Page, label: string): Promise<Map<string, string>> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  await test.info().attach(`axe-${label}.json`, {
    body: JSON.stringify(results.violations, null, 2),
    contentType: "application/json",
  });
  const out = new Map<string, string>();
  for (const v of results.violations) {
    if (v.impact !== "serious" && v.impact !== "critical") continue;
    const sample = v.nodes
      .slice(0, 3)
      .map((n) => n.target.join(" "))
      .join(" | ");
    out.set(v.id, `${v.impact} ${v.id}: ${v.help} (${v.nodes.length}x, e.g. ${sample})`);
  }
  return out;
}

const PAGES: Record<string, (page: Page) => Promise<void>> = {
  landing: async (page) => {
    const landing = new LandingPage(page);
    await landing.goto();
    await expect(landing.themeLinks.first()).toBeVisible();
  },
  theme: async (page) => {
    const theme = new ThemePage(page);
    await theme.skipOnboarding();
    await theme.goto(publishedThemes()[0]!.slug);
    await expect(theme.nodeLinks.first()).toBeVisible();
  },
  catalog: async (page) => {
    const catalog = new CatalogPage(page, "iclr-2025");
    await catalog.goto();
    await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
  },
};

test.describe("accessibility (axe)", () => {
  for (const [label, open] of Object.entries(PAGES)) {
    const known = KNOWN[label] ?? [];
    test(`${label}: no new serious/critical violations`, async ({ page }) => {
      await open(page);
      const found = await blockingViolations(page, label);
      const fresh = [...found].filter(([id]) => !known.includes(id)).map(([, msg]) => msg);
      expect(fresh, `serious/critical axe violations on ${label}`).toEqual([]);
    });

    if (known.length > 0) {
      // BUG: see the KNOWN comment at the top of this file.
      test.fixme(`${label}: no serious/critical violations at all`, async ({ page }) => {
        await open(page);
        const found = await blockingViolations(page, label);
        expect([...found.values()]).toEqual([]);
      });
    }
  }
});

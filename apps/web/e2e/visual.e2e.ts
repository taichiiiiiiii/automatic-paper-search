/**
 * Visual regression (toHaveScreenshot), Chromium only (desktop 1280x800 +
 * mobile 375px).
 *
 * Font rasterisation differs per OS, so baselines are per platform
 * (`e2e/__screenshots__/<platform>/<project>/…`, see playwright.config.ts)
 * and only the Linux ones are committed: they are generated on the CI
 * runner by the e2e workflow's `update-snapshots` dispatch input and come
 * back as an artifact to commit. Every test here SKIPS when the baseline
 * for the current platform is missing (e.g. on macOS, or before the first
 * Linux baseline is committed) instead of failing, unless snapshots are
 * being updated (`--update-snapshots`).
 *
 * Dynamic parts (dates, counts, data-driven lists) are masked; animations
 * and the caret are disabled in the config. A data regeneration that
 * changes a theme's tree needs refreshed baselines (dispatch the workflow).
 */
import { existsSync } from "node:fs";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { CatalogPage, LandingPage, ThemePage } from "./pages";
import { expect, test } from "./support/fixtures";
import { conferences, publishedThemes } from "./support/site";

const VISUAL_CATALOG = "eccv-2024";

/** Skips the test unless a baseline exists for this platform/project (or
 * snapshots are being written). Call before navigating. */
function requireBaselines(testInfo: TestInfo, browserName: string, ...names: string[]): void {
  test.skip(browserName !== "chromium", "visual baselines are Chromium-only");
  const mode = testInfo.config.updateSnapshots;
  if (mode === "all" || mode === "changed") return;
  const missing = names.filter(
    (n) => !existsSync(testInfo.snapshotPath(n, { kind: "screenshot" })),
  );
  test.skip(
    missing.length > 0,
    `no ${process.platform} baseline (${missing.join(", ")}); generate on Linux via the e2e workflow`,
  );
}

/** Text that changes with the published data or the clock. */
function dynamicMasks(page: Page): Locator[] {
  return [
    page.locator("time"),
    page.getByText(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月/),
    page.getByText(/[\d,]+\s*(件|本|編|papers?)/),
  ];
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  // Finite transitions/fade-ins finish (infinite ones are frozen by
  // `animations: "disabled"` at capture time).
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
}

test.describe("visual", () => {
  test("landing (first viewport)", async ({ page, browserName }, testInfo) => {
    requireBaselines(testInfo, browserName, "landing.png");
    const landing = new LandingPage(page);
    await landing.goto();
    await expect(landing.searchBox).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot("landing.png", {
      mask: [...dynamicMasks(page), landing.lineagesSection, landing.conferencesSection],
    });
  });

  test("theme: family tree and timeline", async ({ page, browserName }, testInfo) => {
    requireBaselines(testInfo, browserName, "theme-tree.png", "theme-timeline.png");
    const themes = publishedThemes();
    test.skip(themes.length === 0, "no published theme in this build");
    const slug = [...themes].sort((a, b) => a.slug.localeCompare(b.slug))[0]!.slug;
    const theme = new ThemePage(page);
    await theme.skipOnboarding();
    await theme.goto(slug);
    await expect(theme.tree).toBeVisible();
    await settle(page);
    await expect(theme.tree).toHaveScreenshot("theme-tree.png", { mask: dynamicMasks(page) });
    await theme.goto(slug, "view=timeline");
    await expect(theme.timeline).toBeVisible();
    await settle(page);
    await expect(theme.timeline).toHaveScreenshot("theme-timeline.png", {
      mask: dynamicMasks(page),
    });
  });

  test("conference catalog (first viewport)", async ({ page, browserName }, testInfo) => {
    requireBaselines(testInfo, browserName, "catalog.png");
    // A fixed, small, already-closed edition (cheap to load, stable
    // counts); its rows are masked anyway.
    const conf = VISUAL_CATALOG;
    test.skip(!conferences().some((c) => c.name === conf), `${conf} is not in this build`);
    const catalog = new CatalogPage(page, conf);
    await catalog.goto();
    await expect(catalog.results.first()).toBeVisible({ timeout: 20_000 });
    await settle(page);
    await expect(page).toHaveScreenshot("catalog.png", {
      mask: [...dynamicMasks(page), page.locator("#paper-list")],
    });
  });

  test("how it works (first viewport)", async ({ page, browserName }, testInfo) => {
    requireBaselines(testInfo, browserName, "how-it-works.png");
    await page.goto("/how-it-works/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot("how-it-works.png", { mask: dynamicMasks(page) });
  });

  test.describe("404", () => {
    test.use({
      allowedProblems:
        /^(http: 404 .*\/no-such-page-e2e\/$|console: Failed to load resource: .*404.*no-such-page-e2e)/,
    });
    test("not-found page (full page)", async ({ page, browserName }, testInfo) => {
      requireBaselines(testInfo, browserName, "not-found.png");
      await page.goto("/no-such-page-e2e/");
      await expect(page.getByRole("heading", { level: 1 })).toContainText("404");
      await settle(page);
      await expect(page).toHaveScreenshot("not-found.png", {
        fullPage: true,
        mask: dynamicMasks(page),
      });
    });
  });
});

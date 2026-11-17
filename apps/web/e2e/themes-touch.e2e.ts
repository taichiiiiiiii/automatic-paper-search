import AxeBuilder from "@axe-core/playwright";
import { ThemePage } from "./pages";
import { expect, test } from "./support/fixtures";
import { publishedThemes } from "./support/site";

/**
 * #521 U11: the year x citation view on a phone. At 412 px with a touch
 * screen the chart fits its box (no side-scrolling of the box or the page)
 * and the note says what a tap does; at 1280 px with a mouse the chart and
 * the note stay as before.
 */
const SLUGS = ["neural-radiance-fields", "low-rank-adaptation"];
const MOUSE_NOTE = "点を選ぶと、その論文の土台と発展を下に表示します。線の上に置くと関係が出ます。";

function themesUnderTest(): string[] {
  const published = new Set(publishedThemes().map((t) => t.slug));
  const wanted = SLUGS.filter((s) => published.has(s));
  if (wanted.length > 0) return wanted;
  const first = publishedThemes()[0];
  return first ? [first.slug] : [];
}

test.describe("year x citation view on a 412 px touch screen (#521 U11)", () => {
  test.skip(({ browserName }) => browserName === "firefox", "Firefox has no isMobile emulation");
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });

  for (const slug of themesUnderTest()) {
    test(`${slug}: chart fits the box, tap wording, no axe violation`, async ({ page }) => {
      const theme = new ThemePage(page);
      await theme.skipOnboarding();
      await theme.goto(slug, "view=timeline");
      await expect(theme.timelineChart).toBeVisible();

      await expect(theme.viewNote).toContainText("タップ");
      await expect(theme.viewNote).not.toContainText("置くと");

      await expect
        .poll(() => theme.timelineBox.evaluate((b) => b.scrollWidth - b.clientWidth))
        .toBe(0);
      const pageOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(pageOverflow).toBe(0);

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      const blocking = results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.impact} ${v.id} (${v.nodes.length}x)`);
      expect(blocking).toEqual([]);

      // A tap on a dot selects that paper, also the first one drawn (its
      // neighbours' tap areas used to cover it). Axe runs before the taps:
      // the selected paper's neighbour panel is outside this change.
      for (const point of [theme.timelinePoints.first(), theme.timelinePoints.last()]) {
        await point.tap();
        await expect(point).toHaveAttribute("aria-pressed", "true");
      }
    });
  }
});

test.describe("year x citation view at 1280 px with a mouse (#521 U11)", () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });

  for (const slug of themesUnderTest()) {
    test(`${slug}: 640 px chart and the hover note`, async ({ page }) => {
      const theme = new ThemePage(page);
      await theme.skipOnboarding();
      await theme.goto(slug, "view=timeline");
      await expect(theme.timelineChart).toBeVisible();
      await expect(theme.viewNote).toHaveText(MOUSE_NOTE);
      await expect(theme.timelineChart).toHaveAttribute("width", "640");
    });
  }
});

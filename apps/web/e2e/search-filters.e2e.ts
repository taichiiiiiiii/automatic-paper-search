import { LandingPage } from "./pages";
import { expect, test } from "./support/fixtures";

// #521 U4 (position only): while the top-20 suggestion list is open, the
// filters must sit above it and stay clickable, not under the absolutely
// positioned list. The ranking itself is out of scope.
for (const width of [412, 1280]) {
  test(`search filters stay above the open suggestion list at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const landing = new LandingPage(page);
    await landing.goto();
    await landing.searchBox.fill("diffusion");
    const first = landing.searchResults.getByRole("option").first();
    await expect(first).toBeVisible({ timeout: 15_000 });
    await expect(landing.searchFilters).toBeVisible();

    const filters = await landing.searchFilters.boundingBox();
    const option = await first.boundingBox();
    const list = await landing.searchResults.boundingBox();
    expect(filters).not.toBeNull();
    expect(option).not.toBeNull();
    expect(list).not.toBeNull();
    if (!filters || !option || !list) return;
    expect(filters.y).toBeLessThan(option.y);
    expect(filters.y + filters.height).toBeLessThanOrEqual(list.y + 1);

    // Nothing paints over the facet: the topmost element at its centre is
    // the select itself.
    const conference = landing.searchFilters.getByLabel("学会");
    const hit = await conference.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top === el || el.contains(top);
    });
    expect(hit).toBe(true);
    // Keyboard: Tab from the box walks through the filters and still
    // reaches the "すべての N 件を見る" link while the list stays open.
    const more = page.getByRole("link", { name: /^すべての [\d,]+ 件を見る$/ });
    await landing.searchBox.focus();
    let reached = false;
    for (let i = 0; i < 8 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await more.evaluate((el) => el === document.activeElement).catch(() => false);
    }
    expect(reached).toBe(true);
    await expect(more).toBeVisible();
    await expect(first).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

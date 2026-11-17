import { LandingPage } from "./pages";
import { expect, test } from "./support/fixtures";

// #521 U18: from 721px up the suggestion list is an absolute dropdown and
// used to paint over the "すべての N 件を見る" link, so a click on the link
// opened the first suggestion. At both widths the topmost element at the
// link's centre must be the link itself, and a click must open the full
// results (`?q=…&page=1`) on the landing page.
for (const width of [1280, 412]) {
  test(`'see all' link is not covered by the open suggestion list at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const landing = new LandingPage(page);
    await landing.goto();
    await landing.searchBox.fill("diffusion");
    await expect(landing.searchResults.getByRole("option").first()).toBeVisible({
      timeout: 15_000,
    });
    const more = landing.searchMoreLink;
    await expect(more).toBeVisible();
    await more.scrollIntoViewIfNeeded();

    const centre = await more.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return { x, y, onLink: top === el || el.contains(top) };
    });
    expect(centre.onLink).toBe(true);

    // A real pointer click at that point (not locator.click(), which would
    // fail on the cover instead of reporting where the click landed).
    await page.mouse.click(centre.x, centre.y);
    await expect(page).toHaveURL(/\/\?(?:.*&)?page=1(?:&|$)/);
    expect(new URL(page.url()).pathname).toBe("/");
    expect(landing.searchParam("q")).toBe("diffusion");
    await expect(landing.fullResultLinks.first()).toBeVisible();
    await expect(landing.searchResults).toBeHidden();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

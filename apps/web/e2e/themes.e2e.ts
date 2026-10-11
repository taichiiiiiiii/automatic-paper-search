import { readFile } from "node:fs/promises";
import type { Download, Page } from "@playwright/test";
import { ThemePage } from "./pages";
import { expect, test } from "./support/fixtures";
import { publishedThemes, themeHasFeed } from "./support/site";

const ISSUES_NEW = "https://github.com/taichiiiiiiii/automatic-paper-search/issues/new";

async function downloadBytes(
  page: Page,
  click: () => Promise<void>,
): Promise<{
  name: string;
  bytes: Buffer;
}> {
  const [download] = await Promise.all([page.waitForEvent("download"), click()]);
  return { name: (download as Download).suggestedFilename(), bytes: await readDownload(download) };
}

async function readDownload(download: Download): Promise<Buffer> {
  const path = await download.path();
  return readFile(path);
}

const themes = publishedThemes();

test("at least one theme is published", () => {
  expect(themes.length).toBeGreaterThan(0);
});

test("/themes/ without a theme shows the gallery and a default tree", async ({ page }) => {
  const theme = new ThemePage(page);
  await theme.skipOnboarding();
  await page.goto("/themes/");
  await theme.waitForTree();
  await expect(theme.gallery.getByRole("link")).toHaveCount(themes.length);
});

for (const t of themes) {
  test.describe(`theme ${t.slug}`, () => {
    let theme: ThemePage;
    test.beforeEach(async ({ page }) => {
      theme = new ThemePage(page);
      await theme.skipOnboarding();
    });

    test("tree renders with the theme's papers", async ({ page }) => {
      await theme.goto(t.slug);
      await expect(page).toHaveTitle(new RegExp(t.theme));
      await expect(theme.heading).toBeVisible();
      await expect(theme.nodeLinks.first()).toBeVisible();
      const nodes = await theme.nodeLinks.count();
      expect(nodes).toBeGreaterThan(0);
      expect(nodes).toBeLessThanOrEqual(t.paper_count);
      expect(await theme.edgeButtons.count()).toBeGreaterThan(0);
      await expect(theme.galleryLink(t.theme)).toBeVisible();
    });

    test("evidence panel opens on an edge, has a report link, closes with Esc", async ({
      page,
    }) => {
      await theme.goto(t.slug);
      const edge = theme.edgeButtons.first();
      await edge.focus();
      await page.keyboard.press("Enter");
      await expect(theme.evidencePanel).toBeVisible();
      await expect(edge).toHaveAttribute("aria-pressed", "true");
      await expect(theme.evidenceHeading).toBeFocused();

      const href = await theme.reportErrorLink.getAttribute("href");
      expect(href).toBeTruthy();
      const url = new URL(href!);
      expect(`${url.origin}${url.pathname}`).toBe(ISSUES_NEW);
      expect(url.searchParams.get("template")).toBe("lineage-feedback.yml");
      expect(url.searchParams.get("labels")).toBe("lineage-feedback");
      expect(url.searchParams.get("title")).toContain(t.theme);
      expect(url.searchParams.get("theme")).toContain(t.slug);
      expect(url.searchParams.get("page") ?? "").toContain(`theme=${t.slug}`);

      await page.keyboard.press("Escape");
      await expect(theme.evidencePanel).toBeHidden();
      await expect(edge).toHaveAttribute("aria-pressed", "false");

      // The close button works too.
      await edge.focus();
      await page.keyboard.press("Enter");
      await expect(theme.evidencePanel).toBeVisible();
      await theme.evidenceCloseButton.click();
      await expect(theme.evidencePanel).toBeHidden();
    });

    // BUG (themes, a11y): closing the evidence panel (Esc or 閉じる) drops
    // focus to <body> instead of returning it to the edge that opened it,
    // so keyboard users lose their place in the tree. The panel moves
    // focus to its heading on open (LineageTree.tsx selectEdge) but nothing
    // restores it on close. Expected: focus back on the opening edge.
    test.fixme("closing the evidence panel returns focus to the opening edge", async ({ page }) => {
      await theme.goto(t.slug);
      const edge = theme.edgeButtons.first();
      await edge.focus();
      await page.keyboard.press("Enter");
      await expect(theme.evidenceHeading).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(theme.evidencePanel).toBeHidden();
      await expect(edge).toBeFocused();
    });

    test("main-path toggle is reflected in the URL and restored from it", async () => {
      await theme.goto(t.slug);
      await expect(theme.mainPathGroup).toBeVisible();
      await expect(theme.mainPathButton("強調")).toHaveAttribute("aria-pressed", "true");

      await theme.mainPathButton("本流だけ").click();
      await expect(theme.mainPathButton("本流だけ")).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => theme.searchParam("main")).toBe("only");

      await theme.mainPathButton("切").click();
      await expect(theme.mainPathButton("切")).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => theme.searchParam("main")).toBe("off");

      await theme.mainPathButton("強調").click();
      await expect.poll(() => theme.searchParam("main")).toBeNull();

      await theme.goto(t.slug, "main=only");
      await expect(theme.mainPathButton("本流だけ")).toHaveAttribute("aria-pressed", "true");
    });

    test("view toggle switches tree/timeline, selects a node, keeps state in the URL", async ({
      page,
    }) => {
      await theme.goto(t.slug);
      await expect(theme.viewButton("家系図")).toHaveAttribute("aria-pressed", "true");
      await theme.viewButton("年×被引用").click();
      await expect(theme.timeline).toBeVisible();
      await expect(theme.tree).toBeHidden();
      await expect.poll(() => theme.searchParam("view")).toBe("timeline");

      // Selecting a paper (node) in the timeline selects it everywhere.
      const point = theme.timelinePoints.first();
      await point.focus();
      await page.keyboard.press("Enter");
      await expect(point).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => theme.searchParam("focus")).toBeTruthy();
      await expect(theme.paperSelect).toHaveValue(theme.searchParam("focus")!);

      await theme.viewButton("家系図").click();
      await expect(theme.tree).toBeVisible();
      await expect.poll(() => theme.searchParam("view")).not.toBe("timeline");

      await theme.goto(t.slug, "view=timeline");
      await expect(theme.timeline).toBeVisible();
      await expect(theme.viewButton("年×被引用")).toHaveAttribute("aria-pressed", "true");
    });

    test("Prior/Derivative panel and the two-paper path (?focus= / ?to=)", async () => {
      await theme.goto(t.slug);
      await expect(theme.neighborsPanel).toBeVisible();
      const values = await theme.paperSelect
        .locator("option")
        .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
      expect(values.length).toBeGreaterThan(1);
      const from = values[0]!;
      const to = values[values.length - 1]!;

      await theme.paperSelect.selectOption(from);
      await expect.poll(() => theme.searchParam("focus")).toBe(from);
      await expect(theme.neighborHeading("土台")).toBeVisible();
      await expect(theme.neighborHeading("発展")).toBeVisible();

      await theme.pathToSelect.selectOption(to);
      await expect.poll(() => theme.searchParam("to")).toBe(to);
      await expect(theme.pathResult).toBeVisible();

      // Deep link restores both selections.
      await theme.goto(t.slug, `focus=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      await expect(theme.paperSelect).toHaveValue(from);
      await expect(theme.pathToSelect).toHaveValue(to);
      await expect(theme.pathResult).toBeVisible();
    });

    test("exports download non-empty BibTeX / CSV / SVG / PNG files", async ({ page }) => {
      await theme.goto(t.slug);
      const bib = await downloadBytes(page, () => theme.exportButton("BibTeX").click());
      expect(bib.name).toMatch(/\.bib$/);
      expect(bib.bytes.toString("utf8")).toMatch(/^@\w+\{/m);

      const papers = await downloadBytes(page, () => theme.exportButton("CSV（論文）").click());
      expect(papers.name).toMatch(/\.csv$/);
      expect(papers.bytes.toString("utf8").trim().split("\n").length).toBeGreaterThan(1);

      const rels = await downloadBytes(page, () => theme.exportButton("CSV（関係）").click());
      expect(rels.name).toMatch(/\.csv$/);
      expect(rels.bytes.toString("utf8").trim().split("\n").length).toBeGreaterThan(1);

      const svg = await downloadBytes(page, () => theme.exportButton("SVG").click());
      expect(svg.name).toMatch(/\.svg$/);
      expect(svg.bytes.toString("utf8")).toContain("<svg");

      const png = await downloadBytes(page, () => theme.exportButton("PNG").click());
      expect(png.name).toMatch(/\.png$/);
      expect(png.bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.bytes.length).toBeGreaterThan(1000);
    });

    test("URL copy puts the current URL on the clipboard", async ({ page, context, baseURL }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
      await theme.goto(t.slug, "main=only");
      await theme.copyUrlButton.click();
      await expect(theme.shareStatus).toHaveText(/コピーしました/);
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toBe(page.url());
      expect(new URL(copied).searchParams.get("theme")).toBe(t.slug);
    });

    test("new-papers section links a valid Atom feed", async ({ page, request }) => {
      test.skip(!themeHasFeed(t.slug), "no feed.xml published for this theme");
      await theme.goto(t.slug);
      await expect(theme.newPapersSection).toBeVisible();
      const href = await theme.feedLink.getAttribute("href");
      expect(href).toBe(`/themes/${t.slug}/feed.xml`);
      const res = await request.get(href!);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toMatch(/xml/);
      const xml = await res.text();
      const parsed = await page.evaluate((text) => {
        const doc = new DOMParser().parseFromString(text, "application/xml");
        const root = doc.documentElement;
        const atom = "http://www.w3.org/2005/Atom";
        const child = (name: string) => root.getElementsByTagNameNS(atom, name)[0]?.textContent;
        return {
          error: doc.getElementsByTagName("parsererror").length > 0,
          root: root.localName,
          ns: root.namespaceURI,
          title: child("title"),
          id: child("id"),
          updated: child("updated"),
          entries: root.getElementsByTagNameNS(atom, "entry").length,
        };
      }, xml);
      expect(parsed.error).toBe(false);
      expect(parsed.root).toBe("feed");
      expect(parsed.ns).toBe("http://www.w3.org/2005/Atom");
      expect(parsed.title).toBeTruthy();
      expect(parsed.id).toBeTruthy();
      expect(Number.isNaN(Date.parse(parsed.updated ?? ""))).toBe(false);
    });
  });
}

test("back/forward restores the theme and its view state", async ({ page }) => {
  test.skip(themes.length < 2, "needs two published themes");
  const [a, b] = themes as [(typeof themes)[0], (typeof themes)[0]];
  const theme = new ThemePage(page);
  await theme.skipOnboarding();
  await theme.goto(a.slug);
  await theme.viewButton("年×被引用").click();
  await expect.poll(() => theme.searchParam("view")).toBe("timeline");

  await theme.galleryLink(b.theme).click();
  await expect.poll(() => theme.searchParam("theme")).toBe(b.slug);
  await expect(page).toHaveTitle(new RegExp(b.theme));

  await page.goBack();
  await expect.poll(() => theme.searchParam("theme")).toBe(a.slug);
  await expect(page).toHaveTitle(new RegExp(a.theme));
  await expect(theme.timeline).toBeVisible();
  await expect(theme.viewButton("年×被引用")).toHaveAttribute("aria-pressed", "true");

  await page.goForward();
  await expect.poll(() => theme.searchParam("theme")).toBe(b.slug);
  await expect(page).toHaveTitle(new RegExp(b.theme));
});

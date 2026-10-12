import { readFile } from "node:fs/promises";
import type { Download, Page } from "@playwright/test";
import { ThemePage } from "./pages";
import { expect, PROD, test } from "./support/fixtures";
import { publishedThemes, themeHasCodeLinks, themeHasFeed } from "./support/site";

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

/** Production smoke covers one theme (the first published) end to end. */
const prodTag = (slug: string) => (slug === themes[0]?.slug ? PROD : {});

test("at least one theme is published", PROD, () => {
  expect(themes.length).toBeGreaterThan(0);
});

test("/themes/ without a theme shows the gallery and a default tree", PROD, async ({ page }) => {
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

    test("tree renders with the theme's papers", prodTag(t.slug), async ({ page }) => {
      await theme.goto(t.slug);
      await expect(page).toHaveTitle(new RegExp(t.theme));
      await expect(theme.heading).toContainText(`${t.theme} の系譜`);
      await expect(theme.nodeCards.first()).toBeVisible();
      const nodes = await theme.nodeCards.count();
      expect(nodes).toBeGreaterThan(0);
      expect(nodes).toBeLessThanOrEqual(t.paper_count);
      expect(await theme.edgeButtons.count()).toBeGreaterThan(0);
      await expect(theme.galleryLink(t.theme)).toBeVisible();
      await expect(theme.galleryLink(t.theme)).toHaveAttribute("aria-current", "page");
    });

    test("selecting a card shows the selection bar and ?focus= without leaving the site", async ({
      page,
    }) => {
      await theme.goto(t.slug);
      const card = theme.nodeCards.first();
      await card.click();
      await expect(page).toHaveURL(/\/themes\/\?/);
      await expect(card).toHaveAttribute("aria-pressed", "true");
      await expect(theme.selectedPaperBar).toBeVisible();
      await expect(theme.selectedPaperBar).toContainText(/土台 \d+ 本・発展 \d+ 本/);
      await expect.poll(() => theme.searchParam("focus")).toBeTruthy();
      await expect(theme.paperSelect).toHaveValue(theme.searchParam("focus")!);
      // Clicking it again deselects.
      await card.click();
      await expect(theme.selectedPaperBar).toBeHidden();
      await expect.poll(() => theme.searchParam("focus")).toBeNull();
    });

    test(
      "evidence panel opens on an edge, has a report link, closes with Esc",
      prodTag(t.slug),
      async ({ page }) => {
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
      },
    );

    test("closing the evidence panel returns focus to the opening edge", async ({ page }) => {
      await theme.goto(t.slug);
      const edge = theme.edgeButtons.first();
      await edge.focus();
      await page.keyboard.press("Enter");
      await expect(theme.evidenceHeading).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(theme.evidencePanel).toBeHidden();
      await expect(edge).toBeFocused();

      // Same for the close button.
      await page.keyboard.press("Enter");
      await expect(theme.evidenceHeading).toBeFocused();
      await theme.evidenceCloseButton.click();
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

      await theme.mainPathButton("オフ").click();
      await expect(theme.mainPathButton("オフ")).toHaveAttribute("aria-pressed", "true");
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

    test("並べ方 select changes the layout order", async () => {
      await theme.goto(t.slug);
      const options = await theme.orderSelect
        .locator("option")
        .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      expect(options.length).toBeGreaterThan(1);
      const initial = await theme.orderSelect.inputValue();
      const other = options.find((o) => o !== initial)!;
      await theme.orderSelect.selectOption(other);
      await expect(theme.orderSelect).toHaveValue(other);
      await expect(theme.nodeCards.first()).toBeVisible();
    });

    test("zoom buttons scale the tree and 全体 fits it", async () => {
      await theme.goto(t.slug);
      const z0 = await theme.zoom();
      expect(z0).toBeGreaterThan(0);
      await theme.zoomButton("拡大").click();
      await expect.poll(() => theme.zoom()).toBeGreaterThan(z0);
      const z1 = await theme.zoom();
      await theme.zoomButton("縮小").click();
      await expect.poll(() => theme.zoom()).toBeLessThan(z1);
      await theme.zoomButton("縮小").click();
      await theme.zoomButton("全体").click();
      // "Fit" makes the SVG no wider than its scroll box.
      await expect
        .poll(() =>
          theme.tree.evaluate((svg) => {
            const box = svg.parentElement as HTMLElement;
            return svg.getBoundingClientRect().width <= box.clientWidth + 1;
          }),
        )
        .toBe(true);
    });

    test("reading guide opens on a first visit and stays closed once closed", async ({ page }) => {
      // Fresh storage: no skipOnboarding for this page.
      const fresh = await page.context().newPage();
      const first = new ThemePage(fresh);
      await first.goto(t.slug);
      await expect(first.readingGuide).toHaveAttribute("open", "");
      await expect(first.readingGuide.getByRole("heading", { name: "ことば" })).toBeVisible();
      await first.readingGuide.locator("summary").click();
      await expect(first.readingGuide).not.toHaveAttribute("open", "");
      // The dismissal is stored from the (async) `toggle` event.
      await expect
        .poll(() => fresh.evaluate(() => localStorage.getItem("pp.theme.onboarded")))
        .toBe("1");
      await first.goto(t.slug);
      await expect(first.readingGuide).not.toHaveAttribute("open", "");
      await fresh.close();
      // The page with the skip flag starts collapsed and can be opened.
      await theme.goto(t.slug);
      await expect(theme.readingGuide).not.toHaveAttribute("open", "");
      await theme.readingGuide.locator("summary").click();
      await expect(theme.readingGuide).toHaveAttribute("open", "");
      await expect(page.locator("[data-reading-guide] h3").first()).toBeVisible();
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

    test("export menu downloads non-empty BibTeX / CSV / SVG / PNG files", async ({ page }) => {
      await theme.goto(t.slug);
      await expect(theme.exportButton("bibtex")).toBeHidden();
      await theme.openExportMenu();

      const bib = await downloadBytes(page, () => theme.exportButton("bibtex").click());
      expect(bib.name).toMatch(/\.bib$/);
      expect(bib.bytes.toString("utf8")).toMatch(/^@\w+\{/m);

      await theme.openExportMenu();
      const papers = await downloadBytes(page, () => theme.exportButton("nodes-csv").click());
      expect(papers.name).toMatch(/\.csv$/);
      expect(papers.bytes.toString("utf8").trim().split("\n").length).toBeGreaterThan(1);

      await theme.openExportMenu();
      const rels = await downloadBytes(page, () => theme.exportButton("edges-csv").click());
      expect(rels.name).toMatch(/\.csv$/);
      expect(rels.bytes.toString("utf8").trim().split("\n").length).toBeGreaterThan(1);

      await theme.openExportMenu();
      const svg = await downloadBytes(page, () => theme.exportButton("画像（SVG）").click());
      expect(svg.name).toMatch(/\.svg$/);
      expect(svg.bytes.toString("utf8")).toContain("<svg");

      await theme.openExportMenu();
      const png = await downloadBytes(page, () => theme.exportButton("画像（PNG）").click());
      expect(png.name).toMatch(/\.png$/);
      expect(png.bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.bytes.length).toBeGreaterThan(1000);
    });

    test("URL copy puts the current URL on the clipboard", async ({ page, context, baseURL }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
      await theme.goto(t.slug, "main=only");
      await theme.openExportMenu();
      await theme.copyUrlButton.click();
      await expect(theme.shareStatus).toHaveText(/コピーしました/);
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toBe(page.url());
      expect(new URL(copied).searchParams.get("theme")).toBe(t.slug);
    });

    test("keyboard help dialog traps focus and returns it on close", async ({ page }) => {
      await theme.goto(t.slug);
      // The ⌨ button is shown from `sm` up; the "?" key works everywhere.
      const buttonShown = await theme.keyboardHelpButton.isVisible();
      const opener = buttonShown ? theme.keyboardHelpButton : theme.nodeCards.first();
      if (buttonShown) {
        await opener.click();
      } else {
        await opener.focus();
        await page.keyboard.press("?");
      }
      const dialog = theme.keyboardHelpDialog;
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      const close = dialog.getByRole("button", { name: "閉じる" });
      await expect(close).toBeFocused();
      // Tab / Shift+Tab stay inside the dialog.
      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(close).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();

      // "?" opens it from the keyboard; the close button closes it.
      await page.keyboard.press("?");
      await expect(dialog).toBeVisible();
      await close.click();
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
    });

    test(
      "new-papers section (collapsed) links a valid Atom feed",
      prodTag(t.slug),
      async ({ page, request }) => {
        test.skip(!themeHasFeed(t.slug), "no feed.xml published for this theme");
        await theme.goto(t.slug);
        await expect(theme.newPapersSection).toBeVisible();
        await expect(theme.feedLink).toBeHidden();
        await theme.expand(theme.newPapersSection);
        await expect(theme.feedLink).toBeVisible();
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
      },
    );

    test("コードとモデル section is collapsed and lists badges when opened", async () => {
      test.skip(!themeHasCodeLinks(t.slug), "no code links for this theme");
      await theme.goto(t.slug);
      const section = theme.codeLinksSection;
      await expect(section).toBeVisible();
      const list = section.locator("ul").first();
      await expect(list).toBeHidden();
      await theme.expand(section);
      await expect(list).toBeVisible();
      expect(await section.locator("a[href^='http']").count()).toBeGreaterThan(0);
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

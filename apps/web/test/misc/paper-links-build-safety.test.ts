import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Review finding M1 (continued): `readPapers` in
 * app/[conf]/paper-links/page.tsx used to call `notFound()` on a
 * missing papers.json, which a static export renders as a real,
 * 200-status page -- the build stayed green while silently shipping a
 * 404 look-alike at a real URL. The fix replaced that call with a
 * thrown Error (see paper-links-build-guard.test.ts for the
 * generateStaticParams-level guard that should make this unreachable in
 * practice; this file pins the fallback itself and, once a real build
 * exists, that no built page is a disguised not-found page).
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(TEST_DIR, "..", "..");
const PAPER_LINKS_DIR = join(WEB_ROOT, "app", "[conf]", "paper-links");
// R3-2: readPapers moved to read-papers.ts (shared by page 1 and pages 2..n).
const PAGE_SOURCE = join(PAPER_LINKS_DIR, "read-papers.ts");
const PAGE_SOURCES = [
  PAGE_SOURCE,
  join(PAPER_LINKS_DIR, "page.tsx"),
  join(PAPER_LINKS_DIR, "view.tsx"),
  join(PAPER_LINKS_DIR, "[page]", "page.tsx"),
];

/** Every built no-JS page: `<conf>/paper-links/index.html` and `<conf>/paper-links/<n>/index.html`. */
function builtPaperLinksPages(): Array<{ label: string; file: string }> {
  const pages: Array<{ label: string; file: string }> = [];
  for (const conf of readdirSync(OUT_DIR)) {
    const dir = join(OUT_DIR, conf, "paper-links");
    if (!existsSync(join(dir, "index.html"))) continue;
    pages.push({ label: `${conf}/paper-links`, file: join(dir, "index.html") });
    for (const entry of readdirSync(dir)) {
      if (/^[1-9][0-9]*$/.test(entry) && existsSync(join(dir, entry, "index.html"))) {
        pages.push({ label: `${conf}/paper-links/${entry}`, file: join(dir, entry, "index.html") });
      }
    }
  }
  return pages;
}
const OUT_DIR = join(WEB_ROOT, "out");

describe("paper-links page.tsx readPapers", () => {
  it("fails the build with a thrown Error instead of next/navigation's notFound()", () => {
    expect(readFileSync(PAGE_SOURCE, "utf8")).toMatch(/throw new Error/);
    for (const file of PAGE_SOURCES) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("notFound()");
      expect(source, file).not.toMatch(/from\s+"next\/navigation"/);
    }
  });
});

describe("paper-links head metadata", () => {
  it.skipIf(!existsSync(OUT_DIR))(
    "built /<conf>/paper-links/ pages are noindex and carry no self-canonical link",
    () => {
      const pages = builtPaperLinksPages();
      expect(pages.length).toBeGreaterThan(0);
      for (const { label: conf, file } of pages) {
        const html = readFileSync(file, "utf8");
        expect(html, conf).toMatch(/<meta name="robots" content="noindex, follow"\s*\/?>/);
        // The original docs/<conf>/paper-links.html never carried a
        // self-canonical tag; a canonical pointing at a noindex page is
        // a contradictory signal to crawlers.
        expect(html, conf).not.toMatch(/<link rel="canonical"/);
      }
    },
  );
});

describe("built paper-links pages are never a disguised not-found page", () => {
  it.skipIf(!existsSync(OUT_DIR))(
    "every built /<conf>/paper-links/ page renders real rows, not the not-found fallback",
    () => {
      const pages = builtPaperLinksPages();
      expect(pages.length).toBeGreaterThan(0);
      for (const { label: conf, file } of pages) {
        const html = readFileSync(file, "utf8");
        expect(html, conf).not.toMatch(/This page could not be found/i);
        // Either real rows, or the page's own (not Next's) empty-state copy.
        expect(
          html.includes("data-paper-id=") || html.includes("掲載できる論文はありません"),
          conf,
        ).toBe(true);
      }
    },
  );
});

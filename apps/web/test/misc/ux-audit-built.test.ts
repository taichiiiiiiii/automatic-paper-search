/**
 * Built-output checks for the top page / shared chrome UX audit (design 53,
 * トップ・共通). Each test reads the static export and skips when
 * `apps/web/out` is missing (same pattern as r4-1-site-p0-built.test.ts);
 * CI builds before testing.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB = join(TEST_DIR, "..", "..");
const OUT = join(WEB, "out");
const INDEX = join(OUT, "index.html");
const NOT_FOUND = join(OUT, "404.html");
const CONFERENCES = join(OUT, "conferences.json");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("built output: top page and shared chrome (UX audit, design 53)", () => {
  it.skipIf(!existsSync(INDEX) || !existsSync(CONFERENCES))(
    "the top page's title, h1 and catalog links come from conferences.json at build time",
    () => {
      const html = read(INDEX);
      const rows = JSON.parse(read(CONFERENCES)) as Array<{ name: string; papers: number }>;
      const total = rows.reduce((sum, row) => sum + row.papers, 0).toLocaleString("en-US");
      const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
      expect(title).toContain(`${rows.length} 学会・${total} 本`);
      expect(html).not.toContain("28,000");
      // Visible h1 (not the old screen-reader-only one) carrying the counts.
      expect(html).toMatch(/<h1 class="[^"]*" id="s0-lede">/);
      expect(html).not.toContain('class="visually-hidden">PaperPilot AI 論文検索');
      // Every catalog is linked in the static HTML, without JavaScript and
      // without a collapsed toggle in front of it.
      for (const row of rows) {
        expect(html).toContain(`href="/${row.name}/"`);
      }
      expect(html).not.toContain("s0-confs-toggle");
      expect(html).toContain("テーマ別の系譜");
    },
  );

  it.skipIf(!existsSync(INDEX))("the header is a banner landmark with a catalog entry", () => {
    const html = read(INDEX);
    expect(html).toMatch(/<header\b[^>]*>[\s\S]*<nav aria-label="グローバル">/);
    expect(html).toContain('href="/#s0-confs"');
    expect(html).toMatch(/aria-current="page"[^>]*>探す</);
  });

  it.skipIf(!existsSync(INDEX))("pages do not preload every web-font file", () => {
    // 12 preloads (~640 KB incl. italic / latin-ext) went out on every page;
    // the browser now fetches only the faces the page renders.
    expect(read(INDEX)).not.toMatch(/<link rel="preload"[^>]*\.woff2/);
  });

  it.skipIf(!existsSync(NOT_FOUND))("the 404 page links back into the site", () => {
    const html = read(NOT_FOUND);
    const main = html.slice(html.indexOf('<main id="main-content"'));
    expect(main).toContain('href="/"');
    expect(main).toContain('href="/themes/"');
    expect(main).toContain('href="/#s0-confs"');
  });
});

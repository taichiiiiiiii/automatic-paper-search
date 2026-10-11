import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPaperLinkRows,
  NOJS_ROWS_PER_PAGE,
  paperLinksPageCount,
  paperLinksPagePath,
} from "../../app/[conf]/paper-links/logic";

/**
 * R3-2 (design doc 52 §8): the built no-JS fallback is split into
 * `/<conf>/paper-links/` (page 1, the pre-split URL) plus
 * `/<conf>/paper-links/<n>/` for n = 2..pageCount. Against the real build
 * output: every conference gets exactly its expected pages, the pages
 * together list every paper of `papers.json` exactly once and in the same
 * order as `buildPaperLinkRows`, no page holds more than
 * `NOJS_ROWS_PER_PAGE` rows, `/1/` is not generated, and every page links
 * to every other page without JavaScript.
 *
 * Skips when there is no `out/` (run `next build` first, like the other
 * built-output tests).
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(TEST_DIR, "..", "..");
const OUT_DIR = join(WEB_ROOT, "out");
const PUBLIC_DIR = join(WEB_ROOT, "public");

const PAPER_ID_ATTR_RE = /data-paper-id="([0-9a-f]{40})"/g;

function builtConferences(): string[] {
  return readdirSync(OUT_DIR).filter((d) =>
    existsSync(join(OUT_DIR, d, "paper-links", "index.html")),
  );
}

function pageFile(conf: string, page: number): string {
  return join(OUT_DIR, `${paperLinksPagePath(conf, page)}index.html`);
}

describe.skipIf(!existsSync(OUT_DIR))("split no-JS paper-links pages (built output)", () => {
  it("builds every expected page, and only those", () => {
    const confs = builtConferences();
    expect(confs.length).toBeGreaterThan(0);
    for (const conf of confs) {
      const papers = JSON.parse(readFileSync(join(PUBLIC_DIR, conf, "papers.json"), "utf8"));
      const count = paperLinksPageCount(papers.length);
      const numbered = readdirSync(join(OUT_DIR, conf, "paper-links"))
        .filter((entry) => /^[0-9]+$/.test(entry))
        .map(Number)
        .sort((a, b) => a - b);
      const expected = Array.from({ length: count - 1 }, (_, i) => i + 2);
      expect(numbered, conf).toEqual(expected);
    }
  });

  it("lists every paper exactly once across the pages, in sorted order", () => {
    for (const conf of builtConferences()) {
      const papers = JSON.parse(readFileSync(join(PUBLIC_DIR, conf, "papers.json"), "utf8"));
      const count = paperLinksPageCount(papers.length);
      const ids: string[] = [];
      for (let page = 1; page <= count; page++) {
        const html = readFileSync(pageFile(conf, page), "utf8");
        const pageIds = [...html.matchAll(PAPER_ID_ATTR_RE)].map((m) => m[1] ?? "");
        expect(pageIds.length, `${conf} page ${page}`).toBeLessThanOrEqual(NOJS_ROWS_PER_PAGE);
        ids.push(...pageIds);
      }
      expect(ids, conf).toEqual(buildPaperLinkRows(papers).map((row) => row.paperId));
    }
  });

  it("links every page of a split conference to all of its pages", () => {
    let splitConferences = 0;
    for (const conf of builtConferences()) {
      const papers = JSON.parse(readFileSync(join(PUBLIC_DIR, conf, "papers.json"), "utf8"));
      const count = paperLinksPageCount(papers.length);
      if (count === 1) {
        // A single-page conference keeps the pre-split markup: no pager.
        expect(readFileSync(pageFile(conf, 1), "utf8"), conf).not.toContain('aria-label="ページ"');
        continue;
      }
      splitConferences += 1;
      for (let page = 1; page <= count; page++) {
        const html = readFileSync(pageFile(conf, page), "utf8");
        expect(html, `${conf} page ${page}`).toContain('aria-current="page"');
        for (let other = 1; other <= count; other++) {
          if (other === page) continue;
          expect(html, `${conf} page ${page} -> ${other}`).toContain(
            `href="${paperLinksPagePath(conf, other)}"`,
          );
        }
      }
    }
    // icml-2026 (6,552 papers) is in the repo, so at least one split exists.
    expect(splitConferences).toBeGreaterThan(0);
  });
});

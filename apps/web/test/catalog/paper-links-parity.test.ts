import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Parity check for the `/[conf]/paper-links/` port (design doc §8 P2,
 * `docs/migration/p2-parity-gaps.md` row 8): the built
 * `out/<conf>/paper-links/index.html` must list the exact same set of
 * (title, link href) pairs, in the exact same order, as the current
 * `docs/<conf>/paper-links.html` (`paperpilot/scripts/build_pages.py`).
 *
 * Both documents are scanned with small regexes rather than a full HTML
 * parser (no new dependency) -- this mirrors the scan style already
 * used by apps/web/scripts/sitemap.ts / test/csp.test.ts.
 *
 * Requires `next build` to have already run (same hard requirement as
 * test/csp.test.ts) -- there is no built `out/` to compare against
 * otherwise.
 *
 * The "docs/<conf>/paper-links.html" side is a frozen byte-identical
 * copy under test/fixtures/legacy/ rather than the real docs/ tree
 * (docs/migration/p5-plan.md §2 A1: this test must not read docs/ at
 * test time). Only eccv-2024 and aaai-2026 are frozen -- the smallest
 * two of the 10 published conferences -- rather than the originally
 * tested cvpr-2026 (2.1 MB of HTML): every row in every conference's
 * paper-links.html has an anchor (verified by inspection), so the two
 * smallest conferences exercise exactly the same parsing/parity logic
 * as any larger one, at a fraction of the fixture size. See
 * test/fixtures/legacy/README.md.
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(TEST_DIR, "..", "..");
const OUT_DIR = join(WEB_ROOT, "out");
const LEGACY_FIXTURES_DIR = join(WEB_ROOT, "test", "fixtures", "legacy");
const PUBLIC_DIR = join(WEB_ROOT, "public");

const ROBOTS_NOINDEX_RE = /<meta[^>]*\bname="robots"[^>]*\bcontent="[^"]*noindex[^"]*"/i;

const CONFERENCES = ["eccv-2024", "aaai-2026"] as const;

interface PaperRow {
  readonly paperId: string;
  readonly title: string;
  readonly href: string | null;
}

/** Decodes the small set of entities either side's HTML escaper produces
 * (Python's `html.escape(..., quote=True)` / React's text + attribute
 * escaping) back to plain text, so the two sides compare on content, not
 * on which escaping scheme produced the markup. `&amp;` is decoded last
 * so an entity like `&amp;lt;` (a literal "&lt;" in the source text) is
 * not double-unescaped into "<". */
function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:0*39|x0*27);/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

const PAPER_ID_ATTR_RE = /data-paper-id="([0-9a-f]{40})"/g;
const H2_RE = /<h2\b[^>]*>([\s\S]*?)<\/h2>/;
const ANCHOR_RE = /^<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*)<\/a>$/;

/** Extracts every (paper_id, title, href) row from one rendered page --
 * works for both the Python no-JS fallback and the ported Next page,
 * since both mark each row with `data-paper-id="<40-hex>"` and put the
 * title (plain, or wrapped in a single `<a href="...">`) inside an
 * `<h2>` somewhere in that row's enclosing `<li>...</li>`. */
function extractPaperRows(html: string): PaperRow[] {
  const rows: PaperRow[] = [];
  for (const match of html.matchAll(PAPER_ID_ATTR_RE)) {
    const paperId = match[1];
    if (!paperId) continue;
    const idx = match.index ?? 0;
    const liStart = html.lastIndexOf("<li", idx);
    const liEnd = html.indexOf("</li>", idx);
    if (liStart === -1 || liEnd === -1) continue;
    const block = html.slice(liStart, liEnd);
    const h2Match = H2_RE.exec(block);
    if (!h2Match) continue;
    const inner = (h2Match[1] ?? "").trim();
    const anchorMatch = ANCHOR_RE.exec(inner);
    if (anchorMatch) {
      rows.push({
        paperId,
        href: unescapeHtml(anchorMatch[1] ?? ""),
        title: unescapeHtml((anchorMatch[2] ?? "").trim()),
      });
    } else {
      rows.push({ paperId, href: null, title: unescapeHtml(inner) });
    }
  }
  return rows;
}

function rowKey(row: PaperRow): string {
  return JSON.stringify([row.title, row.href]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe.each(CONFERENCES)("paper-links parity: %s", (conf) => {
  it("lists the exact same (title, href) set as the frozen docs/<conf>/paper-links.html fixture", async () => {
    const legacyPath = join(LEGACY_FIXTURES_DIR, conf, "paper-links.html");
    const builtPath = join(OUT_DIR, conf, "paper-links", "index.html");

    if (!(await exists(legacyPath))) {
      throw new Error(`${legacyPath} does not exist -- is the frozen fixture missing?`);
    }
    if (!(await exists(builtPath))) {
      throw new Error(
        `${builtPath} does not exist. Run "next build" (output: export) before "vitest run".`,
      );
    }

    const legacyHtml = await readFile(legacyPath, "utf8");
    const builtHtml = await readFile(builtPath, "utf8");
    const legacyRows = extractPaperRows(legacyHtml);
    const builtRows = extractPaperRows(builtHtml);

    // Pins the row count against the source data, not just "both sides'
    // regex matched the same (possibly wrong) number of rows" -- an
    // identical under-match on both sides would otherwise pass row 121
    // below despite silently dropping real papers.
    const papersPath = join(PUBLIC_DIR, conf, "papers.json");
    const papers = JSON.parse(await readFile(papersPath, "utf8"));
    expect(Array.isArray(papers)).toBe(true);
    expect(legacyRows.length).toBe(papers.length);
    expect(builtRows.length).toBe(legacyRows.length);

    // The built page must stay out of the sitemap, same as the legacy
    // fallback (scripts/sitemap.ts's `hasNoindexMeta`, safety contract
    // CAT-39).
    expect(ROBOTS_NOINDEX_RE.test(builtHtml), "built page must have a noindex robots meta").toBe(
      true,
    );

    const legacyKeys = new Set(legacyRows.map(rowKey));
    const builtKeys = new Set(builtRows.map(rowKey));
    expect(builtKeys.size).toBe(legacyKeys.size);

    const missingFromBuilt = [...legacyKeys].filter((key) => !builtKeys.has(key));
    const extraInBuilt = [...builtKeys].filter((key) => !legacyKeys.has(key));
    expect(missingFromBuilt, "rows in docs/ but missing from the built page").toEqual([]);
    expect(extraInBuilt, "rows in the built page not present in docs/").toEqual([]);

    // Same paper_id -> same (title, href) on both sides too (a stronger
    // check than "same set" -- catches an id surviving with wrong data).
    const legacyById = new Map(legacyRows.map((row) => [row.paperId, row]));
    for (const builtRow of builtRows) {
      const legacyRow = legacyById.get(builtRow.paperId);
      expect(legacyRow, `paper_id ${builtRow.paperId} missing from docs/`).toBeDefined();
      expect(builtRow.title).toBe(legacyRow?.title);
      expect(builtRow.href).toBe(legacyRow?.href);
    }
  });
});

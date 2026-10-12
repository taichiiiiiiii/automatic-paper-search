import { describe, expect, it } from "vitest";
import {
  buildPaperLinkPages,
  buildPaperLinkRows,
  estimateRenderedBytes,
  NOJS_MAX_PAPERS,
  NOJS_MAX_RENDERED_BYTES,
  NOJS_ROWS_PER_PAGE,
  paginatePaperLinkRows,
  paperLinksPageCount,
  paperLinksPagePath,
  safeHttpUrl,
} from "../../app/[conf]/paper-links/logic";

/**
 * Unit tests for the `/[conf]/paper-links/` pure logic -- ports the
 * cases `paperpilot/tests/test_build_pages.py` has for
 * `_safe_http_url` / `render_paper_links_page` (design doc §8 P2 /
 * CLAUDE.md "TypeScript 移行中の開発ルール": port the existing tests for
 * ported logic).
 */

const ID_A = "a".repeat(40);
const ID_B = "b".repeat(40);
const ID_C = "c".repeat(40);

describe("safeHttpUrl", () => {
  it("accepts a plain http(s) URL", () => {
    expect(safeHttpUrl("http://arxiv.org/abs/2403.06764v3")).toBe(
      "http://arxiv.org/abs/2403.06764v3",
    );
    expect(safeHttpUrl("https://arxiv.org/pdf/2403.06764v3")).toBe(
      "https://arxiv.org/pdf/2403.06764v3",
    );
  });

  it("rejects non-http(s) schemes", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<script>1</script>")).toBeNull();
    expect(safeHttpUrl("ftp://example.com/x")).toBeNull();
  });

  it("rejects embedded credentials", () => {
    expect(safeHttpUrl("https://user:pass@example.com/x")).toBeNull();
    expect(safeHttpUrl("https://user@example.com/x")).toBeNull();
  });

  // Ported 1:1 from paperpilot/tests/test_catalog_nojs_fallback.py's
  // test_fallback_omits_unsafe_original_urls parametrization.
  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "//example.test/no-scheme",
    "https://user:password@example.test/paper",
    'https://example.test/" onclick="alert(1)',
  ])("rejects %s", (unsafe) => {
    expect(safeHttpUrl(unsafe)).toBeNull();
  });

  it("rejects malformed / non-string / empty input", () => {
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl("   ")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
  });

  it("rejects an embedded control character (trailing whitespace is trimmed first, matching Python's `.strip()`)", () => {
    expect(safeHttpUrl("http://example.com/\t/x")).toBeNull();
    expect(safeHttpUrl("http://example.com/\n/x")).toBeNull();
  });

  it("rejects an out-of-range port", () => {
    expect(safeHttpUrl("http://example.com:999999/x")).toBeNull();
  });

  it("accepts an in-range port", () => {
    expect(safeHttpUrl("http://example.com:8080/x")).toBe("http://example.com:8080/x");
  });
});

describe("buildPaperLinkRows", () => {
  it("prefers arxiv_url over pdf_url", () => {
    const [row] = buildPaperLinkRows([
      {
        paper_id: ID_A,
        title: "A",
        arxiv_url: "http://arxiv.org/abs/1",
        pdf_url: "http://arxiv.org/pdf/1",
      },
    ]);
    // Known scholarly hosts are upgraded to https (lib/https-upgrade.ts).
    expect(row?.href).toBe("https://arxiv.org/abs/1");
  });

  it("keeps http links to hosts not known to serve https unchanged", () => {
    const [row] = buildPaperLinkRows([
      { paper_id: ID_A, title: "A", arxiv_url: "http://example.org/paper/1" },
    ]);
    expect(row?.href).toBe("http://example.org/paper/1");
  });

  it("falls back to pdf_url when arxiv_url is unsafe/missing", () => {
    const [row] = buildPaperLinkRows([
      { paper_id: ID_A, title: "A", pdf_url: "http://arxiv.org/pdf/1" },
    ]);
    expect(row?.href).toBe("https://arxiv.org/pdf/1");
  });

  it("is href=null when neither link is a safe http(s) URL", () => {
    const [row] = buildPaperLinkRows([
      { paper_id: ID_A, title: "A", arxiv_url: "javascript:alert(1)" },
    ]);
    expect(row?.href).toBeNull();
  });

  it("defaults an empty/missing title to 'Untitled paper'", () => {
    const [row] = buildPaperLinkRows([{ paper_id: ID_A, title: "" }]);
    expect(row?.title).toBe("Untitled paper");
  });

  it("sorts case-insensitively by (NFKC-normalized, whitespace-collapsed) title, tie-broken by paper_id", () => {
    const rows = buildPaperLinkRows([
      { paper_id: ID_B, title: "banana" },
      { paper_id: ID_A, title: "Apple" },
      { paper_id: ID_C, title: "apple" },
    ]);
    expect(rows.map((r) => r.paperId)).toEqual([ID_A, ID_C, ID_B]);
  });

  it("collapses internal whitespace runs before sorting", () => {
    const rows = buildPaperLinkRows([
      { paper_id: ID_A, title: "a   b" },
      { paper_id: ID_B, title: "a b" },
    ]);
    // Both keys collapse to "a b"; tie-break is paper_id.
    expect(rows.map((r) => r.paperId)).toEqual([ID_A, ID_B]);
  });

  it("throws on an invalid paper_id", () => {
    expect(() => buildPaperLinkRows([{ paper_id: "not-hex", title: "A" }])).toThrow();
    expect(() => buildPaperLinkRows([{ paper_id: 123, title: "A" }])).toThrow();
  });

  it("throws on a duplicate paper_id", () => {
    expect(() =>
      buildPaperLinkRows([
        { paper_id: ID_A, title: "A" },
        { paper_id: ID_A, title: "B" },
      ]),
    ).toThrow();
  });

  it("returns an empty list for an empty input", () => {
    expect(buildPaperLinkRows([])).toEqual([]);
  });

  it("produces the same rows regardless of input order (ported from test_fallback_is_escaped_title_sorted_and_has_stable_anchors)", () => {
    const first = buildPaperLinkRows([
      { paper_id: ID_A, title: "Zulu", arxiv_url: "https://example.test/a" },
      { paper_id: ID_B, title: "Apple", arxiv_url: "https://example.test/b" },
    ]);
    const second = buildPaperLinkRows([
      { paper_id: ID_B, title: "Apple", arxiv_url: "https://example.test/b" },
      { paper_id: ID_A, title: "Zulu", arxiv_url: "https://example.test/a" },
    ]);
    expect(first).toEqual(second);
    expect(first.map((r) => r.paperId)).toEqual([ID_B, ID_A]);
  });

  // Safety contract CAT-18 (docs/migration/safety-contracts.md), ported
  // from test_fallback_rejects_unbounded_row_or_byte_output.
  it("rejects more than NOJS_MAX_PAPERS rows", () => {
    const papers = Array.from({ length: NOJS_MAX_PAPERS + 1 }, (_, i) => ({
      paper_id: i.toString(16).padStart(40, "0"),
      title: `Paper ${i}`,
      arxiv_url: `https://example.test/${i}`,
    }));
    expect(() => buildPaperLinkRows(papers)).toThrow(/row limit/);
  });

  it("rejects a page whose estimated rendered size is over NOJS_MAX_RENDERED_BYTES", () => {
    const hugeTitle = "x".repeat(NOJS_MAX_RENDERED_BYTES);
    expect(() => buildPaperLinkPages([{ paper_id: ID_A, title: hugeTitle }])).toThrow(
      /page 1 exceeds rendered byte estimate/,
    );
  });
});

function manyPapers(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    paper_id: i.toString(16).padStart(40, "0"),
    title: `Paper ${String(i).padStart(6, "0")}`,
    arxiv_url: `https://example.test/${i}`,
  }));
}

// R3-2: the no-JS fallback is split into pages of NOJS_ROWS_PER_PAGE rows.
describe("paginatePaperLinkRows", () => {
  it("keeps a conference that fits one page on a single page", () => {
    const pages = buildPaperLinkPages(manyPapers(NOJS_ROWS_PER_PAGE));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.firstRow).toBe(1);
    expect(pages[0]?.lastRow).toBe(NOJS_ROWS_PER_PAGE);
  });

  it("returns one empty page for an empty conference", () => {
    expect(paginatePaperLinkRows([])).toEqual([{ page: 1, firstRow: 0, lastRow: 0, rows: [] }]);
  });

  it("splits ICML 2026's 6,552 rows into 3 pages, in sorted order, losing none", () => {
    const papers = manyPapers(6_552);
    const rows = buildPaperLinkRows(papers);
    const pages = paginatePaperLinkRows(rows);
    expect(pages.map((p) => p.rows.length)).toEqual([3_000, 3_000, 552]);
    expect(pages.map((p) => [p.page, p.firstRow, p.lastRow])).toEqual([
      [1, 1, 3_000],
      [2, 3_001, 6_000],
      [3, 6_001, 6_552],
    ]);
    expect(pages.flatMap((p) => p.rows)).toEqual(rows);
    expect(paperLinksPageCount(papers.length)).toBe(3);
  });

  it("accepts up to NOJS_MAX_PAPERS rows in total", () => {
    expect(NOJS_MAX_PAPERS).toBe(60_000);
    expect(() => buildPaperLinkRows(manyPapers(9_200))).not.toThrow();
  });
});

describe("paperLinksPagePath / paperLinksPageCount", () => {
  it("keeps page 1 at the pre-split URL", () => {
    expect(paperLinksPagePath("icml-2026", 1)).toBe("/icml-2026/paper-links/");
    expect(paperLinksPagePath("icml-2026", 3)).toBe("/icml-2026/paper-links/3/");
  });

  it("counts at least one page", () => {
    expect(paperLinksPageCount(0)).toBe(1);
    expect(paperLinksPageCount(NOJS_ROWS_PER_PAGE)).toBe(1);
    expect(paperLinksPageCount(NOJS_ROWS_PER_PAGE + 1)).toBe(2);
  });
});

describe("estimateRenderedBytes", () => {
  it("grows with the number and size of rows", () => {
    const empty = estimateRenderedBytes([]);
    const small = estimateRenderedBytes([{ paperId: ID_A, title: "A", href: null }]);
    const bigger = estimateRenderedBytes([
      { paperId: ID_A, title: "A".repeat(200), href: "https://example.test/a" },
    ]);
    expect(small).toBeGreaterThan(empty);
    expect(bigger).toBeGreaterThan(small);
  });
});

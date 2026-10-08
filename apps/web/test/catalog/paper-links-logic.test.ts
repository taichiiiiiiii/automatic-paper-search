import { describe, expect, it } from "vitest";
import {
  buildPaperLinkRows,
  estimateRenderedBytes,
  NOJS_MAX_PAPERS,
  NOJS_MAX_RENDERED_BYTES,
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
    expect(row?.href).toBe("http://arxiv.org/abs/1");
  });

  it("falls back to pdf_url when arxiv_url is unsafe/missing", () => {
    const [row] = buildPaperLinkRows([
      { paper_id: ID_A, title: "A", pdf_url: "http://arxiv.org/pdf/1" },
    ]);
    expect(row?.href).toBe("http://arxiv.org/pdf/1");
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

  it("rejects an estimated rendered size over NOJS_MAX_RENDERED_BYTES", () => {
    const hugeTitle = "x".repeat(NOJS_MAX_RENDERED_BYTES);
    expect(() => buildPaperLinkRows([{ paper_id: ID_A, title: hugeTitle }])).toThrow(
      /rendered byte estimate/,
    );
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

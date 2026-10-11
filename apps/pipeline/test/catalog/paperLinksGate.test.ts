/** Ported from the validation half of paperpilot/tests/test_catalog_nojs_fallback.py. */

import { IdentityError } from "@paperpilot/core/identity";
import { describe, expect, it } from "vitest";
import {
  assertPaperLinksGate,
  NOJS_MAX_PAPERS,
  NOJS_MAX_RENDERED_BYTES,
  NOJS_ROWS_PER_PAGE,
} from "../../src/catalog/paperLinksGate.js";

const PAPER_A = "a".repeat(40);
const PAPER_B = "b".repeat(40);

describe("assertPaperLinksGate", () => {
  it("accepts a normal list of distinct, well-formed paper_ids", () => {
    expect(() =>
      assertPaperLinksGate([
        { paper_id: PAPER_A, title: "Zulu", arxiv_url: "https://example.test/a" },
        { paper_id: PAPER_B, title: "Alpha", arxiv_url: "https://example.test/b" },
      ]),
    ).not.toThrow();
  });

  it("throws IdentityError on a duplicate paper_id", () => {
    expect(() =>
      assertPaperLinksGate([
        { paper_id: PAPER_A, title: "First" },
        { paper_id: PAPER_A, title: "Duplicate" },
      ]),
    ).toThrow(IdentityError);
  });

  it("throws IdentityError on a malformed paper_id", () => {
    expect(() => assertPaperLinksGate([{ paper_id: "not-hex", title: "x" }])).toThrow(
      IdentityError,
    );
  });

  it("throws on exceeding the row limit", () => {
    const papers = Array.from({ length: NOJS_MAX_PAPERS + 1 }, (_, i) => ({
      paper_id: i.toString(16).padStart(40, "0"),
      title: `Paper ${i}`,
    }));
    expect(() => assertPaperLinksGate(papers)).toThrow(/row limit/);
  });

  // R3-2: the fallback is split into pages, so a conference above the old
  // 6,000-row single-page ceiling (ICML 2026: 6,552) must pass.
  it("accepts more rows than one page holds (the web route splits them)", () => {
    expect(NOJS_ROWS_PER_PAGE).toBe(3_000);
    expect(NOJS_MAX_PAPERS).toBe(60_000);
    const papers = Array.from({ length: 9_200 }, (_, i) => ({
      paper_id: i.toString(16).padStart(40, "0"),
      title: `A reasonably long paper title number ${i} about something`,
      arxiv_url: `https://arxiv.org/abs/2601.${String(i).padStart(5, "0")}`,
    }));
    expect(() => assertPaperLinksGate(papers)).not.toThrow();
  });

  it("throws when the largest rows could not fit on one page", () => {
    const longTitle = "x".repeat(Math.ceil(NOJS_MAX_RENDERED_BYTES / NOJS_ROWS_PER_PAGE));
    const papers = Array.from({ length: NOJS_ROWS_PER_PAGE }, (_, i) => ({
      paper_id: i.toString(16).padStart(40, "0"),
      title: longTitle,
    }));
    expect(() => assertPaperLinksGate(papers)).toThrow(/rendered byte limit/);
  });

  it("bounds a page by its largest rows, not the whole conference", () => {
    // Many small rows whose total exceeds one page's budget is fine.
    const papers = Array.from({ length: 2 * NOJS_ROWS_PER_PAGE }, (_, i) => ({
      paper_id: i.toString(16).padStart(40, "0"),
      title: "y".repeat(Math.floor(NOJS_MAX_RENDERED_BYTES / NOJS_ROWS_PER_PAGE / 2)),
    }));
    expect(() => assertPaperLinksGate(papers)).not.toThrow();
  });

  it("accepts an empty list", () => {
    expect(() => assertPaperLinksGate([])).not.toThrow();
  });
});

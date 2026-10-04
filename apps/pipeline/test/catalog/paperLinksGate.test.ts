/** Ported from the validation half of paperpilot/tests/test_catalog_nojs_fallback.py. */
import { describe, expect, it } from "vitest";
import { IdentityError } from "../../src/catalog/identity.js";
import { assertPaperLinksGate, NOJS_MAX_PAPERS } from "../../src/catalog/paperLinksGate.js";

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

  it("accepts an empty list", () => {
    expect(() => assertPaperLinksGate([])).not.toThrow();
  });
});

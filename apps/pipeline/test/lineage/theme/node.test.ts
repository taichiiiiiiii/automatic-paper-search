/**
 * `lineage/theme/node.ts` — `toNode`'s tldr/short_abstract truncation.
 * Review M9: Python slices `str` by Unicode code point
 * (`abstract[:maxLen]`); a native `String.prototype.slice` counts UTF-16
 * code units instead, which can split a surrogate pair (any character
 * outside the Basic Multilingual Plane — emoji, some CJK extension
 * ideographs) right down the middle.
 */
import { describe, expect, it } from "vitest";
import { toNode } from "../../../src/lineage/theme/node.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";

function paperWithAbstract(abstract: string): ThemePaper {
  return {
    paperId: "p1",
    title: "T",
    year: 2024,
    venue: "arXiv",
    citationCount: 0,
    authors: [],
    abstract,
    externalIds: {},
  } as unknown as ThemePaper;
}

describe("toNode tldr/short_abstract — code-point-safe truncation (M9)", () => {
  it("does not split a surrogate pair straddling the tldr cutoff (140 code points)", () => {
    // 139 ASCII chars + one non-BMP emoji (U+1F600, a surrogate PAIR in
    // UTF-16) as exactly the 140th code point + filler, no spaces at all
    // (so the word-boundary branch never fires and the cut is exactly
    // position 140).
    const abstract = `${"a".repeat(139)}😀${"b".repeat(50)}`;
    const node = toNode(paperWithAbstract(abstract));
    // The whole emoji must survive intact — not a lone/unpaired surrogate.
    expect(node.tldr).toBe(`${"a".repeat(139)}😀`);
    expect(Array.from(node.tldr)).toHaveLength(140);
    // No unpaired surrogate code unit anywhere in the result.
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(node.tldr),
    ).toBe(false);
  });

  it("does not split a surrogate pair straddling the short_abstract cutoff (1000 code points)", () => {
    const abstract = `${"a".repeat(999)}😀${"b".repeat(50)}`;
    const node = toNode(paperWithAbstract(abstract));
    expect(node.short_abstract).toBe(`${"a".repeat(999)}😀`);
    expect(Array.from(node.short_abstract ?? "")).toHaveLength(1000);
  });

  it("leaves a short, pure-ASCII abstract untouched (no regression on the common case)", () => {
    const node = toNode(paperWithAbstract("A short abstract with no truncation needed."));
    expect(node.tldr).toBe("A short abstract with no truncation needed.");
  });
});

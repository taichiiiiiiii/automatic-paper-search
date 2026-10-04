import { describe, expect, it } from "vitest";
import { codepointCompare, pySortedStrings } from "../../src/pycompat/sort.js";
import cases from "./fixtures/cases.json";

interface SortPairCase {
  a: string;
  b: string;
  expectedSign: number;
}
interface SortListCase {
  sortList: string[];
  expectedSorted: string[];
}

const pairCases = (cases.codepointSort as unknown as Array<SortPairCase | SortListCase>).filter(
  (c): c is SortPairCase => "a" in c,
);
const listCases = (cases.codepointSort as unknown as Array<SortPairCase | SortListCase>).filter(
  (c): c is SortListCase => "sortList" in c,
);

function sign(n: number): number {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

describe("codepointCompare", () => {
  it("has a substantial, Python-generated fixture set", () => {
    expect(pairCases.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of pairCases) {
    it(`compare(${JSON.stringify(c.a)}, ${JSON.stringify(c.b)}) -> ${c.expectedSign}`, () => {
      expect(sign(codepointCompare(c.a, c.b))).toBe(c.expectedSign);
      // Antisymmetry sanity check (avoid asserting -0 for the equal case).
      expect(sign(codepointCompare(c.b, c.a))).toBe(c.expectedSign === 0 ? 0 : -c.expectedSign);
    });
  }

  for (const c of listCases) {
    it(`pySortedStrings(${JSON.stringify(c.sortList)})`, () => {
      expect(pySortedStrings(c.sortList)).toEqual(c.expectedSorted);
    });
  }

  it("documented example: supplementary-plane char sorts after U+FFFF, unlike UTF-16-unit order", () => {
    const supplementary = "\u{1f600}"; // outside BMP
    const bmpHigh = ""; // BMP, numerically below the leading surrogate of the above
    expect(codepointCompare(bmpHigh, supplementary)).toBeLessThan(0);
    // Naive JS default comparison gets this backwards (documented pitfall).
    expect(bmpHigh < supplementary).toBe(false);
  });

  it("prefix ordering: shorter string sorts first", () => {
    expect(codepointCompare("ab", "abc")).toBeLessThan(0);
    expect(codepointCompare("abc", "ab")).toBeGreaterThan(0);
  });

  it("equal strings compare to 0", () => {
    expect(codepointCompare("same", "same")).toBe(0);
    expect(codepointCompare("", "")).toBe(0);
  });
});

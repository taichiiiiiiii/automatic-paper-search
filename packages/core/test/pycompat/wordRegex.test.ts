import { describe, expect, it } from "vitest";
import {
  isPyWordChar,
  PY_WORD_CLASS_SOURCE,
  pyWordCharRegex,
} from "../../src/pycompat/wordRegex.js";
import cases from "./fixtures/cases.json";

interface WordRegexCase {
  char: string;
  codepoint: number;
  category: string;
  isWord: boolean;
}

const wordRegexCases = cases.wordRegex as unknown as WordRegexCase[];

describe("pyWordCharRegex / isPyWordChar", () => {
  it("has a substantial, Python-generated fixture set", () => {
    expect(wordRegexCases.length).toBeGreaterThanOrEqual(30);
  });

  it("covers a broad mix of Unicode general categories", () => {
    const categories = new Set(wordRegexCases.map((c) => c.category));
    expect(categories.size).toBeGreaterThanOrEqual(8);
  });

  for (const c of wordRegexCases) {
    it(`U+${c.codepoint.toString(16).padStart(4, "0")} ${JSON.stringify(c.char)} (${c.category}) -> isWord=${c.isWord}`, () => {
      expect(isPyWordChar(c.char)).toBe(c.isWord);
    });
  }

  it("can be composed into a larger pattern with the u flag", () => {
    const re = new RegExp(`^${PY_WORD_CLASS_SOURCE}+$`, "u");
    expect(re.test("hello_123")).toBe(true);
    expect(re.test("hello world")).toBe(false);
  });

  it("documented curated examples: digits/letters from non-Latin scripts and superscripts match", () => {
    expect(isPyWordChar("²")).toBe(true); // superscript two, category No
    expect(isPyWordChar("٣")).toBe(true); // arabic-indic digit three, category Nd
    expect(isPyWordChar("ß")).toBe(true); // sharp s, category Ll
  });

  it("documented curated examples: combining marks do NOT match, unlike a naive \\p{Alphabetic}-based guess", () => {
    expect(isPyWordChar("́")).toBe(false); // combining acute accent, Mn
    expect(isPyWordChar("ा")).toBe(false); // devanagari vowel sign AA, Mc (Other_Alphabetic=Yes, but NOT category L)
  });

  it("pyWordCharRegex accepts and preserves additional flags", () => {
    const re = pyWordCharRegex("g");
    expect(re.flags).toContain("g");
    expect(re.flags).toContain("u");
  });
});

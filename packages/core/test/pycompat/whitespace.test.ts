import { describe, expect, it } from "vitest";
import { pyLstrip, pyRstrip, pySplit, pyStrip } from "../../src/pycompat/whitespace.js";
import cases from "./fixtures/cases.json";

interface StripSplitCase {
  input: string;
  strip: string;
  lstrip: string;
  rstrip: string;
  split: string[];
}

const stripSplitCases = cases.stripSplit as unknown as StripSplitCase[];

describe("pyStrip / pyLstrip / pyRstrip / pySplit", () => {
  it("has a substantial, Python-generated fixture set", () => {
    expect(stripSplitCases.length).toBeGreaterThanOrEqual(100);
  });

  for (const c of stripSplitCases) {
    const label = JSON.stringify(c.input);
    it(`pyStrip(${label})`, () => {
      expect(pyStrip(c.input)).toBe(c.strip);
    });
    it(`pyLstrip(${label})`, () => {
      expect(pyLstrip(c.input)).toBe(c.lstrip);
    });
    it(`pyRstrip(${label})`, () => {
      expect(pyRstrip(c.input)).toBe(c.rstrip);
    });
    it(`pySplit(${label})`, () => {
      expect(pySplit(c.input)).toEqual(c.split);
    });
  }

  // Named, human-legible spot checks for the two discriminating gaps
  // documented in whitespace.ts, independent of the generated fixture set.
  it("strips Python-only whitespace that JS's .trim()/\\s misses (U+001C-U+001F, U+0085)", () => {
    expect(pyStrip("\x1chello\x1d")).toBe("hello");
    expect(pyStrip("\x85hello\x85")).toBe("hello");
    expect(pySplit("a\x1cb\x1dc")).toEqual(["a", "b", "c"]);
  });

  it("does NOT strip U+FEFF (BOM) or U+200B (ZWSP), unlike .trim()", () => {
    expect(pyStrip("﻿hello")).toBe("﻿hello");
    expect(pyStrip("hello​")).toBe("hello​");
    // Documenting why a naive `.trim()` port would be wrong here:
    expect("﻿hello".trim()).toBe("hello");
  });

  it("pySplit discards empty strings and leading/trailing whitespace, unlike split(/\\s+/)", () => {
    expect(pySplit("")).toEqual([]);
    expect(pySplit("   ")).toEqual([]);
    expect(pySplit("  a  b  ")).toEqual(["a", "b"]);
    // Documenting why a naive split(/\s+/) port is wrong without .filter(Boolean)
    // AND why .filter(Boolean) alone still isn't enough (whitespace-set gap):
    expect("  a  b  ".split(/\s+/)).toEqual(["", "a", "b", ""]);
  });

  it("pyLstrip/pyRstrip only strip one side", () => {
    expect(pyLstrip("  a  ")).toBe("a  ");
    expect(pyRstrip("  a  ")).toBe("  a");
  });
});

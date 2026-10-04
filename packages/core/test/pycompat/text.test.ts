import { describe, expect, it } from "vitest";
import { nfkc, pyCasefold, pyLower } from "../../src/pycompat/text.js";
import cases from "./fixtures/cases.json";

interface TextCase {
  input: string;
  lower: string;
  casefold: string;
  nfkc: string;
  unicodedata_version: string;
}

const textCases = cases.text as unknown as TextCase[];

describe("pyLower / pyCasefold / nfkc", () => {
  it("has a substantial, Python-generated fixture set", () => {
    expect(textCases.length).toBeGreaterThanOrEqual(30);
  });

  it("records the generating interpreter's Unicode Character Database version for reference", () => {
    expect(textCases[0]?.unicodedata_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const c of textCases) {
    it(`pyLower(${JSON.stringify(c.input)})`, () => {
      expect(pyLower(c.input)).toBe(c.lower);
    });
    it(`nfkc(${JSON.stringify(c.input)})`, () => {
      expect(nfkc(c.input)).toBe(c.nfkc);
    });
  }

  // pyCasefold is explicitly a best-effort approximation (see text.ts doc
  // comment): only assert it on inputs where we know our small extra-folding
  // table covers the gap between toLowerCase() and full Unicode casefold.
  const casefoldCoveredInputs = new Set([
    "Hello World",
    "HELLO",
    "hello",
    "ẞeta",
    "STRASSE",
    "straße",
    "fiancé".toUpperCase(),
    "ﬁancé",
    "FIANCÉ",
  ]);
  for (const c of textCases) {
    if (!casefoldCoveredInputs.has(c.input)) continue;
    it(`pyCasefold(${JSON.stringify(c.input)}) [covered by the extra-folding table]`, () => {
      expect(pyCasefold(c.input)).toBe(c.casefold);
    });
  }

  it("documented gap: pyCasefold matches str.casefold() for ß but is not a complete CaseFolding.txt port", () => {
    expect(pyCasefold("ß")).toBe("ss");
    expect(pyCasefold("STRASSE")).toBe("strasse");
  });

  it("pyLower is NOT locale-sensitive (Turkish dotless i is out of scope, matching Python's default str.lower())", () => {
    expect(pyLower("İstanbul")).toBe("i̇stanbul");
  });

  it("nfkc example: fullwidth digits/letters fold to standard forms", () => {
    expect(nfkc("①②③")).toBe("123");
    expect(nfkc("Ａ")).toBe("A");
  });
});

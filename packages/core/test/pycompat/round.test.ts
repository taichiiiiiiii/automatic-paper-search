import { describe, expect, it } from "vitest";
import { pyRound } from "../../src/pycompat/round.js";
import cases from "./fixtures/cases.json";
import { hexToDouble } from "./fixtures/hex.js";

interface RoundCase {
  xHex: string;
  x_debug: string;
  ndigits: number | null;
  expectedKind: "int" | "float" | "exception";
  expectedInt?: number;
  expectedHex?: string;
  exception?: string;
}

const roundCases = cases.round as unknown as RoundCase[];

describe("pyRound", () => {
  it("has a substantial, Python-generated fixture set", () => {
    expect(roundCases.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of roundCases) {
    const x = hexToDouble(c.xHex);
    const label = `round(${c.x_debug}${c.ndigits === null ? "" : `, ${c.ndigits}`})`;

    it(label, () => {
      if (c.expectedKind === "exception") {
        expect(() => (c.ndigits === null ? pyRound(x) : pyRound(x, c.ndigits!))).toThrow();
        return;
      }

      if (c.expectedKind === "int") {
        const result = pyRound(x);
        expect(result).toBe(c.expectedInt);
        // Python int has no signed zero; make sure we never produced -0.
        expect(Object.is(result, -0)).toBe(false);
        return;
      }

      // float
      const expected = hexToDouble(c.expectedHex!);
      const result = pyRound(x, c.ndigits!);
      if (Number.isNaN(expected)) {
        expect(Number.isNaN(result)).toBe(true);
      } else {
        expect(result).toBe(expected);
        // Preserve sign of zero exactly, since -0.0 !== 0.0 is invisible to toBe()'s ===.
        if (expected === 0) {
          expect(Object.is(result, expected)).toBe(true);
        }
      }
    });
  }

  it("documented example: round(2.675, 2) === 2.67 (round-half-to-even on the true binary value)", () => {
    expect(pyRound(2.675, 2)).toBe(2.67);
  });

  it("documented example: round(0.5) === 0", () => {
    expect(pyRound(0.5)).toBe(0);
  });

  it("documented example: round(1.5) === 2", () => {
    expect(pyRound(1.5)).toBe(2);
  });

  it("documented example: round(-0.5) with no ndigits is int 0, not -0", () => {
    const result = pyRound(-0.5);
    expect(result).toBe(0);
    expect(Object.is(result, -0)).toBe(false);
  });

  it("documented example: round(-0.5, 0) is float -0.0", () => {
    const result = pyRound(-0.5, 0);
    expect(result).toBe(-0);
    expect(Object.is(result, -0)).toBe(true);
  });

  it("round(NaN) throws, round(NaN, 2) returns NaN", () => {
    expect(() => pyRound(NaN)).toThrow();
    expect(Number.isNaN(pyRound(NaN, 2))).toBe(true);
  });

  it("round(Infinity) throws, round(Infinity, 2) returns Infinity", () => {
    expect(() => pyRound(Infinity)).toThrow();
    expect(pyRound(Infinity, 2)).toBe(Infinity);
    expect(() => pyRound(-Infinity)).toThrow();
    expect(pyRound(-Infinity, 2)).toBe(-Infinity);
  });
});

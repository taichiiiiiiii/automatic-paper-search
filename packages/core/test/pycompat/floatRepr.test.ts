import { describe, expect, it } from "vitest";
import { pyFloatRepr } from "../../src/pycompat/floatRepr.js";
import cases from "./fixtures/cases.json";
import { hexToDouble } from "./fixtures/hex.js";

interface FloatReprCase {
  xHex: string;
  x_debug: string;
  expected: string;
  expected_plain_repr: string;
}

const floatReprCases = cases.floatRepr as unknown as FloatReprCase[];

describe("pyFloatRepr", () => {
  it("has a substantial, Python-generated fixture set", () => {
    expect(floatReprCases.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of floatReprCases) {
    it(`repr(${c.x_debug}) -> ${JSON.stringify(c.expected)}`, () => {
      const x = hexToDouble(c.xHex);
      expect(pyFloatRepr(x)).toBe(c.expected);
    });
  }

  it("documented examples", () => {
    expect(pyFloatRepr(1.0)).toBe("1.0");
    expect(pyFloatRepr(1e16)).toBe("1e+16");
    expect(pyFloatRepr(0.1 + 0.2)).toBe("0.30000000000000004");
    expect(pyFloatRepr(Infinity)).toBe("Infinity");
    expect(pyFloatRepr(-Infinity)).toBe("-Infinity");
    expect(pyFloatRepr(NaN)).toBe("NaN");
    expect(pyFloatRepr(-0)).toBe("-0.0");
    expect(pyFloatRepr(0)).toBe("0.0");
    expect(pyFloatRepr(100.0)).toBe("100.0");
    expect(pyFloatRepr(1e-5)).toBe("1e-05");
    expect(pyFloatRepr(1e-4)).toBe("0.0001");
  });
});

import { describe, expect, it } from "vitest";
import { pyIsoformat } from "../../src/pycompat/isoformat.js";
import cases from "./fixtures/cases.json";

interface IsoformatCase {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
  expected: string;
}

const isoformatCases = cases.isoformat as unknown as IsoformatCase[];

function buildUtcDate(c: IsoformatCase): Date {
  // new Date(0) + setUTCFullYear avoids the Date.UTC/new Date two-digit-year
  // (0-99 -> 1900+year) legacy quirk documented in isoformat.ts.
  const d = new Date(0);
  d.setUTCFullYear(c.year, c.month - 1, c.day);
  d.setUTCHours(c.hour, c.minute, c.second, Math.floor(c.microsecond / 1000));
  return d;
}

describe("pyIsoformat", () => {
  it("has a substantial, Python-generated fixture set", () => {
    expect(isoformatCases.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of isoformatCases) {
    it(`isoformat(${c.year}-${c.month}-${c.day} ${c.hour}:${c.minute}:${c.second}.${c.microsecond})`, () => {
      const date = buildUtcDate(c);
      expect(pyIsoformat(date, c.microsecond)).toBe(c.expected);
    });
  }

  it("documented example from the task spec", () => {
    const d = new Date(0);
    d.setUTCFullYear(2026, 5, 27); // month is 0-based: 5 = June
    d.setUTCHours(12, 10, 56, 718);
    expect(pyIsoformat(d, 718401)).toBe("2026-06-27T12:10:56.718401+00:00");
  });

  it("omits .ffffff entirely when microseconds === 0", () => {
    const d = new Date(0);
    d.setUTCFullYear(2026, 0, 1);
    d.setUTCHours(0, 0, 0, 0);
    expect(pyIsoformat(d, 0)).toBe("2026-01-01T00:00:00+00:00");
  });

  it("falls back to Date's own milliseconds*1000 when microseconds is omitted", () => {
    const d = new Date(0);
    d.setUTCFullYear(2026, 0, 1);
    d.setUTCHours(0, 0, 0, 500);
    expect(pyIsoformat(d)).toBe("2026-01-01T00:00:00.500000+00:00");
  });

  it("zero-pads year to 4 digits (year 1)", () => {
    const d = new Date(0);
    d.setUTCFullYear(1, 0, 1);
    d.setUTCHours(0, 0, 0, 0);
    expect(pyIsoformat(d, 0)).toBe("0001-01-01T00:00:00+00:00");
  });
});

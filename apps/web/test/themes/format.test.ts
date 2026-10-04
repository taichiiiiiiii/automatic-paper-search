// Unit tests for lib/themes-format.ts, a scoped port of docs/assets/
// utils.js's window.PP.shortVenue / formatVenue / formatStars.
import { describe, expect, it } from "vitest";
import { formatStars, formatVenue, shortVenue } from "../../lib/themes-format";

describe("shortVenue", () => {
  it("maps known full names to their acronym", () => {
    expect(shortVenue("Neural Information Processing Systems")).toBe("NeurIPS");
    expect(shortVenue("International Conference on Learning Representations")).toBe("ICLR");
    expect(shortVenue("arXiv")).toBe("arXiv");
  });
  it("picks the more specific pattern first", () => {
    expect(shortVenue("NeurIPS Datasets and Benchmarks")).toBe("NeurIPS-DB");
  });
  it("returns the trimmed original for an unmatched venue", () => {
    expect(shortVenue("  Nature  ")).toBe("Nature");
  });
  it("returns empty string for missing/empty input", () => {
    expect(shortVenue(null)).toBe("");
    expect(shortVenue(undefined)).toBe("");
    expect(shortVenue("   ")).toBe("");
  });
});

describe("formatVenue", () => {
  it("joins the short venue and year with a space", () => {
    expect(formatVenue("Neural Information Processing Systems", 2024)).toBe("NeurIPS 2024");
  });
  it("collapses gracefully when either field is missing", () => {
    expect(formatVenue(null, 2024)).toBe("2024");
    expect(formatVenue("ICLR", null)).toBe("ICLR");
    expect(formatVenue(null, null)).toBe("");
    expect(formatVenue("", "")).toBe("");
  });
});

describe("formatStars", () => {
  it("returns empty string for non-positive or non-numeric input", () => {
    expect(formatStars(0)).toBe("");
    expect(formatStars(-5)).toBe("");
    expect(formatStars(null)).toBe("");
    expect(formatStars(undefined)).toBe("");
  });
  it("returns the plain number below 1000", () => {
    expect(formatStars(42)).toBe("42");
    expect(formatStars(999)).toBe("999");
  });
  it("compacts to one decimal 'k' below 10000", () => {
    expect(formatStars(1234)).toBe("1.2k");
    expect(formatStars(9999)).toBe("10.0k");
  });
  it("compacts to a whole 'k' at/above 10000", () => {
    expect(formatStars(12345)).toBe("12k");
    expect(formatStars(226000)).toBe("226k");
  });
});

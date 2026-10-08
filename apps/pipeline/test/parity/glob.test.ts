import { describe, expect, it } from "vitest";
import { matchGlob } from "../../src/parity/glob.js";

describe("matchGlob", () => {
  it("matches a literal path", () => {
    expect(matchGlob("data.json", "data.json")).toBe(true);
    expect(matchGlob("data.json", "other.json")).toBe(false);
  });

  it("matches * within a single path segment", () => {
    expect(matchGlob("*.json", "data.json")).toBe(true);
    expect(matchGlob("*.json", "dir/data.json")).toBe(false);
  });

  it("matches ** across directories", () => {
    expect(matchGlob("**/*.json", "a/b/data.json")).toBe(true);
    expect(matchGlob("**/*.json", "data.json")).toBe(true);
  });

  it("matches ? as a single character", () => {
    expect(matchGlob("data-?.json", "data-1.json")).toBe(true);
    expect(matchGlob("data-?.json", "data-12.json")).toBe(false);
  });

  it("escapes regex special characters in the glob", () => {
    expect(matchGlob("paper-details-v1/*.json", "paper-details-v1/x.json")).toBe(true);
    expect(matchGlob("paper-details-v1/*.json", "paper-details-v2/x.json")).toBe(false);
  });
});

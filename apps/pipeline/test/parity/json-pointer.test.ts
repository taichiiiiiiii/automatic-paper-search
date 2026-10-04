import { describe, expect, it } from "vitest";
import {
  formatPointer,
  isIgnored,
  parsePointer,
  pointerMatches,
} from "../../src/parity/json-pointer.js";

describe("json-pointer", () => {
  it("parses the root pointer as an empty segment list", () => {
    expect(parsePointer("")).toEqual([]);
  });

  it("parses and formats a nested pointer round-trip", () => {
    const segments = parsePointer("/a/b/0");
    expect(segments).toEqual(["a", "b", "0"]);
    expect(formatPointer(segments)).toBe("/a/b/0");
  });

  it("un-escapes ~1 and ~0 per RFC 6901", () => {
    expect(parsePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
  });

  it("escapes ~ and / when formatting", () => {
    expect(formatPointer(["a/b", "c~d"])).toBe("/a~1b/c~0d");
  });

  it("rejects a pointer that does not start with /", () => {
    expect(() => parsePointer("a/b")).toThrow();
  });

  it("matches a wildcard segment against any key", () => {
    expect(pointerMatches(["items", "*", "id"], ["items", "0", "id"])).toBe(true);
    expect(pointerMatches(["items", "*", "id"], ["items", "7", "id"])).toBe(true);
  });

  it("does not match a pattern of different length", () => {
    expect(pointerMatches(["items", "*"], ["items", "0", "id"])).toBe(false);
  });

  it("isIgnored checks against a list of patterns", () => {
    const patterns = [["a"], ["b", "*"]];
    expect(isIgnored(patterns, ["a"])).toBe(true);
    expect(isIgnored(patterns, ["b", "0"])).toBe(true);
    expect(isIgnored(patterns, ["c"])).toBe(false);
  });
});

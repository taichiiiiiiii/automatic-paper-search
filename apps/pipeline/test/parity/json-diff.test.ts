import { describe, expect, it } from "vitest";
import { diffJsonValues } from "../../src/parity/json-diff.js";
import { parsePointer } from "../../src/parity/json-pointer.js";

describe("diffJsonValues", () => {
  it("reports no diffs for deeply equal values", () => {
    expect(
      diffJsonValues({ a: 1, b: [1, "x", null, true] }, { a: 1, b: [1, "x", null, true] }),
    ).toEqual([]);
  });

  it("ignores object key order", () => {
    expect(diffJsonValues({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it("treats 1.0 and 1 as the same number (format-only difference)", () => {
    expect(diffJsonValues({ n: 1.0 }, { n: 1 })).toEqual([]);
  });

  it("treats 0.30000000000000004 and 0.3 as different values (no tolerance)", () => {
    const diffs = diffJsonValues({ n: 0.3 }, { n: 0.30000000000000004 });
    expect(diffs).toEqual([
      { pointer: "/n", kind: "value-mismatch", expected: 0.3, actual: 0.30000000000000004 },
    ]);
  });

  it("is order-significant for arrays", () => {
    const diffs = diffJsonValues([1, 2, 3], [3, 2, 1]);
    expect(diffs.map((d) => d.pointer)).toEqual(["/0", "/2"]);
  });

  it("reports a length-mismatch plus the extra elements for arrays of different length", () => {
    const diffs = diffJsonValues([1, 2], [1, 2, 3]);
    expect(diffs).toEqual([
      { pointer: "", kind: "length-mismatch", expected: 2, actual: 3 },
      { pointer: "/2", kind: "missing-in-expected", actual: 3 },
    ]);
  });

  it("reports missing-in-actual / missing-in-expected for object keys", () => {
    const diffs = diffJsonValues({ a: 1, b: 2 }, { a: 1, c: 3 });
    expect(diffs).toEqual(
      expect.arrayContaining([
        { pointer: "/b", kind: "missing-in-actual", expected: 2 },
        { pointer: "/c", kind: "missing-in-expected", actual: 3 },
      ]),
    );
  });

  it("reports a type-mismatch when the JSON type differs", () => {
    expect(diffJsonValues({ a: "1" }, { a: 1 })).toEqual([
      { pointer: "/a", kind: "type-mismatch", expected: "1", actual: 1 },
    ]);
  });

  it("ignores a pointer path and everything under it", () => {
    const diffs = diffJsonValues(
      { keep: 1, drop: { nested: "old" } },
      { keep: 1, drop: { nested: "new" } },
      [parsePointer("/drop")],
    );
    expect(diffs).toEqual([]);
  });

  it("supports a * wildcard segment matching any array index or object key", () => {
    const diffs = diffJsonValues(
      {
        items: [
          { id: 1, generated_at: "a" },
          { id: 2, generated_at: "a" },
        ],
      },
      {
        items: [
          { id: 1, generated_at: "b" },
          { id: 2, generated_at: "b" },
        ],
      },
      [parsePointer("/items/*/generated_at")],
    );
    expect(diffs).toEqual([]);
  });

  it("does not ignore a sibling field when only one pointer is ignored", () => {
    const diffs = diffJsonValues({ keep: "old", drop: "old" }, { keep: "new", drop: "new" }, [
      parsePointer("/drop"),
    ]);
    expect(diffs).toEqual([
      { pointer: "/keep", kind: "value-mismatch", expected: "old", actual: "new" },
    ]);
  });
});

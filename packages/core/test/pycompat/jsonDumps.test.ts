import { describe, expect, it } from "vitest";
import { type PyJsonDumpsOptions, pyFloat, pyJsonDumps } from "../../src/pycompat/jsonDumps.js";
import cases from "./fixtures/cases.json";

interface JsonDumpsCase {
  label: string;
  value: unknown;
  options: {
    ensureAscii: boolean;
    indent: number | null;
    sortKeys: boolean;
    separators: [string, string] | null;
  };
  expected: string;
}

const jsonDumpsCases = cases.jsonDumps as unknown as JsonDumpsCase[];

/**
 * Reconstruct a gen.py `to_wire()`-encoded fixture value into the shape
 * pyJsonDumps expects: `{"__pyfloat__": "<repr>"}` -> `pyFloat(...)`,
 * `{"__pydict__": [[k, v], ...]}` -> a `Map` (preserving exact order, see
 * gen.py's `to_wire` doc comment for why a Map and not a plain object).
 */
function reviveWireValue(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(reviveWireValue);
  }
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if ("__pyfloat__" in obj) {
      return pyFloat(Number(obj.__pyfloat__));
    }
    if ("__pydict__" in obj) {
      const pairs = obj.__pydict__ as Array<[string, unknown]>;
      return new Map(pairs.map(([k, val]) => [k, reviveWireValue(val)]));
    }
  }
  return v;
}

function toOptions(o: JsonDumpsCase["options"]): PyJsonDumpsOptions {
  return {
    ensureAscii: o.ensureAscii,
    indent: o.indent === null ? undefined : o.indent,
    sortKeys: o.sortKeys,
    separators: o.separators === null ? undefined : o.separators,
  };
}

describe("pyJsonDumps", () => {
  it("has a substantial, Python-generated fixture set", () => {
    expect(jsonDumpsCases.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of jsonDumpsCases) {
    it(`[${c.label}] ${JSON.stringify(c.expected).slice(0, 60)}`, () => {
      const value = reviveWireValue(c.value);
      const result = pyJsonDumps(value, toOptions(c.options));
      expect(result).toBe(c.expected);
    });
  }

  it("documented example: plain JS object with int-vs-float ambiguity needs pyFloat()", () => {
    expect(pyJsonDumps({ a: 2 })).toBe('{"a": 2}');
    expect(pyJsonDumps({ a: pyFloat(2.0) })).toBe('{"a": 2.0}');
  });

  it("documented example: ensureAscii default true escapes non-ASCII", () => {
    expect(pyJsonDumps("héllo")).toBe('"h\\u00e9llo"');
    expect(pyJsonDumps("héllo", { ensureAscii: false })).toBe('"héllo"');
  });

  it("documented example: indent=2 vs indent=0 vs no indent", () => {
    expect(pyJsonDumps({ a: 1, b: 2 })).toBe('{"a": 1, "b": 2}');
    expect(pyJsonDumps({ a: 1, b: 2 }, { indent: 2 })).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(pyJsonDumps({ a: 1, b: 2 }, { indent: 0 })).toBe('{\n"a": 1,\n"b": 2\n}');
  });

  it("documented example: sortKeys uses codepoint order, not a plain object's key order", () => {
    const m = new Map<string, unknown>([
      ["b", 1],
      ["a", 2],
      ["10", 3],
      ["2", 4],
    ]);
    expect(pyJsonDumps(m, { sortKeys: true })).toBe('{"10": 3, "2": 4, "a": 2, "b": 1}');
  });

  it("documented example: forward slash is never escaped", () => {
    expect(pyJsonDumps("a/b")).toBe('"a/b"');
  });

  it("documented example: empty object/array stay on one line even with indent", () => {
    expect(pyJsonDumps({}, { indent: 2 })).toBe("{}");
    expect(pyJsonDumps([], { indent: 2 })).toBe("[]");
  });

  it("throws on undefined (top-level, array element, and object value) instead of silently writing null", () => {
    expect(() => pyJsonDumps(undefined)).toThrow(/undefined/);
    expect(() => pyJsonDumps([1, undefined, 3])).toThrow(/undefined/);
    expect(() => pyJsonDumps({ a: 1, b: undefined })).toThrow(/undefined/);
    // null is unaffected — it is Python's None and must keep serializing.
    expect(pyJsonDumps(null)).toBe("null");
    expect(pyJsonDumps({ a: null })).toBe('{"a": null}');
  });

  it("throws on a non-plain object (class instance, Date, Set) instead of silently writing {}", () => {
    class Foo {
      x = 1;
    }
    expect(() => pyJsonDumps(new Foo())).toThrow(/non-plain object/);
    expect(() => pyJsonDumps(new Date())).toThrow(/non-plain object/);
    expect(() => pyJsonDumps(new Set([1, 2]))).toThrow(/non-plain object/);
    expect(() => pyJsonDumps({ a: new Date() })).toThrow(/non-plain object/);
    // Map and a plain object literal (or Object.create(null)) are still fine.
    expect(pyJsonDumps(new Map([["a", 1]]))).toBe('{"a": 1}');
    expect(pyJsonDumps(Object.assign(Object.create(null), { a: 1 }))).toBe('{"a": 1}');
  });
});

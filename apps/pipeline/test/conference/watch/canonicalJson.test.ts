/**
 * Port of `paperpilot/tests/test_replay_canonical.py`'s
 * `canonical_json_bytes` cases (RPL-10 of docs/migration/safety-contracts.md
 * — P1). Golden bytes/hash taken verbatim from a real run of
 * `paperpilot.replay.canonical.canonical_json_bytes`/`canonical_json_sha256`.
 */
import { createHash } from "node:crypto";
import { PyFloat, pyFloat } from "@paperpilot/core";
import { describe, expect, it } from "vitest";
import {
  canonicalJsonBytes,
  rejectNonFiniteOrCircular,
} from "../../../src/conference/watch/canonicalJson.js";

const GOLDEN_JSON = Buffer.from('{"a":"あ","b":1}\n', "utf-8");
const GOLDEN_JSON_SHA256 = "58968931db66c950c32a1c8e1c1bf41c7e86a3deae3bb09990c242c3d1886b87";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("canonicalJsonBytes (RPL-10)", () => {
  it("matches the golden bytes and SHA-256 hash from the real Python implementation", () => {
    const value = { b: 1, a: "あ" };
    const bytes = canonicalJsonBytes(value);
    expect(bytes).toEqual(GOLDEN_JSON);
    expect(sha256(bytes)).toBe(GOLDEN_JSON_SHA256);
  });

  it("is independent of insertion order", () => {
    const first = { outer: { z: 3, a: 1 }, items: [{ b: 2, a: 1 }] };
    const second = { items: [{ a: 1, b: 2 }], outer: { a: 1, z: 3 } };
    expect(canonicalJsonBytes(first)).toEqual(canonicalJsonBytes(second));
  });

  it("rejects non-finite floats", () => {
    expect(() => canonicalJsonBytes({ bad: Number.NaN })).toThrow();
    expect(() => canonicalJsonBytes({ bad: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalJsonBytes({ bad: Number.NEGATIVE_INFINITY })).toThrow();
  });

  it("rejects circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => canonicalJsonBytes(obj)).toThrow(/circular/);
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    expect(() => canonicalJsonBytes({ arr })).toThrow(/circular/);
  });

  it("accepts a finite pyFloat leaf and renders it with a decimal point", () => {
    const bytes = canonicalJsonBytes({ identity_coverage: pyFloat(1) });
    expect(bytes.toString("utf-8")).toBe('{"identity_coverage":1.0}\n');
  });
});

describe("rejectNonFiniteOrCircular — non-plain object rejection (LOW)", () => {
  it("rejects a Date (no Python dict/list/scalar equivalent)", () => {
    expect(() => rejectNonFiniteOrCircular(new Date())).toThrow(TypeError);
  });

  it("rejects a Set", () => {
    expect(() => rejectNonFiniteOrCircular(new Set([1, 2]))).toThrow(TypeError);
  });

  it("rejects a Map — canonical_json_bytes's Python original only ever accepts a literal dict, never a Map-like object", () => {
    expect(() => rejectNonFiniteOrCircular(new Map([["a", 1]]))).toThrow(TypeError);
  });

  it("rejects an arbitrary class instance", () => {
    class Foo {
      bar = 1;
    }
    expect(() => rejectNonFiniteOrCircular(new Foo())).toThrow(TypeError);
  });

  it("still accepts a plain object (incl. Object.create(null)) and a PyFloat leaf", () => {
    expect(() => rejectNonFiniteOrCircular({ a: 1, b: [1, 2, { c: null }] })).not.toThrow();
    const nullProto = Object.create(null);
    nullProto.x = 1;
    expect(() => rejectNonFiniteOrCircular(nullProto)).not.toThrow();
    expect(() => rejectNonFiniteOrCircular(new PyFloat(1))).not.toThrow();
    expect(() => rejectNonFiniteOrCircular(new PyFloat(Number.NaN))).toThrow(RangeError);
  });

  it("end-to-end: canonicalJsonBytes rejects a Date/Map nested inside an otherwise-plain object", () => {
    expect(() => canonicalJsonBytes({ when: new Date() })).toThrow();
    expect(() => canonicalJsonBytes({ bad: new Map([["x", 1]]) })).toThrow();
  });
});

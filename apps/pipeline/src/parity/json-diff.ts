import { formatPointer, isIgnored } from "./json-pointer.js";
import type { DiffKind, JsonDiffEntry, JsonValue } from "./types.js";

/**
 * Structural JSON comparison per §7.2:
 *   - object key order is ignored (union of keys is walked);
 *   - array order is significant (compared index by index, length mismatch reported);
 *   - numbers must be value-equal, no tolerance (1.0 === 1; 0.30000000000000004 !== 0.3,
 *     because `JSON.parse` already resolves each literal to the nearest IEEE-754 double,
 *     so strict `===` on the parsed values is exactly "value-equal, format differences only").
 *
 * `ignorePointers` are parsed JSON-pointer segment lists (see json-pointer.ts); a path
 * matching one of them (or any of its ancestors) is skipped entirely, children included.
 */
export function diffJsonValues(
  expected: JsonValue,
  actual: JsonValue,
  ignorePointers: readonly (readonly string[])[] = [],
): JsonDiffEntry[] {
  const diffs: JsonDiffEntry[] = [];

  function walk(e: JsonValue, a: JsonValue, segments: string[]): void {
    if (isIgnored(ignorePointers, segments)) return;

    const eType = valueType(e);
    const aType = valueType(a);
    if (eType !== aType) {
      push(segments, "type-mismatch", e, a);
      return;
    }

    if (eType === "object") {
      const eObj = e as Record<string, JsonValue>;
      const aObj = a as Record<string, JsonValue>;
      const keys = new Set<string>([...Object.keys(eObj), ...Object.keys(aObj)]);
      for (const key of keys) {
        const childSegments = [...segments, key];
        if (isIgnored(ignorePointers, childSegments)) continue;
        const inExpected = Object.hasOwn(eObj, key);
        const inActual = Object.hasOwn(aObj, key);
        if (!inExpected) {
          push(childSegments, "missing-in-expected", undefined, aObj[key]);
          continue;
        }
        if (!inActual) {
          push(childSegments, "missing-in-actual", eObj[key], undefined);
          continue;
        }
        walk(eObj[key] as JsonValue, aObj[key] as JsonValue, childSegments);
      }
      return;
    }

    if (eType === "array") {
      const eArr = e as JsonValue[];
      const aArr = a as JsonValue[];
      if (eArr.length !== aArr.length) {
        push(segments, "length-mismatch", eArr.length, aArr.length);
      }
      const len = Math.max(eArr.length, aArr.length);
      for (let i = 0; i < len; i++) {
        const childSegments = [...segments, String(i)];
        if (isIgnored(ignorePointers, childSegments)) continue;
        if (i >= eArr.length) {
          push(childSegments, "missing-in-expected", undefined, aArr[i]);
          continue;
        }
        if (i >= aArr.length) {
          push(childSegments, "missing-in-actual", eArr[i], undefined);
          continue;
        }
        walk(eArr[i] as JsonValue, aArr[i] as JsonValue, childSegments);
      }
      return;
    }

    // primitive: null, boolean, number, string
    if (!primitiveEqual(e, a)) {
      push(segments, "value-mismatch", e, a);
    }
  }

  function push(
    segments: string[],
    kind: DiffKind,
    expectedValue: unknown,
    actualValue: unknown,
  ): void {
    const entry: JsonDiffEntry = { pointer: formatPointer(segments), kind };
    if (expectedValue !== undefined) entry.expected = expectedValue;
    if (actualValue !== undefined) entry.actual = actualValue;
    diffs.push(entry);
  }

  walk(expected, actual, []);
  return diffs;
}

function valueType(v: JsonValue): "null" | "array" | "object" | "number" | "string" | "boolean" {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v as "object" | "number" | "string" | "boolean";
}

function primitiveEqual(e: JsonValue, a: JsonValue): boolean {
  if (typeof e === "number" && typeof a === "number") {
    if (Number.isNaN(e) && Number.isNaN(a)) return true;
    return e === a;
  }
  return e === a;
}

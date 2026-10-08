/**
 * Canonical JSON bytes shared by `fingerprint.ts`, `candidate.ts`,
 * `dryRun.ts`, and `baseline.ts` — TS port of
 * `paperpilot/replay/canonical.py::canonical_json_bytes` (the
 * `allow_nan=False` half `@paperpilot/core`'s `pyJsonDumps` deliberately
 * does not model; see that module's doc comment).
 */

import { PyFloat, pyJsonDumps } from "@paperpilot/core";

/** A plain object literal, or `Object.create(null)` — mirrors Python's `type(value) is dict` (any other object, incl. `Map`/`Set`/`Date`/a class instance, is NOT a `dict` and must be rejected). */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reject values `json.dumps(..., allow_nan=False)` would reject: non-finite
 * floats, circular references, and — exact port of `replay/canonical.py`'s
 * `_validate_json_value`, whose `type(value) is dict` / `type(value) is
 * list` checks are STRICT (not `isinstance`) — any non-plain object. A
 * `Date`/`Map`/`Set`/class instance has no well-defined Python `dict`
 * shape; recursing into it with `Object.values()` would silently validate
 * `{}` (none of those have *own enumerable* properties) and then let
 * `pyJsonDumps` decide its fate inconsistently (it deliberately tolerates
 * `Map` for OTHER, non-canonical callers — see that module's doc comment —
 * so letting a `Map` reach it here would wrongly succeed instead of being
 * rejected like Python's `dict`-only contract requires).
 */
export function rejectNonFiniteOrCircular(value: unknown, active: Set<unknown> = new Set()): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (value instanceof PyFloat) {
    if (!Number.isFinite(value.value)) {
      throw new RangeError("non-finite numbers are not valid canonical JSON");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError("non-finite numbers are not valid canonical JSON");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (active.has(value)) throw new RangeError("circular references are not valid canonical JSON");
    active.add(value);
    try {
      for (const item of value) rejectNonFiniteOrCircular(item, active);
    } finally {
      active.delete(value);
    }
    return;
  }
  if (typeof value === "object" && isPlainObject(value)) {
    if (active.has(value)) throw new RangeError("circular references are not valid canonical JSON");
    active.add(value);
    try {
      for (const item of Object.values(value as Record<string, unknown>))
        rejectNonFiniteOrCircular(item, active);
    } finally {
      active.delete(value);
    }
    return;
  }
  throw new TypeError(`value of type ${typeof value} is not valid canonical JSON`);
}

/** Serialize a JSON value to stable UTF-8 bytes with exactly one trailing LF (`sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False`). */
export function canonicalJsonBytes(value: unknown): Buffer {
  rejectNonFiniteOrCircular(value);
  const text = pyJsonDumps(value, { ensureAscii: false, sortKeys: true, separators: [",", ":"] });
  return Buffer.from(`${text}\n`, "utf-8");
}

/**
 * Canonical JSON bytes shared by `fingerprint.ts`, `candidate.ts`,
 * `dryRun.ts`, and `baseline.ts` — TS port of
 * `paperpilot/replay/canonical.py::canonical_json_bytes` (the
 * `allow_nan=False` half `@paperpilot/core`'s `pyJsonDumps` deliberately
 * does not model; see that module's doc comment).
 */

import { pyJsonDumps } from "@paperpilot/core";

/** Reject values `json.dumps(..., allow_nan=False)` would reject: non-finite floats and circular references. */
export function rejectNonFiniteOrCircular(value: unknown, active: Set<unknown> = new Set()): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
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
  if (typeof value === "object") {
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

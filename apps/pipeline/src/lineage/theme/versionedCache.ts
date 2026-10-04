/**
 * Schema-versioned JSON file cache — TS port of
 * `paperpilot/utils/versioned_cache.py` (`read_versioned_cache`,
 * `write_versioned_cache`). Shared by the GitHub-stars cache and the S2
 * seed-search cache, both of which wrap their payload as
 * `{schema_version, data}` so a version bump invalidates old files
 * instead of misinterpreting their shape.
 */

import { readFileSync } from "node:fs";
import { pyJsonDumps } from "@paperpilot/core";
import { atomicWriteText } from "../../collect/state/atomic.js";

/** Return the cached `data`, or `null` for ANY kind of miss: missing,
 * unreadable, legacy (unwrapped), or a different `version`. The caller
 * still validates the returned data against its own predicate — the
 * version only proves which writer produced it. */
export function readVersionedCache(path: string, version: string): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.schema_version !== version || !("data" in obj)) return null;
  return obj.data;
}

/** Atomically write `data` wrapped with `version`. */
export function writeVersionedCache(path: string, version: string, data: unknown): void {
  atomicWriteText(
    path,
    pyJsonDumps({ schema_version: version, data }, { ensureAscii: false, indent: 2 }),
  );
}

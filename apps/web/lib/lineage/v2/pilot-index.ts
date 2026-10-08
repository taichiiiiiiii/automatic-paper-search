/**
 * Strict lineage-pilot-index-v1 reader -- ported 1:1 from
 * docs/assets/lineage-v2-core.js `parsePilotIndex`/`resolvePilotEntry`
 * (safety-contracts.md SCR-47/SCR-48).
 *
 * This is deliberately a STRICTER contract than
 * apps/web/lib/lineage/pilot-index.ts's `parsePilotIndex` (which that
 * module's own docstring explains is a conservative placeholder the
 * previous page-port agent wrote because the full v2 contract had not
 * been ported yet). That file's exported behaviour must not change --
 * other, unrelated code (`lib/data-lineage.ts`,
 * `test/lineage/pilot-index.test.ts`, `test/lineage/data-lineage.test.ts`)
 * depends on its current loose shape. The real Focus View now uses
 * THIS module instead (see `loader.ts` `loadVerifiedRelease`), which
 * never calls through the loose reader.
 */

import { entryBrand, indexBrand } from "./brand";
import { INDEX_VERSION, PAPER_ID_RE, PILOT_PROFILE, SHA_RE, SLUG_RE } from "./constants";
import { boundedJson, cloneJson, deepFreeze, exactKeys, record, text } from "./json";
import type { PilotIndex, PilotIndexEntry, PilotPathRef } from "./types";
import { validPilotPath } from "./url-alias";

const MAX_INDEX_ENTRIES = 100;
const MAX_INDEX_BYTES = 256 * 1024;

/** Named and exported for test/lineage/focus/schema-contract.test.ts
 * to assert against `schemas/lineage-pilot-index-v1.schema.json`'s
 * `entry.required`. */
export const ENTRY_KEYS = [
  "paper_id",
  "conference",
  "collection_id",
  "release_id",
  "release_profile",
  "artifact",
  "fixture",
  "quality",
] as const;

function validPathRef(value: unknown): value is PilotPathRef {
  return exactKeys(value, ["path", "sha256"]);
}

/**
 * Validates the FULL v2 index shape: closed top-level keys, a
 * `schema_version` match, at most 100 entries, an overall size bound,
 * and -- per entry -- a well-formed `paper_id`/`conference`, a
 * `collection_id` that is exactly `deep:<conference>:paper:<paper_id>`,
 * a non-empty `release_id`, the fixed `release_profile`, no duplicate
 * `paper_id`s, and `artifact`/`fixture`/`quality` sub-objects whose
 * `path` is exactly the deterministic path derived from the entry
 * (`validPilotPath`) and whose `sha256` is 64 lowercase hex chars.
 * Returns a deeply frozen, branded value on success so downstream
 * consumers (`resolvePilotEntry`, `release.ts`) can trust it without
 * re-validating -- and so a caller cannot mutate it after the fact.
 */
export function parsePilotIndex(value: unknown): PilotIndex | null {
  if (
    !boundedJson(value) ||
    !exactKeys(value, ["schema_version", "entries"]) ||
    !record(value) ||
    value.schema_version !== INDEX_VERSION ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_INDEX_ENTRIES ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_INDEX_BYTES
  ) {
    return null;
  }
  const ids = new Set<string>();
  for (const rawEntry of value.entries) {
    if (!exactKeys(rawEntry, ENTRY_KEYS) || !record(rawEntry)) return null;
    const entry = rawEntry as unknown as PilotIndexEntry;
    if (
      !PAPER_ID_RE.test(entry.paper_id) ||
      typeof entry.conference !== "string" ||
      !SLUG_RE.test(entry.conference) ||
      entry.collection_id !== `deep:${entry.conference}:paper:${entry.paper_id}` ||
      !text(entry.release_id) ||
      entry.release_profile !== PILOT_PROFILE ||
      ids.has(entry.paper_id)
    ) {
      return null;
    }
    ids.add(entry.paper_id);
    for (const kind of ["artifact", "fixture", "quality"] as const) {
      const ref = entry[kind];
      if (
        !validPathRef(ref) ||
        !SHA_RE.test(ref.sha256) ||
        !validPilotPath(ref.path, entry, kind)
      ) {
        return null;
      }
    }
  }
  const parsed = deepFreeze(cloneJson(value)) as unknown as PilotIndex;
  indexBrand.add(parsed);
  for (const entry of parsed.entries) entryBrand.add(entry);
  return parsed;
}

/** Finds the entry for `paperId` in a value THIS module parsed (the
 * `indexBrand` check rejects any other object, including a
 * structurally identical one built by hand or round-tripped through
 * JSON) -- never falls back to "first entry" or a partial match. */
export function resolvePilotEntry(
  index: PilotIndex | null,
  paperId: string,
): PilotIndexEntry | null {
  if (!record(index) || !indexBrand.has(index) || !PAPER_ID_RE.test(paperId)) return null;
  return (index.entries as PilotIndexEntry[]).find((entry) => entry.paper_id === paperId) ?? null;
}

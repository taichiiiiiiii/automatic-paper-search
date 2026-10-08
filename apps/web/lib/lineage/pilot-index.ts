/**
 * Minimal reader for `lineage-pilot-index-v1.json`'s `?paper=`
 * query-string gate: `readSinglePaperParam`/`isValidPaperId` (used by
 * `app/lineage/page.tsx` before any fetch) and a LOOSE
 * `parsePilotIndex`/`findPilotEntry` pair kept at their original,
 * deliberately conservative shape for `lib/data-lineage.ts` and its
 * existing tests, which predate the full contract below and must not
 * change behaviour here.
 *
 * The FULL "v2" release contract this index actually gates (SCR-19/
 * SCR-20/SCR-44..SCR-48: strict index/artifact/fixture/quality
 * validation, cross-document binding, state normalization, and the
 * deterministic Focus View projection -- docs/assets/lineage-v2-core.js
 * + docs/assets/lineage-focus.js, ~1900 lines combined) is now ported
 * in `./v2/*` and is what `app/lineage/page.tsx` actually uses to
 * verify a release and render it via
 * `components/lineage/focus/FocusView.tsx`. This file's loose reader
 * is no longer part of that page's real decision path; it is kept
 * only for the other, unrelated consumer described above.
 */
import { MAX_JSON_BYTES } from "./core";

export const PILOT_INDEX_VERSION = "lineage-pilot-index-v1" as const;
export const PAPER_ID_RE = /^[0-9a-f]{40}$/;

export interface PilotIndexEntry {
  paper_id: string;
  [key: string]: unknown;
}

export interface PilotIndex {
  schema_version: typeof PILOT_INDEX_VERSION;
  entries: PilotIndexEntry[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validates only the shape this reader relies on (closed top-level
 * keys, entries is an array of objects each carrying a `paper_id`); it
 * does not validate -- and so cannot authorize use of -- any other
 * field an entry might carry. */
export function parsePilotIndex(data: unknown): PilotIndex | null {
  if (!record(data)) return null;
  const keys = Object.keys(data);
  if (keys.length !== 2 || !keys.includes("schema_version") || !keys.includes("entries"))
    return null;
  if (data.schema_version !== PILOT_INDEX_VERSION || !Array.isArray(data.entries)) return null;
  const entries: PilotIndexEntry[] = [];
  for (const entry of data.entries) {
    if (!record(entry) || typeof entry.paper_id !== "string" || !PAPER_ID_RE.test(entry.paper_id)) {
      return null;
    }
    entries.push({ ...entry, paper_id: entry.paper_id });
  }
  return { schema_version: PILOT_INDEX_VERSION, entries };
}

export function isValidPaperId(value: string | null): value is string {
  return value !== null && PAPER_ID_RE.test(value);
}

/** Reads the single `?paper=` value from a query string the way
 * docs/assets/lineage-focus.js does: exactly one occurrence, or none. A
 * repeated `paper` param is treated the same as a missing one (never
 * "pick the first"), matching `start()`'s
 * `paperValues.length === 1 ? paperValues[0] : null`. */
export function readSinglePaperParam(search: string): string | null {
  const params = new URLSearchParams(search);
  const values = params.getAll("paper");
  return values.length === 1 ? (values[0] as string) : null;
}

export function findPilotEntry(index: PilotIndex | null, paperId: string): PilotIndexEntry | null {
  if (!index) return null;
  const matches = index.entries.filter((entry) => entry.paper_id === paperId);
  return matches.length === 1 ? (matches[0] as PilotIndexEntry) : null;
}

export { MAX_JSON_BYTES };

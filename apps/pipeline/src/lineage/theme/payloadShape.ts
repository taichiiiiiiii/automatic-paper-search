/**
 * Element-level validation for S2/OpenAlex payloads consumed by the theme
 * lineage builder — TS port of the lineage-only half of
 * `paperpilot/utils/payload.py` (`s2_paper_id`, `s2_paper_shape`,
 * `openalex_work_shape`, `s2_relation_entry_ok`, `s2_cached_neighbour_ok`
 * and their private `_optional_*` helpers).
 *
 * `first_unusable`/`gh_repo_slug`/`gh_search_item_ok` are already ported
 * generically in `apps/pipeline/src/collect/signals/payload.ts` — that
 * module's own doc comment explicitly scopes the rest (this file's
 * contents) to the lineage/theme builders as "P4d, not this task's
 * scope" at the time it was written; it is this task now, so it lives
 * here rather than being added to that already-shipped, narrower module.
 */

import { firstUnusable } from "../../collect/signals/payload.js";
import { openalexShortId } from "./openalexWork.js";

export { firstUnusable };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absent/null, or an actual string. */
export function optionalText(value: unknown): boolean {
  return value === null || value === undefined || typeof value === "string";
}

/** Absent/null, or an actual object. */
export function optionalMapping(value: unknown): boolean {
  return value === null || value === undefined || isPlainObject(value);
}

/** Absent/null, or a list whose elements are objects (optionally with a
 * nested `innerKey` object, optionally requiring a string `nameKey`). */
export function optionalMappingList(
  value: unknown,
  options: { innerKey?: string; nameKey?: string } = {},
): boolean {
  if (value === null || value === undefined) return true;
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item)) return false;
    let target: Record<string, unknown> = item;
    if (options.innerKey !== undefined) {
      const nested = item[options.innerKey];
      if (nested !== null && nested !== undefined && !isPlainObject(nested)) return false;
      target = isPlainObject(nested) ? nested : {};
    }
    if (options.nameKey !== undefined && !optionalText(target[options.nameKey])) return false;
  }
  return true;
}

/** Absent/null, or a real (non-boolean) number. */
export function optionalNumber(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "number" && Number.isFinite(value);
}

/** Absent/null, or an integer (non-boolean) number. */
export function optionalInt(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "number" && Number.isInteger(value);
}

/** Every named key on `mapping` is absent/null/string (non-object
 * `mapping` passes trivially — a sibling check elsewhere owns rejecting
 * that). */
export function optionalTextFields(mapping: unknown, keys: readonly string[]): boolean {
  if (!isPlainObject(mapping)) return true;
  return keys.every((key) => optionalText(mapping[key]));
}

/** The usable `paperId` of a Semantic Scholar paper object: a non-empty,
 * untrimmed-equals-trimmed string. */
export function s2PaperId(payload: unknown): string | null {
  if (!isPlainObject(payload)) return null;
  const paperId = payload.paperId;
  if (typeof paperId !== "string" || !paperId || paperId !== paperId.trim()) return null;
  return paperId;
}

/** The paperId of an S2 paper whose consumed fields are readable. */
export function s2PaperShape(
  payload: unknown,
  options: { requireTitle?: boolean } = {},
): string | null {
  const paperId = s2PaperId(payload);
  if (paperId === null) return null;
  const p = payload as Record<string, unknown>;
  if (!optionalMappingList(p.authors, { nameKey: "name" })) return null;
  for (const key of ["title", "venue", "abstract"]) {
    if (!optionalText(p[key])) return null;
  }
  if (!optionalMapping(p.externalIds)) return null;
  if (!optionalTextFields(p.externalIds, ["ArXiv", "arxiv", "DOI", "doi"])) return null;
  if (!optionalNumber(p.citationCount)) return null;
  if (!optionalInt(p.year)) return null;
  if (options.requireTitle) {
    const title = p.title;
    if (typeof title !== "string" || !title.trim()) return null;
  }
  return paperId;
}

/** The Work's short id when its alias-bearing blocks are readable. */
export function openalexWorkShape(work: unknown): string | null {
  const short = openalexShortId(isPlainObject(work) ? (work.id as unknown) : null);
  if (short === null) return null;
  const w = work as Record<string, unknown>;
  for (const key of ["ids", "primary_location"]) {
    const value = w[key];
    if (value !== null && value !== undefined && !isPlainObject(value)) return null;
  }
  if (!optionalMappingList(w.locations)) return null;
  if (!optionalMappingList(w.authorships, { innerKey: "author", nameKey: "display_name" }))
    return null;
  const primary = w.primary_location;
  if (isPlainObject(primary) && !optionalMapping(primary.source)) return null;
  for (const key of ["title", "display_name", "doi"]) {
    if (!optionalText(w[key])) return null;
  }
  if (!optionalNumber(w.cited_by_count)) return null;
  if (!optionalInt(w.publication_year)) return null;
  if (isPlainObject(primary) && !optionalTextFields(primary.source, ["display_name"])) return null;
  if (
    !optionalTextFields(w.ids, [
      "openalex",
      "doi",
      "arxiv",
      "arxiv_id",
      "openreview",
      "openreview_id",
      "mag",
      "pmid",
    ])
  ) {
    return null;
  }
  const locationUrls = ["landing_page_url", "pdf_url"];
  if (!optionalTextFields(primary, locationUrls)) return null;
  const locations = w.locations;
  if (
    Array.isArray(locations) &&
    !locations.every((loc) => optionalTextFields(loc, locationUrls))
  ) {
    return null;
  }
  return short;
}

/** One element of an S2 `references`/`citations` envelope. */
export function s2RelationEntryOk(entry: unknown, innerKey: string): boolean {
  if (!isPlainObject(entry)) return false;
  if (s2PaperShape(entry[innerKey]) === null) return false;
  const influential = entry.isInfluential;
  if (influential !== null && influential !== undefined && typeof influential !== "boolean")
    return false;
  const intents = entry.intents;
  if (intents === null || intents === undefined) return true;
  return Array.isArray(intents) && intents.every((i) => typeof i === "string");
}

/** One element of a FLATTENED relation cache file (envelope fields
 * lifted onto the inner paper). */
export function s2CachedNeighbourOk(paper: unknown): boolean {
  if (s2PaperShape(paper, { requireTitle: true }) === null) return false;
  const p = paper as Record<string, unknown>;
  const influential = p._is_influential;
  if (influential !== null && influential !== undefined && typeof influential !== "boolean")
    return false;
  for (const key of ["_intents", "_contexts"]) {
    const value = p[key];
    if (value === null || value === undefined) continue;
    if (!Array.isArray(value) || !value.every((i) => typeof i === "string")) return false;
  }
  return true;
}

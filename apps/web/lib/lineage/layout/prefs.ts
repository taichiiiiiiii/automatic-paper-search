/**
 * Pure helpers for the `?layout=&view=&relations=` URL state and the
 * `localStorage["pp.lineage.prefs"]` fallback -- ported from the
 * initialization block at the top of docs/assets/lineage.js (the
 * `loadPrefs`/`savePrefs` functions and the `state = {...}` literal
 * that reads `initialParams` / `prefs`).
 *
 * Storage access itself (try/catch around `localStorage`, reading
 * `window.location.search`) stays in
 * components/lineage/graph/lineage-graph-app.tsx, which is the only
 * place allowed to touch the DOM/BOM in this area; these functions
 * take plain strings/records so they can be unit tested without a
 * `window`.
 */
import type { Relation } from "../core";
import { ALL_RELATIONS, DEFAULT_VISIBLE_RELATIONS } from "../relations";
import { DEFAULT_LAYOUT, type LineageLayout, VALID_LAYOUTS } from "./constants";

export interface LineagePrefs {
  layout?: unknown;
  view?: unknown;
  visibleRelations?: unknown;
}

/** Ported from lineage.js `loadPrefs`'s `JSON.parse` + the implicit
 * "not an object" tolerance of the surrounding code (fields are read
 * with `?.`/`Array.isArray` guards wherever they're consumed). Returns
 * `null` on anything that isn't parseable JSON. */
export function parsePrefsJson(raw: string | null): LineagePrefs | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as LineagePrefs) : null;
  } catch {
    return null;
  }
}

function isValidLayout(value: unknown): value is LineageLayout {
  return typeof value === "string" && VALID_LAYOUTS.has(value as LineageLayout);
}

/** Ported from the `layout:` field of lineage.js's initial `state`
 * literal: URL `?layout=` wins, then the saved pref, then
 * `DEFAULT_LAYOUT` ("topics"). */
export function resolveInitialLayout(
  urlLayout: string | null,
  prefs: LineagePrefs | null,
): LineageLayout {
  if (isValidLayout(urlLayout)) return urlLayout;
  if (isValidLayout(prefs?.layout)) return prefs?.layout as LineageLayout;
  return DEFAULT_LAYOUT;
}

/** Ported from the `?relations=` parsing + `visibleRelations:` field
 * of lineage.js's initial `state` literal. URL relations win outright
 * (even an empty/all-invalid URL list falls through to prefs, exactly
 * like the original's `urlRelations.length > 0 ? urlRelations : ...`),
 * then the saved pref list (filtered to known relations), then
 * `DEFAULT_VISIBLE_RELATIONS`. */
export function resolveInitialRelations(
  urlRelationsParam: string | null,
  prefs: LineagePrefs | null,
): Set<Relation> {
  const urlRelations = (urlRelationsParam || "")
    .split(",")
    .filter((r): r is Relation => ALL_RELATIONS.includes(r as Relation));
  if (urlRelations.length > 0) return new Set(urlRelations);
  const prefsRelations = prefs?.visibleRelations;
  const saved = Array.isArray(prefsRelations)
    ? prefsRelations.filter(
        (r): r is Relation => typeof r === "string" && ALL_RELATIONS.includes(r as Relation),
      )
    : [];
  if (saved.length > 0) return new Set(saved);
  return new Set(DEFAULT_VISIBLE_RELATIONS);
}

export interface SerializablePrefs {
  layout: LineageLayout;
  view: "list" | "graph";
  visibleRelations: Relation[];
}

/** Ported from lineage.js `savePrefs`'s `JSON.stringify` payload
 * shape (sorted order is not required by the original, but a stable
 * `[...Set]` order matters for `syncDisplayUrl`'s `relations=` query
 * value -- see `serializeRelationsParam`). */
export function buildPrefsPayload(
  layout: LineageLayout,
  view: "list" | "graph",
  visibleRelations: ReadonlySet<Relation>,
): SerializablePrefs {
  return { layout, view, visibleRelations: [...visibleRelations] };
}

/** Ported from lineage.js `syncDisplayUrl`'s
 * `[...state.visibleRelations].sort().join(",")`. */
export function serializeRelationsParam(visibleRelations: ReadonlySet<Relation>): string {
  return [...visibleRelations].sort().join(",");
}

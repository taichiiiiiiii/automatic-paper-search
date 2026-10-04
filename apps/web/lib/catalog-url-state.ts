/**
 * URL state (filters / search / sort), ported from docs/assets/app.js
 * (`readUrlState` / `syncUrlState`). Filters live in the query string so
 * a filtered view is shareable, survives reload, and the back button
 * restores it. Params are omitted when they equal their default so the
 * common URL stays clean: `q=<search> type=Oral|Poster tags=a,b,c
 * sort=newest|oral|title`.
 */
import {
  ACCEPTANCE_TYPES,
  type AcceptanceType,
  SORT_VALUES,
  type SortValue,
} from "./catalog-constants";

export interface CatalogUrlState {
  search: string;
  type: AcceptanceType;
  sort: SortValue;
  activeTags: Set<string>;
}

export function defaultCatalogUrlState(): CatalogUrlState {
  return { search: "", type: "all", sort: "default", activeTags: new Set() };
}

/** Reads the filter/search/sort state out of a `location.search`-style
 * string. Unrecognized values fall back to the default silently (an
 * invalid `type`/`sort` must not throw and must not widen the result
 * set) -- matching docs/assets/app.js `readUrlState`. */
export function readCatalogUrlState(search: string): CatalogUrlState {
  const state = defaultCatalogUrlState();
  const params = new URLSearchParams(search);
  const q = params.get("q");
  if (typeof q === "string") state.search = q;
  const type = params.get("type");
  if ((ACCEPTANCE_TYPES as readonly string[]).includes(type ?? "")) {
    state.type = type as AcceptanceType;
  }
  const sort = params.get("sort");
  if (sort && (SORT_VALUES as readonly string[]).includes(sort)) state.sort = sort as SortValue;
  const tags = params.get("tags");
  if (tags) {
    state.activeTags = new Set(
      tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    );
  }
  return state;
}

/**
 * Applies filter/search/sort state onto an existing URL's query params,
 * mutating a copy -- every OTHER param (notably `?paper=`, owned by
 * lib/catalog-core.ts `setPaperParam`) is left untouched. Returns the
 * full URL string, ready for `history.replaceState`.
 */
export function buildCatalogUrl(currentUrl: string, state: CatalogUrlState): string {
  const url = new URL(currentUrl);
  const params = url.searchParams;
  const q = state.search.trim();
  if (q) params.set("q", q);
  else params.delete("q");
  if (state.type !== "all") params.set("type", state.type);
  else params.delete("type");
  if (state.activeTags.size > 0) params.set("tags", [...state.activeTags].join(","));
  else params.delete("tags");
  if (state.sort !== "default") params.set("sort", state.sort);
  else params.delete("sort");
  return url.toString();
}

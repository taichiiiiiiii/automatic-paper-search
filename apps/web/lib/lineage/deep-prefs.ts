/**
 * Pure helpers for the deep viewer's `?relations=` URL state and its
 * `localStorage["pp.deep.prefs"]` fallback -- ported from the
 * initialization block at the top of docs/assets/deep.js
 * (`STORAGE_KEY`, `loadPrefs`, `savePrefs`, the `visibleRelations`
 * field of its `state` literal, and `syncDisplayUrl`'s `relations=`
 * writer).
 *
 * Kept separate from lib/lineage/layout/prefs.ts (the conference
 * lineage viewer's equivalent) rather than shared, because the two
 * originals use DIFFERENT storage keys (`pp.deep.prefs` vs
 * `pp.lineage.prefs`) and different payload shapes -- lineage.js also
 * persists `layout`, deep.js never does -- so a filter saved on one
 * page must not silently become the other's. Same field names,
 * precedence and serialisation are duplicated on purpose to keep each
 * port pinned to its own JS source.
 *
 * Same boundary as that file: the relation maths themselves take plain
 * strings/records so they can be unit tested without a `window`, and
 * the two functions that do touch storage (`loadDeepRelations`/
 * `saveDeepRelations`) take the store as a *thunk*. That is not
 * decoration -- Safari raises when the `window.localStorage` *property
 * itself* is read with cookies blocked, before `getItem`/`setItem` ever
 * run, so the property access has to sit inside the `try` too. A page
 * passes `() => window.localStorage`; a test passes a stub that throws.
 */
import type { Relation } from "./core";
import { ALL_RELATIONS, DEFAULT_VISIBLE_RELATIONS } from "./relations";

/** Ported from deep.js `STORAGE_KEY`. */
export const DEEP_STORAGE_KEY = "pp.deep.prefs";

/** What may legally sit in `pp.deep.prefs`. Deep's own payload is
 * `{view, visibleRelations}` (no `layout`); everything is `unknown`
 * because the stored blob is untrusted derived data. */
export interface DeepPrefs {
  view?: unknown;
  visibleRelations?: unknown;
}

/** The slice of `Storage` this module needs, so tests can hand in a
 * partial stub instead of a jsdom `localStorage`. */
export interface DeepPrefsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type DeepPrefsStoreSource = () => DeepPrefsStore | null;

/** The shape actually written back out. `view` is only re-emitted when
 * the blob already carried a valid one: this port has no list/graph
 * toggle yet (docs/migration/p2-parity-gaps.md's graph-view gap), so it
 * must not invent a view -- but it must not erase the visitor's saved
 * one either, or the toggle's eventual port would silently reset it. */
export interface SerializableDeepPrefs {
  visibleRelations: Relation[];
  view?: "list" | "graph";
}

/** Ported from deep.js `loadPrefs`'s `JSON.parse` (whose `catch`
 * returns `null`), plus the same tolerance for a non-object blob -- the
 * original only ever reads fields off `prefs?.`. */
export function parseDeepPrefsJson(raw: string | null): DeepPrefs | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as DeepPrefs) : null;
  } catch {
    return null;
  }
}

/** Ported from `initialParams.get("relations")`. Takes the raw
 * `window.location.search` string (leading `?` included or not --
 * `URLSearchParams` accepts both). */
export function readRelationsParam(search: string | null | undefined): string | null {
  if (!search) return null;
  return new URLSearchParams(search).get("relations");
}

function toKnownRelations(values: readonly unknown[]): Relation[] {
  return values.filter(
    (value): value is Relation =>
      typeof value === "string" && ALL_RELATIONS.includes(value as Relation),
  );
}

/** Ported from the `?relations=` split + `visibleRelations:` field of
 * deep.js's initial `state` literal. A non-empty URL list wins outright
 * -- exactly like the original's `urlRelations.length > 0 ? ... :
 * ...`, which means an empty or all-unknown `?relations=` falls through
 * to the saved prefs rather than meaning "show nothing"; that quirk is
 * the current site's behaviour and is kept. Then the saved list
 * (filtered to known relations, empty treated as unset), then
 * `DEFAULT_VISIBLE_RELATIONS`. */
export function resolveInitialRelations(
  urlRelationsParam: string | null,
  prefs: DeepPrefs | null,
): Set<Relation> {
  const fromUrl = toKnownRelations((urlRelationsParam || "").split(","));
  if (fromUrl.length > 0) return new Set(fromUrl);
  const prefsRelations = prefs?.visibleRelations;
  const saved = Array.isArray(prefsRelations) ? toKnownRelations(prefsRelations) : [];
  if (saved.length > 0) return new Set(saved);
  return new Set(DEFAULT_VISIBLE_RELATIONS);
}

/** Ported from deep.js `syncDisplayUrl`'s
 * `[...state.visibleRelations].sort().join(",")` -- sorted so the URL a
 * visitor bookmarks stays stable regardless of chip click order. */
export function serializeRelationsParam(visibleRelations: ReadonlySet<Relation>): string {
  return [...visibleRelations].sort().join(",");
}

/** Ported from deep.js `savePrefs`'s `JSON.stringify` payload. */
export function buildDeepPrefsPayload(
  visibleRelations: ReadonlySet<Relation>,
  previous: DeepPrefs | null = null,
): SerializableDeepPrefs {
  const payload: SerializableDeepPrefs = { visibleRelations: [...visibleRelations] };
  const view = previous?.view;
  if (view === "list" || view === "graph") payload.view = view;
  return payload;
}

function resolveStore(source: DeepPrefsStoreSource): DeepPrefsStore | null {
  try {
    return source();
  } catch {
    return null;
  }
}

/** `loadPrefs()` behind a throwing-safe read. Never throws; returns
 * `null` for no store, a store whose access raises, or unreadable
 * JSON. */
export function readDeepPrefs(source: DeepPrefsStoreSource): DeepPrefs | null {
  const store = resolveStore(source);
  if (!store) return null;
  try {
    return parseDeepPrefsJson(store.getItem(DEEP_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** The filter this visitor came in with: URL `?relations=`, else
 * `pp.deep.prefs`, else the default relations -- and the defaults if
 * storage is unavailable (private mode) instead of throwing. */
export function loadDeepRelations(
  search: string | null | undefined,
  source: DeepPrefsStoreSource,
): Set<Relation> {
  return resolveInitialRelations(readRelationsParam(search), readDeepPrefs(source));
}

/** `savePrefs()`: re-reads the stored blob (so a `view` written by the
 * original site survives our relations-only write) and stores the new
 * filter. Never throws -- a blocked accessor, a throwing `getItem`, or
 * a quota/private-mode `setItem` all leave the page working with
 * in-memory state only. */
export function saveDeepRelations(
  visibleRelations: ReadonlySet<Relation>,
  source: DeepPrefsStoreSource,
): void {
  const store = resolveStore(source);
  if (!store) return;
  let previous: DeepPrefs | null = null;
  try {
    previous = parseDeepPrefsJson(store.getItem(DEEP_STORAGE_KEY));
  } catch {
    previous = null;
  }
  try {
    store.setItem(
      DEEP_STORAGE_KEY,
      JSON.stringify(buildDeepPrefsPayload(visibleRelations, previous)),
    );
  } catch {
    /* localStorage may be disabled */
  }
}

/** Ported from `syncDisplayUrl`: the href to `history.replaceState`
 * after a chip toggle, carrying the filter in `?relations=`. Only the
 * `relations` key is touched -- this page has no view toggle yet, so an
 * existing `?view=` is left as the visitor wrote it. Every other query
 * parameter (notably the picker's `?paper=`) is preserved. */
export function deepDisplayUrl(href: string, visibleRelations: ReadonlySet<Relation>): string {
  const url = new URL(href);
  url.searchParams.set("relations", serializeRelationsParam(visibleRelations));
  return url.toString();
}

/**
 * URL query-string codec + localStorage prefs for the theme lineage
 * tree, ported from docs/assets/theme.js's `readUrlState()` /
 * `syncUrlState()` / `loadPrefs()` / `savePrefs()` (P2 review M8a).
 *
 * Every reader here is an allowlist guard (an unrecognised xaxis mode,
 * relation, or orphan value is silently ignored rather than corrupting
 * layout/filter state -- mirrors the original's "data-xaxis comes from
 * the DOM/URL/localStorage and could be tampered with" comments) and
 * every writer degrades to a no-op on failure (storage disabled,
 * private-mode exceptions) rather than throwing. Pure/DOM-free except
 * for the injectable `StorageLike` parameter so tests never touch real
 * `localStorage` (see test/themes/url-state.test.ts).
 */
import {
  ALL_RELATIONS,
  DEFAULT_RELATIONS,
  DEFAULT_X_AXIS_MODE,
  type Relation,
  X_AXIS_MODES,
  type XAxisMode,
} from "./themes-tree";

const X_AXIS_MODE_SET: ReadonlySet<string> = new Set(X_AXIS_MODES);
const RELATION_SET: ReadonlySet<string> = new Set(ALL_RELATIONS);

// ---- URL query-string state (?xaxis=&ymin=&ymax=&q=&rels=&orphan=&node=) --

export interface TreeUrlState {
  /** `null` = param absent / invalid -- caller falls back to prefs/default. */
  xAxisMode: XAxisMode | null;
  yearMin: number | null;
  yearMax: number | null;
  /** `null` = param absent (NOT the same as an explicit empty string). */
  searchQuery: string | null;
  /** `null` = param absent or every requested relation was unrecognised. */
  visibleRelations: Relation[] | null;
  /** `null` = param absent; `true`/`false` = explicit `?orphan=hide`/`show`. */
  hideOrphans: boolean | null;
  /** Permalink focus (`?node=`), resolved against the artifact by the
   * caller via `resolveFocus` -- this module only extracts the raw value. */
  node: string | null;
  /** `null` = param absent; `?main=off|only` (design doc 48 P0-1). */
  mainPath: MainPathMode | null;
  /** Paper selected in the Prior / Derivative panel (`?focus=`, design
   * doc 48 P0-5 / P1-3). Raw value; resolved like `node` by the caller.
   * Also the scroll target when `?node=` is absent. */
  focus: string | null;
  /** Second paper of the two-paper path (`?to=`, design doc 48 P1-5). */
  pathTo: string | null;
  /** `?view=timeline` shows the year × citation view (design doc 48 P1-5). */
  view: ThemeView | null;
}

/** Theme page main view: the family tree (default) or the year ×
 * citation-count timeline. */
export type ThemeView = "tree" | "timeline";
export const DEFAULT_THEME_VIEW: ThemeView = "tree";

/** Upper bound for a node id taken from the URL (ids are short; this
 * only stops a pathological query from being carried around). */
const MAX_NODE_PARAM = 300;

function nodeParam(params: URLSearchParams, name: string): string | null {
  const raw = params.get(name);
  return typeof raw === "string" && raw.length > 0 && raw.length <= MAX_NODE_PARAM ? raw : null;
}

/** Main path (本流) display: emphasise it (default), show only it, or off. */
export type MainPathMode = "highlight" | "only" | "off";
export const DEFAULT_MAIN_PATH_MODE: MainPathMode = "highlight";

/** Parses `search` (e.g. `window.location.search` or a `URLSearchParams`
 * query string) into the whitelisted tree filter state. Never throws --
 * `URLSearchParams` itself never throws on malformed input, and every
 * field here is validated against a fixed allowlist before use. */
export function readTreeUrlState(search: string): TreeUrlState {
  const params = new URLSearchParams(search);

  const xaxisRaw = params.get("xaxis");
  const xAxisMode = xaxisRaw && X_AXIS_MODE_SET.has(xaxisRaw) ? (xaxisRaw as XAxisMode) : null;

  const yminRaw = params.get("ymin");
  const yminParsed = yminRaw !== null ? Number.parseInt(yminRaw, 10) : Number.NaN;
  const yearMin = Number.isFinite(yminParsed) ? yminParsed : null;

  const ymaxRaw = params.get("ymax");
  const ymaxParsed = ymaxRaw !== null ? Number.parseInt(ymaxRaw, 10) : Number.NaN;
  const yearMax = Number.isFinite(ymaxParsed) ? ymaxParsed : null;

  const q = params.get("q");
  const searchQuery = typeof q === "string" ? q : null;

  const relsRaw = params.get("rels");
  let visibleRelations: Relation[] | null = null;
  if (relsRaw) {
    const requested = relsRaw
      .split(",")
      .map((r) => r.trim())
      .filter((r): r is Relation => RELATION_SET.has(r));
    if (requested.length > 0) visibleRelations = requested;
  }

  const orphanRaw = params.get("orphan");
  const hideOrphans = orphanRaw === "show" ? false : orphanRaw === "hide" ? true : null;

  const nodeRaw = params.get("node");
  const node = typeof nodeRaw === "string" && nodeRaw.length > 0 ? nodeRaw : null;

  const mainRaw = params.get("main");
  const mainPath: MainPathMode | null =
    mainRaw === "off" || mainRaw === "only" || mainRaw === "highlight" ? mainRaw : null;

  const viewRaw = params.get("view");
  const view: ThemeView | null = viewRaw === "timeline" || viewRaw === "tree" ? viewRaw : null;

  return {
    xAxisMode,
    yearMin,
    yearMax,
    searchQuery,
    visibleRelations,
    hideOrphans,
    node,
    mainPath,
    focus: nodeParam(params, "focus"),
    pathTo: nodeParam(params, "to"),
    view,
  };
}

export interface TreeUrlWriteState {
  xAxisMode: XAxisMode;
  /** Current slider bounds, or `null` when the data has no plausible years. */
  yearRange: { min: number; max: number } | null;
  /** The *data's* full extents -- a bound is only written when it narrows
   * past this (matches the original: writing the no-op default pollutes
   * the URL with `&ymin=2014&ymax=2026` after a "clear all"). */
  dataYearExtents: { min: number; max: number } | null;
  searchQuery: string;
  visibleRelations: ReadonlySet<Relation>;
  /** The raw toggle value (not the "disabled because zero orphans"
   * effective value) -- matches `state.hideOrphans` in the original,
   * which the disabled-toggle UI affordance never mutates. */
  hideOrphans: boolean;
  /** Optional so older callers keep compiling; absent = default. */
  mainPath?: MainPathMode;
  /** Selected paper / path target / view. A key that is absent leaves
   * the URL param untouched; `null` removes it. */
  focus?: string | null;
  pathTo?: string | null;
  view?: ThemeView;
}

/**
 * Applies the "omit when it equals the default" rule to `params`
 * in-place (set/delete, mirroring `syncUrlState()`'s shape) so the
 * caller can then write it back via `history.replaceState`. Pure
 * w.r.t. `history` -- this function itself never touches it, which
 * keeps it testable without jsdom.
 */
export function writeTreeUrlParams(params: URLSearchParams, s: TreeUrlWriteState): void {
  if (s.xAxisMode !== DEFAULT_X_AXIS_MODE) {
    params.set("xaxis", s.xAxisMode);
  } else {
    params.delete("xaxis");
  }

  if (
    s.yearRange &&
    s.dataYearExtents &&
    Number.isFinite(s.yearRange.min) &&
    s.yearRange.min !== s.dataYearExtents.min
  ) {
    params.set("ymin", String(s.yearRange.min));
  } else {
    params.delete("ymin");
  }
  if (
    s.yearRange &&
    s.dataYearExtents &&
    Number.isFinite(s.yearRange.max) &&
    s.yearRange.max !== s.dataYearExtents.max
  ) {
    params.set("ymax", String(s.yearRange.max));
  } else {
    params.delete("ymax");
  }

  if (s.searchQuery) {
    params.set("q", s.searchQuery);
  } else {
    params.delete("q");
  }

  const rels = [...s.visibleRelations].sort();
  const allDefaults =
    rels.length === DEFAULT_RELATIONS.length && rels.every((r) => DEFAULT_RELATIONS.includes(r));
  if (rels.length > 0 && !allDefaults) {
    params.set("rels", rels.join(","));
  } else {
    params.delete("rels");
  }

  // Symmetric with readTreeUrlState: only the non-default choice is
  // persisted. Default is hide, so `?orphan=show` means "opted in to
  // reveal"; everything else (including the matching-default `hide`)
  // is cleared.
  if (!s.hideOrphans) {
    params.set("orphan", "show");
  } else {
    params.delete("orphan");
  }

  if (s.mainPath && s.mainPath !== DEFAULT_MAIN_PATH_MODE) {
    params.set("main", s.mainPath);
  } else {
    params.delete("main");
  }

  if ("focus" in s) {
    if (s.focus) params.set("focus", s.focus);
    else params.delete("focus");
  }
  if ("pathTo" in s) {
    if (s.pathTo) params.set("to", s.pathTo);
    else params.delete("to");
  }
  if ("view" in s) {
    if (s.view && s.view !== DEFAULT_THEME_VIEW) params.set("view", s.view);
    else params.delete("view");
  }
}

// ---- localStorage prefs (`pp.theme.prefs.v2`) -----------------------------

/** `.v2` since baseline_only joined DEFAULT_RELATIONS (R2 UX P0-1): every
 * earlier visitor had the OLD defaults auto-saved under `pp.theme.prefs`
 * (the prefs effect persists on mount), which would keep hiding the
 * background-citation evidence for them. Bumping the key drops that. */
export const THEME_PREFS_STORAGE_KEY = "pp.theme.prefs.v2";

export interface ThemePrefs {
  xAxisMode: XAxisMode;
  visibleRelations: Relation[];
}

/** Minimal `Storage` surface this module needs -- lets tests pass a
 * fake without touching real `localStorage`/jsdom. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Reads+validates `pp.theme.prefs`. `localStorage` is user-controlled
 * (and can throw outright in private-mode browsers, not just on a
 * missing key), so every step -- the storage access itself, JSON
 * parsing, and each field's shape -- is covered by one try/catch, and
 * any failure degrades to `null` (caller falls back to the built-in
 * default) rather than throwing or returning partially-trusted data.
 */
export function loadThemePrefs(storage: StorageLike): ThemePrefs | null {
  try {
    const raw = storage.getItem(THEME_PREFS_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const xAxisModeRaw = (parsed as { xAxisMode?: unknown }).xAxisMode;
    const visibleRelationsRaw = (parsed as { visibleRelations?: unknown }).visibleRelations;
    const xAxisMode =
      typeof xAxisModeRaw === "string" && X_AXIS_MODE_SET.has(xAxisModeRaw)
        ? (xAxisModeRaw as XAxisMode)
        : DEFAULT_X_AXIS_MODE;
    const visibleRelations = Array.isArray(visibleRelationsRaw)
      ? visibleRelationsRaw.filter(
          (r): r is Relation => typeof r === "string" && RELATION_SET.has(r),
        )
      : [];
    return {
      xAxisMode,
      visibleRelations: visibleRelations.length > 0 ? visibleRelations : [...DEFAULT_RELATIONS],
    };
  } catch {
    return null;
  }
}

/** Best-effort write -- a full/disabled/private-mode storage must never
 * surface as a crash; the session just stops persisting prefs. */
export function saveThemePrefs(storage: StorageLike, prefs: ThemePrefs): void {
  try {
    storage.setItem(THEME_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore -- localStorage disabled */
  }
}

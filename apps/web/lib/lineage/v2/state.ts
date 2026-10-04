/**
 * Focus View URL/preference state normalization -- ported 1:1 from
 * docs/assets/lineage-v2-core.js `readState`/`writeState`/`validState`
 * (safety-contracts.md SCR-48: "URL・設定の状態で表示範囲を広げない").
 *
 * `readState` is the single place every query-string/localStorage
 * value becomes a typed, bounded `FocusViewState`. Its guiding
 * invariant: an UNRECOGNISED or AMBIGUOUS input must never silently
 * broaden what is shown -- a duplicate query key never "picks the
 * first", an unknown explicit filter value is dropped (not ignored in
 * favour of "show everything"), and simultaneous `relations`/`rels`
 * aliases collapse to an empty, explicit filter rather than one
 * silently winning. Every anomaly is recorded in `statusCodes` for the
 * UI to surface, never swallowed.
 */

import { releaseBrand, releasePrivate } from "./brand";
import {
  GENEALOGY,
  MAX_EXPANDED_IDS,
  MAX_STATE_TEXT,
  RELATIONS,
  type Relation,
  TRUST_TIERS,
  type TrustTier,
} from "./constants";
import { compareText, deepFreeze, record } from "./json";
import { resolveFocus } from "./release";
import type { Release } from "./types";

export type FocusFamily = "genealogy" | "comparison";
export type FocusViewMode = "graph" | "list";

export interface FocusViewState {
  focusId: string | null;
  view: FocusViewMode;
  hops: 1 | 2 | 3;
  nodeLimit: number;
  claimLimit: 18;
  minConfidence: 0.5 | 0.7 | 0.9;
  trustTiers: TrustTier[];
  families: FocusFamily[];
  relations: Relation[];
  relationFilterExplicit: boolean;
  evidenceSources: string[];
  evidenceKinds: string[];
  evidenceSourcesExplicit: boolean;
  evidenceKindsExplicit: boolean;
  expandedNodeIds: string[];
  pageSize: 20;
  statusCodes: string[];
}

/** A simple reversible CSV-with-backslash-escaping used for list-valued
 * query params and the preference store (`\,` for a literal comma,
 * `\\` for a literal backslash). `null` means malformed input. */
export function escapedCsvParse(value: unknown): string[] | null {
  if (typeof value !== "string" || value.length > MAX_STATE_TEXT) return null;
  const output: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      if (character !== "," && character !== "\\") return null;
      current += character;
      escaped = false;
    } else if (character === "\\") escaped = true;
    else if (character === ",") {
      output.push(current);
      current = "";
    } else current += character;
  }
  if (escaped) return null;
  output.push(current);
  return output;
}

export function escapedCsvWrite(values: string[]): string {
  return values.map((value) => value.replaceAll("\\", "\\\\").replaceAll(",", "\\,")).join(",");
}

type ParamsInput = URLSearchParams | string | Record<string, unknown> | undefined;

function paramSource(params: ParamsInput): URLSearchParams {
  if (params instanceof URLSearchParams) return params;
  if (typeof params === "string") return new URLSearchParams(params);
  if (record(params)) {
    const converted = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string") converted.set(key, value);
    }
    return converted;
  }
  return new URLSearchParams();
}

export interface ReadStateOptions {
  params?: ParamsInput;
  prefs?: Record<string, unknown>;
  mobile?: boolean;
}

const PREFERENCE_KEYS: Record<string, string> = {
  focus: "focusId",
  limit: "nodeLimit",
  min_conf: "minConfidence",
  trust: "trustTiers",
  relations: "relations",
  rels: "relations",
  evidence_sources: "evidenceSources",
  evidence_kinds: "evidenceKinds",
  expanded: "expandedNodeIds",
};

/**
 * Builds a normalized `FocusViewState` from the current URL
 * (`params`), the persisted preference blob (`prefs`), and whether the
 * viewport is mobile-sized (`mobile`, used only as the view default).
 * Returns a deeply frozen state; every unrecognised/ambiguous input is
 * recorded in `statusCodes` rather than silently widening what the
 * projection (`selectFocusProjection`) will show.
 */
export function readState(
  release: Release | null,
  options: ReadStateOptions = {},
): FocusViewState | null {
  if (!release || typeof release !== "object" || !releaseBrand.has(release as object)) return null;
  const { params, prefs = {}, mobile = false } = options;
  const query = paramSource(params);
  const statuses = new Set<string>();
  const duplicates = new Set([...query.keys()].filter((key) => query.getAll(key).length !== 1));
  duplicates.forEach((key) => {
    statuses.add(`duplicate_${key}`);
  });

  const preference = (key: string, fallback: unknown): unknown => {
    if (!record(prefs)) return fallback;
    const candidate = Object.hasOwn(prefs, key)
      ? prefs[key]
      : prefs[PREFERENCE_KEYS[key] as string];
    return Array.isArray(candidate)
      ? escapedCsvWrite(candidate as string[])
      : (candidate ?? fallback);
  };
  const source = (key: string, fallback: unknown): unknown =>
    duplicates.has(key) ? null : query.has(key) ? query.get(key) : preference(key, fallback);

  const requestedFocus = duplicates.has("focus") ? false : (source("focus", null) as string | null);
  const focus = resolveFocus(release, requestedFocus);
  if (requestedFocus !== null && requestedFocus !== "" && focus === null) {
    statuses.add("unknown_focus");
  }

  const rawView = source("view", mobile ? "list" : "graph");
  const view: FocusViewMode =
    rawView === "list" || rawView === "graph" ? rawView : mobile ? "list" : "graph";
  if (rawView !== view) statuses.add("invalid_view");

  const enumNumber = (key: string, allowed: number[], fallback: number): number => {
    const raw = source(key, String(fallback));
    const number = Number(raw);
    if (allowed.includes(number) && String(number) === String(raw)) return number;
    if (raw !== undefined && raw !== null && String(raw) !== String(fallback))
      statuses.add(`invalid_${key}`);
    return fallback;
  };
  const hops = enumNumber("hops", [1, 2, 3], 1) as 1 | 2 | 3;
  const rawLimit = source("limit", "7");
  const parsedLimit = Number(rawLimit);
  const nodeLimit =
    Number.isInteger(parsedLimit) && parsedLimit >= 5 && parsedLimit <= 50 ? parsedLimit : 7;
  if (nodeLimit !== parsedLimit) statuses.add("invalid_limit");
  const minConfidence = enumNumber("min_conf", [0.5, 0.7, 0.9], 0.7) as 0.5 | 0.7 | 0.9;

  const parseAllowed = (
    key: string,
    fallback: string[],
    allowed: Set<string>,
    explicitEmpty = false,
  ): string[] => {
    const present =
      query.has(key) ||
      (record(prefs) &&
        (Object.hasOwn(prefs, key) || Object.hasOwn(prefs, PREFERENCE_KEYS[key] as string)));
    if (!present && fallback.length === 0) return [];
    const raw = source(key, escapedCsvWrite(fallback));
    const parsed = escapedCsvParse(raw);
    if (parsed === null) {
      statuses.add(`invalid_${key}`);
      return present ? [] : fallback;
    }
    if (explicitEmpty && present && parsed.length === 1 && parsed[0] === "") return [];
    const valid: string[] = [];
    for (const item of parsed) {
      if (allowed.has(item) && !valid.includes(item)) valid.push(item);
      else statuses.add(`unknown_${key}`);
    }
    return present ? valid : fallback;
  };

  const trustTiers = parseAllowed(
    "trust",
    ["verified", "corroborated"],
    TRUST_TIERS as Set<string>,
  );
  const families = parseAllowed("families", ["genealogy"], new Set(["genealogy", "comparison"]));
  const ambiguousRelations = query.has("relations") && query.has("rels");
  if (ambiguousRelations) statuses.add("ambiguous_relations");
  const relationKey = query.has("relations") || !query.has("rels") ? "relations" : "rels";
  const relationFilterExplicit =
    query.has(relationKey) ||
    (record(prefs) &&
      (typeof prefs.relationFilterExplicit === "boolean"
        ? prefs.relationFilterExplicit
        : Object.hasOwn(prefs, relationKey)));
  const defaultRelations = [...GENEALOGY];
  const relations = ambiguousRelations
    ? []
    : parseAllowed(relationKey, defaultRelations, RELATIONS as Set<string>, true);

  const evidenceSources = new Set(release.artifact.evidence.map((item) => item.source));
  const evidenceKinds = new Set(release.artifact.evidence.map((item) => item.kind));
  let selectedSources = parseAllowed("evidence_sources", [], evidenceSources, true);
  let selectedKinds = parseAllowed("evidence_kinds", [], evidenceKinds, true);
  let evidenceSourcesExplicit =
    query.has("evidence_sources") ||
    (record(prefs) &&
      (typeof prefs.evidenceSourcesExplicit === "boolean"
        ? prefs.evidenceSourcesExplicit
        : Object.hasOwn(prefs, "evidence_sources") || Object.hasOwn(prefs, "evidenceSources")));
  let evidenceKindsExplicit =
    query.has("evidence_kinds") ||
    (record(prefs) &&
      (typeof prefs.evidenceKindsExplicit === "boolean"
        ? prefs.evidenceKindsExplicit
        : Object.hasOwn(prefs, "evidence_kinds") || Object.hasOwn(prefs, "evidenceKinds")));
  const ambiguousEvidence =
    query.has("evidence") && (query.has("evidence_sources") || query.has("evidence_kinds"));
  if (duplicates.has("evidence")) {
    selectedSources = [];
    selectedKinds = [];
    evidenceSourcesExplicit = true;
    evidenceKindsExplicit = true;
  } else if (ambiguousEvidence) {
    statuses.add("ambiguous_evidence");
    selectedSources = [];
    selectedKinds = [];
    evidenceSourcesExplicit = true;
    evidenceKindsExplicit = true;
  } else if (
    query.has("evidence") &&
    !query.has("evidence_sources") &&
    !query.has("evidence_kinds")
  ) {
    const legacy = escapedCsvParse(query.get("evidence"));
    if (legacy === null) statuses.add("invalid_evidence");
    else {
      selectedSources = [];
      selectedKinds = [];
      evidenceSourcesExplicit = true;
      evidenceKindsExplicit = true;
      for (const token of legacy) {
        if (token.startsWith("source:") && evidenceSources.has(token.slice(7)))
          selectedSources.push(token.slice(7));
        else if (token.startsWith("kind:") && evidenceKinds.has(token.slice(5)))
          selectedKinds.push(token.slice(5));
        else statuses.add("unknown_evidence");
      }
    }
  }

  const rawExpanded = source("expanded", "");
  const parsedExpanded = escapedCsvParse(rawExpanded);
  const expandedNodeIds: string[] = [];
  const indexes = releasePrivate.get(release as object);
  if (parsedExpanded === null) statuses.add("invalid_expanded");
  else if (indexes) {
    for (const id of parsedExpanded) {
      if (id === "") continue;
      if (
        indexes.nodeById.has(id) &&
        !expandedNodeIds.includes(id) &&
        expandedNodeIds.length < MAX_EXPANDED_IDS
      ) {
        expandedNodeIds.push(id);
      } else statuses.add("unknown_expanded");
    }
  }
  expandedNodeIds.sort(compareText);

  const state: FocusViewState = {
    focusId: focus?.id || null,
    view,
    hops,
    nodeLimit,
    claimLimit: 18,
    minConfidence,
    trustTiers: [...trustTiers].sort(compareText) as TrustTier[],
    families: [...families].sort(compareText) as FocusFamily[],
    relations: [...relations].sort(compareText) as Relation[],
    relationFilterExplicit: Boolean(relationFilterExplicit),
    evidenceSources: [...new Set(selectedSources)].sort(compareText),
    evidenceKinds: [...new Set(selectedKinds)].sort(compareText),
    evidenceSourcesExplicit: Boolean(evidenceSourcesExplicit),
    evidenceKindsExplicit: Boolean(evidenceKindsExplicit),
    expandedNodeIds,
    pageSize: 20,
    statusCodes: [...statuses].sort(compareText),
  };
  // Deeply frozen, matching the JS source's `deepFreeze(state)` -- a
  // caller (or a bug in this module) can never mutate a state object
  // `selectFocusProjection`/`writeState` then read from.
  return deepFreeze(state);
}

/** Writes `state` onto `url`'s search params (mirroring `readState`'s
 * precedence): `focus` is removed when null, `relations`/
 * `evidence_sources`/`evidence_kinds` are removed (not written as
 * empty) unless the state says the filter was explicit, the legacy
 * combined `evidence`/`rels` params are always removed. */
export function writeState(url: URL | string, state: FocusViewState | null | undefined): URL {
  const output = url instanceof URL ? new URL(url.href) : new URL(url, "https://paperpilot.local/");
  if (!record(state)) return output;
  const set = (key: string, value: unknown) => output.searchParams.set(key, String(value));
  if (state.focusId === null) output.searchParams.delete("focus");
  else set("focus", state.focusId);
  set("view", state.view);
  set("hops", state.hops);
  set("limit", state.nodeLimit);
  set("min_conf", state.minConfidence);
  set("trust", escapedCsvWrite(state.trustTiers));
  set("families", escapedCsvWrite(state.families));
  if (state.relationFilterExplicit) set("relations", escapedCsvWrite(state.relations));
  else output.searchParams.delete("relations");
  output.searchParams.delete("rels");
  if (state.evidenceSourcesExplicit)
    set("evidence_sources", escapedCsvWrite(state.evidenceSources));
  else output.searchParams.delete("evidence_sources");
  if (state.evidenceKindsExplicit) set("evidence_kinds", escapedCsvWrite(state.evidenceKinds));
  else output.searchParams.delete("evidence_kinds");
  output.searchParams.delete("evidence");
  if (state.expandedNodeIds.length) set("expanded", escapedCsvWrite(state.expandedNodeIds));
  else output.searchParams.delete("expanded");
  return output;
}

/** Structural + brand validation for a `FocusViewState` that is about
 * to be handed to `selectFocusProjection` -- used by that function
 * itself as its own fail-closed precondition. A state object not
 * produced by `readState` (e.g. a hand-built one missing `Object.freeze`)
 * is rejected. */
export function validState(release: Release, state: unknown): state is FocusViewState {
  if (!record(state) || !Object.isFrozen(state) || !Array.isArray(state.statusCodes)) return false;
  const indexes = releasePrivate.get(release as object);
  if (!indexes) return false;
  return (
    (state.focusId === null || indexes.nodeById.has(state.focusId as string)) &&
    (state.view === "graph" || state.view === "list") &&
    [1, 2, 3].includes(state.hops as number) &&
    Number.isInteger(state.nodeLimit) &&
    (state.nodeLimit as number) >= 5 &&
    (state.nodeLimit as number) <= 50 &&
    state.claimLimit === 18 &&
    [0.5, 0.7, 0.9].includes(state.minConfidence as number) &&
    Array.isArray(state.trustTiers) &&
    (state.trustTiers as unknown[]).every((item) => TRUST_TIERS.has(item as TrustTier)) &&
    Array.isArray(state.families) &&
    (state.families as unknown[]).every((item) => item === "genealogy" || item === "comparison") &&
    Array.isArray(state.relations) &&
    (state.relations as unknown[]).every((item) => RELATIONS.has(item as Relation)) &&
    Array.isArray(state.evidenceSources) &&
    Array.isArray(state.evidenceKinds) &&
    typeof state.evidenceSourcesExplicit === "boolean" &&
    typeof state.evidenceKindsExplicit === "boolean" &&
    Array.isArray(state.expandedNodeIds) &&
    (state.expandedNodeIds as unknown[]).length <= MAX_EXPANDED_IDS
  );
}

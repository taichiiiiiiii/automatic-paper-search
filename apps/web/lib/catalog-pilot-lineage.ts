/**
 * Pilot-lineage probe link, ported from docs/assets/app.js
 * (`resolvePilotLineageForSelection`, `renderPilotLineageSection`,
 * `createPilotLineageLookupOwner`, `startPilotLineageLookup`,
 * `abandonPilotLineageLookup`) -- SCR-19.
 *
 * `/lineage-pilot-index-v1.json` is a small, site-wide (not
 * per-conference) index of papers that have an audited deep-lineage
 * artifact. When the selected paper is in it (for THIS conference --
 * paper_id alone is not enough, since a graph-local id namespace could
 * collide across conferences), the card offers a link to that audited
 * view; otherwise it says plainly that none is published yet.
 *
 * `parsePilotLineageIndex` below is a deliberately conservative,
 * fail-closed SUBSET of the full index contract
 * (docs/assets/lineage-v2-core.js `parsePilotIndex`, SCR-47/48): it
 * validates `schema_version`, the entry count bound, and that every
 * entry has a well-formed `paper_id` + conference slug with no
 * duplicates, but does NOT validate the `artifact`/`fixture`/`quality`
 * path+sha256 triples those entries also carry (the catalog never reads
 * or renders lineage content itself -- it only resolves "does an entry
 * exist for this paper in this conference" to decide whether to show a
 * link). The full contract belongs in a shared module
 * (`packages/core/lineage/contract-v2.ts`, per safety-contracts.md) for
 * whichever page actually fetches and renders the audited artifact; this
 * file must not grow a second definition of it.
 */
import { BASE_PATH } from "@paperpilot/core/site";
import { isPaperId } from "./catalog-core";

export const PILOT_LINEAGE_INDEX_PATH = `${BASE_PATH}/lineage-pilot-index-v1.json`;
export const PILOT_LINEAGE_INDEX_MAX_BYTES = 256 * 1024;
export const PILOT_LINEAGE_INDEX_TIMEOUT_MS = 8_000;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const PILOT_INDEX_MAX_ENTRIES = 100;

export interface PilotLineageEntry {
  paper_id: string;
  conference: string;
}

export interface PilotLineageIndex {
  schema_version: "lineage-pilot-index-v1";
  entries: PilotLineageEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parsePilotLineageIndex(value: unknown): PilotLineageIndex | null {
  if (!isRecord(value)) return null;
  if (value.schema_version !== "lineage-pilot-index-v1") return null;
  if (!Array.isArray(value.entries) || value.entries.length > PILOT_INDEX_MAX_ENTRIES) return null;
  const ids = new Set<string>();
  const entries: PilotLineageEntry[] = [];
  for (const raw of value.entries) {
    if (
      !isRecord(raw) ||
      !isPaperId(raw.paper_id) ||
      typeof raw.conference !== "string" ||
      !SLUG_RE.test(raw.conference) ||
      ids.has(raw.paper_id)
    ) {
      return null;
    }
    ids.add(raw.paper_id);
    entries.push({ paper_id: raw.paper_id, conference: raw.conference });
  }
  return { schema_version: "lineage-pilot-index-v1", entries };
}

/** Finds the one entry (if any) that matches BOTH `paperId` and the
 * current conference -- a stale/foreign entry can never resolve to a
 * link on another conference's card. */
export function resolvePilotLineageForSelection(
  index: PilotLineageIndex | null,
  paperId: string,
  conference: string,
): PilotLineageEntry | null {
  if (!index || !isPaperId(paperId)) return null;
  const entry = index.entries.find((e) => e.paper_id === paperId);
  return entry && entry.conference === conference ? entry : null;
}

export type PilotLineageStatus = "loading" | "ready" | "unavailable";

export interface PilotLineageLookupOwner {
  paperId: string;
  controller: AbortController;
  isActive: () => boolean;
  finish: () => void;
  abandon: () => void;
}

/** A single in-flight lookup, with its own deadline. Mirrors
 * docs/assets/app.js `createPilotLineageLookupOwner`: the deadline
 * fires `onTimeout` exactly once and the card must never be left
 * "loading" forever if the index fetch stalls. */
export interface TimerHelpers {
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createPilotLineageLookupOwner(
  paperId: string,
  timerHelpers: TimerHelpers = {},
  onTimeout: () => void = () => {},
): PilotLineageLookupOwner {
  const setTimer =
    timerHelpers.setTimer ?? ((cb: () => void, delay: number) => globalThis.setTimeout(cb, delay));
  const clearTimer =
    timerHelpers.clearTimer ?? ((handle: unknown) => globalThis.clearTimeout(handle as number));
  const controller = new AbortController();
  let active = true;
  const timer = setTimer(() => {
    if (!active) return;
    active = false;
    controller.abort(new DOMException("pilot lineage lookup timed out", "TimeoutError"));
    onTimeout();
  }, PILOT_LINEAGE_INDEX_TIMEOUT_MS);
  return {
    paperId,
    controller,
    isActive: () => active,
    finish() {
      if (!active) return;
      active = false;
      clearTimer(timer);
    },
    abandon() {
      if (!active) return;
      active = false;
      clearTimer(timer);
      controller.abort(new DOMException("pilot lineage lookup abandoned", "AbortError"));
    },
  };
}

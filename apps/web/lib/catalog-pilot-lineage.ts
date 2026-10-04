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
 * `parsePilotLineageIndex`/`resolvePilotLineageForSelection` below used
 * to be a hand-rolled, deliberately conservative SUBSET of the full
 * index contract -- validating only `schema_version`, the entry count
 * bound, and a well-formed `paper_id`/conference slug, while skipping
 * the `artifact`/`fixture`/`quality` path+sha256 triples (SCR-47) and
 * the branded-value replay guard (SCR-48). That was a placeholder from
 * before the full v2 reader existed. Now that
 * `lib/lineage/v2` (SCR-47/SCR-48) is ported, this module delegates to
 * it directly -- `parsePilotIndex`/`resolvePilotEntry` -- instead of
 * keeping a second, looser definition of the same contract. The
 * catalog still never reads or renders lineage content itself; it only
 * resolves "does a fully-verified entry exist for this paper in this
 * conference" to decide whether to show a link. The exported names/
 * shapes here are kept stable (`PilotLineageIndex`, `PilotLineageEntry`,
 * `parsePilotLineageIndex`, `resolvePilotLineageForSelection`) because
 * `lib/catalog-data.ts` and `components/catalog/catalog-app.tsx` (both
 * outside this file's ownership) import them and only ever check the
 * resolved entry's truthiness -- they do not need to change.
 */
import { BASE_PATH } from "@paperpilot/core/site";
import { isPaperId } from "./catalog-core";
import { parsePilotIndex, resolvePilotEntry } from "./lineage/v2";
import type { PilotIndex, PilotIndexEntry } from "./lineage/v2/types";

export const PILOT_LINEAGE_INDEX_PATH = `${BASE_PATH}/lineage-pilot-index-v1.json`;
export const PILOT_LINEAGE_INDEX_MAX_BYTES = 256 * 1024;
export const PILOT_LINEAGE_INDEX_TIMEOUT_MS = 8_000;

export type PilotLineageEntry = PilotIndexEntry;
export type PilotLineageIndex = PilotIndex;

/** Full lineage-pilot-index-v1 contract (SCR-47/48) -- see this file's
 * header. Fails closed (`null`) on anything the strict v2 reader does
 * not accept, including today's production index (an entry-less
 * `{schema_version, entries: []}`), which still parses fine since an
 * empty `entries` array trivially satisfies every per-entry check. */
export function parsePilotLineageIndex(value: unknown): PilotLineageIndex | null {
  return parsePilotIndex(value);
}

/** Finds the one entry (if any) that matches BOTH `paperId` and the
 * current conference -- a stale/foreign entry can never resolve to a
 * link on another conference's card. `resolvePilotEntry` also enforces
 * SCR-48's replay guard: only a value THIS module's `parsePilotIndex`
 * produced (branded, deep-frozen) can resolve, so a structurally
 * identical object built by hand (or round-tripped through
 * `structuredClone`/`JSON`) never resolves. */
export function resolvePilotLineageForSelection(
  index: PilotLineageIndex | null,
  paperId: string,
  conference: string,
): PilotLineageEntry | null {
  if (!isPaperId(paperId)) return null;
  const entry = resolvePilotEntry(index, paperId);
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

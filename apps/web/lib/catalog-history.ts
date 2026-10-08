/**
 * Selection/history restore contract, ported from docs/assets/app.js
 * (`makeCatalogHistoryRestore`, `buildSelectionHistoryEntries`,
 * `readCatalogHistoryRestore`, `shouldFocusSelectedPaperAfterPopstate`).
 *
 * Selecting a paper pushes a history entry so Back/Forward work; the
 * LIST entry (the one the reader came from) carries a restore snapshot
 * (progressive-reveal count, scroll position, the paper that was
 * selected) so returning to it does not silently reset to the top of
 * the list. SCR-17.
 */

import { CATALOG_HISTORY_VERSION, CATALOG_RESTORE_KEY, PAGE_SIZE } from "./catalog-constants";
import { isPaperId, setPaperParam } from "./catalog-core";

export interface CatalogHistoryRestore {
  version: typeof CATALOG_HISTORY_VERSION;
  visibleCount: number;
  scrollY: number;
  focusPaperId: string;
}

export function makeCatalogHistoryRestore(options: {
  visibleCount: number;
  scrollY: number;
  focusPaperId: string;
}): CatalogHistoryRestore {
  if (!Number.isInteger(options.visibleCount) || options.visibleCount < PAGE_SIZE) {
    throw new TypeError("visibleCount must be an integer at least PAGE_SIZE");
  }
  if (!isPaperId(options.focusPaperId)) throw new TypeError("focusPaperId must be a paper_id");
  const safeScrollY = Number.isFinite(options.scrollY) ? Math.max(0, options.scrollY) : 0;
  return {
    version: CATALOG_HISTORY_VERSION,
    visibleCount: options.visibleCount,
    scrollY: safeScrollY,
    focusPaperId: options.focusPaperId,
  };
}

export interface SelectionHistoryEntries {
  /** New `history.state` for the LIST entry (replaceState target) --
   * every existing key is preserved, only the restore snapshot is
   * added/overwritten. */
  currentState: Record<string, unknown>;
  /** `history.state` for the new SELECTED entry (pushState target). */
  selectedState: { paperpilotPaperSelection: true; [CATALOG_RESTORE_KEY]: CatalogHistoryRestore };
  /** The URL for the new SELECTED entry (`currentUrl` + `?paper=`). */
  selectedUrl: string;
}

export function buildSelectionHistoryEntries(options: {
  currentState: unknown;
  currentUrl: string;
  paperId: string;
  visibleCount: number;
  scrollY: number;
}): SelectionHistoryEntries {
  const restore = makeCatalogHistoryRestore({
    visibleCount: options.visibleCount,
    scrollY: options.scrollY,
    focusPaperId: options.paperId,
  });
  const stateBase =
    options.currentState &&
    typeof options.currentState === "object" &&
    !Array.isArray(options.currentState)
      ? (options.currentState as Record<string, unknown>)
      : {};
  return {
    currentState: { ...stateBase, [CATALOG_RESTORE_KEY]: restore },
    selectedState: { paperpilotPaperSelection: true, [CATALOG_RESTORE_KEY]: restore },
    selectedUrl: setPaperParam(options.currentUrl, options.paperId),
  };
}

/** Reads a restore snapshot out of a `history.state` object (the LIST
 * entry's state, visited via Back/Forward). Fails closed (returns null)
 * on any shape mismatch, version mismatch, or an out-of-range field --
 * an untrusted/stale snapshot must never silently restore a bogus
 * scroll position or reveal count. `visibleCount` is clamped to
 * `[PAGE_SIZE, catalogSize]` so a restore from a since-shrunk catalog
 * cannot ask to reveal more rows than exist. */
export function readCatalogHistoryRestore(
  historyState: unknown,
  catalogSize: number,
): { visibleCount: number; scrollY: number; focusPaperId: string } | null {
  if (!historyState || typeof historyState !== "object" || Array.isArray(historyState)) return null;
  if (!Number.isInteger(catalogSize) || catalogSize < 0) return null;
  const restore = (historyState as Record<string, unknown>)[CATALOG_RESTORE_KEY];
  if (!restore || typeof restore !== "object" || Array.isArray(restore)) return null;
  const record = restore as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "focusPaperId,scrollY,version,visibleCount") return null;
  if (record.version !== CATALOG_HISTORY_VERSION) return null;
  if (typeof record.visibleCount !== "number" || !Number.isInteger(record.visibleCount))
    return null;
  if (record.visibleCount < PAGE_SIZE) return null;
  if (
    typeof record.scrollY !== "number" ||
    !Number.isFinite(record.scrollY) ||
    record.scrollY < 0
  ) {
    return null;
  }
  if (!isPaperId(record.focusPaperId)) return null;
  return {
    visibleCount: Math.max(PAGE_SIZE, Math.min(record.visibleCount, catalogSize)),
    scrollY: record.scrollY,
    focusPaperId: record.focusPaperId as string,
  };
}

/** Forward navigation into a selection (nothing was selected, now
 * something is) must focus the regenerated selected heading; every
 * other transition (selected-to-selected, or plain list restoration)
 * leaves focus where the rest of the restore path already put it. */
export function shouldFocusSelectedPaperAfterPopstate(
  previousPaperId: string | null,
  selectedPaperId: string | null,
): boolean {
  return previousPaperId === null && isPaperId(selectedPaperId);
}

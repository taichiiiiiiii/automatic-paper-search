/**
 * Ported from paperpilot/tests/viewer/test_catalog_history.mjs (the pure
 * helpers only -- the source-regex assertions on docs/assets/app.js do
 * not apply to a React port and are dropped; see the P2 report for the
 * component-level behavior those were guarding).
 */
import { describe, expect, it } from "vitest";
import {
  buildSelectionHistoryEntries,
  readCatalogHistoryRestore,
  shouldFocusSelectedPaperAfterPopstate,
} from "../../lib/catalog-history";

const paperId = "a".repeat(40);

describe("buildSelectionHistoryEntries", () => {
  const entries = buildSelectionHistoryEntries({
    currentState: { unrelatedOwner: "preserved" },
    currentUrl: "https://example.test/cvpr-2026/?q=vision&type=Oral&tags=3D&sort=title",
    paperId,
    visibleCount: 90,
    scrollY: 1234.5,
  });

  it("preserves unrelated keys on the LIST entry's state", () => {
    expect(entries.currentState.unrelatedOwner).toBe("preserved");
  });

  it("writes a restore snapshot onto both the LIST and SELECTED entries identically", () => {
    expect(entries.currentState.paperpilotCatalogRestore).toEqual({
      version: 1,
      visibleCount: 90,
      scrollY: 1234.5,
      focusPaperId: paperId,
    });
    expect(entries.selectedState.paperpilotCatalogRestore).toEqual(
      entries.currentState.paperpilotCatalogRestore,
    );
    expect(entries.selectedState.paperpilotPaperSelection).toBe(true);
  });

  it("builds the SELECTED url with ?paper= added, every other param kept", () => {
    const url = new URL(entries.selectedUrl);
    expect(url.searchParams.get("paper")).toBe(paperId);
    expect(url.searchParams.get("q")).toBe("vision");
    expect(url.searchParams.get("type")).toBe("Oral");
    expect(url.searchParams.get("tags")).toBe("3D");
    expect(url.searchParams.get("sort")).toBe("title");
  });
});

describe("readCatalogHistoryRestore", () => {
  const entries = buildSelectionHistoryEntries({
    currentState: {},
    currentUrl: "https://example.test/cvpr-2026/",
    paperId,
    visibleCount: 90,
    scrollY: 1234.5,
  });

  it("returns the restore snapshot as-is when it fits the current catalog", () => {
    expect(readCatalogHistoryRestore(entries.currentState, 218)).toEqual({
      visibleCount: 90,
      scrollY: 1234.5,
      focusPaperId: paperId,
    });
  });

  it("bounds the restored reveal count to the current catalog size", () => {
    expect(readCatalogHistoryRestore(entries.currentState, 60)).toEqual({
      visibleCount: 60,
      scrollY: 1234.5,
      focusPaperId: paperId,
    });
  });

  it("preserves the visibleCount >= PAGE_SIZE invariant for a small or empty catalog", () => {
    expect(readCatalogHistoryRestore(entries.currentState, 12)).toEqual({
      visibleCount: 30,
      scrollY: 1234.5,
      focusPaperId: paperId,
    });
    expect(readCatalogHistoryRestore(entries.currentState, 0)).toEqual({
      visibleCount: 30,
      scrollY: 1234.5,
      focusPaperId: paperId,
    });
  });

  it.each([
    null,
    {},
    { version: 2, visibleCount: 90, scrollY: 1, focusPaperId: paperId },
    { version: 1, visibleCount: 29, scrollY: 1, focusPaperId: paperId },
    { version: 1, visibleCount: 90.5, scrollY: 1, focusPaperId: paperId },
    { version: 1, visibleCount: 90, scrollY: -1, focusPaperId: paperId },
    { version: 1, visibleCount: 90, scrollY: 1, focusPaperId: "not-an-id" },
  ])("fails closed (returns null) on a malformed restore snapshot: %j", (badRestore) => {
    expect(readCatalogHistoryRestore({ paperpilotCatalogRestore: badRestore }, 218)).toBeNull();
  });
});

describe("shouldFocusSelectedPaperAfterPopstate", () => {
  it("focuses on Forward from an unselected list into a selection", () => {
    expect(shouldFocusSelectedPaperAfterPopstate(null, paperId)).toBe(true);
  });
  it("does not steal focus on a selected-to-selected transition", () => {
    expect(shouldFocusSelectedPaperAfterPopstate("b".repeat(40), paperId)).toBe(false);
  });
  it("does not focus on ordinary list restoration (nothing selected either side)", () => {
    expect(shouldFocusSelectedPaperAfterPopstate(null, null)).toBe(false);
  });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../../../docs/assets/app.js");
const corePath = resolve(here, "../../../docs/assets/catalog-core.js");

await import(`${pathToFileURL(corePath).href}?contract=catalog-history-v1`);
globalThis.__PAPERPILOT_CATALOG_HISTORY_TEST__ = true;
globalThis.window = {
  location: {
    href: "https://example.test/cvpr-2026/?q=vision&type=Oral&tags=3D&sort=title",
    pathname: "/cvpr-2026/",
    search: "?q=vision&type=Oral&tags=3D&sort=title",
  },
  PP: { escapeHtml: String },
  PaperPilotLineageCore: {},
  PaperPilotCatalogCore: globalThis.PaperPilotCatalogCore,
};
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
};

await import(`${pathToFileURL(appPath).href}?contract=catalog-history-v1`);
const historyCore = globalThis.__test;
assert.ok(historyCore, "app.js must expose its pure history helpers in explicit test mode");

const paperId = "a".repeat(40);
const entries = historyCore.buildSelectionHistoryEntries({
  currentState: { unrelatedOwner: "preserved" },
  currentUrl: window.location.href,
  paperId,
  visibleCount: 90,
  scrollY: 1234.5,
});

assert.equal(entries.currentState.unrelatedOwner, "preserved");
assert.equal(entries.currentState.paperpilotCatalogRestore.version, 1);
assert.equal(entries.currentState.paperpilotCatalogRestore.visibleCount, 90);
assert.equal(entries.currentState.paperpilotCatalogRestore.scrollY, 1234.5);
assert.equal(entries.currentState.paperpilotCatalogRestore.focusPaperId, paperId);
assert.deepEqual(
  entries.selectedState.paperpilotCatalogRestore,
  entries.currentState.paperpilotCatalogRestore,
  "Back and Forward entries carry the same list restoration snapshot",
);
assert.equal(entries.selectedState.paperpilotPaperSelection, true);

const selectedUrl = new URL(entries.selectedUrl);
assert.equal(selectedUrl.searchParams.get("paper"), paperId);
assert.equal(selectedUrl.searchParams.get("q"), "vision");
assert.equal(selectedUrl.searchParams.get("type"), "Oral");
assert.equal(selectedUrl.searchParams.get("tags"), "3D");
assert.equal(selectedUrl.searchParams.get("sort"), "title");

assert.deepEqual(
  historyCore.readCatalogHistoryRestore(entries.currentState, 218),
  { visibleCount: 90, scrollY: 1234.5, focusPaperId: paperId },
);
assert.deepEqual(
  historyCore.readCatalogHistoryRestore(entries.currentState, 60),
  { visibleCount: 60, scrollY: 1234.5, focusPaperId: paperId },
  "restored reveal count is bounded by the current catalog",
);
assert.deepEqual(
  historyCore.readCatalogHistoryRestore(entries.currentState, 12),
  { visibleCount: 30, scrollY: 1234.5, focusPaperId: paperId },
  "a small catalog preserves the visibleCount >= PAGE_SIZE state invariant",
);
assert.deepEqual(
  historyCore.readCatalogHistoryRestore(entries.currentState, 0),
  { visibleCount: 30, scrollY: 1234.5, focusPaperId: paperId },
  "an empty catalog also preserves the visibleCount invariant",
);

for (const badRestore of [
  null,
  {},
  { version: 2, visibleCount: 90, scrollY: 1, focusPaperId: paperId },
  { version: 1, visibleCount: 29, scrollY: 1, focusPaperId: paperId },
  { version: 1, visibleCount: 90.5, scrollY: 1, focusPaperId: paperId },
  { version: 1, visibleCount: 90, scrollY: -1, focusPaperId: paperId },
  { version: 1, visibleCount: 90, scrollY: 1, focusPaperId: "not-an-id" },
]) {
  assert.equal(
    historyCore.readCatalogHistoryRestore({ paperpilotCatalogRestore: badRestore }, 218),
    null,
  );
}

assert.equal(
  historyCore.shouldFocusSelectedPaperAfterPopstate(null, paperId),
  true,
  "Forward from an unselected list focuses the regenerated selected heading",
);
assert.equal(
  historyCore.shouldFocusSelectedPaperAfterPopstate("b".repeat(40), paperId),
  false,
  "selected-to-selected history navigation does not steal focus",
);
assert.equal(
  historyCore.shouldFocusSelectedPaperAfterPopstate(null, null),
  false,
  "ordinary list restoration keeps its existing restoration focus path",
);

const appSource = await readFile(appPath, "utf8");
assert.match(
  appSource,
  /window\.history\.replaceState\(\s*historyEntries\.currentState/,
  "selection writes restoration data to the list entry before pushState",
);
assert.match(
  appSource,
  /window\.history\.pushState\(\s*historyEntries\.selectedState/,
  "selection writes restoration data to the selected entry",
);
assert.match(
  appSource,
  /const historyRestore = readCatalogHistoryRestore\(event\.state/,
  "popstate restores from the destination history entry",
);
assert.doesNotMatch(
  appSource,
  /popstate[\s\S]{0,600}state\.visibleCount = PAGE_SIZE/,
  "popstate must not unconditionally discard progressive reveal state",
);
assert.match(
  appSource,
  /focusAfterSelectionClosed\(paperId\)/,
  "direct close moves focus after replacing the selected-card DOM",
);
assert.match(
  appSource,
  /placeSelectedPaper\(\{[\s\S]{0,160}shouldFocusSelectedPaperAfterPopstate\(previousPaperId, state\.selectedPaperId\)/,
  "popstate applies the Forward-only focus decision after regenerating the list DOM",
);

console.log("catalog history contract passed");

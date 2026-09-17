import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../../../docs/assets/app.js");
const catalogCorePath = resolve(here, "../../../docs/assets/catalog-core.js");
const paperId = "1".repeat(40);
const otherPaperId = "2".repeat(40);

await import(`${pathToFileURL(catalogCorePath).href}?pilot-lineage`);
globalThis.__PAPERPILOT_CATALOG_HISTORY_TEST__ = true;
globalThis.window = {
  location: { href: "https://example.test/synthetic-pilot/", pathname: "/synthetic-pilot/", search: "" },
  PP: { escapeHtml: String },
  PaperPilotLineageCore: {},
  PaperPilotLineageV2: {
    parsePilotIndex: (value) => value?.schema_version === "lineage-pilot-index-v1" ? value : null,
    resolvePilotEntry: (index, id) => index.entries.find((entry) => entry.paper_id === id) || null,
  },
  PaperPilotCatalogCore: globalThis.PaperPilotCatalogCore,
};
globalThis.document = { getElementById: () => null, querySelector: () => null };
globalThis.CSS = { escape: String };

await import(`${pathToFileURL(appPath).href}?pilot-lineage`);
const app = globalThis.__test;
const index = {
  schema_version: "lineage-pilot-index-v1",
  entries: [{ paper_id: paperId, conference: "synthetic-pilot" }],
};

assert.equal(app.resolvePilotLineageForSelection(index, paperId, "synthetic-pilot"), index.entries[0]);
assert.equal(app.resolvePilotLineageForSelection(index, paperId, "wrong-conference"), null);
assert.equal(app.resolvePilotLineageForSelection(index, otherPaperId, "synthetic-pilot"), null);

app.catalogState.pilotLineageByPaperId.set(paperId, { status: "ready", paperId });
assert.match(app.renderPilotLineageSection({ paper_id: paperId }), new RegExp(`lineage/\\?paper=${paperId}`));
assert.doesNotMatch(app.renderPilotLineageSection({ paper_id: otherPaperId }), /<a /, "a stale entry cannot create the next card's link");

let cleared = false;
const owner = app.createPilotLineageLookupOwner(paperId, {
  setTimer: () => 7,
  clearTimer: () => { cleared = true; },
});
app.catalogState.pilotLineageLookupOwner = owner;
app.catalogState.pilotLineageByPaperId.set(paperId, { status: "loading", paperId });
app.abandonPilotLineageLookup(paperId);
assert.equal(owner.controller.signal.aborted, true);
assert.equal(owner.isActive(), false);
assert.equal(cleared, true);
assert.equal(app.catalogState.pilotLineageByPaperId.has(paperId), false, "unselect removes an unresolved lookup");

let timeoutCallback = null;
app.catalogState.paperById.set(otherPaperId, { paper_id: otherPaperId });
app.catalogState.selectedPaperId = otherPaperId;
globalThis.fetch = () => new Promise(() => {});
app.startPilotLineageLookup(otherPaperId, {
  setTimer: (callback) => { timeoutCallback = callback; return 9; },
  clearTimer() {},
});
assert.equal(app.catalogState.pilotLineageByPaperId.get(otherPaperId).status, "loading");
timeoutCallback();
assert.equal(app.catalogState.pilotLineageLookupOwner, null, "deadline releases the active owner");
assert.equal(app.catalogState.pilotLineageByPaperId.get(otherPaperId).status, "unavailable", "deadline cannot leave the selected card loading forever");

console.log("catalog pilot lineage contract passed");

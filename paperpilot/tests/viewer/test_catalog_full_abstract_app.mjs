import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corePath = resolve(here, "../../../docs/assets/catalog-core.js");
const appPath = resolve(here, "../../../docs/assets/app.js");
await import(`${pathToFileURL(corePath).href}?contract=catalog-abstract-app-v1`);

const paperId = "b".repeat(40);
let activeElement = null;
let listReplacements = 0;
const fetches = [];

function createNode(tagName, id = "") {
  const node = {
    attributes: new Map(),
    children: [],
    className: "",
    id,
    isConnected: true,
    tagName: tagName.toUpperCase(),
    textContent: "",
    classList: {
      add: (...tokens) => {
        node.className = [...new Set(`${node.className} ${tokens.join(" ")}`.trim().split(/\s+/))]
          .filter(Boolean)
          .join(" ");
      },
    },
    replaceChildren: (...children) => {
      for (const child of node.children) child.isConnected = false;
      node.children = children;
      for (const child of children) child.isConnected = true;
    },
    setAttribute: (name, value) => node.attributes.set(name, String(value)),
  };
  return node;
}

const list = {
  _innerHTML: "",
  get innerHTML() { return this._innerHTML; },
  set innerHTML(value) {
    listReplacements += 1;
    this._innerHTML = value;
  },
};
const detailBody = createNode("div");
const noIdCloseControl = createNode("button");
activeElement = noIdCloseControl;

globalThis.__PAPERPILOT_CATALOG_HISTORY_TEST__ = true;
globalThis.CSS = { escape: String };
globalThis.fetch = (_url, options) => new Promise((resolveFetch, rejectFetch) => {
  fetches.push({ options, rejectFetch, resolveFetch });
});
globalThis.window = {
  location: {
    href: "https://example.test/cvpr-2026/",
    origin: "https://example.test",
    pathname: "/cvpr-2026/",
    search: "",
  },
  PP: { escapeHtml: String },
  PaperPilotLineageCore: {},
  PaperPilotCatalogCore: globalThis.PaperPilotCatalogCore,
};
globalThis.document = {
  get activeElement() { return activeElement; },
  createElement: (tagName) => createNode(tagName),
  getElementById: (id) => id === "paper-list" ? list : id === "results-meta" ? { innerHTML: "" } : null,
  querySelector: (selector) => selector.includes(".paper__detail-body") ? detailBody : null,
};

await import(`${pathToFileURL(appPath).href}?contract=catalog-abstract-app-v1`);
const app = globalThis.__test;
const paper = {
  abstract: "Short preview text.",
  arxiv_url: "https://arxiv.org/abs/1234.5678",
  authors: ["Ada Lovelace"],
  paper_id: paperId,
  pdf_url: "https://arxiv.org/pdf/1234.5678",
  tags: ["Vision"],
  title: "Async abstract lifecycle",
  type: "Poster",
};
app.catalogState.papers = [paper];
app.catalogState.paperById = new Map([[paperId, paper]]);
app.catalogState.selectedPaperId = paperId;

const settle = () => new Promise((resolveTick) => setImmediate(resolveTick));
const shard = (text) => ({
  schema_version: "paper-details-v1",
  prefix: paperId.slice(0, 2),
  papers: [[paperId, text]],
});
const response = (text) => ({ ok: true, json: async () => shard(text) });

app.startFullAbstractLoad(paperId);
assert.equal(fetches.length, 1);
assert.equal(fetches[0].options.cache, "no-cache");
assert.equal(fetches[0].options.signal.aborted, false, "detail fetch receives a live AbortSignal");
assert.equal(app.catalogState.fullAbstractById.get(paperId).status, "loading");

app.abortFullAbstractLoad(paperId);
assert.equal(fetches[0].options.signal.aborted, true, "abandoned detail work is aborted");
assert.equal(app.catalogState.fullAbstractById.has(paperId), false, "aborted loading state is not cached");

// Model a transport that resolves after cancellation: ownership checks must
// prevent the stale result from winning the next selection's race.
fetches[0].resolveFetch(response("stale full abstract"));
await settle();
assert.equal(app.catalogState.fullAbstractById.has(paperId), false);

app.startFullAbstractLoad(paperId);
assert.equal(fetches.length, 2, "an abandoned request is retryable");
fetches[1].resolveFetch(response("fresh <em>full</em> abstract"));
await settle();
assert.deepEqual(app.catalogState.fullAbstractById.get(paperId), {
  status: "ready",
  text: "fresh <em>full</em> abstract",
});
assert.equal(detailBody.children.length, 1);
assert.equal(detailBody.children[0].tagName, "P");
assert.equal(detailBody.children[0].textContent, "fresh <em>full</em> abstract");
assert.equal(detailBody.children[0].children.length, 0, "detail text is not parsed as HTML");
assert.equal(listReplacements, 0, "detail completion does not replace the paper list");
assert.equal(activeElement, noIdCloseControl, "completion preserves a focused no-id control");
assert.equal(noIdCloseControl.isConnected, true);

const completedFetch = fetches[1];
app.startFullAbstractLoad(paperId);
assert.equal(fetches[1], completedFetch, "successful detail data remains cached");
assert.equal(fetches.length, 2);

const appSource = await readFile(appPath, "utf8");
assert.match(
  appSource,
  /function closeSelectedPaper\(\)[\s\S]{0,180}abortFullAbstractLoad\(paperId\)/,
  "closing a selected card aborts its detail request",
);
assert.match(
  appSource,
  /state\.selectedPaperId !== paperId[\s\S]{0,100}abortFullAbstractLoad\(state\.selectedPaperId\)/,
  "changing directly to another card aborts its abandoned detail request",
);
assert.match(
  appSource,
  /previousPaperId !== state\.selectedPaperId[\s\S]{0,100}abortFullAbstractLoad\(previousPaperId\)/,
  "history navigation aborts its abandoned detail request",
);

console.log("catalog full-abstract cancellation, race, and focus contract passed");

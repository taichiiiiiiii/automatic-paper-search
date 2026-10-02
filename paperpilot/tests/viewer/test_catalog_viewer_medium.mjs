import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corePath = resolve(here, "../../../docs/assets/catalog-core.js");
const appPath = resolve(here, "../../../docs/assets/app.js");
await import(`${pathToFileURL(corePath).href}?contract=catalog-viewer-medium-v1`);

const PAPERS = "papers.json";
const paperId = "c".repeat(40);

// Registrations are kept per type in an array: a Map keyed by type would
// overwrite a second binding of the same event, and a handler or an injected
// control bound twice is exactly what these checks must catch.
function createListeners() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) {
      const handlers = listeners.get(type);
      if (handlers) handlers.push(listener);
      else listeners.set(type, [listener]);
    },
  };
}
const handlersFor = (node, type) => node.listeners.get(type) ?? [];

function createNode(tagName, id = "") {
  const attributes = new Map();
  const node = {
    ...createListeners(),
    attributes,
    children: [],
    className: "",
    dataset: {},
    id,
    innerHTML: "",
    isConnected: true,
    tagName: tagName.toUpperCase(),
    textContent: "",
    classList: {
      add: (...tokens) => {
        node.className = [...new Set(`${node.className} ${tokens.join(" ")}`.trim().split(/\s+/))]
          .filter(Boolean)
          .join(" ");
      },
      toggle: () => false,
    },
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    querySelector: () => null,
    replaceChildren: (...children) => {
      for (const child of node.children) child.isConnected = false;
      node.children = children;
      for (const child of children) child.isConnected = true;
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
  };
  return node;
}

const listWrites = [];
// The list is a string sink in this harness, so querySelector can only answer
// for the one node the failure row hands focus to.
const retryButton = createNode("button", "catalog-retry");
retryButton.focusCalls = [];
retryButton.focus = (options) => retryButton.focusCalls.push(options);
const list = {
  ...createListeners(),
  _innerHTML: "",
  querySelector: (selector) => (selector === "#catalog-retry" ? retryButton : null),
  get innerHTML() { return this._innerHTML; },
  set innerHTML(value) {
    listWrites.push(value);
    this._innerHTML = value;
    // Writing the list's markup throws the rows away, so the one node
    // querySelector keeps handing back stands in for a freshly built 再試行:
    // the real button carries no disabled state into the next row.
    retryButton.disabled = false;
  },
};
const resultsMeta = { textContent: "" };
const newestOption = { disabled: false, textContent: "新着順" };
const sortSelect = {
  ...createListeners(),
  value: "default",
  querySelector: (selector) => (selector === 'option[value="newest"]' ? newestOption : null),
};
const searchInput = createNode("input", "search");
const typeChips = createNode("div", "type-chips");
const tagChips = createNode("div", "tag-chips");
const resultsClear = createNode("button", "results-clear");
const bodyChildren = [];
const detailBody = createNode("div");
const replaceStateCalls = [];
const fetches = [];

// Same escaping contract as docs/assets/utils.js — an identity stub could not
// tell escaped shard text from injected markup.
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[c]));

globalThis.__PAPERPILOT_CATALOG_HISTORY_TEST__ = true;
globalThis.CSS = { escape: String };
globalThis.history = {
  state: null,
  replaceState(_state, _title, url) { replaceStateCalls.push(String(url)); },
};
globalThis.fetch = (url, options) => new Promise((resolveFetch, rejectFetch) => {
  fetches.push({ options, rejectFetch, resolveFetch, url });
});
globalThis.window = {
  addEventListener() {},
  location: {
    href: "https://example.test/iclr-2026/?sort=newest",
    origin: "https://example.test",
    pathname: "/iclr-2026/",
    search: "?sort=newest",
  },
  PP: { escapeHtml },
  PaperPilotLineageCore: {},
  PaperPilotCatalogCore: globalThis.PaperPilotCatalogCore,
  history: globalThis.history,
};
globalThis.document = {
  ...createListeners(),
  activeElement: null,
  body: { children: bodyChildren, appendChild(child) { bodyChildren.push(child); } },
  createElement: (tagName) => createNode(tagName),
  getElementById: (id) => (id === "paper-list" ? list
    : id === "results-meta" ? resultsMeta
    : id === "sort" ? sortSelect
    : id === "search" ? searchInput
    : id === "type-chips" ? typeChips
    : id === "tag-chips" ? tagChips
    : id === "results-clear" ? resultsClear
    : null),
  querySelector: (selector) => (selector.includes(".paper__detail-body") ? detailBody : null),
};

await import(`${pathToFileURL(appPath).href}?contract=catalog-viewer-medium-v1`);
const app = globalThis.__test;
const state = app.catalogState;
const settle = () => new Promise((resolveTick) => setImmediate(resolveTick));
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await settle();
};
const papersFetches = () => fetches.filter((call) => call.url === PAPERS);

// --- 1. 「新着順」 sorts on arXiv ids and never pretends about the rest ----
const row = (key, arxivId) => {
  const paper = {
    arxiv_url: "",
    authors: [],
    paper_id: key.repeat(40),
    abstract: "preview",
    tags: [],
    title: `row ${key}`,
    type: "Poster",
  };
  if (arxivId !== null) paper.arxiv_id = arxivId;
  return paper;
};
const mixed = [
  row("1", "2506.00101"),
  row("2", ""),
  row("3", "2505.99999"),
  row("4", null),
  row("5", "2506.00102"),
];

state.sort = "newest";
assert.deepEqual(
  app.getSorted(mixed).map((p) => p.title),
  ["row 5", "row 1", "row 3", "row 2", "row 4"],
  "dated rows come first in descending order; undated rows keep collection order",
);

const undated = [row("a", ""), row("b", null), row("c", "")];
state.papers = undated;
state.sort = "newest";
app.applySortAvailability();
assert.equal(newestOption.disabled, true, "no loaded arXiv id disables the option");
assert.equal(newestOption.textContent, "新着順（arXiv ID がない学会では使えません）");
assert.equal(state.sort, "default", "an unusable sort falls back to the default");
assert.equal(replaceStateCalls.length, 1, "the fallback rewrites the URL state");
assert.equal(new URL(replaceStateCalls[0]).searchParams.has("sort"), false);
assert.deepEqual(
  app.getSorted(state.papers).map((p) => p.title),
  ["row a", "row b", "row c"],
  "the default order is kept",
);
state.sort = "newest";
assert.deepEqual(
  app.getSorted(undated).map((p) => p.title),
  ["row a", "row b", "row c"],
  "even a stale newest selection leaves an all-undated catalog in collection order",
);
state.sort = "default";
state.papers = [...undated, row("d", "2506.00001")];
app.applySortAvailability();
assert.equal(newestOption.disabled, false, "a single arXiv id re-enables the option");
assert.equal(newestOption.textContent, "新着順");
assert.equal(replaceStateCalls.length, 1, "an available sort does not rewrite the URL");

// --- 2. the async full abstract keeps highlighting, shown whole -----------
const preview = "word ".repeat(64); // the 320-char stored preview
assert.equal(preview.length, 320);
// The match sits 335 chars in, past the 320-char preview, so only the loaded
// full text can contain it.
const tail = `and the hidden zygote <b>marker</b> ${"tail ".repeat(40)}`;
const fullAbstract = `${preview}${tail}`;
const shardResponse = {
  ok: true,
  json: async () => ({
    schema_version: "paper-details-v1",
    prefix: paperId.slice(0, 2),
    papers: [[paperId, fullAbstract]],
  }),
};
const loaded = row("c", "2506.00002");
loaded.title = "Async full abstract";
state.papers = [loaded];
state.paperById = new Map([[paperId, loaded]]);
state.selectedPaperId = paperId;
state.search = "zygote";
state.sort = "default";

app.startFullAbstractLoad(paperId);
const shardFetch = fetches[fetches.length - 1];
shardFetch.resolveFetch(shardResponse);
await settle();

const [abstractNode, ...rest] = detailBody.children;
assert.equal(abstractNode.tagName, "P");
assert.equal(abstractNode.id, `abstract-${paperId}`);
// The selected card is never clamped (same as the first paint), so the loaded
// full abstract carries no "続きを読む" toggle.
assert.equal(abstractNode.className, "paper__abstract is-full");
assert.ok(
  rest.every((node) => node.tagName !== "BUTTON"),
  "the selected card's full abstract is not clamped behind a toggle",
);
assert.match(
  abstractNode.innerHTML,
  /<mark class="hl">zygote<\/mark>/,
  "the query is highlighted in the async-loaded full abstract",
);
assert.ok(
  abstractNode.innerHTML.includes("&lt;b&gt;marker&lt;/b&gt;"),
  "shard text is escaped before it reaches markup",
);
assert.ok(!abstractNode.innerHTML.includes("<b>"), "no raw shard tag is injected");
assert.ok(
  abstractNode.innerHTML.startsWith("word word") && !abstractNode.innerHTML.includes("…"),
  "the loaded full abstract is shown whole, not windowed to the match",
);

// Both render paths must keep going through that one builder — the async
// update used to be a separate, highlight-free implementation.
const appSource = await readFile(appPath, "utf8");
assert.match(
  appSource,
  /function renderPaper\([\s\S]{0,2500}?buildAbstractDek\(/,
  "the first paint builds the dek through the shared builder",
);
assert.match(
  appSource,
  /function updateFullAbstractSection\([\s\S]{0,1200}?buildAbstractDek\(/,
  "the async full-abstract update builds the same dek",
);

// --- 3. a failed catalog load is a way forward, not a dead end ------------
state.selectedPaperId = null;
const loading = app.init();
await settle();
assert.equal(papersFetches().length, 1);
for (const call of fetches) call.rejectFetch(new Error("offline"));
await loading;
await flush();

const failure = listWrites[listWrites.length - 1];
assert.ok(failure, "the list is rendered on failure");
assert.match(failure, /論文一覧を読み込めませんでした。/);
assert.match(failure, /<button[^>]*id="catalog-retry"[^>]*>再試行<\/button>/);
assert.match(failure, /href="paper-links\.html"/);
assert.match(failure, /JavaScript なしの論文リンク一覧/);
assert.doesNotMatch(failure, /failed to load/i);
assert.match(resultsMeta.textContent, /論文一覧を読み込めませんでした。/);

const retryHandler = handlersFor(list, "click")[0];
assert.ok(retryHandler, "the failure row wires a retry");
assert.equal(retryButton.focusCalls.length, 0, "the first failure leaves focus alone");

// The reader activates 再試行 with the keyboard, so focus must survive the
// row's own re-render; the load must not be re-entered while it runs.
globalThis.document.activeElement = retryButton;
const retryEvent = () => ({
  target: { closest: (selector) => (selector === "#catalog-retry" ? retryButton : null) },
});
const beforeRetry = fetches.length;
retryHandler(retryEvent());
assert.equal(retryButton.disabled, true, "the button is disabled while the retry loads");
retryHandler(retryEvent());
await flush();
assert.equal(papersFetches().length, 2, "retrying re-runs the load exactly once");

for (const call of fetches.slice(beforeRetry)) call.rejectFetch(new Error("offline"));
await flush();
assert.equal(listWrites.length, 2, "the retry renders the failure row again");
assert.equal(handlersFor(list, "click").length, 1, "the retry handler is bound once, not per failure");
assert.equal(retryButton.focusCalls.length, 1, "the re-rendered row takes focus back to 再試行");
assert.deepEqual(retryButton.focusCalls[0], { preventScroll: true }, "the handoff never scrolls");
assert.doesNotMatch(listWrites[1], /disabled/, "the fresh row offers an enabled retry");
assert.equal(retryButton.disabled, false, "the re-created 再試行 is enabled again");

// --- 4. a retry that lands must not bind the catalog controls twice --------
globalThis.document.activeElement = null;
// The focus claim was spent by the handoff above, so a retry nobody was
// standing on must leave the focus where it is.
retryHandler(retryEvent());
await settle();
for (const call of fetches.slice(-2)) call.rejectFetch(new Error("offline"));
await flush();
assert.equal(retryButton.focusCalls.length, 1, "an unfocused retry does not move focus");

// A published-but-empty papers.json parses and validates; for the reader it is
// still a load that brought nothing, so it takes the same way forward.
const emptyRound = fetches.length;
retryHandler(retryEvent());
await settle();
for (const call of fetches.slice(emptyRound)) {
  if (call.url === PAPERS) call.resolveFetch({ ok: true, json: async () => [] });
  else call.rejectFetch(new Error("no quality manifest"));
}
await flush();
assert.match(listWrites[listWrites.length - 1], /id="catalog-retry"/, "an empty catalog renders the failure row");
assert.match(listWrites[listWrites.length - 1], /論文一覧を読み込めませんでした。/);

// A successful load reaches the optional lineage gate; keep it closed so this
// fixture only has to answer the papers fetch.
globalThis.window.PaperPilotLineageCore.qualityRowIsEligible = () => false;
const recovered = [row("d", "2506.00004"), row("e", "2506.00005")];
const answerPendingFetches = () => {
  for (const call of fetches) {
    if (call.url === PAPERS) call.resolveFetch({ ok: true, json: async () => recovered });
    else call.rejectFetch(new Error("no quality manifest"));
  }
};

const beforeSuccess = papersFetches().length;
const beforeSuccessWrites = listWrites.length;
retryHandler(retryEvent());
await settle();
answerPendingFetches();
await flush();
assert.equal(papersFetches().length, beforeSuccess + 1, "the retry ran one load");
assert.equal(listWrites.length, beforeSuccessWrites + 1, "the catalog replaces the failure row");
assert.match(listWrites[listWrites.length - 1], /<li class="paper/, "paper rows are rendered");
assert.doesNotMatch(listWrites[listWrites.length - 1], /catalog-retry/, "the retry row is gone");
assert.match(resultsMeta.innerHTML, /2 \/ 2 件/, "the aria-live counter is restored");

// init() re-enters with the controls already live, so every binding and every
// injected node has to stay singular across loads.
const reentered = app.init();
await settle();
answerPendingFetches();
await reentered;
await flush();
assert.equal(
  handlersFor(list, "click").filter((handler) => handler === retryHandler).length,
  1,
  "the retry handler is not bound a second time",
);
assert.equal(handlersFor(list, "click").length, 2, "the retry handler plus one row delegation");
assert.equal(handlersFor(searchInput, "input").length, 1, "the search input is wired once");
assert.equal(handlersFor(sortSelect, "change").length, 1, "the sort select is wired once");
assert.equal(
  handlersFor(globalThis.document, "visibilitychange").length,
  1,
  "bindEvents is wired once, not per load",
);
assert.equal(
  bodyChildren.filter((node) => node.id === "back-to-top").length,
  1,
  "#back-to-top is created once",
);

// --- 5. the first paint clamps previews and keeps entities whole ------------
const longPreview = "alpha ".repeat(40);
assert.equal(longPreview.length, 240);
const previewRow = row("d", "2506.00006");
previewRow.abstract = longPreview;
const selectedRow = row("c", "2506.00007");
selectedRow.abstract = longPreview;
state.papers = [previewRow, selectedRow];
state.paperById = new Map([[previewRow.paper_id, previewRow], [paperId, selectedRow]]);
state.selectedPaperId = paperId;
state.search = "";
// Both rows hold a loaded full abstract in the cache: only the selected one may
// show it, and only it may be marked is-full.
state.fullAbstractById = new Map([
  [paperId, { status: "ready", text: longPreview }],
  [previewRow.paper_id, { status: "ready", text: `${longPreview} only in the detail` }],
]);
const dekClass = (html) => /<p class="(paper__abstract[^"]*)"/.exec(html)[1];
const previewHtml = app.renderPaper(previewRow, 0);
const selectedHtml = app.renderPaper(selectedRow, 1);
assert.equal(dekClass(previewHtml), "paper__abstract is-clamped", "a long preview is clamped");
assert.match(
  previewHtml,
  /<button class="paper__expand-btn" type="button" aria-expanded="false" aria-controls="abstract\-/,
  "the clamp comes with a 続きを読む toggle",
);
assert.doesNotMatch(previewHtml, /is-full/, "a preview is never is-full, even with the text cached");
assert.equal(dekClass(selectedHtml), "paper__abstract is-full", "the selected card shows the full text");
assert.doesNotMatch(selectedHtml, /is-clamped|paper__expand-btn/, "the selected card is not clamped");

// Highlighting escaped text used to match the query "amp" inside the "&amp;"
// that "R&D" escaped into, cutting the entity in half.
const entityRow = row("b", "2506.00008");
entityRow.abstract = "R&D samples";
entityRow.title = "R&D samples";
state.search = "amp";
const entityHtml = app.renderPaper(entityRow, 0);
assert.ok(
  entityHtml.includes('R&amp;D s<mark class="hl">amp</mark>les'),
  "the escaped text survives and only the matched term is wrapped",
);
assert.doesNotMatch(entityHtml, /&<mark/, "no entity is split by a <mark>");

// --- 6. the match window is cut from the raw text ---------------------------
// The window index used to come from abstract.toLowerCase(), which is not
// length-preserving: the "İ" below becomes two code units, so every index after
// it is one too high for the raw string the window is sliced out of.
const windowRow = row("f", "2506.00009");
windowRow.abstract = `İ ${Array.from({ length: 40 }, (_, n) => `w${String(n).padStart(2, "0")}`).join(" ")}`;
const windowQuery = "w25";
assert.equal(windowRow.abstract.indexOf(windowQuery), 102, "the fixture puts the match 102 characters in");
assert.equal(
  windowRow.abstract.toLowerCase().indexOf(windowQuery),
  103,
  "the İ makes the lowercased index one past the place in the raw text",
);
state.search = windowQuery;
const windowHtml = app.renderPaper(windowRow, 0);
const windowDek = /<p class="paper__abstract[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(windowHtml)[1];
assert.ok(
  windowDek.startsWith('<span aria-hidden="true">… </span>w07'),
  `the window opens on the whole word a full 70 characters before the match, got ${windowDek.slice(0, 44)}`,
);
assert.match(
  windowDek,
  /<mark class="hl">w25<\/mark>/,
  "the match stays highlighted inside the windowed dek",
);

// --- 7. a stalled papers.json still hands back a live 再試行 ---------------
// An unbounded fetch held init() awaiting forever: the finally never ran, so
// catalogLoadInFlight stayed true and the disabled button was the last thing
// the reader ever got.
state.selectedPaperId = null;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const scheduled = [];
const cleared = [];
globalThis.setTimeout = (callback, delay) => {
  scheduled.push({ callback, delay });
  return scheduled.length;
};
globalThis.clearTimeout = (token) => {
  cleared.push(token);
};
try {
  let stalledLoadSettled = false;
  app.init().then(() => { stalledLoadSettled = true; });
  await settle();
  const stalled = papersFetches()[papersFetches().length - 1];
  assert.equal(scheduled.length, 1, "the papers fetch is armed with one deadline");
  assert.equal(scheduled[0].delay, 8_000, "the load reuses the shared lookup budget");
  assert.ok(stalled.options?.signal, "the deadline can cancel the request it guards");
  assert.equal(stalled.options.signal.aborted, false, "the deadline is not spent yet");
  const beforeStalledWrites = listWrites.length;

  scheduled[0].callback(); // the clock reaches the deadline; the answer never comes
  await flush();

  assert.equal(stalledLoadSettled, true, "init() returns even though the fetch never answered");
  assert.equal(stalled.options.signal.aborted, true, "the expired deadline cancels the stalled request");
  assert.equal(listWrites.length, beforeStalledWrites + 1, "the timeout renders the failure row");
  assert.match(listWrites[beforeStalledWrites], /論文一覧を読み込めませんでした。/);
  assert.match(listWrites[beforeStalledWrites], /id="catalog-retry"/);
  assert.equal(retryButton.disabled, false, "the timeout hands back an enabled 再試行");
  assert.equal(cleared.length, 1, "the spent deadline is cleared");

  // catalogLoadInFlight was released by the same rejection, so the reader's
  // next click is a new load instead of a dead button.
  const fetchesBefore = fetches.length;
  const papersBefore = papersFetches().length;
  retryHandler(retryEvent());
  await settle();
  assert.equal(papersFetches().length, papersBefore + 1, "the next 再試行 starts a new fetch");

  // A load that lands on its own must not leave its deadline armed: a late
  // abort would reject a request nothing is watching any more.
  for (const call of fetches.slice(fetchesBefore)) {
    if (call.url === PAPERS) call.resolveFetch({ ok: true, json: async () => recovered });
    else call.rejectFetch(new Error("no quality manifest"));
  }
  await flush();
  assert.match(listWrites[listWrites.length - 1], /<li class="paper/, "the retry after a timeout can still load");
  assert.equal(cleared.length, 2, "a load that lands clears its deadline");
} finally {
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
}

console.log("catalog viewer medium contract passed: newest sort, async dek, load failure, retry re-entry, first paint, window index, stalled load");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corePath = resolve(here, "../../../docs/assets/catalog-core.js");
const appPath = resolve(here, "../../../docs/assets/app.js");
await import(`${pathToFileURL(corePath).href}?contract=catalog-slide-app-v1`);

const paperId = "a".repeat(40);
let activeElement = null;
let listReplacements = 0;
let loadStarts = 0;
let pendingLoad = null;
let rejectOnAbort = true;
const focused = [];
const connectedCardNodes = new Set();

function makeFakeTimers() {
  const scheduled = [];
  const cleared = [];
  return {
    cleared,
    scheduled,
    helpers: {
      setTimer(callback, delay) {
        const token = { callback, delay };
        scheduled.push(token);
        return token;
      },
      clearTimer(token) {
        cleared.push(token);
      },
    },
  };
}

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
    focus: () => {
      activeElement = node;
      focused.push(node);
    },
    replaceChildren: (...children) => {
      for (const child of node.children) child.isConnected = false;
      node.children = children;
      for (const child of children) child.isConnected = true;
    },
    setAttribute: (name, value) => {
      node.attributes.set(name, String(value));
    },
  };
  return node;
}

const list = {
  _innerHTML: "",
  get innerHTML() { return this._innerHTML; },
  set innerHTML(value) {
    listReplacements += 1;
    for (const node of connectedCardNodes) node.isConnected = false;
    this._innerHTML = value;
  },
};
const resultsMeta = { innerHTML: "" };
const slideBody = createNode("div", `slides-body-${paperId}`);
const slideHeading = createNode("h3", `slides-heading-${paperId}`);
const paperHeading = createNode("h2", `paper-heading-${paperId}`);

const fakeCore = {
  ...globalThis.PaperPilotCatalogCore,
  loadPublicSlideState: (_paperId, { signal }) => new Promise((resolveLoad, rejectLoad) => {
    loadStarts += 1;
    const rejectsThisAbort = rejectOnAbort;
    pendingLoad = { rejectLoad, resolveLoad, signal };
    signal.addEventListener("abort", () => {
      if (rejectsThisAbort) rejectLoad(new DOMException("abandoned", "AbortError"));
    }, { once: true });
  }),
};

globalThis.__PAPERPILOT_CATALOG_HISTORY_TEST__ = true;
globalThis.window = {
  location: {
    href: "https://example.test/cvpr-2026/",
    origin: "https://example.test",
    pathname: "/cvpr-2026/",
    search: "",
  },
  PP: { escapeHtml: String },
  PaperPilotLineageCore: {},
  PaperPilotCatalogCore: fakeCore,
};
globalThis.document = {
  get activeElement() { return activeElement; },
  createElement: (tagName) => createNode(tagName),
  getElementById: (id) => {
    if (id === "paper-list") return list;
    if (id === "results-meta") return resultsMeta;
    if (id === slideBody.id) return slideBody;
    if (id === slideHeading.id) return slideHeading;
    if (id === paperHeading.id) return paperHeading;
    return null;
  },
  querySelector: () => null,
};

await import(`${pathToFileURL(appPath).href}?contract=catalog-slide-app-v1`);
const app = globalThis.__test;
const paper = {
  abstract: "A compact abstract.",
  arxiv_url: "https://arxiv.org/abs/1234.5678",
  authors: ["Ada Lovelace"],
  paper_id: paperId,
  pdf_url: "https://arxiv.org/pdf/1234.5678",
  tags: ["Vision"],
  title: "Authenticated reviewed slides",
  type: "Poster",
};
app.catalogState.papers = [paper];
app.catalogState.paperById = new Map([[paperId, paper]]);
app.catalogState.selectedPaperId = paperId;

const abandonTimers = makeFakeTimers();
app.startPublicSlidesLoad(paperId, abandonTimers.helpers);
assert.equal(app.catalogState.publicSlidesByPaperId.get(paperId).status, "loading");
assert.equal(pendingLoad.signal.aborted, false);
app.abortPublicSlidesLoad(paperId);
await new Promise((resolveTick) => setImmediate(resolveTick));
assert.equal(pendingLoad.signal.aborted, true, "abandoned card loads receive an abort signal");
assert.deepEqual(
  abandonTimers.cleared,
  abandonTimers.scheduled,
  "abandonment clears its pending deadline",
);
assert.equal(
  app.catalogState.publicSlidesByPaperId.has(paperId),
  false,
  "AbortError is not cached as an unverified result",
);

const deadlineTimers = makeFakeTimers();
rejectOnAbort = false;
app.startPublicSlidesLoad(paperId, deadlineTimers.helpers);
rejectOnAbort = true;
const timedOutAttempt = pendingLoad;
assert.equal(deadlineTimers.scheduled.length, 1);
assert.equal(deadlineTimers.scheduled[0].delay, 8_000, "the lookup deadline is code-owned and fixed");
deadlineTimers.scheduled[0].callback();
assert.equal(timedOutAttempt.signal.aborted, true, "deadline aborts the owned lookup");
assert.equal(timedOutAttempt.signal.reason?.name, "TimeoutError");
assert.deepEqual(deadlineTimers.cleared, deadlineTimers.scheduled, "the fired deadline is cleared");
assert.deepEqual(
  app.catalogState.publicSlidesByPaperId.get(paperId),
  { status: "unverified", entry: null },
  "timeout becomes one visible unverified result",
);
assert.equal(slideBody.children.length, 1, "timeout replaces the loading status in place");
assert.match(slideBody.children[0].className, /--error/);
timedOutAttempt.resolveLoad({
  state: "published",
  entry: {
    coverage: "full_text",
    deck_path: "/automatic-paper-search/paper-slides-v1/decks/stale/",
  },
});
await new Promise((resolveTick) => setImmediate(resolveTick));
assert.deepEqual(
  app.catalogState.publicSlidesByPaperId.get(paperId),
  { status: "unverified", entry: null },
  "a stale successful completion cannot erase the timeout result",
);

app.startPublicSlidesLoad(paperId);
assert.notEqual(pendingLoad, timedOutAttempt, "a later explicit start retries a timeout");
app.abortPublicSlidesLoad(paperId);
await new Promise((resolveTick) => setImmediate(resolveTick));
assert.equal(
  app.catalogState.publicSlidesByPaperId.has(paperId),
  false,
  "abandoning a timeout retry remains uncached and clears loading UI state",
);

activeElement = paperHeading;
const successTimers = makeFakeTimers();
app.startPublicSlidesLoad(paperId, successTimers.helpers);
pendingLoad.resolveLoad({ state: "not_published", entry: null });
await new Promise((resolveTick) => setImmediate(resolveTick));
assert.deepEqual(successTimers.cleared, successTimers.scheduled, "success clears its deadline");
assert.deepEqual(
  focused,
  [slideHeading],
  "resolution moves focus from the initial paper heading to the slide-state heading",
);
assert.equal(slideBody.children.length, 1);
assert.equal(slideBody.children[0].attributes.get("role"), "status");
assert.match(
  app.renderPublicSlidesSection(paper),
  new RegExp(`slides-heading-${paperId}" tabindex="-1"`),
);
assert.equal(listReplacements, 0, "slide resolution does not replace the full paper list");
const notPublishedAttempt = pendingLoad;
app.startPublicSlidesLoad(paperId);
assert.equal(pendingLoad, notPublishedAttempt, "not_published remains stable across reselection");
assert.equal(loadStarts, 4);

app.catalogState.publicSlidesByPaperId.delete(paperId);
const closeButton = createNode("button");
closeButton.closest = () => ({ dataset: { paperId } });
connectedCardNodes.add(closeButton);
activeElement = closeButton;
const failureTimers = makeFakeTimers();
app.startPublicSlidesLoad(paperId, failureTimers.helpers);
pendingLoad.rejectLoad(new Error("public index unavailable"));
await new Promise((resolveTick) => setImmediate(resolveTick));
assert.deepEqual(failureTimers.cleared, failureTimers.scheduled, "failure clears its deadline");
assert.deepEqual(
  focused,
  [slideHeading],
  "async slide resolution does not move focus from a no-id card control",
);
assert.equal(activeElement, closeButton, "the actual focused control remains focused");
assert.equal(closeButton.isConnected, true, "the focused control remains connected to the card");
assert.equal(listReplacements, 0, "a moved focus target is not destroyed by full-list replacement");

const failedAttempt = pendingLoad;
app.startPublicSlidesLoad(paperId);
assert.notEqual(pendingLoad, failedAttempt, "an explicit later selection retries cached unverified state");
assert.equal(app.catalogState.publicSlidesByPaperId.get(paperId).status, "loading");
pendingLoad.resolveLoad({
  state: "published",
  entry: {
    coverage: "full_text",
    deck_path: "/automatic-paper-search/paper-slides-v1/decks/sd1-test/",
  },
});
await new Promise((resolveTick) => setImmediate(resolveTick));
assert.equal(loadStarts, 6, "retry occurs once per explicit start and does not auto-loop");
assert.equal(slideBody.children.length, 2);
assert.equal(slideBody.children[1].tagName, "A");
assert.equal(
  slideBody.children[1].attributes.get("href"),
  "/automatic-paper-search/paper-slides-v1/decks/sd1-test/",
);
assert.equal(activeElement, closeButton, "successful retry also leaves moved focus untouched");
assert.equal(listReplacements, 0);
const publishedAttempt = pendingLoad;
app.startPublicSlidesLoad(paperId);
assert.equal(pendingLoad, publishedAttempt, "published remains stable across reselection");
assert.equal(loadStarts, 6);

const appSource = await readFile(appPath, "utf8");
assert.match(
  appSource,
  /function closeSelectedPaper\(\)[\s\S]{0,180}abortPublicSlidesLoad\(paperId\)/,
  "closing a selected card aborts its slide lookup",
);
assert.match(
  appSource,
  /state\.selectedPaperId !== paperId[\s\S]{0,100}abortPublicSlidesLoad\(state\.selectedPaperId\)/,
  "changing directly to another card aborts the abandoned slide lookup",
);
assert.match(
  appSource,
  /previousPaperId !== state\.selectedPaperId[\s\S]{0,100}abortPublicSlidesLoad\(previousPaperId\)/,
  "history navigation aborts the abandoned slide lookup",
);

console.log("catalog public-slide app cancellation and focus contract passed");

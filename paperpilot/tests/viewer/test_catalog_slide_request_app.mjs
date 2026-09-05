import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corePath = resolve(here, "../../../docs/assets/catalog-core.js");
const appPath = resolve(here, "../../../docs/assets/app.js");
await import(`${pathToFileURL(corePath).href}?contract=slide-request-app-v1`);

const paperId = "a".repeat(40);
const requestId = `paper-slide-${"A".repeat(22)}`;
const statusCap = `psc_${"B".repeat(43)}`;
const deckId = `sd1-${"c".repeat(64)}`;
const deckPath = `/automatic-paper-search/paper-slides-v1/decks/${deckId}/${"d".repeat(64)}-${"e".repeat(64)}.html`;
const apiBase = "https://slides-api.example.test";
const storage = new Map();
const calls = [];
const pending = [];
let activeElement = null;
let hidden = false;
let verifiedEntry = null;
let verificationGate = null;
let verificationSignal = null;

function jsonResponse(value, status) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return {
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return "application/json; charset=utf-8";
        if (name.toLowerCase() === "content-length") return String(bytes.byteLength);
        return null;
      },
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

function deferredFetch(url, options) {
  return new Promise((resolveFetch, rejectFetch) => {
    const call = { url, options, resolveFetch, rejectFetch };
    calls.push(call);
    pending.push(call);
    options.signal?.addEventListener("abort", () => {
      rejectFetch(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

function createNode(tagName, id = "") {
  const listeners = new Map();
  const node = {
    attributes: new Map(),
    children: [],
    className: "",
    dataset: {},
    id,
    isConnected: false,
    open: false,
    returnValue: "",
    tagName: tagName.toUpperCase(),
    textContent: "",
    classList: {
      add(...tokens) { node.className = `${node.className} ${tokens.join(" ")}`.trim(); },
    },
    focus() { activeElement = node; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    append(...children) {
      node.children.push(...children);
      for (const child of children) child.isConnected = true;
    },
    appendChild(child) {
      node.children.push(child);
      child.isConnected = true;
      return child;
    },
    close(value = "") {
      node.returnValue = value;
      node.open = false;
      listeners.get("close")?.({ target: node });
    },
    emit(type, event = {}) { listeners.get(type)?.({ target: node, preventDefault() {}, ...event }); },
    replaceChildren(...children) { node.children = children; },
    setAttribute(name, value) { node.attributes.set(name, String(value)); },
    showModal() { node.open = true; },
  };
  return node;
}

const slideBody = createNode("div", `slides-body-${paperId}`);
const slideHeading = createNode("h3", `slides-heading-${paperId}`);
const list = { innerHTML: "" };
const resultsMeta = { innerHTML: "" };
const fakeCore = {
  ...globalThis.PaperPilotCatalogCore,
  PAPER_SLIDE_API_BASE: apiBase,
  async loadPublicSlideState(_paperId, options = {}) {
    verificationSignal = options.signal || null;
    if (verificationGate) return verificationGate.promise;
    return verifiedEntry
      ? { state: "published", entry: verifiedEntry }
      : { state: "not_published", entry: null };
  },
};

globalThis.__PAPERPILOT_CATALOG_HISTORY_TEST__ = true;
globalThis.fetch = deferredFetch;
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
  sessionStorage: {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, value); },
    removeItem(key) { storage.delete(key); },
  },
};
globalThis.document = {
  get activeElement() { return activeElement; },
  get hidden() { return hidden; },
  createElement: (tagName) => createNode(tagName),
  getElementById(id) {
    if (id === "paper-list") return list;
    if (id === "results-meta") return resultsMeta;
    if (id === slideBody.id) return slideBody;
    if (id === slideHeading.id) return slideHeading;
    return null;
  },
  querySelector: () => null,
  body: createNode("body"),
};

await import(`${pathToFileURL(appPath).href}?contract=slide-request-app-v1`);
const app = globalThis.__test;
const paper = {
  abstract: "A compact abstract.",
  arxiv_url: "https://arxiv.org/abs/1234.5678",
  authors: ["Ada Lovelace"],
  paper_id: paperId,
  pdf_url: "https://arxiv.org/pdf/1234.5678",
  tags: ["Vision"],
  title: "Capability-safe slide request",
  type: "Poster",
};
app.catalogState.papers = [paper];
app.catalogState.paperById = new Map([[paperId, paper]]);
app.catalogState.selectedPaperId = paperId;
app.catalogState.publicSlidesByPaperId.set(paperId, { status: "not_published", entry: null });

const requestMarkup = app.renderPublicSlidesSection(paper);
assert.match(requestMarkup, /data-request-slides=/);
assert.doesNotMatch(requestMarkup, /status_cap|request_id|paper-slide-/);

const trigger = createNode("button");
trigger.isConnected = true;
assert.equal(app.openPaperSlideConfirmation(paperId, trigger), true);
const dialog = globalThis.document.body.children[0];
assert.equal(dialog.tagName, "DIALOG");
assert.equal(dialog.attributes.get("aria-labelledby"), "paper-slide-dialog-title");
assert.equal(dialog.attributes.get("aria-describedby"), "paper-slide-dialog-description");
assert.equal(activeElement.textContent, "キャンセル", "Cancel receives initial focus");
const confirmationCopy = dialog.children[1].children.map((node) => node.textContent).join("\n");
assert.match(confirmationCopy, /自動判定/);
assert.match(confirmationCopy, /機械生成/);
assert.match(confirmationCopy, /レビューが完了するまで公開されません/);
assert.match(confirmationCopy, /数分〜十数分/);
assert.match(confirmationCopy, /費用カテゴリ/);
let prevented = false;
dialog.emit("cancel", { preventDefault() { prevented = true; } });
assert.equal(prevented, true, "Escape is handled as an explicit cancel");
assert.equal(activeElement, trigger, "Escape restores the request trigger focus");
assert.equal(app.openPaperSlideConfirmation(paperId, trigger), true);
dialog.emit("click", { target: dialog });
assert.equal(activeElement, trigger, "backdrop cancel restores the request trigger focus");
assert.equal(app.openPaperSlideConfirmation(paperId, trigger), true);
dialog.close("cancel");
assert.equal(activeElement, trigger, "Cancel button semantics restore the request trigger focus");
assert.equal(globalThis.document.body.children.length, 1, "the native dialog is a singleton");

const first = app.requestPaperSlide(paperId);
const duplicate = await app.requestPaperSlide(paperId);
assert.equal(duplicate, false, "a second click cannot create a second request");
assert.equal(calls.length, 1);
assert.equal(calls[0].url, `${apiBase}/api/paper-slides`);
assert.equal(calls[0].options.method, "POST");
assert.deepEqual(JSON.parse(calls[0].options.body), {
  paper_id: paperId,
  language: "ja",
  coverage_preference: "auto",
});
assert.deepEqual(Object.keys(JSON.parse(calls[0].options.body)).sort(), [
  "coverage_preference", "language", "paper_id",
]);
assert.equal(activeElement, slideHeading, "request transition moves focus to the state heading");

calls[0].resolveFetch(jsonResponse({
  ok: true,
  status: "queued",
  request_id: requestId,
  status_cap: statusCap,
  paper_id: paperId,
  deduplicated: false,
}, 202));
assert.equal(await first, true);
await new Promise((resolveTick) => setImmediate(resolveTick));
assert.equal(calls.length, 2, "accepted request starts authenticated status polling");
assert.equal(calls[1].url, `${apiBase}/api/paper-slides/status`);
assert.equal(calls[1].options.method, "POST");
assert.deepEqual(JSON.parse(calls[1].options.body), { request_id: requestId });
assert.equal(calls[1].options.headers.authorization, `PaperSlide ${statusCap}`);
assert.equal(calls[1].url.includes(statusCap), false);
assert.equal(calls[1].options.body.includes(statusCap), false);
assert.equal([...storage.values()].some((value) => value.includes(statusCap)), true);
assert.equal(slideBody.children.some((node) => node.textContent.includes(statusCap)), false);
assert.equal(
  JSON.stringify(app.catalogState.paperSlideRequestsByPaperId.get(paperId)).includes(statusCap),
  false,
  "exported render state never contains the capability",
);
assert.equal(
  JSON.stringify(app.paperSlideRequestView(
    paper,
    app.catalogState.publicSlidesByPaperId.get(paperId),
  )).includes(statusCap),
  false,
  "view objects never expose the capability",
);

app.abandonPaperSlideRequest(paperId);
await new Promise((resolveTick) => setImmediate(resolveTick));
assert.equal(calls[1].options.signal.aborted, true, "closing/changing a card aborts the in-flight status request");
assert.equal([...storage.values()].some((value) => value.includes(statusCap)), true);
assert.equal(app.restorePaperSlideRequest(paperId), true, "same-tab session restores polling");
assert.equal(calls.length, 3);
calls[2].resolveFetch(jsonResponse({
  ok: true,
  request_id: requestId,
  paper_id: paperId,
  status: "running",
  phase: "extracting",
  coverage: null,
  deck_id: null,
  preview_available: false,
  preview_expires_at: null,
  public_url: null,
  message_code: "PAPER_SLIDE_EXTRACTING",
  updated_at: "2026-09-04T01:02:03Z",
}, 200));
await new Promise((resolveTick) => setImmediate(resolveTick));
assert.equal(app.catalogState.paperSlideRequestsByPaperId.get(paperId).status, "running");
assert.match(slideBody.children[0].textContent, /抽出/);
assert.doesNotMatch(slideBody.children[0].textContent, /%/);
app.stopPaperSlidePolling(paperId);

app.catalogState.paperSlideRequestsByPaperId.delete(paperId);
app.restorePaperSlideRequest(paperId);
assert.equal(calls.length, 4);
calls[3].resolveFetch(jsonResponse({
  ok: true,
  request_id: requestId,
  paper_id: paperId,
  status: "published",
  phase: null,
  coverage: "full_text",
  deck_id: deckId,
  preview_available: false,
  preview_expires_at: null,
  public_url: deckPath,
  message_code: "PAPER_SLIDE_PUBLISHED",
  updated_at: "2026-09-04T01:03:03Z",
}, 200));
await new Promise((resolveTick) => setImmediate(resolveTick));
await new Promise((resolveTick) => setImmediate(resolveTick));
assert.equal(app.catalogState.paperSlideRequestsByPaperId.get(paperId).status, "failed");
assert.equal(slideBody.children.some((node) => node.tagName === "A"), false, "path mismatch never exposes a link");

app.catalogState.paperSlideRequestsByPaperId.delete(paperId);
const malformedRequest = app.requestPaperSlide(paperId);
assert.equal(calls.length, 5);
calls[4].resolveFetch(jsonResponse({
  ok: true,
  status: "queued",
  request_id: requestId,
  status_cap: statusCap,
  paper_id: paperId,
  deduplicated: false,
  server_message: statusCap,
}, 202));
assert.equal(await malformedRequest, false);
assert.equal([...storage.values()].some((value) => value.includes(statusCap)), false);
assert.equal(slideBody.children.some((node) => node.textContent.includes(statusCap)), false);

app.catalogState.paperSlideRequestsByPaperId.delete(paperId);
hidden = true;
const requestId2 = `paper-slide-${"D".repeat(22)}`;
const statusCap2 = `psc_${"E".repeat(43)}`;
const successfulRequest = app.requestPaperSlide(paperId);
assert.equal(calls.length, 6);
calls[5].resolveFetch(jsonResponse({
  ok: true,
  status: "queued",
  request_id: requestId2,
  status_cap: statusCap2,
  paper_id: paperId,
  deduplicated: true,
}, 202));
assert.equal(await successfulRequest, true);
assert.equal(calls.length, 6, "a hidden page pauses status network activity");
hidden = false;
const visibleOwner = app.catalogState.paperSlidePollByPaperId.get(paperId);
app.pollPaperSlideStatus(visibleOwner);
assert.equal(calls.length, 7);
verifiedEntry = {
  paper_id: paperId,
  deck_id: deckId,
  coverage: "full_text",
  deck_path: deckPath,
};
calls[6].resolveFetch(jsonResponse({
  ok: true,
  request_id: requestId2,
  paper_id: paperId,
  status: "published",
  phase: null,
  coverage: "full_text",
  deck_id: deckId,
  preview_available: false,
  preview_expires_at: null,
  public_url: deckPath,
  message_code: "PAPER_SLIDE_PUBLISHED",
  updated_at: "2026-09-04T01:04:03Z",
}, 200));
await new Promise((resolveTick) => setImmediate(resolveTick));
await new Promise((resolveTick) => setImmediate(resolveTick));
assert.equal(app.catalogState.publicSlidesByPaperId.get(paperId).status, "published");
assert.equal(slideBody.children[1].attributes.get("href"), deckPath);
assert.equal([...storage.values()].some((value) => value.includes(statusCap2)), false);

assert.equal(await app.readPaperSlideJson({
  headers: {
    get(name) {
      if (name.toLowerCase() === "content-type") return "application/json";
      if (name.toLowerCase() === "content-length") return String((16 * 1024) + 1);
      return null;
    },
  },
  body: { getReader() { throw new Error("oversized body must not be opened"); } },
}), null, "declared oversized responses are rejected before opening the stream");

let oversizedReaderCancelled = false;
assert.equal(await app.readPaperSlideJson({
  headers: {
    get(name) { return name.toLowerCase() === "content-type" ? "application/json" : null; },
  },
  body: {
    getReader() {
      return {
        async read() { return { done: false, value: new Uint8Array((16 * 1024) + 1) }; },
        async cancel() { oversizedReaderCancelled = true; },
      };
    },
  },
}), null, "streamed responses are bounded independently of Content-Length");
assert.equal(oversizedReaderCancelled, true, "an oversized response stream is cancelled");

app.catalogState.publicSlidesByPaperId.set(paperId, { status: "not_published", entry: null });
app.catalogState.paperSlideRequestsByPaperId.delete(paperId);
const readerFailureIndex = calls.length;
const readerFailureRequest = app.requestPaperSlide(paperId);
calls[readerFailureIndex].resolveFetch({
  status: 202,
  headers: { get(name) { return name.toLowerCase() === "content-type" ? "application/json" : null; } },
  body: { getReader() { throw new Error("reader unavailable"); } },
});
assert.equal(await readerFailureRequest, false, "body.getReader errors fail the request closed");
assert.equal(app.catalogState.paperSlideRequestsByPaperId.get(paperId).retryable, true);
assert.equal([...storage.values()].some((value) => value.includes("psc_")), false);

app.catalogState.paperSlideRequestsByPaperId.delete(paperId);
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay === 15_000) {
    queueMicrotask(() => callback(...args));
    return 987_654;
  }
  return nativeSetTimeout(callback, delay, ...args);
};
try {
  const timeoutIndex = calls.length;
  const timedOutRequest = app.requestPaperSlide(paperId);
  assert.equal(await timedOutRequest, false, "the request deadline aborts a stalled fetch");
  assert.equal(calls[timeoutIndex].options.signal.aborted, true);
  assert.equal(app.catalogState.paperSlideRequestsByPaperId.get(paperId).retryable, true);
} finally {
  globalThis.setTimeout = nativeSetTimeout;
}

// A completed status request retains its deadline until reviewed-static
// verification finishes. Its timer must only abort the status controller,
// never the newer verification controller stored on the same owner.
app.catalogState.paperSlideRequestsByPaperId.delete(paperId);
const deadlineCallbacks = [];
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay === 15_000 || delay === 8_000) {
    deadlineCallbacks.push({ callback, delay, args });
    return 123_456 + deadlineCallbacks.length;
  }
  return nativeSetTimeout(callback, delay, ...args);
};
let resolveVerification;
verificationGate = {
  promise: new Promise((resolveVerificationPromise) => {
    resolveVerification = resolveVerificationPromise;
  }),
};
try {
  const requestId3 = `paper-slide-${"F".repeat(22)}`;
  const statusCap3 = `psc_${"G".repeat(43)}`;
  const statusIndex = calls.length;
  app.beginPaperSlidePolling({ paper_id: paperId, request_id: requestId3, status_cap: statusCap3 });
  calls[statusIndex].resolveFetch(jsonResponse({
    ok: true,
    request_id: requestId3,
    paper_id: paperId,
    status: "published",
    phase: null,
    coverage: "full_text",
    deck_id: deckId,
    preview_available: false,
    preview_expires_at: null,
    public_url: deckPath,
    message_code: "PAPER_SLIDE_PUBLISHED",
    updated_at: "2026-09-04T01:05:03Z",
  }, 200));
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.ok(verificationSignal, "published status starts static verification");
  deadlineCallbacks.find((item) => item.delay === 15_000).callback();
  assert.equal(verificationSignal.aborted, false,
    "the old status deadline cannot abort reviewed-static verification");
  resolveVerification({ state: "published", entry: verifiedEntry });
  await new Promise((resolveTick) => setImmediate(resolveTick));
  await new Promise((resolveTick) => setImmediate(resolveTick));
} finally {
  verificationGate = null;
  globalThis.setTimeout = nativeSetTimeout;
}

const source = await (await import("node:fs/promises")).readFile(appPath, "utf8");
assert.doesNotMatch(source, /localStorage/);
assert.doesNotMatch(source, /window\.confirm/);
assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*status_cap/);
assert.match(source, /addEventListener\("pagehide"/);
assert.match(source, /addEventListener\("visibilitychange"/);
assert.match(source, /AbortController/);

console.log("catalog slide request/status app contract passed");

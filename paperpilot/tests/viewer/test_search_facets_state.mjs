import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, "../../../docs/assets/search.js"), "utf8");

class Element {
  constructor(tagName, id = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.dataset = {};
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  dispatch(name, extra = {}) {
    const event = { target: this, preventDefault() {}, ...extra };
    this.listeners.get(name)?.(event);
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  querySelector(selector) {
    return selector === ".site-search__input" ? elements.get("s0-search-input") : null;
  }
  querySelectorAll() { return []; }
  contains(node) { return node === this || node === elements.get("s0-search-input"); }
  focus() { this.focused = true; }
  scrollIntoView() {}
}

const ids = [
  "s0-search-input", "s0-search-listbox", "s0-search-status", "s0-search-retry",
  "s0-search-more", "s0-results", "s0-results-heading", "s0-results-summary",
  "s0-results-list", "s0-results-pagination", "s0-search-filters",
  "s0-filter-conference", "s0-filter-year", "s0-filter-type", "s0-filter-reset",
];
const elements = new Map(ids.map((id) => [id, new Element("div", id)]));
const form = new Element("form");
const documentListeners = new Map();
const document = {
  querySelector: (selector) => selector === "[data-search]" ? form : null,
  getElementById: (id) => elements.get(id) || null,
  createElement: (tagName) => new Element(tagName),
  addEventListener: (name, fn) => documentListeners.set(name, fn),
};

let locationUrl = new URL(
  "https://example.test/?q=alpha&conference=iclr-2026&year=2026&type=Oral&page=1"
);
const location = {};
for (const name of ["href", "search", "pathname", "hash"]) {
  Object.defineProperty(location, name, {
    get: () => locationUrl[name],
    set: (value) => { locationUrl = new URL(value, locationUrl); },
  });
}
const historyCalls = [];
const setLocation = (value) => { locationUrl = new URL(value, locationUrl); };
const history = {
  pushState(_state, _title, value) { historyCalls.push(["push", value]); setLocation(value); },
  replaceState(_state, _title, value) { historyCalls.push(["replace", value]); setLocation(value); },
};
const windowListeners = new Map();
const window = {
  location,
  history,
  addEventListener: (name, fn) => windowListeners.set(name, fn),
};

const rows = [
  ["alpha old oral", "eccv-2024", 0, [], ["Vision"], 2024, "Oral"],
  ["alpha new poster", "iclr-2026", 1, [], ["Vision"], 2026, "Poster"],
  ["alpha new oral", "iclr-2026", 2, [], ["Vision"], 2026, "Oral"],
];
const paperIds = ["0".repeat(40), "1".repeat(40), "2".repeat(40)];
let indexFetches = 0;
async function fetch(url) {
  if (url === "search-index-v2.json") {
    indexFetches += 1;
    return { ok: true, json: async () => rows };
  }
  return {
    ok: true,
    json: async () => ({
      schema_version: "search-paper-ids-v1", block: 0, start: 0, paper_ids: paperIds,
    }),
  };
}

const context = {
  console, document, window, fetch, URL, URLSearchParams, Intl,
  setTimeout: (fn) => { fn(); return 1; },
  clearTimeout() {},
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "search.js" });

async function settle() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
}

await settle();
assert.equal(indexFetches, 1, "a valid deep link initializes the real search state machine");
assert.equal(elements.get("s0-filter-conference").value, "iclr-2026");
assert.equal(elements.get("s0-filter-year").value, "2026");
assert.equal(elements.get("s0-filter-type").value, "Oral");
assert.equal(elements.get("s0-results-list").children.length, 1);
assert.equal(elements.get("s0-search-filters").hidden, false);

elements.get("s0-filter-conference").value = "eccv-2024";
elements.get("s0-filter-year").value = "2024";
elements.get("s0-results-heading").focused = false;
elements.get("s0-filter-conference").dispatch("change");
await settle();
assert.match(location.search, /conference=eccv-2024/);
assert.match(location.search, /page=1/);
assert.equal(elements.get("s0-results-list").children.length, 1);
assert.equal(historyCalls.at(-1)[0], "push", "filter changes create Back-restorable history");
assert.notEqual(
  elements.get("s0-results-heading").focused,
  true,
  "keyboard selection keeps focus in the native facet instead of moving it to the heading"
);

setLocation("/?q=alpha&conference=iclr-2026&conference=eccv-2024&page=1");
windowListeners.get("popstate")();
await settle();
assert.equal(elements.get("s0-results-list").children.length, 0);
assert.match(elements.get("s0-results-summary").textContent, /無効/);
assert.equal(elements.get("s0-search-filters").hidden, false, "zero results retain clearable filters");
assert.equal(elements.get("s0-filter-reset").disabled, false);

elements.get("s0-filter-reset").dispatch("click");
await settle();
assert.equal(new URLSearchParams(location.search).getAll("conference").length, 0);
assert.equal(elements.get("s0-results-list").children.length, 3);

setLocation("/?q=a&conference=iclr-2026");
windowListeners.get("popstate")();
await settle();
assert.equal(indexFetches, 1, "one-character queries do not fetch or refetch the index");
assert.equal(elements.get("s0-search-filters").hidden, true);

console.log("search facet actual-init state contract passed");

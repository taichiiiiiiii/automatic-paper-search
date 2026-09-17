import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const fixtureRoot = resolve(repo, "paperpilot/tests/fixtures/lineage-pilot/positive-release");
const paperId = "1".repeat(40);

class MockClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
}

class MockElement {
  constructor(tag = "div", namespaceURI = "http://www.w3.org/1999/xhtml") {
    this.tagName = tag.toUpperCase();
    this.namespaceURI = namespaceURI;
    this.children = [];
    this.dataset = {};
    this.classList = new MockClassList();
    this.hidden = false;
    this.textContent = "";
    this.childElementCount = 0;
    this.open = false;
  }
  append(...children) { this.children.push(...children); this.childElementCount = this.children.filter((child) => child instanceof MockElement).length; }
  replaceChildren(...children) { this.children = [...children]; this.childElementCount = this.children.filter((child) => child instanceof MockElement).length; }
  setAttribute(name, value) { this[name] = String(value); }
  removeAttribute(name) { delete this[name]; }
  addEventListener() {}
  querySelector(selector) {
    if (selector === "h3") return this.children.find((child) => child?.tagName === "H3") || null;
    const action = /^\[data-action="([a-z-]+)"\]$/.exec(selector)?.[1];
    if (action) {
      const visit = (node) => {
        if (node?.dataset?.action === action) return node;
        for (const child of node?.children || []) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      return visit(this);
    }
    return null;
  }
  querySelectorAll(selector) {
    if (selector !== "[data-node-id]") return [];
    const found = [];
    const visit = node => {
      if (node?.dataset?.nodeId) found.push(node);
      for (const child of node?.children || []) visit(child);
    };
    this.children.forEach(visit);
    return found;
  }
  cloneNode() { return new MockElement(this.tagName, this.namespaceURI); }
  focus() { this.focusCount = (this.focusCount || 0) + 1; globalThis.document.activeElement = this; }
}

const ids = [
  "lineage-audit-status", "lineage-audit-heading", "lineage-audit-message", "lineage-ready", "lineage-title",
  "lineage-paper-meta", "lineage-catalog-back", "lineage-hops", "lineage-confidence",
  "lineage-tentative", "lineage-genealogy", "lineage-comparison", "lineage-relation-options",
  "lineage-advanced-summary",
  "lineage-evidence-source-options", "lineage-evidence-kind-options", "lineage-counts",
  "lineage-exclusions", "lineage-force-list", "lineage-graph-panel", "lineage-graph",
  "lineage-node-cards", "lineage-list-panel", "lineage-claim-list", "lineage-page-status",
  "lineage-pagination", "lineage-inspector", "lineage-inspector-body",
  "lineage-list-heading",
];
const elements = new Map(ids.map((id) => [id, new MockElement()]));
elements.get("lineage-ready").hidden = true;
elements.get("lineage-inspector").hidden = true;

const documentListeners = new Map();
globalThis.document = {
  title: "",
  activeElement: null,
  getElementById: (id) => elements.get(id) || null,
  querySelectorAll: () => [],
  addEventListener(type, listener) { documentListeners.set(type, listener); },
  createElement: (tag) => new MockElement(tag),
  createElementNS: (namespaceURI, tag) => new MockElement(tag, namespaceURI),
  createTextNode: (text) => ({ textContent: text }),
};
globalThis.window = {
  location: {
    href: "https://example.test/automatic-paper-search/lineage/",
    origin: "https://example.test",
    search: "",
  },
  history: {
    pushState(_state, _unused, url) { this.replaceState(_state, _unused, url); },
    replaceState(_state, _unused, url) {
      const next = new URL(url);
      window.location.href = next.href;
      window.location.search = next.search;
    },
  },
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  crypto: globalThis.crypto,
};
globalThis.localStorage = { getItem: () => null, setItem() {} };

await import(`${pathToFileURL(resolve(repo, "docs/assets/catalog-core.js")).href}?focus-app`);
window.PaperPilotCatalogCore = globalThis.PaperPilotCatalogCore;
await import(`${pathToFileURL(resolve(repo, "docs/assets/lineage-v2-core.js")).href}?focus-app`);
globalThis.__PAPERPILOT_LINEAGE_FOCUS_TEST__ = true;
await import(`${pathToFileURL(resolve(repo, "docs/assets/lineage-focus.js")).href}?focus-app`);

const app = globalThis.__lineageFocusTest;
const labelBoxes = [];
const labelPath = [{x:100,y:100}, {x:400,y:100}];
const labelSpot = app.placeEdgeLabel(labelPath, "拡張", new Map(), labelBoxes);
assert.equal(app.placeEdgeLabel(labelPath, "拡張", new Map(), [], {width:260,height:200}), null,
  "labels do not escape the right canvas boundary");
assert.equal(app.placeEdgeLabel(labelPath, "拡張", new Map(), [], {width:500,height:95}), null,
  "labels do not escape the bottom canvas boundary");
assert.deepEqual(app.placeEdgeLabel(labelPath, "拡張", new Map(), [], {width:268,height:96}),
  {x:250,y:92}, "a label exactly inside the canvas remains available");
assert.ok(labelSpot);
assert.equal(labelBoxes.length, 1);
assert.equal(app.placeEdgeLabel(labelPath, "拡張", new Map(), labelBoxes), null,
  "a coincident label is omitted instead of overprinted");
assert.equal(app.placeEdgeLabel(labelPath, "拡張", new Map([["card", {x:250,y:92}]]), []), null,
  "labels do not cover a card");
const alternatePath = [{x:100,y:100}, {x:400,y:100}, {x:400,y:300}];
const alternateBefore = JSON.stringify(alternatePath);
assert.deepEqual(app.placeEdgeLabel(alternatePath, "拡張", new Map([["card", {x:250,y:92}]]), []),
  {x:400,y:192}, "a blocked longest segment falls back to another segment");
assert.equal(JSON.stringify(alternatePath), alternateBefore, "label placement preserves the edge route");
assert.equal(app.placeEdgeLabel([], "拡張", new Map(), []), null);
assert.equal(app.placeEdgeLabel([{x:0,y:0}, {x:10,y:0}], "要確認", new Map(), []), null,
  "labels do not escape the top or left canvas boundary");
const routingNodes = new Map([
  ["a", { x: 100, y: 100 }], ["blocker", { x: 350, y: 100 }],
  ["b", { x: 600, y: 100 }],
]);
const routed = app.routeEdge(routingNodes.get("a"), routingNodes.get("b"), routingNodes);
assert.ok(routed.length > 2, "an intervening card requires a detour");
for (let i = 1; i < routed.length; i++) {
  assert.equal(app.segmentHitsCard(routed[i - 1], routed[i], routingNodes.get("blocker")), false);
}
assert.deepEqual(app.routeEdge(routingNodes.get("a"), routingNodes.get("b"), routingNodes), routed);
assert.deepEqual([...routingNodes.values()], [{ x: 100, y: 100 }, { x: 350, y: 100 }, { x: 600, y: 100 }]);
assert.ok(app, "explicit test mode exposes bounded Focus View helpers");

let fetchCount = 0;
async function fixtureFetch(url) {
  fetchCount += 1;
  const parsed = new URL(url);
  let path;
  if (parsed.pathname.endsWith("/lineage-pilot-index-v1.json")) path = resolve(fixtureRoot, "lineage-pilot-index-v1.json");
  else if (parsed.pathname.endsWith("/synthetic-pilot/papers.json")) path = resolve(fixtureRoot, "catalog.json");
  else {
    const marker = "/automatic-paper-search/";
    path = resolve(fixtureRoot, parsed.pathname.slice(parsed.pathname.indexOf(marker) + marker.length));
  }
  const bytes = await readFile(path);
  return {
    ok: true,
    redirected: false,
    url: parsed.href,
    headers: { get: (name) => name === "content-length" ? String(bytes.byteLength) : null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

const invalidStarted = await app.start({ fetchImpl: async () => { throw new Error("must not fetch"); } });
assert.equal(invalidStarted, false);
assert.equal(elements.get("lineage-ready").hidden, true, "invalid paper never reveals controls");
assert.match(elements.get("lineage-audit-message").textContent, /paper ID/);
assert.equal(elements.get("lineage-audit-heading").textContent, "監査済みの系譜は表示できません");

window.location.search = `?paper=${paperId}`;
window.location.href = `https://example.test/automatic-paper-search/lineage/?paper=${paperId}`;
const directOwner = app.loadOwner();
const directRelease = await app.loadVerifiedRelease(paperId, directOwner, { fetchImpl: fixtureFetch });
directOwner.finish();
assert.ok(directRelease, "real producer bytes pass the five-resource verifier");
fetchCount = 0;
const started = await app.start({ fetchImpl: fixtureFetch });
assert.equal(started, true, "real producer bytes pass the browser verifier");
assert.equal(fetchCount, 5, "one viewer load uses exactly the bounded five resources");
assert.equal(elements.get("lineage-audit-status").hidden, true);
assert.equal(elements.get("lineage-ready").hidden, false, "controls reveal only after verification");
assert.ok(elements.get("lineage-title").textContent.length > 0);
assert.ok(app.model.release && Object.isFrozen(app.model.release));
assert.equal(app.model.projection.focus.seed_paper_id, paperId);
const laneNodes = ["focus", "parent", "grandparent", "child", "compare", "tentative", "other"].map(id => ({id}));
const initialSvg = elements.get("lineage-graph").children[0];
const expectedGraphLayout = app.laneLayout(app.model.projection.nodes, app.model.projection.claims, app.model.projection.focus.id);
assert.deepEqual(initialSvg.children.filter(child => child.class === "lineage-focus__graph-lane-label")
  .map(child => child.textContent), expectedGraphLayout.labels.map(label => label.label));
assert.equal(initialSvg.viewBox, `0 0 ${expectedGraphLayout.width} ${expectedGraphLayout.height}`);
assert.ok(initialSvg.children.slice(-expectedGraphLayout.labels.length)
  .every(child => child.class === "lineage-focus__graph-lane-label"),
  "lane headings paint after edges and nodes so their halo can mask crossing lines");
for (const node of initialSvg.children.filter(child => child.dataset?.focusId)) {
  const at = expectedGraphLayout.positions.get(node.dataset.focusId);
  assert.equal(node.transform, `translate(${at.x - 65} ${at.y - 31})`);
  assert.equal(node.tabindex, "0");
}
const laneEdge = (src, dst, extra = {}) => ({src, dst, claim_family:"genealogy", decision:"accepted", trust_tier:"verified", ...extra});
const laneClaims = [laneEdge("parent", "focus"), laneEdge("grandparent", "parent"),
  laneEdge("focus", "child"), laneEdge("compare", "focus", {claim_family:"comparison"}),
  laneEdge("tentative", "focus", {trust_tier:"tentative"})];
const lanes = app.nodeLanes(laneNodes, laneClaims, "focus");
assert.equal(lanes.find(lane => lane.key === "other").label, "その他の関連論文",
  "positional grouping must not imply that every other node is unverified");
const beforeLanes = JSON.stringify([laneNodes, laneClaims]);
const laneLayout = app.laneLayout(laneNodes, laneClaims, "focus");
assert.ok(laneLayout.positions.get("grandparent").x < laneLayout.positions.get("parent").x);
assert.ok(laneLayout.positions.get("parent").x < laneLayout.positions.get("focus").x);
assert.ok(laneLayout.positions.get("focus").x < laneLayout.positions.get("child").x);
assert.ok(laneLayout.positions.get("compare").y > laneLayout.positions.get("child").y);
assert.ok(laneLayout.positions.get("other").y > laneLayout.positions.get("compare").y);
assert.deepEqual(app.laneLayout([...laneNodes].reverse(), [...laneClaims].reverse(), "focus"), laneLayout);
for (const sample of [[], [{id:"focus"}], laneNodes,
  Array.from({length:50}, (_, i) => ({id: i === 0 ? "focus" : `node-${i}`}))]) {
  const placed = app.laneLayout(sample, laneClaims, "focus");
  assert.equal(placed.positions.size, sample.length);
  const points = [...placed.positions.values()];
  for (const [i, point] of points.entries()) {
    assert.ok(point.x >= 65 && point.y >= 31 && point.x + 65 < placed.width && point.y + 31 < placed.height);
    for (const other of points.slice(i + 1)) {
      assert.ok(Math.abs(point.x - other.x) >= 130 || Math.abs(point.y - other.y) >= 62);
    }
  }
}
// A 50-node mixed projection exercises every lane, not merely isolated nodes.
const mixedNodes = [{id:"focus"}, ...Array.from({length:49}, (_, i) => ({id:`mixed-${i}`}))];
const mixedClaims = mixedNodes.slice(1).map((node, i) => i < 15 ? laneEdge(node.id, "focus")
  : i < 30 ? laneEdge("focus", node.id)
  : laneEdge("focus", node.id, i < 40 ? {claim_family:"comparison"} : {trust_tier:"tentative"}));
const mixedBefore = JSON.stringify([mixedNodes, mixedClaims]);
const mixedLayout = app.laneLayout(mixedNodes, mixedClaims, "focus");
assert.equal(mixedLayout.positions.size, 50);
assert.deepEqual(app.nodeLanes(mixedNodes, mixedClaims, "focus").map(lane => lane.nodes.length), [1,15,15,10,9]);
assert.deepEqual(app.laneLayout([...mixedNodes].reverse(), [...mixedClaims].reverse(), "focus"), mixedLayout);
const mixedPoints = [...mixedLayout.positions.values()];
for (const claim of mixedClaims) {
  const from = mixedLayout.positions.get(claim.src), to = mixedLayout.positions.get(claim.dst);
  const path = app.routeEdge(from, to, mixedLayout.positions);
  assert.ok(path.length >= 2, `route remains available for ${claim.dst}`);
  for (let i = 1; i < path.length; i++) {
    for (const card of mixedPoints.filter(p => p !== from && p !== to)) {
      assert.equal(app.segmentHitsCard(path[i - 1], path[i], card), false);
    }
  }
}
for (const [i, point] of mixedPoints.entries()) {
  assert.ok(point.x >= 65 && point.y >= 31 && point.x + 65 < mixedLayout.width && point.y + 31 < mixedLayout.height);
  for (const other of mixedPoints.slice(i + 1)) {
    assert.ok(Math.abs(point.x - other.x) >= 130 || Math.abs(point.y - other.y) >= 62);
  }
}
const familyBottom = Math.max(...mixedNodes.slice(0,31).map(node => mixedLayout.positions.get(node.id).y + 31));
const comparisonTop = Math.min(...mixedNodes.slice(31,41).map(node => mixedLayout.positions.get(node.id).y - 31));
assert.ok(comparisonTop > familyBottom, "comparison band must clear every genealogy node, including tall branches");
assert.equal(JSON.stringify([mixedNodes, mixedClaims]), mixedBefore);
assert.deepEqual(app.nodeLanes(laneNodes, [...laneClaims,
  laneEdge("other", "focus", {decision:"rejected"}), laneEdge("missing", "focus")], "focus"), lanes);
assert.equal(JSON.stringify([laneNodes, laneClaims]), beforeLanes);
assert.deepEqual(lanes.map(lane => lane.nodes.map(node => node.id)),
  [["focus"], ["grandparent", "parent"], ["child"], ["compare"], ["other", "tentative"]]);
assert.deepEqual(app.nodeLanes([...laneNodes].reverse(), [...laneClaims].reverse(), "focus"), lanes);
assert.equal(new Set(lanes.flatMap(lane => lane.nodes.map(node => node.id))).size, laneNodes.length);
assert.equal(app.nodeLanes(laneNodes, [...laneClaims, laneEdge("focus","parent")], "focus")
  .find(lane => lane.key === "other").nodes.some(node => node.id === "parent"), true);
const renderedClaims = elements.get("lineage-claim-list").children;
assert.ok(renderedClaims.length > 0);
for (const card of renderedClaims) {
  assert.ok(card.children.some(child => child.textContent.startsWith("関係の解釈:")));
  assert.ok(card.children.some(child => /人手検証済み|複数の根拠で支持|要確認の推定/.test(child.textContent)));
}

const layout = app.layeredLayout(app.model.projection.nodes, app.model.projection.claims);
const isolatedNodes = [{id:"a"}, {id:"b"}];
for (const extra of [{decision:"rejected"}, {trust_tier:"unknown"}, {claim_family:"comparison"}]) {
  const ignoredLayout = app.layeredLayout(isolatedNodes, [laneEdge("a", "b", extra)]);
  assert.equal(ignoredLayout.positions.get("a").x, ignoredLayout.positions.get("b").x,
    "rejected, unknown-trust and comparison edges cannot imply genealogy rank");
}
const parent = layout.positions.get("node:synthetic-parent");
const cycleNodes = ["root", "a", "b", "tail"].map(id => ({id}));
const cycleClaims = [laneEdge("root", "a"), laneEdge("a", "b"), laneEdge("b", "a"), laneEdge("b", "tail")];
const cycleLayout = app.layeredLayout(cycleNodes, cycleClaims);
const cycleLaneLayout = app.laneLayout(cycleNodes, cycleClaims, "a");
assert.equal(cycleLaneLayout.positions.size, cycleNodes.length);
assert.ok(cycleLaneLayout.positions.get("b").y > cycleLaneLayout.positions.get("a").y);
assert.deepEqual(app.laneLayout([...cycleNodes].reverse(), [...cycleClaims].reverse(), "a"), cycleLaneLayout);
for (const node of cycleNodes) {
  assert.equal(cycleLayout.positions.get(node.id).x, cycleLayout.positions.get("root").x,
    "unprocessed cycle and downstream nodes must not receive partial generation rank");
}
assert.deepEqual(app.layeredLayout([...cycleNodes].reverse(), [...cycleClaims].reverse()), cycleLayout);
const child = layout.positions.get("node:synthetic-child");
assert.ok(parent.x < child.x, "trusted parent → child genealogy determines the visible generation rank");

assert.deepEqual(
  app.rectangleEdgePoints({ x: 0, y: 0 }, { x: 300, y: 0 }),
  { start: { x: 65, y: 0 }, end: { x: 235, y: 0 } },
  "horizontal arrows meet the left/right rectangle borders",
);
assert.deepEqual(
  app.rectangleEdgePoints({ x: 0, y: 0 }, { x: 0, y: 200 }),
  { start: { x: 0, y: 31 }, end: { x: 0, y: 169 } },
  "vertical arrows meet the top/bottom rectangle borders",
);
const steep = app.rectangleEdgePoints({ x: 0, y: 0 }, { x: 40, y: 200 });
assert.deepEqual(steep, {
  start: { x: 6.2, y: 31 },
  end: { x: 33.8, y: 169 },
});
assert.equal(
  Math.max(Math.abs((steep.end.x - 40) / 65), Math.abs((steep.end.y - 200) / 31)),
  1,
  "a steep arrowhead lies on, rather than floats outside, the target rectangle",
);

const centerAction = {
  dataset: { action: "focus", value: "node:synthetic-child" },
  closest: (selector) => selector === "[data-action]" ? centerAction : null,
};
documentListeners.get("click")({ target: centerAction });
assert.equal(document.activeElement, elements.get("lineage-title"), "an actual center-change event lands on the refreshed page heading");
assert.equal(elements.get("lineage-title").textContent, "Synthetic Child");

const expandAction = {
  dataset: { action: "expand", value: "node:synthetic-child" },
  closest: (selector) => selector === "[data-action]" ? expandAction : null,
};
documentListeners.get("click")({ target: expandAction });
assert.equal(document.activeElement?.dataset?.action, "collapse", "expansion restores focus to the same node's regenerated action");
const collapseAction = {
  dataset: { action: "collapse", value: "node:synthetic-child" },
  closest: (selector) => selector === "[data-action]" ? collapseAction : null,
};
documentListeners.get("click")({ target: collapseAction });
assert.equal(document.activeElement?.tagName, "H3", "collapse falls back to the same node's regenerated heading when no expansion remains");

const pageAction = {
  dataset: { action: "page", value: "1" },
  closest: (selector) => selector === "[data-action]" ? pageAction : null,
};
documentListeners.get("click")({ target: pageAction });
assert.equal(document.activeElement, elements.get("lineage-list-heading"), "an actual paging event lands on the programmatically focusable list heading");

const dialog = elements.get("lineage-inspector");
const claimId = app.model.projection.claims[0].id;

// Keyboard activation must never fall through to a nonexistent claim when a
// focus projection fails closed (the resolved release is torn down by closed()).
const restoreAfterClosed = () => {
  window.location.search = `?paper=${paperId}`;
  window.location.href = `https://example.test/automatic-paper-search/lineage/?paper=${paperId}`;
  const owner = app.loadOwner();
  return app.loadVerifiedRelease(paperId, owner, { fetchImpl: fixtureFetch }).then((release) => {
    owner.finish();
    app.model.release = release;
    const viewState = window.PaperPilotLineageV2.readState(release, {
      params: new URLSearchParams(window.location.search), prefs: {}, mobile: false,
    });
    app.model.viewState = viewState;
    app.model.projection = window.PaperPilotLineageV2.selectFocusProjection(release, viewState);
    app.model.page = 1;
  });
};
const missingFocus = {
  dataset: { focusId: "node:intentionally-missing" },
  closest: (selector) => selector === "[data-focus-id]" ? missingFocus : null,
};
const keyEvent = (target, key) => ({ key, target, preventDefault() {} });
for (const key of ["Enter", " "]) {
  assert.ok(app.model.projection, "keyboard regression starts from an active release");
  assert.doesNotThrow(() => documentListeners.get("keydown")(keyEvent(missingFocus, key)),
    `unresolvable ${key} focus target must not dereference a nonexistent claim`);
  assert.equal(elements.get("lineage-ready").hidden, true, `${key} failure keeps controls fail-closed`);
  assert.equal(elements.get("lineage-audit-heading").textContent, "監査済みの系譜は表示できません");
  await restoreAfterClosed();
}
const validFocus = {
  dataset: { focusId: "node:synthetic-child" },
  closest: (selector) => selector === "[data-focus-id]" ? validFocus : null,
};
documentListeners.get("keydown")(keyEvent(validFocus, "Enter"));
assert.equal(document.activeElement, elements.get("lineage-title"), "Enter still centers a valid focus node");
assert.equal(elements.get("lineage-title").textContent, "Synthetic Child");
const validClaimTrigger = {
  dataset: { claimId: app.model.projection.claims[0].id },
  closest: (selector) => selector === "[data-claim-id]" ? validClaimTrigger : null,
};
documentListeners.get("keydown")(keyEvent(validClaimTrigger, " "));
assert.equal(dialog.hidden, false, "Space on a valid claim still opens the inspector");
app.closeInspector(false);
assert.equal(dialog.hidden, true);
await restoreAfterClosed();

let restoredFocus = 0;
const trigger = { focus: () => { restoredFocus += 1; } };
let nativeOpenCount = 0;
dialog.showModal = function showModal() {
  assert.equal(this.hidden, false, "hidden is cleared before the native modal opens");
  this.open = true;
  nativeOpenCount += 1;
};
dialog.close = function close() { this.open = false; };
app.openInspector(claimId, trigger);
assert.equal(dialog.open, true);
app.closeInspector();
assert.equal(dialog.open, false);
assert.equal(dialog.hidden, true, "native close returns to the fail-closed hidden state");
assert.equal(restoredFocus, 1);
app.openInspector(claimId, trigger);
assert.equal(nativeOpenCount, 2, "a native dialog can open again after being closed");
app.closeInspector(false);
assert.equal(restoredFocus, 1, "navigation close does not restore stale focus");

delete dialog.showModal;
delete dialog.close;
app.openInspector(claimId, trigger);
assert.equal(dialog.hidden, false, "fallback dialog becomes visible");
assert.equal(dialog.open, "", "fallback dialog receives the open attribute");
app.closeInspector();
assert.equal(dialog.hidden, true);
assert.equal(dialog.open, undefined, "fallback close removes the open attribute");

const redirectOwner = app.loadOwner();
await assert.rejects(
  () => app.loadVerifiedRelease(paperId, redirectOwner, {
    fetchImpl: async (url) => ({
      ok: true,
      redirected: true,
      url: String(url),
      headers: { get: () => "2" },
      arrayBuffer: async () => new Uint8Array([123, 125]).buffer,
    }),
  }),
  /refused/,
);
redirectOwner.finish();

const bytesOwner = app.loadOwner();
await assert.rejects(
  () => app.fetchBytes("../lineage-pilot-index-v1.json", 1, bytesOwner.controller.signal, fixtureFetch),
  /too large/,
);
bytesOwner.finish();

console.log("lineage focus app contract passed");

// Pure-logic tests for the X-axis encoding modes added to docs/assets/theme.js.
//
// theme.js targets the browser, so we stub the small surface it touches at
// module-load time (document.getElementById, localStorage, window.PP) and
// then exercise the exported layout functions through `globalThis`.
//
// Run via: node paperpilot/tests/viewer/test_theme_xaxis_layout.mjs
//
// Lifecycle: this is the canonical regression test for X-axis modes — the
// pytest wrapper at test_theme_viewer_smoke.py invokes it as a subprocess
// so coverage shows up in the existing pytest run. Keep both in sync if
// you rename / add modes.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEME_JS = resolve(__dirname, "../../../docs/assets/theme.js");

// Browser DOM stubs sufficient for theme.js's module-load time. The viewer
// reads several elements via getElementById and short-circuits when they
// return null — that's the contract we exercise. We don't run init().
function makeStubElement() {
  const el = {
    value: "",
    hidden: false,
    innerHTML: "",
    textContent: "",
    style: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    dataset: {},
    children: [],
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    insertAdjacentHTML() {},
    insertBefore(node) { return node; },
    cloneNode() { return makeStubElement(); },
    querySelector: () => null,
    querySelectorAll: () => [],
    remove() {},
    focus() {},
  };
  return el;
}

function makeContext() {
  const stubDoc = {
    getElementById: () => makeStubElement(),
    createElement: () => makeStubElement(),
    createElementNS: () => makeStubElement(),
    fonts: { ready: Promise.resolve() },
  };
  const localStorageBacking = new Map();
  const ctx = {
    document: stubDoc,
    window: {
      PP: { escapeHtml: (s) => String(s), formatStars: (n) => String(n) },
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: {
      getItem: (k) => (localStorageBacking.has(k) ? localStorageBacking.get(k) : null),
      setItem: (k, v) => localStorageBacking.set(k, v),
      removeItem: (k) => localStorageBacking.delete(k),
    },
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve([]) }),
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    XMLSerializer: class { serializeToString() { return ""; } },
    URL,
    Promise,
    Map,
    Set,
    Math,
    JSON,
    console,
    setTimeout,
    clearTimeout,
  };
  ctx.window.localStorage = ctx.localStorage;
  ctx.window.document = ctx.document;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

function loadThemeJs() {
  const ctx = makeContext();
  const src = readFileSync(THEME_JS, "utf8");
  // Strip the `init();` call at the very bottom — we only want the
  // module-level definitions, not its async DOM bootstrap.
  const stripped = src.replace(/\binit\(\);\s*$/, "");
  // Expose internal symbols on globalThis so the test can reach them.
  // We append our own probe to the script source rather than re-parsing.
  const probe = `
    globalThis.__test = {
      layoutChronological,
      computePagerank,
      buildLayoutContext,
      scoreForMode,
      computeModeData,
      venueTierBucket,
      existingThemeMatch,
      readUrlState,
      syncUrlState,
      state,
      X_AXIS_MODES,
      DEFAULT_X_AXIS_MODE,
      X_AXIS_HINT,
      X_AXIS_BUTTON,
      X_AXIS_LEGEND,
    };
  `;
  vm.runInContext(stripped + "\n" + probe, ctx, { filename: "theme.js" });
  return ctx.__test;
}

const T = loadThemeJs();

// ---- Tiny assertion helper ----------------------------------------------------

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    failed++;
    failures.push({ name, err: e });
    process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`);
  }
}
function eq(actual, expected, msg = "") {
  if (actual !== expected) {
    throw new Error(`${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}
function approx(actual, expected, tol = 1e-6, msg = "") {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${msg}\n    expected: ${expected} (±${tol})\n    actual:   ${actual}`);
  }
}
function truthy(v, msg) { if (!v) throw new Error(msg || `expected truthy, got ${v}`); }

// ---- Fixtures ---------------------------------------------------------------

// venue_tier values mirror the strings the Python pipeline emits
// ("A+" / "A" / "preprint") so the venue-mode tests reflect real data.
//
// 5-paper toy lineage spanning 3 years. P0 (2017) is the seed; P1, P2 (2020)
// extend P0; P3 (2024) supersedes P1; P4 (2024) is an orphan with no edges.
//
// IMPORTANT: P3's citation_count (10) is intentionally LOWER than P4's
// (500) so the novelty test cannot accidentally pass via the citation
// fallback. With the correct "incoming-edge" semantics P3 still sorts
// left because its incoming `supersedes` makes it disruptive (-1) which
// beats P4's tiny fallback (~-5e-4). If the condition were ever inverted
// to "outgoing only", P3 would have no edges to inspect and fall through
// to citation fallback (~-1e-5), letting P4 (-5e-4) sort left and the
// test fail loudly.
const NODES = [
  { id: "P0", title: "Seed",     year: 2017, citation_count: 1000, venue_tier: "A+" },
  { id: "P1", title: "Branch A", year: 2020, citation_count: 500,  venue_tier: "A+" },
  { id: "P2", title: "Branch B", year: 2020, citation_count: 100,  venue_tier: "A" },
  { id: "P3", title: "Replacer", year: 2024, citation_count: 10,   venue_tier: "A+" },
  { id: "P4", title: "Orphan",   year: 2024, citation_count: 500,  venue_tier: "preprint" },
];
const EDGES = [
  { src: "P0", dst: "P1", rel: "extends", conf: 0.9 },
  { src: "P0", dst: "P2", rel: "extends", conf: 0.9 },
  { src: "P1", dst: "P3", rel: "supersedes", conf: 0.9 },
];

// ---- Tests ------------------------------------------------------------------

console.log("X-axis modes:");

test("X_AXIS_MODES list matches the documented option set", () => {
  eq(T.X_AXIS_MODES.length, 6);
  for (const m of ["rank", "citation_log", "genealogy", "centrality", "venue", "novelty"]) {
    truthy(T.X_AXIS_MODES.includes(m), `missing mode ${m}`);
  }
});

test("DEFAULT_X_AXIS_MODE is rank (preserves prior behaviour)", () => {
  eq(T.DEFAULT_X_AXIS_MODE, "rank");
});

test("X_AXIS_HINT has an entry for every mode", () => {
  for (const m of T.X_AXIS_MODES) {
    truthy(typeof T.X_AXIS_HINT[m] === "string" && T.X_AXIS_HINT[m].length > 0,
      `missing hint for ${m}`);
  }
});

test("layoutChronological(rank) sorts by citation desc within year", () => {
  const { positioned } = T.layoutChronological(NODES, EDGES, "rank");
  const row2020 = positioned.filter((p) => p.year === 2020).sort((a, b) => a._x - b._x);
  eq(row2020[0].id, "P1", "P1 (500 cites) should be left of P2 (100 cites)");
  eq(row2020[1].id, "P2");
});

test("layoutChronological(citation_log) keeps high-citation papers left", () => {
  const { positioned } = T.layoutChronological(NODES, EDGES, "citation_log");
  const row2020 = positioned.filter((p) => p.year === 2020).sort((a, b) => a._x - b._x);
  eq(row2020[0].id, "P1");
});

test("layoutChronological(genealogy) places P3 near its parent P1", () => {
  const { positioned } = T.layoutChronological(NODES, EDGES, "genealogy");
  const p1 = positioned.find((p) => p.id === "P1");
  const p3 = positioned.find((p) => p.id === "P3");
  truthy(p1 && p3, "both nodes positioned");
  // P3's score is parent.placedX — so when P4 (orphan) is placed alongside,
  // P3 should land closer to P1's column than P4 does. Distance check is
  // robust to absolute X choices.
  const p4 = positioned.find((p) => p.id === "P4");
  const distP3 = Math.abs(p3._x - p1._x);
  const distP4 = Math.abs(p4._x - p1._x);
  truthy(distP3 < distP4 || distP3 === 0,
    `genealogy: P3 should be ≤ P4 distance to P1 (got P3=${distP3}, P4=${distP4})`);
});

test("layoutChronological(centrality) puts the seed P0 leftmost in 2017", () => {
  const { positioned } = T.layoutChronological(NODES, EDGES, "centrality");
  const row2017 = positioned.filter((p) => p.year === 2017);
  eq(row2017.length, 1);
  eq(row2017[0].id, "P0");
});

test("layoutChronological(venue) A+ left, preprint right in 2024", () => {
  const { positioned } = T.layoutChronological(NODES, EDGES, "venue");
  const row2024 = positioned.filter((p) => p.year === 2024).sort((a, b) => a._x - b._x);
  eq(row2024[0].id, "P3", "A+ first");
  eq(row2024[1].id, "P4", "preprint last");
});

test("layoutChronological(novelty) puts the disruptive supersedes-receiver P3 left of orphan P4", () => {
  const { positioned } = T.layoutChronological(NODES, EDGES, "novelty");
  const row2024 = positioned.filter((p) => p.year === 2024).sort((a, b) => a._x - b._x);
  // P3 has an INCOMING `supersedes` edge → disruptive (-1). P4 has no
  // edges → tiny citation fallback. Crucially P3 has lower citations than
  // P4 (10 vs 500), so the test would fail if the implementation ever
  // counted outgoing instead of incoming edges.
  eq(row2024[0].id, "P3");
});

test("layoutChronological(novelty) does NOT mark P0 (parent only, outgoing edges) as disruptive", () => {
  // Sanity: P0 emits two `extends` edges but is incoming-edge-free, so
  // it should fall through to citation-count fallback rather than score
  // as disruptive or incremental. Adding a sibling year-2017 node lets
  // us check the relative ordering.
  const nodes = [
    ...NODES,
    { id: "Q", title: "2017 sibling", year: 2017, citation_count: 5, venue_tier: 1 },
  ];
  const { positioned } = T.layoutChronological(nodes, EDGES, "novelty");
  const row2017 = positioned.filter((p) => p.year === 2017).sort((a, b) => a._x - b._x);
  // P0 (1000 cites) should beat Q (5 cites) on the citation tiebreak.
  // If P0 were mis-counted as having edges, its score would be 0 (no
  // incoming) which would tie with Q's 0 and rely on insertion order.
  eq(row2017[0].id, "P0");
  eq(row2017[1].id, "Q");
});

test("layoutChronological(unknown) falls back to default without throwing", () => {
  const { positioned } = T.layoutChronological(NODES, EDGES, "totally-bogus");
  eq(positioned.length, NODES.length);
});

test("layoutChronological handles empty edges array", () => {
  const { positioned } = T.layoutChronological(NODES, [], "genealogy");
  eq(positioned.length, NODES.length);
});

test("layoutChronological handles unknown-year node by appending Unknown row", () => {
  const nodes = [
    { id: "U", title: "?", year: null, citation_count: 0 },
    ...NODES,
  ];
  const { positioned, yearLabels } = T.layoutChronological(nodes, EDGES, "rank");
  truthy(positioned.find((p) => p.id === "U"), "unknown-year node still positioned");
  eq(yearLabels[yearLabels.length - 1].label, "Unknown");
});

test("computePagerank ranks the seed P0 above the leaf P4", () => {
  const pr = T.computePagerank(NODES, EDGES);
  truthy(pr.get("P0") > pr.get("P4"),
    `seed P0 (${pr.get("P0")}) should outrank orphan P4 (${pr.get("P4")})`);
});

test("computePagerank sums to ~1 (probability distribution invariant)", () => {
  const pr = T.computePagerank(NODES, EDGES);
  let sum = 0;
  for (const v of pr.values()) sum += v;
  approx(sum, 1.0, 1e-3);
});

test("computePagerank returns empty Map for empty node list", () => {
  const pr = T.computePagerank([], []);
  eq(pr.size, 0);
});

test("computePagerank ignores edges that reference nodes outside the graph", () => {
  // Stray edges (e.g. a parent paper that isn't part of the theme node
  // set) used to register a phantom out-degree on the in-graph endpoint
  // and could flip an in-graph node into the dangling bucket. The valid-
  // edge prefilter introduced alongside this test pins the behaviour:
  // adding a stray edge must not change ranks for the rest of the graph.
  const stray = [
    ...EDGES,
    { src: "MISSING_PARENT", dst: "P1", rel: "extends", conf: 0.5 },
    { src: "P3", dst: "MISSING_CHILD", rel: "extends", conf: 0.5 },
  ];
  const baseline = T.computePagerank(NODES, EDGES);
  const polluted = T.computePagerank(NODES, stray);
  eq(polluted.size, NODES.length, "no phantom ids leak into the rank map");
  // Each in-graph rank must match the clean run within fp tolerance.
  for (const id of baseline.keys()) {
    approx(polluted.get(id), baseline.get(id), 1e-6, `${id} rank drift`);
  }
});

test("X_AXIS_BUTTON has icon+label+title for every mode", () => {
  for (const m of T.X_AXIS_MODES) {
    const meta = T.X_AXIS_BUTTON[m];
    truthy(meta && meta.icon && meta.label && meta.title, `missing button meta for ${m}`);
  }
});

test("X_AXIS_LEGEND has left+right strings for every mode", () => {
  for (const m of T.X_AXIS_MODES) {
    const lg = T.X_AXIS_LEGEND[m];
    truthy(lg && lg.left && lg.right, `missing legend for ${m}`);
  }
});

test("computeModeData(venue) maps tier strings to numeric buckets", () => {
  const meta = T.computeModeData(NODES, EDGES, "venue");
  eq(meta.get("P0").value, 1, "A+ → 1");
  eq(meta.get("P2").value, 2, "A → 2");
  eq(meta.get("P4").value, 3, "preprint → 3");
});

test("venueTierBucket maps known shapes correctly", () => {
  eq(T.venueTierBucket("A+"), 1);
  eq(T.venueTierBucket("a+"), 1, "case insensitive");
  eq(T.venueTierBucket("aplus"), 1, "alternate spelling");
  eq(T.venueTierBucket("A"), 2);
  eq(T.venueTierBucket("preprint"), 3);
  eq(T.venueTierBucket(""), 3, "empty → preprint bucket");
  eq(T.venueTierBucket(null), 99, "null → unknown");
  eq(T.venueTierBucket(undefined), 99, "undefined → unknown");
  eq(T.venueTierBucket("workshop"), 99, "unknown string → 99");
  eq(T.venueTierBucket(1), 1, "numeric pass-through");
  eq(T.venueTierBucket(2), 2, "numeric pass-through");
  eq(T.venueTierBucket(99), 99, "numeric out-of-range → 99");
  eq(T.venueTierBucket(0), 99, "0 → 99 (no tier)");
});

test("computeModeData(novelty) labels P3 disrupt, P1 incremental, orphan P4 neutral", () => {
  const meta = T.computeModeData(NODES, EDGES, "novelty");
  eq(meta.get("P3").value, "disrupt", "incoming supersedes → disrupt");
  eq(meta.get("P1").value, "incremental", "incoming extends → incremental");
  eq(meta.get("P4").value, "neutral", "no incoming edges → neutral");
});

test("computeModeData(genealogy) groups nodes that share an ancestor under one hue", () => {
  const meta = T.computeModeData(NODES, EDGES, "genealogy");
  // P1, P2 both stem from P0; P3 stems from P1 → still P0 root.
  const hP0 = meta.get("P0").value;
  const hP1 = meta.get("P1").value;
  const hP2 = meta.get("P2").value;
  const hP3 = meta.get("P3").value;
  eq(hP1, hP0);
  eq(hP2, hP0);
  eq(hP3, hP0);
  // P4 (orphan) hashes from its own id, so it must differ from the
  // P0 lineage to be useful as a visual bucket.
  truthy(meta.get("P4").value !== hP0, "orphan should fall in a different bucket");
});

test("computeModeData returns empty Map for modes without per-card hooks", () => {
  for (const m of ["rank", "citation_log", "centrality"]) {
    const meta = T.computeModeData(NODES, EDGES, m);
    eq(meta.size, 0, `${m} should not populate per-card hooks`);
  }
});

test("existingThemeMatch returns slug for case-insensitive theme name match", () => {
  // existingThemeMatch reads `state.manifest` — set it up for these tests.
  T.state.manifest = [
    { slug: "vision-transformer", theme: "Vision Transformer" },
    { slug: "mixture-of-experts", theme: "Mixture of Experts" },
    { slug: "rlhf", theme: "Reinforcement Learning from Human Feedback" },
  ];
  eq(T.existingThemeMatch("Vision Transformer"), "vision-transformer");
  eq(T.existingThemeMatch("vision transformer"), "vision-transformer", "case insensitive");
  eq(T.existingThemeMatch("VISION TRANSFORMER"), "vision-transformer");
  eq(T.existingThemeMatch("  Mixture of Experts  "), "mixture-of-experts", "trims whitespace");
});

test("existingThemeMatch returns slug for slug match too (autocomplete handles either)", () => {
  T.state.manifest = [
    { slug: "vision-transformer", theme: "Vision Transformer" },
  ];
  eq(T.existingThemeMatch("vision-transformer"), "vision-transformer");
  eq(T.existingThemeMatch("VISION-TRANSFORMER"), "vision-transformer");
});

test("existingThemeMatch returns null for non-matching input or empty manifest", () => {
  T.state.manifest = [{ slug: "vision-transformer", theme: "Vision Transformer" }];
  eq(T.existingThemeMatch("Graph Neural Network"), null, "unknown theme");
  eq(T.existingThemeMatch(""), null, "empty input");
  eq(T.existingThemeMatch("   "), null, "whitespace input");
  T.state.manifest = [];
  eq(T.existingThemeMatch("anything"), null, "empty manifest");
});

test("buildLayoutContext indexes parents per node correctly", () => {
  const ctx = T.buildLayoutContext(NODES, EDGES);
  const parentsOfP1 = [...ctx.parentsById.get("P1")];
  eq(parentsOfP1.length, 1);
  eq(parentsOfP1[0], "P0");
  const parentsOfP3 = [...ctx.parentsById.get("P3")];
  eq(parentsOfP3.length, 1);
  eq(parentsOfP3[0], "P1");
});

// ---- Report -----------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}

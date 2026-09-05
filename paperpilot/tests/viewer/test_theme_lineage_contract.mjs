// P2T theme consumer contract tests for docs/assets/theme.js +
// docs/assets/lineage-core.js.
//
// Two layers, all deterministic and network-free:
//
// 1. Static checks: themes/index.html loads lineage-core.js before
//    theme.js, and theme.js carries the quality-gated consumer (strict
//    parse, row eligibility, byte-hash gate, kind="theme") with no legacy
//    `.rel`/`.conf` artifact consumers and no first-focus fallback left.
//
// 2. Behavioural checks: lineage-core.js + theme.js are loaded into a VM
//    with a stubbed fetch(); loadLineageQuality()/loadThemeArtifact() must
//    render only for a ready+passed row whose artifact bytes hash to the
//    audited input_sha256 and parse as strict lineage-artifact-v1, and
//    must never even fetch the artifact when the quality gate is closed.
//
// Run via: node paperpilot/tests/viewer/test_theme_lineage_contract.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const THEME_JS = resolve(here, "../../../docs/assets/theme.js");
const LINEAGE_CORE_JS = resolve(here, "../../../docs/assets/lineage-core.js");
const THEMES_INDEX_HTML = resolve(here, "../../../docs/themes/index.html");

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) {
    console.log(`  ok  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL ${label}`);
    failed++;
  }
}

// ---- Fixtures ---------------------------------------------------------------

const paperId = "1".repeat(40);
const otherPaperId = "2".repeat(40);
const provenance = {
  producer: { name: "fixture", version: "1" },
  evidence: { source: "fixture", kind: "citation", sha256: "a".repeat(64) },
  classification: {
    method: "citation_heuristic",
    provider: null,
    model: null,
    prompt_version: null,
    schema_version: "fixture-v1",
  },
};

function themeArtifact() {
  return {
    schema_version: "lineage-artifact-v1",
    root: "seed-a",
    nodes: [
      { id: "child", title: "Child", is_focus: false },
      {
        id: "seed-a", title: "Seed A", is_focus: true, seed_paper_id: paperId,
        aliases: [["arxiv", "2601.00001"]],
      },
      { id: "seed-b", title: "Seed B", is_focus: true, seed_paper_id: otherPaperId },
    ],
    edges: [
      {
        src: "seed-a", dst: "child", rel: "extends", relation: "extends",
        conf: 0.9, confidence: 0.9, rationale: "Specific evidence", provenance,
      },
      {
        src: "seed-b", dst: "child", rel: "successor", relation: "successor",
        conf: 0.7, confidence: 0.7, rationale: "Other evidence", provenance,
      },
    ],
    clusters: [],
    meta: {
      kind: "theme", generator: "paperpilot.scripts.build_theme_lineage",
      generated_at: "2026-08-30T00:00:00Z",
    },
  };
}

function qualityAudit() {
  return {
    fixture_sha256: "9".repeat(64),
    evaluated_at: "2026-08-30T00:00:00Z",
    actor: "ci:audit-v1",
    checks: [
      {
        name: "artifact_contract_v1", status: "passed",
        observed: 0, expected: 0, evidence: [],
      },
      {
        name: "golden_fixture", status: "passed",
        observed: "fixture-sha", expected: "matching frozen fixture", evidence: [],
      },
    ],
  };
}

function themeQualityRow(overrides = {}) {
  return {
    collection_id: "theme:test-theme",
    kind: "theme",
    slug: "test-theme",
    label: "Test Theme",
    path: "themes/test-theme/lineage.json",
    availability: "ready",
    audit_status: "passed",
    freshness: "fresh",
    generated_at: "2026-08-30T00:00:00Z",
    snapshot_date: null,
    node_count: 3,
    edge_count: 2,
    artifact_schema_version: "lineage-artifact-v1",
    input_sha256: null,
    audit: qualityAudit(),
    ...overrides,
  };
}

function qualityManifest(row) {
  return {
    schema_version: "lineage-quality-v1",
    as_of: "2026-08-30T00:00:00Z",
    audit_version: "audit-v1",
    collections: [row],
  };
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Static contract --------------------------------------------------------

console.log("static contract");
const themeSrc = readFileSync(THEME_JS, "utf8");
const indexHtml = readFileSync(THEMES_INDEX_HTML, "utf8");

const coreTag = indexHtml.indexOf("assets/lineage-core.js");
const themeTag = indexHtml.indexOf("assets/theme.js");
ok(coreTag >= 0 && themeTag >= 0 && coreTag < themeTag,
   "themes/index.html loads lineage-core.js before theme.js");

ok(themeSrc.includes('fetchJsonWithSha256(\n      "../lineage-quality-v1.json"'),
   "theme.js bounded-fetches the shared lineage-quality-v1 read model");
ok(themeSrc.includes("LineageCore.parseQualityManifest"),
   "theme.js strict-parses the quality manifest");
ok(themeSrc.includes("LineageCore.resolveQualityCollection")
   && /kind:\s*"theme"/.test(themeSrc),
   "theme.js resolves the quality row with kind=theme");
ok(themeSrc.includes("LineageCore.qualityRowIsEligible")
   && themeSrc.includes("LineageCore.qualityRowIsPublishable"),
   "theme.js gates on row eligibility and the audited byte hash");
ok(themeSrc.includes('LineageCore.parseArtifact(loaded.data, { kind: "theme" })'),
   "theme.js strict-parses the artifact as kind=theme before display");
ok(themeSrc.includes("LineageCore.resolveFocus(state.data, requestedNode)"),
   "permalink focus uses canonical-reserved seed, exact alias, then graph-local ID");

ok(!/(\be|edge)\.rel\b|(\be|edge)\.conf\b/.test(themeSrc),
   "no legacy .rel/.conf artifact consumers remain");
ok(!/\.find\??\.\(\(?[a-z]\)?\s*=>\s*[a-z]\.is_focus\)/.test(themeSrc)
   && !themeSrc.includes("focusNodeFromLocation"),
   "first-focus fallback is removed");
ok(themeSrc.includes("_quality.json") && themeSrc.includes("quality: {}"),
   "_quality.json stays loaded for badge telemetry only");
ok(themeSrc.includes("state.manifest = eligibleThemeManifest(manifest, lineageQuality)"),
   "gallery and picker receive only strict quality-eligible theme rows");
ok(indexHtml.includes('id="lineage-audit-status"')
   && indexHtml.includes('id="lineage-ready-ui" hidden'),
   "theme HTML defaults to an audit-pending state with interaction hidden");
ok(/id="hero-toggle"[\s\S]*?hidden/.test(indexHtml),
   "theme hero toggle is hidden and unfocusable before JavaScript eligibility");
ok(themeSrc.indexOf("showReadyUi();") < themeSrc.indexOf("bindHeroToggle();"),
   "theme hero controls are bound only after the ready UI opens");

// ---- Behavioural contract (VM + stubbed fetch) -------------------------------

function makeStubElement(id = "") {
  return {
    id,
    value: "",
    hidden: ["lineage-ready-ui", "hero-toggle", "hero-new-theme", "theme-request"]
      .includes(id),
    innerHTML: "",
    textContent: "",
    style: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    dataset: {},
    children: [],
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    listenerTypes: [],
    addEventListener(type) { this.listenerTypes.push(type); },
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
}

function loadViewer(routes, { coreMode = "complete" } = {}) {
  const calls = [];
  const parseState = { count: 0 };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeStubElement(id));
    return elements.get(id);
  };
  const ctx = {
    document: {
      getElementById: (id) => element(id),
      querySelector: () => element("meta"),
      querySelectorAll: () => [],
      createElement: () => makeStubElement(),
      createElementNS: () => makeStubElement(),
      fonts: { ready: Promise.resolve() },
      documentElement: element("document-element"),
      title: "",
    },
    window: {
      PP: { escapeHtml: (s) => String(s), formatStars: (n) => String(n) },
      location: {
        search: "",
        pathname: "/automatic-paper-search/themes/",
        href: "http://localhost/themes/",
      },
      history: { replaceState() {}, pushState() {} },
      matchMedia: () => ({ matches: false }),
      addEventListener() {},
      removeEventListener() {},
      scrollTo() {},
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url) => {
      calls.push(String(url));
      const route = routes.get(String(url));
      if (!route) {
        const fail = async () => { throw new Error(`no route for ${url}`); };
        return { ok: false, status: 404, json: fail, arrayBuffer: fail };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => route.headers?.[String(name).toLowerCase()] ?? null },
        json: async () => JSON.parse(route.text),
        arrayBuffer: async () => {
          route.arrayBufferCalls = (route.arrayBufferCalls || 0) + 1;
          return route.bytes.buffer.slice(
            route.bytes.byteOffset, route.bytes.byteOffset + route.bytes.byteLength,
          );
        },
      };
    },
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    crypto: globalThis.crypto,
    TextDecoder,
    URL,
    URLSearchParams,
    Promise,
    Map,
    Set,
    Math,
    JSON: {
      parse: (value) => { parseState.count++; return JSON.parse(value); },
      stringify: JSON.stringify,
    },
    Date,
    console,
    setTimeout,
    clearTimeout,
  };
  ctx.window.localStorage = ctx.localStorage;
  ctx.window.document = ctx.document;
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  const coreSrc = readFileSync(LINEAGE_CORE_JS, "utf8");
  const themeSrcStripped = readFileSync(THEME_JS, "utf8")
    .replace(/\binit\(\);\s*$/, "");
  const probe = `
    let __renderCalls = 0;
    render = () => { __renderCalls++; };
    setupYearRange = () => {};
    readUrlState = () => {};
    renderPicker = () => {};
    bindPicker = () => {};
    renderThemeGallery = () => {};
    renderHeader = () => {};
    renderFilterChips = () => {};
    bindFilterBar = () => {};
    bindXAxisMode = () => {};
    bindYearRange = () => {};
    bindExport = () => {};
    bindFiltersToggle = () => {};
    bindActiveFiltersClear = () => {};
    bindOrphanToggle = () => {};
    bindOnboardingDismiss = () => {};
    bindStaleBannerClose = () => {};
    bindKeyboardShortcuts = () => {};
    showOnboardingHintIfFirstVisit = () => {};
    maybeShowStaleBanner = () => {};
    maybeShowSparseHint = () => {};
    scrollCanvasToNode = () => {};
    globalThis.__test = {
      eligibleThemeManifest, loadLineageQuality, loadThemeArtifact, state, init,
      renderCalls: () => __renderCalls,
    };
  `;
  if (coreMode !== "missing") {
    vm.runInContext(coreSrc, ctx, { filename: "lineage-core.js" });
    if (coreMode === "incomplete") ctx.window.PaperPilotLineageCore = {};
  }
  vm.runInContext(themeSrcStripped + "\n" + probe, ctx, { filename: "theme.js" });
  return { ctx, calls, parseState, element };
}

function routeFor(artifactText, row) {
  const routes = new Map();
  routes.set("../lineage-quality-v1.json", {
    text: JSON.stringify(qualityManifest(row)),
    bytes: new TextEncoder().encode(JSON.stringify(qualityManifest(row))),
  });
  routes.set(`../${row.path}`, {
    text: artifactText,
    bytes: new TextEncoder().encode(artifactText),
  });
  return routes;
}

async function runGate(artifactText, row) {
  const { ctx, calls, parseState } = loadViewer(routeFor(artifactText, row));
  const viewer = ctx.__test;
  viewer.state.lineageQuality = await viewer.loadLineageQuality();
  const parsesBeforeArtifact = parseState.count;
  const data = await viewer.loadThemeArtifact("test-theme");
  return { data, calls, artifactParseCalls: parseState.count - parsesBeforeArtifact };
}

async function runPositiveInit(artifactText, row) {
  const routes = routeFor(artifactText, row);
  routes.set("themes-manifest.json", {
    text: JSON.stringify([{
      slug: row.slug,
      theme: row.label,
      paper_count: 3,
      generated_at: "2026-08-30T00:00:00Z",
    }]),
    bytes: new TextEncoder().encode("[]"),
  });
  routes.set("_quality.json", {
    text: JSON.stringify({ themes: {} }),
    bytes: new TextEncoder().encode("{}"),
  });
  const { ctx, calls, element } = loadViewer(routes);
  await ctx.__test.init();
  return { ctx, calls, element };
}

console.log("quality gate behaviour");
const artifactText = JSON.stringify(themeArtifact());
const artifactBytes = new TextEncoder().encode(artifactText);
const artifactSha = await sha256Hex(artifactBytes);

console.log("positive init contract");
{
  const passedRow = themeQualityRow({ input_sha256: artifactSha });
  const { ctx, calls, element } = await runPositiveInit(artifactText, passedRow);
  ok(calls.includes("../themes/test-theme/lineage.json"),
     "matching ready+passed theme init fetches its authorised artifact");
  ok(element("lineage-audit-status").hidden
     && !element("lineage-ready-ui").hidden
     && !element("hero-toggle").hidden
     && !element("theme-request").hidden,
     "matching theme init hides audit status and exposes the ready UI");
  ok(element("theme-request").listenerTypes.includes("submit")
     && element("theme-search-input").listenerTypes.includes("input")
     && element("hero-toggle").listenerTypes.includes("click"),
     "matching theme init binds request, search, and hero controls");
  ok(ctx.__test.renderCalls() === 1,
     "matching theme init reaches the render boundary");
}

{
  const passedRow = themeQualityRow({ input_sha256: artifactSha });
  const failedRow = themeQualityRow({
    collection_id: "theme:failed-theme",
    slug: "failed-theme",
    label: "Failed Theme",
    path: "themes/failed-theme/lineage.json",
    input_sha256: artifactSha,
    audit_status: "failed",
    audit: {
      ...qualityAudit(),
      checks: qualityAudit().checks.map((check, index) => (
        index === 0 ? { ...check, status: "failed" } : check
      )),
    },
  });
  const { ctx } = loadViewer(new Map());
  const viewer = ctx.__test;
  const quality = ctx.window.PaperPilotLineageCore.parseQualityManifest(
    qualityManifest(passedRow),
  );
  const manifest = [
    { slug: "test-theme", theme: "Test Theme", paper_count: 3 },
    { slug: "failed-theme", theme: "Failed Theme", paper_count: 40 },
  ];
  ok(viewer.eligibleThemeManifest(manifest, quality).map((row) => row.slug).join(",")
     === "test-theme",
     "gallery eligibility cannot be inferred from legacy counts or badges");
  const failedQuality = ctx.window.PaperPilotLineageCore.parseQualityManifest(
    qualityManifest(failedRow),
  );
  ok(viewer.eligibleThemeManifest(manifest, failedQuality).length === 0,
     "ready but audit-failed theme yields an empty public shelf");
}

{
  const { data, calls } = await runGate(artifactText, themeQualityRow({
    input_sha256: artifactSha,
  }));
  ok(data !== null && data.nodes.length === 3,
     "ready+passed row with exact SHA renders the strict theme artifact");
  ok(data?.edges.every((edge) => typeof edge.relation === "string"
     && typeof edge.confidence === "number"
     && !("rel" in edge) && !("conf" in edge)),
     "rendered edges expose canonical relation/confidence only");
  ok(calls.length === 2 && calls[1] === "../themes/test-theme/lineage.json",
     "artifact fetch URL is assembled from the validated row path");
}

{
  const { data, calls } = await runGate(artifactText, themeQualityRow({
    input_sha256: artifactSha, audit_status: "failed",
  }));
  ok(data === null && calls.length === 1,
     "audit-failed row never fetches or renders the artifact");
}

{
  const { data, calls } = await runGate(artifactText, themeQualityRow({
    input_sha256: artifactSha, availability: "unavailable",
  }));
  ok(data === null && calls.length === 1,
     "unavailable row never fetches or renders the artifact");
}

{
  const { data, artifactParseCalls } = await runGate(artifactText, themeQualityRow({
    input_sha256: "e".repeat(64),
  }));
  ok(data === null && artifactParseCalls === 0,
     "artifact hash mismatch fails closed before JSON parsing");
}

{
  const invalidJson = `[${"x".repeat(1024 * 1024)}`;
  const { data, artifactParseCalls } = await runGate(invalidJson, themeQualityRow({
    input_sha256: "e".repeat(64),
  }));
  ok(data === null && artifactParseCalls === 0,
     "mismatched large invalid JSON is never decoded or parsed");
}

{
  const legacy = themeArtifact();
  legacy.edges.forEach((edge) => {
    delete edge.relation;
    delete edge.confidence;
  });
  const legacyText = JSON.stringify(legacy);
  const legacySha = await sha256Hex(new TextEncoder().encode(legacyText));
  const { data } = await runGate(legacyText, themeQualityRow({
    input_sha256: legacySha,
  }));
  ok(data === null, "legacy rel/conf-only artifact is rejected even with a matching SHA");
}

{
  const seedless = themeArtifact();
  delete seedless.nodes[2].seed_paper_id;
  const seedlessText = JSON.stringify(seedless);
  const seedlessSha = await sha256Hex(new TextEncoder().encode(seedlessText));
  const { data } = await runGate(seedlessText, themeQualityRow({
    input_sha256: seedlessSha,
  }));
  ok(data === null, "theme focus without seed_paper_id is rejected even with a matching SHA");
}

for (const [label, mutate] of [
  ["wrong theme meta kind", (value) => { value.meta.kind = "conference"; }],
  ["missing theme generator", (value) => { delete value.meta.generator; }],
  ["invalid theme generated_at", (value) => { value.meta.generated_at = "2026-02-30T00:00:00Z"; }],
  ["non-empty theme clusters", (value) => { value.clusters = [{ id: "legacy" }]; }],
  ["unknown theme alias namespace", (value) => {
    value.nodes[1].aliases = [["semantic_scholar", "seed-a"]];
  }],
]) {
  const invalid = themeArtifact();
  mutate(invalid);
  const invalidText = JSON.stringify(invalid);
  const invalidSha = await sha256Hex(new TextEncoder().encode(invalidText));
  const { data } = await runGate(invalidText, themeQualityRow({ input_sha256: invalidSha }));
  ok(data === null, `${label} is rejected even with a matching SHA`);
}

{
  const row = themeQualityRow({ input_sha256: artifactSha });
  row.audit.checks[1].status = "failed";
  const { data, calls } = await runGate(artifactText, row);
  ok(data === null && calls.length === 1,
     "contradictory passed audit checks fail before the artifact fetch");
}

{
  const row = themeQualityRow({ input_sha256: artifactSha });
  row.audit.fixture_sha256 = null;
  const { data, calls } = await runGate(artifactText, row);
  ok(data === null && calls.length === 1,
     "passed row without a frozen fixture hash fails before the artifact fetch");
}

{
  const row = themeQualityRow({ input_sha256: artifactSha });
  const routes = routeFor(artifactText, row);
  const artifactRoute = routes.get(`../${row.path}`);
  artifactRoute.headers = { "content-length": String((8 * 1024 * 1024) + 1) };
  const { ctx } = loadViewer(routes);
  const viewer = ctx.__test;
  viewer.state.lineageQuality = await viewer.loadLineageQuality();
  const data = await viewer.loadThemeArtifact("test-theme");
  ok(data === null && !artifactRoute.arrayBufferCalls,
     "oversized artifact is rejected before body allocation or parsing");
}

{
  const row = themeQualityRow({ input_sha256: artifactSha });
  const routes = routeFor(artifactText, row);
  const qualityRoute = routes.get("../lineage-quality-v1.json");
  qualityRoute.headers = { "content-length": String((8 * 1024 * 1024) + 1) };
  const { ctx, calls } = loadViewer(routes);
  const viewer = ctx.__test;
  viewer.state.lineageQuality = await viewer.loadLineageQuality();
  const data = await viewer.loadThemeArtifact("test-theme");
  ok(viewer.state.lineageQuality === null && data === null && calls.length === 1
     && !qualityRoute.arrayBufferCalls,
     "oversized quality manifest fails closed before body allocation or artifact fetch");
}

console.log("quality manifest failure modes");
{
  const row = themeQualityRow({ input_sha256: artifactSha });
  const manifest = qualityManifest(row);
  manifest.audit_version = "audit-v2";
  const routes = new Map([["../lineage-quality-v1.json", {
    text: JSON.stringify(manifest),
    bytes: new TextEncoder().encode(JSON.stringify(manifest)),
  }], [`../${row.path}`, {
    text: artifactText, bytes: artifactBytes,
  }]]);
  const { ctx, calls } = loadViewer(routes);
  const viewer = ctx.__test;
  viewer.state.lineageQuality = await viewer.loadLineageQuality();
  const data = await viewer.loadThemeArtifact("test-theme");
  ok(viewer.state.lineageQuality === null && data === null && calls.length === 1,
     "malformed quality manifest fails closed without fetching the artifact");
}

{
  const routes = new Map();
  const { ctx, calls } = loadViewer(routes);
  const viewer = ctx.__test;
  viewer.state.lineageQuality = await viewer.loadLineageQuality();
  const data = await viewer.loadThemeArtifact("test-theme");
  ok(viewer.state.lineageQuality === null && data === null && calls.length === 1,
     "missing quality manifest fails closed without fetching the artifact");
}

{
  const { ctx } = loadViewer(routeFor(artifactText, themeQualityRow({
    input_sha256: artifactSha,
  })));
  const viewer = ctx.__test;
  viewer.state.lineageQuality = await viewer.loadLineageQuality();
  const unknown = await viewer.loadThemeArtifact("other-theme");
  ok(unknown === null, "slug without a quality row never reaches the network");
}

for (const coreMode of ["missing", "incomplete"]) {
  const { ctx, calls } = loadViewer(new Map(), { coreMode });
  const viewer = ctx.__test;
  viewer.state.lineageQuality = await viewer.loadLineageQuality();
  const data = await viewer.loadThemeArtifact("test-theme");
  ok(viewer.state.lineageQuality === null && data === null && calls.length === 0,
     `${coreMode} LineageCore fails closed without throwing or fetching`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

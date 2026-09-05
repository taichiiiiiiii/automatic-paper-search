// Behavioural negative tests for the direct conference lineage gate.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../../../docs/assets/lineage.js"), "utf8")
  .replace(/\binit\(\);\s*$/, "");

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

function runCase({
  qualityResponse,
  qualityRow,
  artifactSha = "a".repeat(64),
  parsedArtifact = null,
}) {
  const elements = new Map();
  let listeners = 0;
  let artifactFetches = 0;
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        hidden: id === "lineage-ready-ui" || id === "hero-toggle",
        innerHTML: "",
        dataset: {},
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        listenerTypes: [],
        addEventListener(type) { this.listenerTypes.push(type); listeners++; },
        setAttribute() {},
        insertAdjacentHTML() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
      });
    }
    return elements.get(id);
  }
  const core = {
    resolveView: () => "graph",
    parseQualityManifest: (value) => value,
    resolveQualityCollection: () => qualityRow,
    qualityRowIsEligible: (row) => row?.availability === "ready"
      && row?.audit_status === "passed",
    fetchJsonWithSha256: async (url) => {
      if (url === "lineage.json") artifactFetches++;
      return { data: parsedArtifact, sha256: artifactSha };
    },
    qualityRowIsPublishable: (row, { artifactSha256 }) => (
      row?.availability === "ready" && row?.audit_status === "passed"
      && row?.input_sha256 === artifactSha256
    ),
    parseArtifact: () => parsedArtifact,
    resolveFocus: (data) => data?.nodes?.find((node) => node.id === data.root) || null,
    selectActiveEdges: () => [],
  };
  const ctx = {
    document: {
      getElementById: (id) => element(id),
      addEventListener() {},
      querySelector: () => element("legend"),
      querySelectorAll: () => [element("interactive-control")],
      createElement: () => element("created"),
      createElementNS: () => element("created-ns"),
    },
    window: {
      PP: { escapeHtml: String, formatStars: String },
      PaperPilotLineageCore: core,
      location: {
        pathname: "/automatic-paper-search/iclr-2026/lineage.html",
        search: "",
        href: "http://localhost/iclr-2026/lineage.html",
      },
      matchMedia: () => ({ matches: false }),
      addEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async () => qualityResponse,
    URL,
    URLSearchParams,
    Map,
    Set,
    Math,
    JSON,
    console,
  };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(`${source}
    let __renderCalls = 0;
    render = () => { __renderCalls++; };
    scrollToFocus = () => {};
    updateTitle = () => {};
    globalThis.__run = init;
    globalThis.__renderCalls = () => __renderCalls;
  `, ctx, { filename: "lineage.js" });
  return ctx.__run().then(() => ({
    artifactFetches,
    listeners,
    auditHidden: element("lineage-audit-status").hidden,
    readyHidden: element("lineage-ready-ui").hidden,
    heroToggleHidden: element("hero-toggle").hidden,
    searchListeners: element("search-input").listenerTypes,
    renderCalls: ctx.__renderCalls(),
  }));
}

console.log("conference publication gate");
const failedRow = { availability: "ready", audit_status: "failed" };
const failedResult = await runCase({
  qualityRow: failedRow,
  qualityResponse: { ok: true, json: async () => ({ collections: [failedRow] }) },
});
ok(failedResult.artifactFetches === 0,
   "audit-failed row does not fetch lineage.json");
ok(failedResult.readyHidden && !failedResult.auditHidden,
   "audit-failed row leaves only the pending state visible");
ok(failedResult.listeners === 0,
   "audit-failed row binds no hidden keyboard or display controls");

const missingResult = await runCase({
  qualityRow: null,
  qualityResponse: { ok: false, json: async () => { throw new Error("unreachable"); } },
});
ok(missingResult.artifactFetches === 0,
   "failed quality fetch does not fetch lineage.json");
ok(missingResult.readyHidden && !missingResult.auditHidden,
   "failed quality fetch keeps the fail-closed pending state");
ok(missingResult.listeners === 0,
   "failed quality fetch binds no hidden keyboard or display controls");

const positiveArtifact = {
  root: "root-node",
  nodes: [{ id: "root-node", title: "Verified Root", is_focus: true }],
  edges: [],
  clusters: [],
};
const positiveRow = {
  availability: "ready",
  audit_status: "passed",
  input_sha256: "c".repeat(64),
};
const positiveResult = await runCase({
  qualityRow: positiveRow,
  artifactSha: positiveRow.input_sha256,
  parsedArtifact: positiveArtifact,
  qualityResponse: { ok: true, json: async () => ({ collections: [positiveRow] }) },
});
ok(positiveResult.artifactFetches === 1,
   "matching ready+passed conference init fetches its authorised artifact once");
ok(!positiveResult.readyHidden && positiveResult.auditHidden
   && !positiveResult.heroToggleHidden,
   "matching conference init hides audit status and exposes ready controls");
ok(positiveResult.searchListeners.includes("input"),
   "matching conference init binds the primary search control");
ok(positiveResult.renderCalls === 1,
   "matching conference init reaches the render boundary");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

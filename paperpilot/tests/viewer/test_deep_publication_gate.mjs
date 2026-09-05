// Behavioural positive contract for the direct deep-lineage init path.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../../../docs/assets/deep.js"), "utf8")
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

const paperId = "d".repeat(40);
const manifestSha = "b".repeat(64);
const artifactSha = "c".repeat(64);
const entry = {
  paper_id: paperId,
  aliases: [["arxiv", "2601.00001"], ["semantic_scholar", "fixture"]],
  arxiv_id: "2601.00001",
  title: "Verified Deep Paper",
  filename: "deep-2601.00001.json",
};
const manifest = {
  schema_version: "deep-manifest-v1",
  conference: "iclr-2026",
  generated_at: "2026-08-30T00:00:00Z",
  entries: [entry],
};
const artifact = {
  root: "root-node",
  nodes: [{ id: "root-node", title: entry.title, is_focus: true }],
  edges: [],
  clusters: [],
  meta: { seed_paper_id: paperId },
};
const qualityRow = {
  kind: "deep",
  conference: "iclr-2026",
  paper_id: paperId,
  path: "iclr-2026/deep-2601.00001.json",
  availability: "ready",
  audit_status: "passed",
  input_sha256: artifactSha,
  manifest_input_sha256: manifestSha,
};

function createHarness({ eligible = true } = {}) {
  const calls = [];
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: "",
        hidden: id === "lineage-ready-ui",
        innerHTML: "",
        textContent: id === "deep-footer-hint"
          ? "品質監査に合格した深掘り系譜のみ公開します" : "",
        dataset: { view: "graph" },
        listenerTypes: [],
        classList: { add() {}, remove() {}, contains: () => false },
        style: {},
        addEventListener(type) { this.listenerTypes.push(type); },
        setAttribute() {},
        insertAdjacentHTML() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        focus() {},
      });
    }
    return elements.get(id);
  };
  const core = {
    resolveView: () => "graph",
    fetchJsonWithSha256: async (url) => {
      calls.push(String(url));
      return url === "deep-manifest.json"
        ? { data: manifest, sha256: manifestSha }
        : { data: artifact, sha256: artifactSha };
    },
    parseDeepManifest: (data) => data,
    parseQualityManifest: (data) => data,
    resolveQualityCollection: () => qualityRow,
    qualityRowIsEligible: (row, { manifestSha256 }) => (
      eligible && row?.availability === "ready" && row?.audit_status === "passed"
      && row.manifest_input_sha256 === manifestSha256
    ),
    qualityRowIsPublishable: (row, { artifactSha256, manifestSha256 }) => (
      row?.input_sha256 === artifactSha256
      && row?.manifest_input_sha256 === manifestSha256
    ),
    resolveManifestEntry: (data) => data?.entries?.[0] || null,
    parseArtifact: (data) => data,
    resolveFocus: (data) => data?.nodes?.find((node) => node.id === data.root) || null,
    selectActiveEdges: () => [],
  };
  const ctx = {
    document: {
      getElementById: (id) => element(id),
      addEventListener() {},
      querySelectorAll: () => [element("view-control")],
      createElement: () => element("created"),
      createElementNS: () => element("created-ns"),
      title: "",
    },
    window: {
      PP: {
        escapeHtml: String,
        formatStars: String,
        formatVenue: String,
        truncateTitle: String,
      },
      PaperPilotLineageCore: core,
      location: {
        pathname: "/automatic-paper-search/iclr-2026/deep.html",
        search: "",
        href: "http://localhost/iclr-2026/deep.html",
      },
      history: { replaceState() {} },
      matchMedia: () => ({ matches: false }),
      addEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ collections: [qualityRow] }) };
    },
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
  `, ctx, { filename: "deep.js" });
  return { ctx, calls, element };
}

console.log("deep publication gate");
const { ctx, calls, element } = createHarness();
await ctx.__run();
ok(calls.includes("deep-manifest.json")
   && calls.includes("deep-2601.00001.json"),
   "matching ready+passed deep init fetches manifest and authorised artifact");
ok(element("lineage-audit-status").hidden
   && !element("lineage-ready-ui").hidden,
   "matching deep init hides audit status and exposes ready controls");
ok(element("search-input").listenerTypes.includes("input")
   && element("paper-picker").listenerTypes.includes("change"),
   "matching deep init binds search and paper-picker controls");
ok(element("deep-footer-hint").textContent.includes("エッジにホバー"),
   "matching deep init replaces pending footer text with interaction guidance");
ok(ctx.__renderCalls() === 1,
   "matching deep init reaches the render boundary");

const closed = createHarness({ eligible: false });
await closed.ctx.__run();
ok(!closed.calls.includes("deep-2601.00001.json"),
   "ineligible deep row never fetches the lineage artifact");
ok(!closed.element("lineage-audit-status").hidden
   && closed.element("lineage-ready-ui").hidden,
   "ineligible deep row leaves only the pending state visible");
ok(closed.element("search-input").listenerTypes.length === 0,
   "ineligible deep row binds no hidden search control");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

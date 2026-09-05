// Static integration pins for the P2 lineage list/mobile consumer.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const lineage = read("docs/assets/lineage.js");
const deep = read("docs/assets/deep.js");
const app = read("docs/assets/app.js");
const css = read("docs/assets/style.css");
const htmls = [
  read("docs/iclr-2026/lineage.html"),
  read("docs/eccv-2024/lineage.html"),
  read("docs/iclr-2026/deep.html"),
];

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

console.log("strict readers");
ok(lineage.includes("LineageCore.parseArtifact"), "conference viewer parses v1 strictly");
ok(deep.includes("LineageCore.parseDeepManifest"), "deep viewer parses manifest v1 strictly");
ok(deep.includes("LineageCore.parseArtifact"), "deep viewer parses artifact v1 strictly");
ok(app.includes("LineageCore.parseArtifact"), "catalog relation CTA parses v1 strictly");
ok(app.includes("LineageCore.fetchJsonWithSha256")
   && app.includes("LineageCore.qualityRowIsPublishable"),
   "catalog relations are bound to the audited artifact hash");
ok(!lineage.includes("nodes[0]"), "conference viewer has no first-node fallback");
ok(!deep.includes("nodes[0]"), "deep viewer has no first-node fallback");
ok(!deep.includes("`deep-${"), "deep viewer cannot build a filename from a raw parameter");
ok(deep.includes("const jsonName = entry.filename"), "deep fetch path comes from manifest entry");
ok(lineage.includes("parseQualityManifest") && lineage.includes("qualityRowIsPublishable"),
   "conference direct viewer is gated by matching quality row and hash");
ok(deep.includes("parseQualityManifest") && deep.includes("qualityRowIsPublishable"),
   "deep viewer is gated by matching deep quality row and hashes");
ok(lineage.includes('fetch("../lineage-quality-v1.json"'),
   "conference quality fetch failure can fail closed");
ok(deep.includes('fetch("../lineage-quality-v1.json"'),
   "deep quality fetch failure can fail closed");
ok(/LineageCore\.qualityRowIsEligible\(qualityRow\)\s*\?\s*await LineageCore\.fetchJsonWithSha256\("lineage\.json"\)/s.test(lineage),
   "conference artifact is never fetched before row eligibility passes");
ok(lineage.indexOf("bindLayoutButtons();") > lineage.indexOf("if (!state.data)"),
   "conference controls bind only after quality and artifact verification");
ok(deep.indexOf("bindViewButtons();") > deep.indexOf("if (!state.data)"),
   "deep controls bind only after quality and artifact verification");

console.log("list and URL state");
ok(lineage.includes("function renderRelationList"), "conference relation list exists");
ok(deep.includes("function renderRelationList"), "deep relation list exists");
ok(lineage.includes("LineageCore.selectActiveEdges"), "conference graph/list share active edges");
ok(deep.includes("LineageCore.selectActiveEdges"), "deep graph/list share active edges");
ok(lineage.includes('url.searchParams.set("view", state.view)'), "conference view uses replaceable URL state");
ok(deep.includes('url.searchParams.set("view", state.view)'), "deep view uses replaceable URL state");
ok(app.includes("provenance.evidence.source") && app.includes("e.confidence"),
   "catalog relation rows expose evidence and confidence");
ok(app.includes("encodeURIComponent(paper.paper_id)"), "catalog CTA uses canonical paper_id");
ok(app.includes("node.is_focus !== true")
   && !app.includes("[node.paper_id, node.seed_paper_id]"),
   "catalog joins only canonical focus seed_paper_id");
ok(lineage.includes('data-id="${escapeHtml(n.id)}"'),
   "conference search escapes graph-local IDs before HTML interpolation");

console.log("HTML and mobile contract");
for (const [index, html] of htmls.entries()) {
  ok(html.includes("lineage-core.js") && html.includes('data-view="list"')
     && html.includes('id="relation-list"'), `viewer HTML ${index + 1} wires core and list controls`);
  ok(html.includes('id="lineage-audit-status"')
     && html.includes('id="lineage-ready-ui" hidden'),
     `viewer HTML ${index + 1} defaults to audit-pending with controls hidden`);
}
ok(css.includes("@media (max-width: 720px)") && css.includes(".relation-row__path"),
   "720px relation-list layout is present");
ok(css.includes("min-height: 44px"), "mobile interactive controls use 44px targets");
ok(css.includes("@media (prefers-reduced-motion: reduce)"), "reduced-motion guard remains present");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

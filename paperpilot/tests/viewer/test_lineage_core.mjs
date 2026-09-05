// Pure contract tests for docs/assets/lineage-core.js.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../../../docs/assets/lineage-core.js"), "utf8");
globalThis.window = globalThis;
(0, eval)(source);
const Core = globalThis.PaperPilotLineageCore;

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

function artifact() {
  return {
    schema_version: "lineage-artifact-v1",
    root: "root",
    nodes: [
      {
        id: "root", title: "Root", is_focus: true, seed_paper_id: paperId,
        aliases: [["semantic_scholar", "root"]],
      },
      { id: "z-child", title: "Child", is_focus: false },
    ],
    edges: [{
      src: "root", dst: "z-child", rel: "extends", relation: "extends",
      conf: 0.8, confidence: 0.8, rationale: "Specific evidence", provenance,
    }],
    clusters: [],
    meta: { kind: "conference", generated_at: "2026-08-30T00:00:00Z" },
  };
}

console.log("artifact parsing");
const parsed = Core.parseArtifact(artifact(), { kind: "conference" });
ok(parsed !== null, "valid v1 artifact is accepted");
ok(parsed.edges[0].relation === "extends" && parsed.edges[0].confidence === 0.8,
   "edge is normalized to canonical fields");
ok(!("rel" in parsed.edges[0]) && !("conf" in parsed.edges[0]),
   "legacy edge aliases do not escape the reader");

const legacy = artifact();
delete legacy.schema_version;
ok(Core.parseArtifact(legacy, { kind: "conference" }) === null,
   "legacy artifact is rejected");
const nonFocusRoot = artifact();
nonFocusRoot.root = "z-child";
ok(Core.parseArtifact(nonFocusRoot, { kind: "conference" }) === null,
   "root cannot fall back to a non-focus or first node");
const aliasMismatch = artifact();
aliasMismatch.edges[0].rel = "contrasts";
ok(Core.parseArtifact(aliasMismatch, { kind: "conference" }) === null,
   "relation aliases must agree");
const stringProvenance = artifact();
stringProvenance.edges[0].provenance = "llm";
ok(Core.parseArtifact(stringProvenance, { kind: "conference" }) === null,
   "legacy string provenance is rejected");
const missingRationale = artifact();
missingRationale.edges[0].rationale = "";
ok(Core.parseArtifact(missingRationale, { kind: "conference" }) === null,
   "empty rationale is rejected");
const extraProvenance = structuredClone(artifact());
extraProvenance.edges[0].provenance.producer.extra = true;
ok(Core.parseArtifact(extraProvenance, { kind: "conference" }) === null,
   "provenance nested objects reject extra keys");
const unsortedNodes = artifact();
unsortedNodes.nodes.reverse();
ok(Core.parseArtifact(unsortedNodes, { kind: "conference" }) === null,
   "node order must be graph-local ID ascending");
const unsortedEdges = artifact();
unsortedEdges.nodes.push({ id: "z-other", title: "Other", is_focus: false });
unsortedEdges.edges.push({
  src: "root", dst: "z-other", rel: "contrasts", relation: "contrasts",
  conf: 0.7, confidence: 0.7, rationale: "Other evidence", provenance,
});
unsortedEdges.edges.reverse();
ok(Core.parseArtifact(unsortedEdges, { kind: "conference" }) === null,
   "edge order must be src, dst, relation ascending");
const wrongRankedRoot = artifact();
wrongRankedRoot.nodes.push(
  { id: "z-focus", title: "Other focus", is_focus: true, seed_paper_id: otherPaperId },
  { id: "z-other", title: "Other", is_focus: false },
);
wrongRankedRoot.nodes.sort((left, right) => left.id < right.id ? -1 : 1);
wrongRankedRoot.edges.push(
  {
    src: "z-focus", dst: "z-child", rel: "contrasts", relation: "contrasts",
    conf: 0.7, confidence: 0.7, rationale: "Other evidence", provenance,
  },
  {
    src: "z-focus", dst: "z-other", rel: "extends", relation: "extends",
    conf: 0.7, confidence: 0.7, rationale: "Other evidence", provenance,
  },
);
wrongRankedRoot.edges.sort((left, right) => {
  const a = `${left.src}\u0000${left.dst}\u0000${left.relation}`;
  const b = `${right.src}\u0000${right.dst}\u0000${right.relation}`;
  return a < b ? -1 : a > b ? 1 : 0;
});
ok(Core.parseArtifact(wrongRankedRoot, { kind: "conference" }) === null,
   "root must be highest-degree focus with ID tie-break");

console.log("focus resolution");
ok(Core.resolveFocus(parsed, paperId)?.id === "root", "canonical seed resolves first");
ok(Core.resolveFocus(parsed, "root")?.id === "root", "known graph-local ID is compatible");
ok(Core.resolveFocus(parsed, "unknown") === null, "unknown focus never falls back");
const untrustedCanonical = artifact();
untrustedCanonical.nodes[1].paper_id = otherPaperId;
untrustedCanonical.nodes[1].seed_paper_id = otherPaperId;
untrustedCanonical.nodes[1].aliases = [["legacy", otherPaperId]];
const parsedUntrustedCanonical = Core.parseArtifact(untrustedCanonical, { kind: "conference" });
ok(Core.resolveFocus(parsedUntrustedCanonical, otherPaperId) === null,
   "40hex cannot fall through to non-focus fields or aliases");
const hexGraphLocal = artifact();
hexGraphLocal.nodes[1].id = otherPaperId;
hexGraphLocal.edges[0].dst = otherPaperId;
hexGraphLocal.nodes.sort((left, right) => left.id < right.id ? -1 : 1);
const parsedHexGraphLocal = Core.parseArtifact(hexGraphLocal, { kind: "conference" });
ok(Core.resolveFocus(parsedHexGraphLocal, otherPaperId) === null,
   "40hex cannot fall through to a graph-local ID");
const ambiguous = artifact();
ambiguous.nodes.push({
  id: "other", title: "Other", is_focus: true, seed_paper_id: otherPaperId,
  aliases: [["legacy", paperId]],
});
ambiguous.nodes.sort((left, right) => left.id < right.id ? -1 : 1);
const parsedAmbiguous = Core.parseArtifact(ambiguous, { kind: "conference" });
ok(parsedAmbiguous === null, "unknown node alias namespaces are rejected");
const s2Compatible = artifact();
s2Compatible.nodes[0].aliases = [["semantic_scholar", "root"]];
const parsedS2Compatible = Core.parseArtifact(s2Compatible, { kind: "conference" });
ok(parsedS2Compatible !== null && Core.resolveFocus(parsedS2Compatible, "root")?.id === "root",
   "conference keeps Semantic Scholar alias shape compatibility via graph-local ID");

console.log("deep manifest");
const manifest = {
  schema_version: "deep-manifest-v1",
  conference: "test-2026",
  generated_at: "2026-08-30T00:00:00Z",
  entries: [{
    paper_id: paperId,
    aliases: [["arxiv", "2602.18473"], ["semantic_scholar", "root"]],
    arxiv_id: "2602.18473",
    title: "Root",
    filename: "deep-2602.18473.json",
  }],
};
const parsedManifest = Core.parseDeepManifest(manifest);
ok(parsedManifest !== null, "strict manifest wrapper is accepted");
ok(Core.parseDeepManifest(manifest.entries) === null, "legacy manifest array is rejected");
const extraManifestKey = structuredClone(manifest);
extraManifestKey.extra = true;
ok(Core.parseDeepManifest(extraManifestKey) === null,
   "deep manifest wrapper rejects extra keys");
const extraEntryKey = structuredClone(manifest);
extraEntryKey.entries[0].extra = true;
ok(Core.parseDeepManifest(extraEntryKey) === null,
   "deep manifest entry rejects extra keys");
const badConference = structuredClone(manifest);
badConference.conference = "../test";
ok(Core.parseDeepManifest(badConference) === null,
   "deep manifest conference is a strict slug");
const badTimestamp = structuredClone(manifest);
badTimestamp.generated_at = "2026-08-30";
ok(Core.parseDeepManifest(badTimestamp) === null,
   "deep manifest timestamp requires a timezone");
ok(Core.resolveManifestEntry(parsedManifest, { paper: paperId })?.filename
   === "deep-2602.18473.json", "canonical paper resolves an audited filename");
ok(Core.resolveManifestEntry(parsedManifest, { arxiv: "2602.18473" })?.paper_id
   === paperId, "legacy arxiv resolves only through an exact alias");
ok(Core.resolveManifestEntry(parsedManifest, { arxiv: "2401.00001" }) === null,
   "unknown arxiv cannot synthesize a filename");

console.log("view and edge selection");
const mobile = () => ({ matches: true });
ok(Core.resolveView({ urlView: "graph", savedView: "list", matchMedia: mobile }) === "graph",
   "URL view overrides saved and responsive state");
ok(Core.resolveView({ savedView: "graph", matchMedia: mobile }) === "graph",
   "saved view overrides responsive state");
ok(Core.resolveView({ matchMedia: mobile }) === "list", "720px responsive default is list");
const active = Core.selectActiveEdges(
  parsed.edges, new Set(["extends"]), new Set(["root", "z-child"]),
);
ok(active.length === 1, "active edge survives relation and render-scope filters");
ok(Core.selectActiveEdges(parsed.edges, new Set(["contrasts"])).length === 0,
   "relation filter applies to the shared edge set");
ok(Core.selectActiveEdges(parsed.edges, new Set(["extends"]), new Set(["root"]))
   .length === 0, "list and graph both drop edges with unpositioned endpoints");

console.log("quality gate");

// Builders for the closed lineage-quality-v1 shape (mirrors
// schemas/lineage-quality-v1.schema.json + build_lineage_quality.py output).
function qualityRow(overrides = {}) {
  return {
    collection_id: "conference:test-2026",
    kind: "conference",
    slug: "test-2026",
    label: "Test 2026",
    path: "test-2026/lineage.json",
    availability: "ready",
    audit_status: "passed",
    freshness: "fresh",
    generated_at: "2026-08-30T00:00:00Z",
    snapshot_date: null,
    node_count: 12,
    edge_count: 20,
    artifact_schema_version: "lineage-artifact-v1",
    input_sha256: "b".repeat(64),
    audit: {
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
    },
    ...overrides,
  };
}
function themeRow(overrides = {}) {
  return qualityRow({
    collection_id: "theme:test-theme",
    kind: "theme",
    slug: "test-theme",
    label: "Test Theme",
    path: "themes/test-theme/lineage.json",
    input_sha256: "f".repeat(64),
    ...overrides,
  });
}
function deepRow(overrides = {}) {
  return qualityRow({
    collection_id: `deep:test-2026:${paperId}`,
    kind: "deep",
    conference: "test-2026",
    paper_id: paperId,
    arxiv_id: "2602.18473",
    path: "test-2026/deep-2602.18473.json",
    manifest_path: "test-2026/deep-manifest.json",
    manifest_input_sha256: "c".repeat(64),
    input_sha256: "d".repeat(64),
    ...overrides,
  });
}
function qualityManifest(rows, overrides = {}) {
  return {
    schema_version: "lineage-quality-v1",
    as_of: "2026-08-30T00:00:00Z",
    audit_version: "audit-v1",
    collections: rows,
    ...overrides,
  };
}

const quality = Core.parseQualityManifest(
  qualityManifest([qualityRow(), deepRow(), themeRow()]),
);
ok(quality !== null, "closed quality schema accepts conference, deep, and theme rows");
const conferenceQuality = Core.resolveQualityCollection(quality, {
  kind: "conference", slug: "test-2026", path: "test-2026/lineage.json",
});
ok(Core.qualityRowIsPublishable(conferenceQuality, { artifactSha256: "b".repeat(64) }),
   "conference row requires ready, passed, and exact artifact hash");
ok(!Core.qualityRowIsPublishable(conferenceQuality, { artifactSha256: "e".repeat(64) }),
   "artifact hash mismatch fails closed");
const deepQuality = Core.resolveQualityCollection(quality, {
  kind: "deep", conference: "test-2026", paperId, path: "test-2026/deep-2602.18473.json",
});
ok(Core.qualityRowIsPublishable(deepQuality, {
  artifactSha256: "d".repeat(64), manifestSha256: "c".repeat(64),
}), "deep row requires exact artifact and manifest hashes");
const themeQuality = Core.resolveQualityCollection(quality, {
  kind: "theme", slug: "test-theme",
});
ok(themeQuality?.collection_id === "theme:test-theme",
   "theme row resolves uniquely by kind, slug, and themes/<slug>/lineage.json");
ok(Core.qualityRowIsEligible(themeQuality),
   "ready+passed theme row is eligible for fetch");
ok(Core.resolveQualityCollection(quality, { kind: "theme", slug: "test-2026" }) === null,
   "theme selector never matches a conference row with the same slug");
ok(Core.resolveQualityCollection(quality, { kind: "theme", slug: "unknown" }) === null,
   "unknown theme slug resolves to nothing");
ok(!Core.qualityRowIsEligible(themeRow({ audit_status: "failed" })),
   "audit-failed theme row stays ineligible");
ok(!Core.qualityRowIsEligible(themeRow({ availability: "sparse" })),
   "sparse theme row stays ineligible");

console.log("quality gate rejections");
ok(Core.parseQualityManifest({ schema_version: "lineage-quality-v1", collections: [] }) === null,
   "malformed quality manifest fails closed");
ok(Core.parseQualityManifest(qualityManifest([qualityRow()], { extra: true })) === null,
   "top-level object rejects extra keys");
ok(Core.parseQualityManifest(qualityManifest([qualityRow()], { audit_version: "audit-v2" }))
   === null, "audit_version is a closed constant");
ok(Core.parseQualityManifest(qualityManifest([qualityRow({ label: undefined })])) === null,
   "row rejects a missing required key");
ok(Core.parseQualityManifest(qualityManifest([qualityRow({ extra: true })])) === null,
   "row rejects extra keys");
ok(Core.parseQualityManifest(qualityManifest([qualityRow({ paper_id: paperId })])) === null,
   "non-deep row rejects deep-only fields");
ok(Core.parseQualityManifest(qualityManifest(
  [qualityRow(), deepRow({ manifest_path: undefined })],
)) === null, "deep row requires every deep-only field");
ok(Core.parseQualityManifest(qualityManifest(
  [qualityRow({ collection_id: "theme:test-2026" })],
)) === null, "collection_id prefix must match the kind");
ok(Core.parseQualityManifest(qualityManifest(
  [themeRow({ path: "themes/other/lineage.json" })],
)) === null, "theme path must be themes/<slug>/lineage.json");
ok(Core.parseQualityManifest(qualityManifest(
  [qualityRow({ path: "test-2026/lineage-v2.json" })],
)) === null, "conference path must be <slug>/lineage.json");
ok(Core.parseQualityManifest(qualityManifest([qualityRow({ node_count: 12.5 })])) === null,
   "counts must be non-negative integers");
ok(Core.parseQualityManifest(qualityManifest([qualityRow({ freshness: "unknown" })])) === null,
   "freshness is a closed enum");
ok(Core.parseQualityManifest(qualityManifest([themeRow(), qualityRow()])) === null,
   "collections must be sorted by collection_id");
ok(Core.parseQualityManifest(qualityManifest([qualityRow(), qualityRow()])) === null,
   "collections must be unique by collection_id");
ok(Core.parseQualityManifest(qualityManifest(
  [deepRow({ audit_status: "passed", manifest_input_sha256: null })],
)) === null, "ready+passed deep row requires manifest hash");
ok(Core.parseQualityManifest(qualityManifest([
  qualityRow(),
  deepRow({
    collection_id: "deep:test-2026:file:deep-2602.18473.json",
    paper_id: null, arxiv_id: null, manifest_input_sha256: null,
    availability: "failed", audit_status: "unknown",
  }),
])) !== null, "unresolved deep row stays explicit without identity");

console.log("quality audit rejections");
const auditMutations = {
  "audit rejects extra keys": qualityRow({ audit: { extra: true } }),
  "audit requires the ci actor": qualityRow({ audit: { actor: "human" } }),
  "audit timestamp requires a timezone": qualityRow({ audit: { evaluated_at: "2026-08-30" } }),
  "check rejects extra keys": qualityRow({ audit: { checks: [{ extra: true }] } }),
  "check evidence is bounded string list": qualityRow({
    audit: { checks: [{ evidence: Array.from({ length: 21 }, (_, i) => String(i)) }] },
  }),
  "checks must be sorted by name": qualityRow({
    audit: { checks: [{ name: "zeta" }, { name: "alpha" }] },
  }),
  "checks must be unique by name": qualityRow({
    audit: { checks: [{ name: "alpha" }, { name: "alpha" }] },
  }),
};
for (const [label, row] of Object.entries(auditMutations)) {
  const candidate = structuredClone(row);
  // Merge the mutation over the canonical audit so each case breaks exactly
  // one rule at a time.
  candidate.audit = { ...structuredClone(qualityRow().audit), ...row.audit };
  if (row.audit.checks) {
    candidate.audit.checks = row.audit.checks.map((check) => ({
      name: "artifact_contract_v1", status: "passed",
      observed: 0, expected: 0, evidence: [],
      ...check,
    }));
  }
  ok(Core.parseQualityManifest(qualityManifest([candidate])) === null, label);
}

console.log("theme artifact parsing");
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
const parsedTheme = Core.parseArtifact(themeArtifact(), { kind: "theme" });
ok(parsedTheme !== null, "strict theme artifact is accepted");
ok(Core.resolveFocus(parsedTheme, "2601.00001")?.id === "seed-a",
   "theme focus resolves through an exact alias");
const seedlessTheme = themeArtifact();
delete seedlessTheme.nodes[2].seed_paper_id;
ok(Core.parseArtifact(seedlessTheme, { kind: "theme" }) === null,
   "theme focus without canonical seed_paper_id is rejected");
const legacyTheme = themeArtifact();
legacyTheme.edges.forEach((edge) => {
  delete edge.relation;
  delete edge.confidence;
});
ok(Core.parseArtifact(legacyTheme, { kind: "theme" }) === null,
   "theme artifact with legacy rel/conf-only edges is rejected");

console.log("theme strict metadata and aliases");
for (const [label, mutate] of [
  ["theme meta kind must match the requested kind", (value) => { value.meta.kind = "conference"; }],
  ["theme generator is required", (value) => { delete value.meta.generator; }],
  ["theme generated_at must be a valid timezone timestamp", (value) => {
    value.meta.generated_at = "2026-02-30T00:00:00Z";
  }],
  ["theme clusters must be empty", (value) => { value.clusters = [{ id: "legacy" }]; }],
  ["non-focus seed_paper_id is validated when present", (value) => {
    value.nodes[0].seed_paper_id = "BAD";
  }],
  ["theme rejects Semantic Scholar as a canonical alias", (value) => {
    value.nodes[1].aliases = [["semantic_scholar", "seed-a"]];
  }],
  ["node aliases must already be normalized", (value) => {
    value.nodes[1].aliases = [["arxiv", "2601.00001v2"]];
  }],
  ["node aliases are graph-wide unique", (value) => {
    value.nodes[2].aliases = [["arxiv", "2601.00001"]];
  }],
]) {
  const candidate = themeArtifact();
  mutate(candidate);
  ok(Core.parseArtifact(candidate, { kind: "theme" }) === null, label);
}

console.log("quality authorization consistency");
for (const [label, overrides] of [
  ["passed row requires lineage-artifact-v1", { artifact_schema_version: "legacy" }],
  ["passed row requires an artifact hash", { input_sha256: null }],
  ["passed row requires a frozen fixture hash", {
    audit: { ...qualityRow().audit, fixture_sha256: null },
  }],
  ["passed row cannot contain a failed check", {
    audit: {
      ...qualityRow().audit,
      checks: qualityRow().audit.checks.map((check) => (
        check.name === "golden_fixture" ? { ...check, status: "failed" } : check
      )),
    },
  }],
  ["passed row requires artifact_contract_v1", {
    audit: {
      ...qualityRow().audit,
      checks: [qualityRow().audit.checks[1]],
    },
  }],
]) {
  ok(Core.parseQualityManifest(qualityManifest([qualityRow(overrides)])) === null, label);
}
const failedWithoutFailedCheck = qualityRow({ audit_status: "failed" });
ok(Core.parseQualityManifest(qualityManifest([failedWithoutFailedCheck])) === null,
   "failed audit_status requires a failed check");
ok(Core.parseQualityManifest(qualityManifest([], { as_of: "2026-02-30T00:00:00Z" })) === null,
   "impossible calendar timestamps are rejected");

console.log("bounded JSON fetch");
const originalFetch = globalThis.fetch;
try {
  const compatibleBytes = new TextEncoder().encode('{"ok":true}');
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => null },
    arrayBuffer: async () => compatibleBytes.buffer.slice(
      compatibleBytes.byteOffset, compatibleBytes.byteOffset + compatibleBytes.byteLength,
    ),
  });
  const compatible = await Core.fetchJsonWithSha256("compatible.json");
  ok(compatible?.data?.ok === true && /^[0-9a-f]{64}$/.test(compatible.sha256),
     "existing two-argument conference/deep fetch contract remains compatible");

  let arrayBufferCalled = false;
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: (name) => name === "content-length" ? String(Core.MAX_JSON_BYTES + 1) : null },
    arrayBuffer: async () => { arrayBufferCalled = true; return new ArrayBuffer(0); },
  });
  ok(await Core.fetchJsonWithSha256("oversize.json") === null && !arrayBufferCalled,
     "oversized Content-Length is rejected before body allocation");

  let cancelled = false;
  let reads = 0;
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          reads++;
          return reads === 1
            ? { done: false, value: new Uint8Array(Core.MAX_JSON_BYTES + 1) }
            : { done: true };
        },
        cancel: async () => { cancelled = true; },
      }),
    },
  });
  ok(await Core.fetchJsonWithSha256("stream-oversize.json") === null && cancelled,
     "streaming response is cancelled as soon as the byte limit is exceeded");

  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(Core.MAX_JSON_BYTES + 1),
  });
  ok(await Core.fetchJsonWithSha256("fallback-oversize.json") === null,
     "non-streaming fallback enforces the byte limit after allocation");
} finally {
  globalThis.fetch = originalFetch;
}

const publicQuality = Core.parseQualityManifest(JSON.parse(readFileSync(
  resolve(here, "../../../docs/lineage-quality-v1.json"), "utf8",
)));
ok(publicQuality !== null, "generated public quality read model matches the strict reader");
const publicConferenceRows = publicQuality?.collections.filter(
  (row) => row.kind === "conference",
) || [];
ok(publicConferenceRows.length === 10
   && publicConferenceRows.every((row) => !Core.qualityRowIsEligible(row)),
   "all 10 conference artifacts remain fail closed until their audits pass");
const publicDeepRows = publicQuality?.collections.filter((row) => row.kind === "deep") || [];
ok(publicDeepRows.length === 14
   && publicDeepRows.every((row) => !Core.qualityRowIsEligible(row)),
   "all 14 legacy deep artifacts are explicit and remain fail closed");
const publicThemeRows = publicQuality?.collections.filter((row) => row.kind === "theme") || [];
ok(publicThemeRows.length === 3
   && publicThemeRows.every((row) => !Core.qualityRowIsEligible(row)),
   "all 3 legacy theme artifacts remain fail closed until human-reviewed fixtures");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

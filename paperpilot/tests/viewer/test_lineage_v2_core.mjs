// Contract tests for docs/assets/lineage-v2-core.js.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../..");
const source = readFileSync(resolve(repository, "docs/assets/lineage-v2-core.js"), "utf8");
globalThis.window = globalThis;
(0, eval)(source);
const Core = globalThis.PaperPilotLineageV2;

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

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
  ).join(",")}}`;
}

function bytes(value) {
  return Buffer.from(`${canonical(value)}\n`, "utf8");
}

function digest(value) {
  const input = Buffer.isBuffer(value) ? value : bytes(value);
  return createHash("sha256").update(input).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

const bundleRoot = resolve(
  repository, "paperpilot/tests/fixtures/lineage-pilot/positive-release",
);

function loadPositiveBundle() {
  const index = JSON.parse(readFileSync(resolve(bundleRoot, "lineage-pilot-index-v1.json"), "utf8"));
  const entry = index.entries[0];
  return {
    index,
    artifact: JSON.parse(readFileSync(resolve(bundleRoot, entry.artifact.path), "utf8")),
    fixture: JSON.parse(readFileSync(resolve(bundleRoot, entry.fixture.path), "utf8")),
    quality: JSON.parse(readFileSync(resolve(bundleRoot, entry.quality.path), "utf8")),
    catalog: JSON.parse(readFileSync(resolve(bundleRoot, "catalog.json"), "utf8")),
  };
}

function rebind(bundle) {
  const entry = bundle.index.entries[0];
  const fixtureCollection = bundle.fixture.collections.find(
    (item) => item.collection_id === entry.collection_id,
  );
  const evidenceById = new Map(bundle.artifact.evidence.map((item) => [item.id, item]));
  const labelByReview = new Map(
    fixtureCollection.edge_labels.map((item) => [item.review_id, item]),
  );
  for (const claim of bundle.artifact.claims) {
    const evidenceHash = digest(claim.evidence_ids.map((id) => evidenceById.get(id))
      .sort((left, right) => left.id.localeCompare(right.id)));
    if (claim.review_binding !== null) claim.review_binding.evidence_sha256 = evidenceHash;
    const label = claim.review_binding === null ? fixtureCollection.edge_labels.find(
      (item) => item.src === claim.src && item.dst === claim.dst,
    ) : labelByReview.get(claim.review_binding.review_id);
    if (label) {
      label.src = claim.src;
      label.dst = claim.dst;
      label.evidence_sha256 = evidenceHash;
    }
  }
  const artifactBytes = bytes(bundle.artifact);
  const artifactHash = digest(artifactBytes);
  entry.artifact.sha256 = artifactHash;
  entry.artifact.path = `lineage-pilots/${entry.conference}/${entry.paper_id}/artifacts/${artifactHash}.json`;
  fixtureCollection.artifact_sha256 = artifactHash;
  const row = bundle.quality.collections[0];
  row.artifact_sha256 = artifactHash;
  row.path = entry.artifact.path;
  const fixtureBytes = bytes(bundle.fixture);
  const fixtureHash = digest(fixtureBytes);
  entry.fixture.sha256 = fixtureHash;
  entry.fixture.path = `lineage-pilots/${entry.conference}/${entry.paper_id}/fixtures/${fixtureHash}.json`;
  row.fixture_sha256 = fixtureHash;
  const qualityBytes = bytes(bundle.quality);
  const qualityHash = digest(qualityBytes);
  entry.quality.sha256 = qualityHash;
  entry.quality.path = `lineage-pilots/${entry.conference}/${entry.paper_id}/quality/${qualityHash}.json`;
  return { artifactBytes, fixtureBytes, qualityBytes };
}

async function verify(bundle) {
  const rebound = rebind(bundle);
  const index = Core.parsePilotIndex(bundle.index);
  if (index === null) return null;
  const entry = Core.resolvePilotEntry(index, bundle.index.entries[0].paper_id);
  return Core.verifyPilotRelease({
    entry,
    ...rebound,
    catalogPaperIds: bundle.catalog.map((paper) => paper.paper_id),
  });
}

console.log("pilot index and immutable release");
const positive = loadPositiveBundle();
const rawPositiveBytes = {
  artifactBytes: readFileSync(resolve(bundleRoot, positive.index.entries[0].artifact.path)),
  fixtureBytes: readFileSync(resolve(bundleRoot, positive.index.entries[0].fixture.path)),
  qualityBytes: readFileSync(resolve(bundleRoot, positive.index.entries[0].quality.path)),
};
const parsedIndex = Core.parsePilotIndex(clone(positive.index));
ok(parsedIndex !== null && Object.isFrozen(parsedIndex.entries[0]), "closed pilot index is frozen");
const entry = Core.resolvePilotEntry(parsedIndex, "1".repeat(40));
const release = await Core.verifyPilotRelease({
  entry,
  ...rawPositiveBytes,
  catalogPaperIds: positive.catalog.map((paper) => paper.paper_id),
});
ok(release !== null, "backend cross-language fixture verifies from exact bytes");
ok(Object.getPrototypeOf(release) === null && Object.isFrozen(release.artifact.nodes[0]),
   "verified release is null-prototype and deeply frozen");
ok(release.row === release.qualityRow, "row compatibility alias preserves object identity");
ok(await Core.verifyPilotRelease({
  entry: Object.freeze(clone(entry)), ...rawPositiveBytes,
  catalogPaperIds: positive.catalog.map((paper) => paper.paper_id),
}) === null, "a frozen raw entry cannot forge the private index brand");
const corruptArtifact = Buffer.from(rawPositiveBytes.artifactBytes);
corruptArtifact[corruptArtifact.length - 2] ^= 1;
ok(await Core.verifyPilotRelease({
  entry, ...rawPositiveBytes, artifactBytes: corruptArtifact,
  catalogPaperIds: positive.catalog.map((paper) => paper.paper_id),
}) === null, "actual artifact byte hash is mandatory");
ok(await Core.verifyPilotRelease({
  entry, ...rawPositiveBytes, catalogPaperIds: ["2".repeat(40)],
}) === null, "catalog membership is bound from actual canonical IDs");
const racedArtifact = Buffer.from(rawPositiveBytes.artifactBytes);
const trustedArtifact = Buffer.from(racedArtifact);
const titleOffset = racedArtifact.indexOf("Synthetic Parent");
racedArtifact.write("Synthetic Forged", titleOffset, "utf8");
const racedVerification = Core.verifyPilotRelease({
  entry,
  ...rawPositiveBytes,
  artifactBytes: racedArtifact,
  catalogPaperIds: positive.catalog.map((paper) => paper.paper_id),
});
trustedArtifact.copy(racedArtifact);
ok(await racedVerification === null,
   "all BufferSources are snapshotted before the first asynchronous hash");

const duplicateIndex = clone(positive.index);
duplicateIndex.entries.push(clone(duplicateIndex.entries[0]));
ok(Core.parsePilotIndex(duplicateIndex) === null, "duplicate paper IDs reject the whole index");
const escapedPath = clone(positive.index);
escapedPath.entries[0].artifact.path = escapedPath.entries[0].artifact.path.replace(
  "lineage-pilots/", "lineage-pilots/%2e%2e/",
);
ok(Core.parsePilotIndex(escapedPath) === null, "percent/traversal paths are rejected");

console.log("strict semantic negatives");
const malformedUrl = loadPositiveBundle();
malformedUrl.artifact.evidence[0].url = "https://[";
ok(await verify(malformedUrl) === null, "malformed evidence URL returns null without throwing");
const extraClassification = loadPositiveBundle();
extraClassification.artifact.claims[0].classification.extra = true;
ok(await verify(extraClassification) === null, "nested extra classification field is rejected");
const noncanonicalDoi = loadPositiveBundle();
noncanonicalDoi.artifact.nodes[0].aliases = [["doi", "10.1234/foo%2fbar"]];
ok(await verify(noncanonicalDoi) === null, "percent-decoded DOI aliases must already be canonical");
const badEndpoint = loadPositiveBundle();
badEndpoint.artifact.evidence[0].cited_work_id = badEndpoint.artifact.evidence[0].citing_work_id;
ok(await verify(badEndpoint) === null, "evidence endpoint binding is enforced");
const lowKappa = loadPositiveBundle();
lowKappa.fixture.collections[0].edge_labels[1].reviews[1].evidence_support = "supports";
ok(await verify(lowKappa) === null, "declared agreement cannot replace recomputed kappa");
const rawForgery = clone(release);
rawForgery.verified = true;
ok(Core.selectFocusProjection(rawForgery, Object.freeze({})) === null,
   "public properties cannot forge a verified release");

console.log("state normalization and exact round trip");
const defaultState = Core.readState(release, { params: new URLSearchParams(), mobile: true });
ok(defaultState.view === "list" && defaultState.hops === 1 && defaultState.nodeLimit === 7
   && defaultState.claimLimit === 18 && defaultState.statusCodes.length === 0,
   "responsive defaults are 1-hop, 7-node, 18-claim list");
const explicitGraph = Core.readState(release, {
  params: new URLSearchParams("view=graph"), mobile: true, prefs: { view: "list" },
});
ok(explicitGraph.view === "graph", "URL view overrides prefs and mobile");
const unknownFocus = Core.readState(release, { params: new URLSearchParams("focus=missing") });
ok(unknownFocus.focusId === null && Core.selectFocusProjection(release, unknownFocus) === null,
   "unknown explicit focus never falls back to root");
const emptyRelations = Core.readState(release, { params: new URLSearchParams("relations=") });
ok(emptyRelations.relationFilterExplicit && emptyRelations.relations.length === 0
   && Core.selectFocusProjection(release, emptyRelations).counts.eligibleClaims === 0,
   "explicit empty relation set restores zero claims");
const unknownEvidence = Core.readState(release, {
  params: new URLSearchParams("evidence_sources=not-a-source"),
});
ok(unknownEvidence.evidenceSourcesExplicit && unknownEvidence.evidenceSources.length === 0
   && Core.selectFocusProjection(release, unknownEvidence).counts.eligibleClaims === 0,
   "unknown explicit evidence cannot broaden to all evidence");
const duplicateTrust = Core.readState(release, {
  params: new URLSearchParams("trust=verified&trust=tentative"),
});
ok(duplicateTrust.trustTiers.length === 0
   && Core.selectFocusProjection(release, duplicateTrust).counts.eligibleClaims === 0,
   "duplicate filter keys never first-match");
const ambiguousRelations = Core.readState(release, {
  params: new URLSearchParams("relations=extends&rels="),
});
ok(ambiguousRelations.relations.length === 0
   && ambiguousRelations.statusCodes.includes("ambiguous_relations")
   && Core.selectFocusProjection(release, ambiguousRelations).counts.eligibleClaims === 0,
   "simultaneous relation aliases cannot silently ignore an empty filter");
const ambiguousEvidence = Core.readState(release, {
  params: new URLSearchParams("evidence=source%3Asynthetic-primary&evidence_sources="),
});
ok(ambiguousEvidence.evidenceSourcesExplicit && ambiguousEvidence.evidenceKindsExplicit
   && Core.selectFocusProjection(release, ambiguousEvidence).counts.eligibleClaims === 0,
   "legacy and split evidence filters cannot broaden each other");
const duplicateLegacyEvidence = Core.readState(release, {
  params: new URLSearchParams(
    "evidence=source%3Asynthetic-primary%2Ckind%3Apaper-text&evidence=",
  ),
});
ok(Core.selectFocusProjection(release, duplicateLegacyEvidence).counts.eligibleClaims === 0,
   "duplicate legacy evidence filters cannot first-match a broader occurrence");

function makeLargeBundle() {
  const paperId = "1".repeat(40);
  const conference = "synthetic-large";
  const collectionId = `deep:${conference}:paper:${paperId}`;
  const nodes = Array.from({ length: 200 }, (_, index) => ({
    id: index === 17 ? "node:comma,slash\\雪" : `node:${String(index).padStart(3, "0")}`,
    title: `Synthetic node ${index}`,
    first_published_at: `${2020 + Math.floor(index / 40)}-01-01`,
    is_focus: index === 0,
    seed_paper_id: index === 0 ? paperId : null,
    aliases: index === 0 ? [["openreview", "synthetic-large-root"]] : [],
  }));
  const evidence = [];
  const links = [];
  const claims = [];
  const labels = [];
  let candidate = 0;
  outer: for (let src = 0; src < nodes.length; src++) {
    for (let dst = src + 1; dst < nodes.length; dst++) {
      const id = String(candidate).padStart(4, "0");
      const evidenceId = `evidence:${id}`;
      const excerpt = `Synthetic evidence ${id}`;
      evidence.push({
        id: evidenceId,
        source: "synthetic",
        kind: "citation_context",
        source_work_id: `synthetic-work:${id}`,
        cited_work_id: nodes[src].id,
        citing_work_id: nodes[dst].id,
        url: `https://example.invalid/evidence/${id}`,
        locator: { page: 1, section: null, reference_marker: null, sentence_ordinal: null, paragraph_ordinal: null },
        excerpt,
        excerpt_sha256: digest(Buffer.from(excerpt)),
        input_sha256: "a".repeat(64),
        retrieved_at: "2026-01-01T00:00:00Z",
        snapshot_ref: "synthetic-large-snapshot",
      });
      links.push({ id: `link:${id}`, src: nodes[dst].id, dst: nodes[src].id, type: "citation", evidence_ids: [evidenceId] });
      const accepted = candidate < 900;
      const comparison = candidate < 6;
      const relation = accepted
        ? (comparison ? "contrasts" : candidate % 2 === 0 ? "extends" : "successor") : null;
      const reviewId = `review:${id}`;
      const evidenceHash = digest([evidence[evidence.length - 1]]);
      claims.push({
        id: `claim:${id}`,
        src: nodes[src].id,
        dst: nodes[dst].id,
        claim_family: comparison ? "comparison" : "genealogy",
        relation,
        decision: accepted ? "accepted" : "unknown",
        trust_tier: accepted ? "verified" : "tentative",
        raw_score: null,
        calibrated_probability: null,
        calibration_id: null,
        evidence_ids: [evidenceId],
        rationale: accepted ? `Synthetic rationale ${id}` : "",
        classification: { method: "human_review", provider: null, model: null, prompt_version: null, schema_version: "synthetic-v1" },
        reason_codes: accepted ? [] : ["insufficient_evidence"],
        review_binding: accepted ? { review_id: reviewId, fixture_id: "synthetic-large-fixture", evidence_sha256: evidenceHash } : null,
      });
      const gold = {
        citation_valid: true,
        gold_family: accepted ? (comparison ? "comparison" : "genealogy") : null,
        gold_relation: relation,
        evidence_support: accepted ? "supports" : "insufficient",
      };
      labels.push({
        review_id: reviewId,
        collection_id: collectionId,
        src: nodes[src].id,
        dst: nodes[dst].id,
        evidence_sha256: evidenceHash,
        reviews: ["synthetic-human-a", "synthetic-human-b"].map((reviewer_id) => ({
          reviewer_id,
          blind_to_model: true,
          blind_to_peer: true,
          ...gold,
          notes: "Synthetic test review only.",
          reviewed_at: "2026-01-03T00:00:00Z",
        })),
        adjudication: {
          adjudicator_id: "synthetic-human-c",
          ...gold,
          notes: "Synthetic test adjudication only.",
          reviewed_at: "2026-01-04T00:00:00Z",
        },
      });
      if (++candidate === 1000) break outer;
    }
  }
  const universe = {
    snapshot_ref: "synthetic-large-snapshot",
    input_sha256: "b".repeat(64),
    selection_method: "deterministic-test-only",
    candidate_count: claims.length,
  };
  const artifact = {
    schema_version: "lineage-artifact-v2",
    release_id: "synthetic-large-release",
    root: nodes[0].id,
    nodes,
    links,
    evidence,
    claims,
    clusters: [],
    meta: {
      kind: "deep",
      producer: { name: "synthetic-large-generator", version: "1" },
      generated_at: "2026-01-01T00:00:00Z",
      candidate_universe: universe,
    },
  };
  const fixture = {
    schema_version: "lineage-audit-fixtures-v2",
    fixture_id: "synthetic-large-fixture",
    created_at: "2026-01-02T00:00:00Z",
    collections: [{
      collection_id: collectionId,
      release_id: artifact.release_id,
      artifact_sha256: "0".repeat(64),
      candidate_universe: clone(universe),
      focus_labels: [{ node_id: nodes[0].id, on_topic: true }],
      edge_labels: labels,
    }],
  };
  const decisionCounts = { accepted: 900, unknown: 100, abstained: 0, rejected: 0 };
  const checks = [
    "artifact_contract_v2", "identity", "evidence_binding", "review_binding", "accepted_dag",
    "accepted_temporal", "frozen_candidate_ledger",
  ].map((name) => ({ name, status: "passed", detail: "Synthetic test only." }));
  const quality = {
    schema_version: "lineage-quality-v2",
    audit_version: "audit-v2",
    as_of: "2026-01-05T00:00:00Z",
    collections: [{
      collection_id: collectionId,
      kind: "deep",
      slug: conference,
      label: "Synthetic large graph",
      path: "placeholder/synthetic-large/artifact.json",
      release_id: artifact.release_id,
      release_profile: "claim-verified-pilot-v1",
      availability: "ready",
      audit_status: "passed",
      artifact_schema_version: "lineage-artifact-v2",
      artifact_sha256: "0".repeat(64),
      fixture_sha256: "0".repeat(64),
      node_count: nodes.length,
      link_count: links.length,
      claim_decision_count: claims.length,
      accepted_genealogy_count: 894,
      accepted_comparison_count: 6,
      decision_counts: decisionCounts,
      calibration: {
        status: "not_applicable", reason: "Synthetic claim-verified pilot.", sample_count: 0,
        wilson_lower_bound: null, supersedes_wilson_lower_bound: null, macro_precision: null,
        ece: null, brier: null, accepted_coverage: null, unknown_abstained_recall: null,
      },
      review: { status: "passed", reviewed_claim_count: 900, agreement: 1, fixture_id: fixture.fixture_id },
      checks,
    }],
  };
  return {
    index: { schema_version: "lineage-pilot-index-v1", entries: [{
      paper_id: paperId,
      conference,
      collection_id: collectionId,
      release_id: artifact.release_id,
      release_profile: "claim-verified-pilot-v1",
      artifact: { path: "placeholder", sha256: "0".repeat(64) },
      fixture: { path: "placeholder", sha256: "0".repeat(64) },
      quality: { path: "placeholder", sha256: "0".repeat(64) },
    }] },
    artifact,
    fixture,
    quality,
    catalog: [{
      paper_id: paperId,
      title: "Synthetic large root",
      authors: ["Synthetic Author"],
      tags: ["Synthetic"],
      abstract: "Synthetic 200-node/1,000-claim browser QA fixture only.",
    }],
  };
}

console.log("large deterministic Focus View");
const largeBundle = makeLargeBundle();
const largeRelease = await verify(largeBundle);
ok(largeRelease !== null, "200-node/1,000-claim synthetic release verifies");
const largeState = Core.readState(largeRelease, { params: new URLSearchParams() });
const largeProjection = Core.selectFocusProjection(largeRelease, largeState);
ok(largeProjection.nodes.length <= 7 && largeProjection.claims.length <= 18,
   "default projection respects 7/18 caps");
ok(largeProjection.counts.totalNodes === 200 && largeProjection.counts.allClaims === 1000
   && largeProjection.counts.acceptedGenealogyClaims === 894
   && largeProjection.counts.acceptedComparisonClaims === 6,
   "raw, ledger, and accepted denominators remain separate");
ok(largeProjection.claims.every((claim) => claim.decision === "accepted"
   && claim.trust_tier === "verified" && claim.claim_family === "genealogy"),
   "default projection contains only accepted trusted genealogy");
const comparisonState = Core.readState(largeRelease, {
  params: new URLSearchParams(
    "families=genealogy%2Ccomparison&relations=extends%2Csuccessor%2Csupersedes%2Cablation%2Cbaseline_only%2Ccontrasts",
  ),
});
const comparisonProjection = Core.selectFocusProjection(largeRelease, comparisonState);
const comparisonOnly = Core.selectFocusProjection(largeRelease, Core.readState(largeRelease, {
  params: new URLSearchParams("families=comparison&relations=contrasts&limit=5"),
}));
ok(comparisonOnly.comparisonClaims.length > 0 && comparisonOnly.nodes.length <= 5,
   "explicit comparison-only view adds direct focus neighbours within the node cap");
ok(comparisonOnly.comparisonClaims.every(claim => claim.src === comparisonOnly.focus.id || claim.dst === comparisonOnly.focus.id),
   "comparison-only expansion does not traverse comparison chains");
ok(comparisonProjection.comparisonClaims.length <= 6
   && comparisonProjection.genealogyClaims.length + comparisonProjection.comparisonClaims.length <= 18,
   "comparison is explicit, capped at six, and remains inside the total claim cap");

const permutedBundle = clone(largeBundle);
for (const field of ["nodes", "links", "evidence", "claims"]) permutedBundle.artifact[field].reverse();
permutedBundle.fixture.collections[0].edge_labels.reverse();
const permutedRelease = await verify(permutedBundle);
const permutedProjection = Core.selectFocusProjection(
  permutedRelease, Core.readState(permutedRelease, { params: new URLSearchParams() }),
);
ok(JSON.stringify(largeProjection.nodes.map((node) => node.id))
   === JSON.stringify(permutedProjection.nodes.map((node) => node.id))
   && JSON.stringify(largeProjection.claims.map((claim) => claim.id))
   === JSON.stringify(permutedProjection.claims.map((claim) => claim.id)),
   "projection order is independent of all input array orders");

const wideState = Core.readState(largeRelease, {
  params: new URLSearchParams("limit=50"),
});
const wideProjection = Core.selectFocusProjection(largeRelease, wideState);
const specialId = "node:comma,slash\\雪";
const expandedIds = [...new Set([...wideProjection.nodes.map((node) => node.id), specialId])];
const expandedState = Core.readState(largeRelease, {
  params: new URLSearchParams({
    limit: "50",
    expanded: expandedIds.map((id) => id.replaceAll("\\", "\\\\").replaceAll(",", "\\,")).join(","),
  }),
});
const roundTrip = Core.readState(largeRelease, {
  params: Core.writeState("https://paperpilot.local/lineage/", expandedState).searchParams,
});
ok(roundTrip.expandedNodeIds.includes(specialId),
   "escaped CSV preserves exact comma, backslash, and Unicode node IDs");
const expandedProjection = Core.selectFocusProjection(largeRelease, expandedState);
ok(expandedProjection.forceList || (expandedProjection.nodes.length <= 50
   && expandedProjection.claims.length <= 80),
   "explicit expansion either stays graph-safe or requests list fallback");

const emitIndex = process.argv.indexOf("--emit");
if (emitIndex !== -1) {
  const outputRoot = process.argv[emitIndex + 1];
  if (!outputRoot) throw new Error("--emit requires an output directory");
  const rebound = rebind(largeBundle);
  const emittedEntry = largeBundle.index.entries[0];
  const outputs = [
    ["lineage-pilot-index-v1.json", bytes(largeBundle.index)],
    ["catalog.json", bytes(largeBundle.catalog)],
    [emittedEntry.artifact.path, rebound.artifactBytes],
    [emittedEntry.fixture.path, rebound.fixtureBytes],
    [emittedEntry.quality.path, rebound.qualityBytes],
  ];
  for (const [path, content] of outputs) {
    const destination = resolve(outputRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  console.log(`emitted large synthetic release: ${outputRoot}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

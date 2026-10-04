/**
 * Ports paperpilot/tests/viewer/test_lineage_v2_core.mjs's cases 1:1
 * against the TS port in lib/lineage/v2/* (not the JS) -- same
 * fixtures (paperpilot/tests/fixtures/lineage-pilot/positive-release),
 * same `makeLargeBundle`/`rebind` synthetic-release generator, same
 * assertions. See lib/lineage/v2/constants.ts's module doc for why
 * byte-identical behaviour with docs/assets/lineage-v2-core.js matters
 * (safety-contracts.md SCR-47/SCR-48).
 *
 * `canonical`/`bytes`/`digest` below are deliberately reimplemented
 * independently of lib/lineage/v2/json.ts's own `canonicalJson`/
 * `sha256` (even though they compute the same thing) -- using the
 * module under test to build its own test fixtures would make the
 * hash-mismatch assertions tautological.
 */
// biome-ignore-all lint/suspicious/noExplicitAny: this file rebuilds/mutates
// raw JSON fixtures (bypassing the strict TS port's own types on purpose,
// to probe its runtime validation) with loosely-typed helpers throughout --
// same rationale as test/lineage/core.test.ts.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PilotIndex, PilotIndexEntry, Release } from "../../../lib/lineage/v2";
import {
  parsePilotIndex,
  readState,
  resolvePilotEntry,
  selectFocusProjection,
  verifyPilotRelease,
  writeState,
} from "../../../lib/lineage/v2";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../../../..");
const bundleRoot = resolve(repository, "paperpilot/tests/fixtures/lineage-pilot/positive-release");

if (!existsSync(bundleRoot)) {
  throw new Error(
    `fixture root not found at ${bundleRoot} -- check the relative depth from this test file`,
  );
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
    .join(",")}}`;
}

function bytes(value: unknown): Buffer {
  return Buffer.from(`${canonical(value)}\n`, "utf8");
}

function digest(value: unknown): string {
  const input = Buffer.isBuffer(value) ? value : bytes(value);
  return createHash("sha256").update(input).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface PositiveBundle {
  index: PilotIndex;
  artifact: Record<string, unknown>;
  fixture: Record<string, unknown>;
  quality: Record<string, unknown>;
  catalog: Array<{ paper_id: string }>;
}

function loadPositiveBundle(): PositiveBundle {
  const index = JSON.parse(
    readFileSync(resolve(bundleRoot, "lineage-pilot-index-v1.json"), "utf8"),
  );
  const entry = index.entries[0] as PilotIndexEntry;
  return {
    index,
    artifact: JSON.parse(readFileSync(resolve(bundleRoot, entry.artifact.path), "utf8")),
    fixture: JSON.parse(readFileSync(resolve(bundleRoot, entry.fixture.path), "utf8")),
    quality: JSON.parse(readFileSync(resolve(bundleRoot, entry.quality.path), "utf8")),
    catalog: JSON.parse(readFileSync(resolve(bundleRoot, "catalog.json"), "utf8")),
  };
}

function rebind(bundle: PositiveBundle) {
  const entry = bundle.index.entries[0] as unknown as Record<string, any>;
  const fixtureCollections = bundle.fixture.collections as unknown as Array<Record<string, any>>;
  const fixtureCollection = fixtureCollections.find(
    (item) => item.collection_id === entry.collection_id,
  ) as Record<string, any>;
  const evidenceList = (bundle.artifact as unknown as { evidence: Array<Record<string, any>> })
    .evidence;
  const evidenceById = new Map(evidenceList.map((item) => [item.id, item]));
  const labelByReview = new Map(
    (fixtureCollection.edge_labels as Array<Record<string, any>>).map((item) => [
      item.review_id,
      item,
    ]),
  );
  const claims = (bundle.artifact as unknown as { claims: Array<Record<string, any>> }).claims;
  for (const claim of claims) {
    const evidenceHash = digest(
      (claim.evidence_ids as string[])
        .map((id) => evidenceById.get(id) as Record<string, any>)
        .sort((left, right) => String(left.id).localeCompare(String(right.id))),
    );
    if (claim.review_binding !== null) claim.review_binding.evidence_sha256 = evidenceHash;
    const label =
      claim.review_binding === null
        ? (fixtureCollection.edge_labels as Array<Record<string, any>>).find(
            (item) => item.src === claim.src && item.dst === claim.dst,
          )
        : labelByReview.get(claim.review_binding.review_id);
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
  const row = (bundle.quality.collections as Array<Record<string, any>>)[0] as Record<string, any>;
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

async function verify(bundle: PositiveBundle): Promise<Release | null> {
  const rebound = rebind(bundle);
  const index = parsePilotIndex(bundle.index);
  if (index === null) return null;
  const entry = resolvePilotEntry(index, (bundle.index.entries[0] as PilotIndexEntry).paper_id);
  if (!entry) return null;
  return verifyPilotRelease({
    entry,
    ...rebound,
    catalogPaperIds: bundle.catalog.map((paper) => paper.paper_id),
  });
}

describe("pilot index and immutable release", () => {
  const positive = loadPositiveBundle();
  const rawPositiveBytes = {
    artifactBytes: readFileSync(
      resolve(bundleRoot, (positive.index.entries[0] as PilotIndexEntry).artifact.path),
    ),
    fixtureBytes: readFileSync(
      resolve(bundleRoot, (positive.index.entries[0] as PilotIndexEntry).fixture.path),
    ),
    qualityBytes: readFileSync(
      resolve(bundleRoot, (positive.index.entries[0] as PilotIndexEntry).quality.path),
    ),
  };

  it("closed pilot index is frozen", () => {
    const parsedIndex = parsePilotIndex(clone(positive.index));
    expect(parsedIndex).not.toBeNull();
    expect(Object.isFrozen(parsedIndex?.entries[0])).toBe(true);
  });

  it("backend cross-language fixture verifies from exact bytes, and the release is null-prototype and deeply frozen", async () => {
    const parsedIndex = parsePilotIndex(clone(positive.index)) as PilotIndex;
    const entry = resolvePilotEntry(parsedIndex, "1".repeat(40)) as PilotIndexEntry;
    const release = await verifyPilotRelease({
      entry,
      ...rawPositiveBytes,
      catalogPaperIds: positive.catalog.map((paper) => paper.paper_id),
    });
    expect(release).not.toBeNull();
    expect(Object.getPrototypeOf(release)).toBeNull();
    expect(Object.isFrozen((release as Release).artifact.nodes[0])).toBe(true);
    expect((release as Release).row).toBe((release as Release).qualityRow);
  });

  it("a frozen raw entry cannot forge the private index brand", async () => {
    const parsedIndex = parsePilotIndex(clone(positive.index)) as PilotIndex;
    const entry = resolvePilotEntry(parsedIndex, "1".repeat(40)) as PilotIndexEntry;
    const forgedEntry = Object.freeze(clone(entry));
    const release = await verifyPilotRelease({
      entry: forgedEntry,
      ...rawPositiveBytes,
      catalogPaperIds: positive.catalog.map((paper) => paper.paper_id),
    });
    expect(release).toBeNull();
  });

  it("actual artifact byte hash is mandatory", async () => {
    const parsedIndex = parsePilotIndex(clone(positive.index)) as PilotIndex;
    const entry = resolvePilotEntry(parsedIndex, "1".repeat(40)) as PilotIndexEntry;
    const corruptArtifact = Buffer.from(rawPositiveBytes.artifactBytes);
    const flipIndex = corruptArtifact.length - 2;
    corruptArtifact[flipIndex] = (corruptArtifact[flipIndex] as number) ^ 1;
    const release = await verifyPilotRelease({
      entry,
      ...rawPositiveBytes,
      artifactBytes: corruptArtifact,
      catalogPaperIds: positive.catalog.map((paper) => paper.paper_id),
    });
    expect(release).toBeNull();
  });

  it("catalog membership is bound from actual canonical IDs", async () => {
    const parsedIndex = parsePilotIndex(clone(positive.index)) as PilotIndex;
    const entry = resolvePilotEntry(parsedIndex, "1".repeat(40)) as PilotIndexEntry;
    const release = await verifyPilotRelease({
      entry,
      ...rawPositiveBytes,
      catalogPaperIds: ["2".repeat(40)],
    });
    expect(release).toBeNull();
  });

  it("all BufferSources are snapshotted before the first asynchronous hash", async () => {
    const parsedIndex = parsePilotIndex(clone(positive.index)) as PilotIndex;
    const entry = resolvePilotEntry(parsedIndex, "1".repeat(40)) as PilotIndexEntry;
    const racedArtifact = Buffer.from(rawPositiveBytes.artifactBytes);
    const trustedArtifact = Buffer.from(racedArtifact);
    const titleOffset = racedArtifact.indexOf("Synthetic Parent");
    racedArtifact.write("Synthetic Forged", titleOffset, "utf8");
    const racedVerification = verifyPilotRelease({
      entry,
      ...rawPositiveBytes,
      artifactBytes: racedArtifact,
      catalogPaperIds: positive.catalog.map((paper) => paper.paper_id),
    });
    trustedArtifact.copy(racedArtifact);
    expect(await racedVerification).toBeNull();
  });

  it("duplicate paper IDs reject the whole index", () => {
    const duplicateIndex = clone(positive.index) as unknown as { entries: unknown[] };
    duplicateIndex.entries.push(clone(duplicateIndex.entries[0]));
    expect(parsePilotIndex(duplicateIndex)).toBeNull();
  });

  it("percent/traversal paths are rejected", () => {
    const escapedPath = clone(positive.index) as unknown as {
      entries: Array<{ artifact: { path: string } }>;
    };
    (escapedPath.entries[0] as { artifact: { path: string } }).artifact.path = (
      escapedPath.entries[0] as { artifact: { path: string } }
    ).artifact.path.replace("lineage-pilots/", "lineage-pilots/%2e%2e/");
    expect(parsePilotIndex(escapedPath)).toBeNull();
  });
});

describe("strict semantic negatives", () => {
  it("malformed evidence URL returns null without throwing", async () => {
    const malformedUrl = loadPositiveBundle();
    (malformedUrl.artifact as unknown as { evidence: Array<{ url: string }> }).evidence[0]!.url =
      "https://[";
    await expect(verify(malformedUrl)).resolves.toBeNull();
  });

  it("nested extra classification field is rejected", async () => {
    const extraClassification = loadPositiveBundle();
    (
      extraClassification.artifact as unknown as {
        claims: Array<{ classification: Record<string, unknown> }>;
      }
    ).claims[0]!.classification.extra = true;
    await expect(verify(extraClassification)).resolves.toBeNull();
  });

  it("percent-decoded DOI aliases must already be canonical", async () => {
    const noncanonicalDoi = loadPositiveBundle();
    (noncanonicalDoi.artifact as unknown as { nodes: Array<{ aliases: unknown }> })
      .nodes[0]!.aliases = [["doi", "10.1234/foo%2fbar"]];
    await expect(verify(noncanonicalDoi)).resolves.toBeNull();
  });

  it("evidence endpoint binding is enforced", async () => {
    const badEndpoint = loadPositiveBundle();
    const evidence = (
      badEndpoint.artifact as unknown as {
        evidence: Array<{ cited_work_id: string; citing_work_id: string }>;
      }
    ).evidence;
    (evidence[0] as { cited_work_id: string; citing_work_id: string }).cited_work_id = (
      evidence[0] as { cited_work_id: string; citing_work_id: string }
    ).citing_work_id;
    await expect(verify(badEndpoint)).resolves.toBeNull();
  });

  it("declared agreement cannot replace recomputed kappa", async () => {
    const lowKappa = loadPositiveBundle();
    const lowKappaCollections = (
      lowKappa.fixture as unknown as {
        collections: Array<{ edge_labels: Array<{ reviews: Array<Record<string, unknown>> }> }>;
      }
    ).collections;
    (
      lowKappaCollections[0]!.edge_labels[1]!.reviews[1] as Record<string, unknown>
    ).evidence_support = "supports";
    await expect(verify(lowKappa)).resolves.toBeNull();
  });

  it("public properties cannot forge a verified release", async () => {
    const positive = loadPositiveBundle();
    const parsedIndex = parsePilotIndex(clone(positive.index)) as PilotIndex;
    const entry = resolvePilotEntry(parsedIndex, "1".repeat(40)) as PilotIndexEntry;
    const release = await verifyPilotRelease({
      entry,
      artifactBytes: readFileSync(resolve(bundleRoot, entry.artifact.path)),
      fixtureBytes: readFileSync(resolve(bundleRoot, entry.fixture.path)),
      qualityBytes: readFileSync(resolve(bundleRoot, entry.quality.path)),
      catalogPaperIds: positive.catalog.map((paper) => paper.paper_id),
    });
    const rawForgery = clone(release) as unknown as Record<string, unknown>;
    rawForgery.verified = true;
    expect(selectFocusProjection(rawForgery as unknown as Release, Object.freeze({}))).toBeNull();
  });
});

describe("state normalization and exact round trip", () => {
  async function loadRelease(): Promise<Release> {
    const positive = loadPositiveBundle();
    const parsedIndex = parsePilotIndex(clone(positive.index)) as PilotIndex;
    const entry = resolvePilotEntry(parsedIndex, "1".repeat(40)) as PilotIndexEntry;
    const release = await verifyPilotRelease({
      entry,
      artifactBytes: readFileSync(resolve(bundleRoot, entry.artifact.path)),
      fixtureBytes: readFileSync(resolve(bundleRoot, entry.fixture.path)),
      qualityBytes: readFileSync(resolve(bundleRoot, entry.quality.path)),
      catalogPaperIds: positive.catalog.map((paper) => paper.paper_id),
    });
    return release as Release;
  }

  it("responsive defaults are 1-hop, 7-node, 18-claim list", async () => {
    const release = await loadRelease();
    const defaultState = readState(release, { params: new URLSearchParams(), mobile: true });
    expect(defaultState?.view).toBe("list");
    expect(defaultState?.hops).toBe(1);
    expect(defaultState?.nodeLimit).toBe(7);
    expect(defaultState?.claimLimit).toBe(18);
    expect(defaultState?.statusCodes.length).toBe(0);
  });

  it("URL view overrides prefs and mobile", async () => {
    const release = await loadRelease();
    const explicitGraph = readState(release, {
      params: new URLSearchParams("view=graph"),
      mobile: true,
      prefs: { view: "list" },
    });
    expect(explicitGraph?.view).toBe("graph");
  });

  it("unknown explicit focus never falls back to root", async () => {
    const release = await loadRelease();
    const unknownFocus = readState(release, { params: new URLSearchParams("focus=missing") });
    expect(unknownFocus?.focusId).toBeNull();
    expect(selectFocusProjection(release, unknownFocus)).toBeNull();
  });

  it("explicit empty relation set restores zero claims", async () => {
    const release = await loadRelease();
    const emptyRelations = readState(release, { params: new URLSearchParams("relations=") });
    expect(emptyRelations?.relationFilterExplicit).toBe(true);
    expect(emptyRelations?.relations.length).toBe(0);
    expect(selectFocusProjection(release, emptyRelations)?.counts.eligibleClaims).toBe(0);
  });

  it("unknown explicit evidence cannot broaden to all evidence", async () => {
    const release = await loadRelease();
    const unknownEvidence = readState(release, {
      params: new URLSearchParams("evidence_sources=not-a-source"),
    });
    expect(unknownEvidence?.evidenceSourcesExplicit).toBe(true);
    expect(unknownEvidence?.evidenceSources.length).toBe(0);
    expect(selectFocusProjection(release, unknownEvidence)?.counts.eligibleClaims).toBe(0);
  });

  it("duplicate filter keys never first-match", async () => {
    const release = await loadRelease();
    const duplicateTrust = readState(release, {
      params: new URLSearchParams("trust=verified&trust=tentative"),
    });
    expect(duplicateTrust?.trustTiers.length).toBe(0);
    expect(selectFocusProjection(release, duplicateTrust)?.counts.eligibleClaims).toBe(0);
  });

  it("simultaneous relation aliases cannot silently ignore an empty filter", async () => {
    const release = await loadRelease();
    const ambiguousRelations = readState(release, {
      params: new URLSearchParams("relations=extends&rels="),
    });
    expect(ambiguousRelations?.relations.length).toBe(0);
    expect(ambiguousRelations?.statusCodes).toContain("ambiguous_relations");
    expect(selectFocusProjection(release, ambiguousRelations)?.counts.eligibleClaims).toBe(0);
  });

  it("legacy and split evidence filters cannot broaden each other", async () => {
    const release = await loadRelease();
    const ambiguousEvidence = readState(release, {
      params: new URLSearchParams("evidence=source%3Asynthetic-primary&evidence_sources="),
    });
    expect(ambiguousEvidence?.evidenceSourcesExplicit).toBe(true);
    expect(ambiguousEvidence?.evidenceKindsExplicit).toBe(true);
    expect(selectFocusProjection(release, ambiguousEvidence)?.counts.eligibleClaims).toBe(0);
  });

  it("duplicate legacy evidence filters cannot first-match a broader occurrence", async () => {
    const release = await loadRelease();
    const duplicateLegacyEvidence = readState(release, {
      params: new URLSearchParams(
        "evidence=source%3Asynthetic-primary%2Ckind%3Apaper-text&evidence=",
      ),
    });
    expect(selectFocusProjection(release, duplicateLegacyEvidence)?.counts.eligibleClaims).toBe(0);
  });
});

interface LargeBundle {
  index: PilotIndex;
  artifact: Record<string, unknown>;
  fixture: Record<string, unknown>;
  quality: Record<string, unknown>;
  catalog: Array<{ paper_id: string; [key: string]: unknown }>;
}

function makeLargeBundle(): LargeBundle {
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
  const evidence: Array<Record<string, unknown>> = [];
  const links: Array<Record<string, unknown>> = [];
  const claims: Array<Record<string, unknown>> = [];
  const labels: Array<Record<string, unknown>> = [];
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
        cited_work_id: (nodes[src] as { id: string }).id,
        citing_work_id: (nodes[dst] as { id: string }).id,
        url: `https://example.invalid/evidence/${id}`,
        locator: {
          page: 1,
          section: null,
          reference_marker: null,
          sentence_ordinal: null,
          paragraph_ordinal: null,
        },
        excerpt,
        excerpt_sha256: digest(Buffer.from(excerpt)),
        input_sha256: "a".repeat(64),
        retrieved_at: "2026-01-01T00:00:00Z",
        snapshot_ref: "synthetic-large-snapshot",
      });
      links.push({
        id: `link:${id}`,
        src: (nodes[dst] as { id: string }).id,
        dst: (nodes[src] as { id: string }).id,
        type: "citation",
        evidence_ids: [evidenceId],
      });
      const accepted = candidate < 900;
      const comparison = candidate < 6;
      const relation = accepted
        ? comparison
          ? "contrasts"
          : candidate % 2 === 0
            ? "extends"
            : "successor"
        : null;
      const reviewId = `review:${id}`;
      const evidenceHash = digest([evidence[evidence.length - 1]]);
      claims.push({
        id: `claim:${id}`,
        src: (nodes[src] as { id: string }).id,
        dst: (nodes[dst] as { id: string }).id,
        claim_family: comparison ? "comparison" : "genealogy",
        relation,
        decision: accepted ? "accepted" : "unknown",
        trust_tier: accepted ? "verified" : "tentative",
        raw_score: null,
        calibrated_probability: null,
        calibration_id: null,
        evidence_ids: [evidenceId],
        rationale: accepted ? `Synthetic rationale ${id}` : "",
        classification: {
          method: "human_review",
          provider: null,
          model: null,
          prompt_version: null,
          schema_version: "synthetic-v1",
        },
        reason_codes: accepted ? [] : ["insufficient_evidence"],
        review_binding: accepted
          ? {
              review_id: reviewId,
              fixture_id: "synthetic-large-fixture",
              evidence_sha256: evidenceHash,
            }
          : null,
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
        src: (nodes[src] as { id: string }).id,
        dst: (nodes[dst] as { id: string }).id,
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
    root: (nodes[0] as { id: string }).id,
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
    collections: [
      {
        collection_id: collectionId,
        release_id: artifact.release_id,
        artifact_sha256: "0".repeat(64),
        candidate_universe: clone(universe),
        focus_labels: [{ node_id: (nodes[0] as { id: string }).id, on_topic: true }],
        edge_labels: labels,
      },
    ],
  };
  const decisionCounts = { accepted: 900, unknown: 100, abstained: 0, rejected: 0 };
  const checks = [
    "artifact_contract_v2",
    "identity",
    "evidence_binding",
    "review_binding",
    "accepted_dag",
    "accepted_temporal",
    "frozen_candidate_ledger",
  ].map((name) => ({ name, status: "passed", detail: "Synthetic test only." }));
  const quality = {
    schema_version: "lineage-quality-v2",
    audit_version: "audit-v2",
    as_of: "2026-01-05T00:00:00Z",
    collections: [
      {
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
          status: "not_applicable",
          reason: "Synthetic claim-verified pilot.",
          sample_count: 0,
          wilson_lower_bound: null,
          supersedes_wilson_lower_bound: null,
          macro_precision: null,
          ece: null,
          brier: null,
          accepted_coverage: null,
          unknown_abstained_recall: null,
        },
        review: {
          status: "passed",
          reviewed_claim_count: 900,
          agreement: 1,
          fixture_id: fixture.fixture_id,
        },
        checks,
      },
    ],
  };
  return {
    index: {
      schema_version: "lineage-pilot-index-v1",
      entries: [
        {
          paper_id: paperId,
          conference,
          collection_id: collectionId,
          release_id: artifact.release_id,
          release_profile: "claim-verified-pilot-v1",
          artifact: { path: "placeholder", sha256: "0".repeat(64) },
          fixture: { path: "placeholder", sha256: "0".repeat(64) },
          quality: { path: "placeholder", sha256: "0".repeat(64) },
        },
      ],
    } as unknown as PilotIndex,
    artifact,
    fixture,
    quality,
    catalog: [
      {
        paper_id: paperId,
        title: "Synthetic large root",
        authors: ["Synthetic Author"],
        tags: ["Synthetic"],
        abstract: "Synthetic 200-node/1,000-claim browser QA fixture only.",
      },
    ],
  };
}

async function verifyLarge(bundle: LargeBundle): Promise<Release | null> {
  const rebound = rebind(bundle as unknown as PositiveBundle);
  const index = parsePilotIndex(bundle.index);
  if (index === null) return null;
  const entry = resolvePilotEntry(
    index,
    (bundle.index.entries[0] as unknown as PilotIndexEntry).paper_id,
  );
  if (!entry) return null;
  return verifyPilotRelease({
    entry,
    ...rebound,
    catalogPaperIds: bundle.catalog.map((paper) => paper.paper_id),
  });
}

describe("large deterministic Focus View", () => {
  it("200-node/1,000-claim synthetic release verifies with correct default projection", async () => {
    const largeBundle = makeLargeBundle();
    const largeRelease = await verifyLarge(largeBundle);
    expect(largeRelease).not.toBeNull();
    const largeState = readState(largeRelease, { params: new URLSearchParams() });
    const largeProjection = selectFocusProjection(largeRelease, largeState);
    expect(largeProjection?.nodes.length).toBeLessThanOrEqual(7);
    expect(largeProjection?.claims.length).toBeLessThanOrEqual(18);
    expect(largeProjection?.counts.totalNodes).toBe(200);
    expect(largeProjection?.counts.allClaims).toBe(1000);
    expect(largeProjection?.counts.acceptedGenealogyClaims).toBe(894);
    expect(largeProjection?.counts.acceptedComparisonClaims).toBe(6);
    expect(
      largeProjection?.claims.every(
        (claim) =>
          claim.decision === "accepted" &&
          claim.trust_tier === "verified" &&
          claim.claim_family === "genealogy",
      ),
    ).toBe(true);
  });

  it("explicit comparison-only view adds direct focus neighbours within the node cap, without traversing comparison chains", async () => {
    const largeBundle = makeLargeBundle();
    const largeRelease = await verifyLarge(largeBundle);
    const comparisonOnly = selectFocusProjection(
      largeRelease,
      readState(largeRelease, {
        params: new URLSearchParams("families=comparison&relations=contrasts&limit=5"),
      }),
    );
    expect((comparisonOnly?.comparisonClaims.length ?? 0) > 0).toBe(true);
    expect(comparisonOnly?.nodes.length).toBeLessThanOrEqual(5);
    expect(
      comparisonOnly?.comparisonClaims.every(
        (claim) => claim.src === comparisonOnly.focus.id || claim.dst === comparisonOnly.focus.id,
      ),
    ).toBe(true);
  });

  it("comparison is explicit, capped at six, and remains inside the total claim cap", async () => {
    const largeBundle = makeLargeBundle();
    const largeRelease = await verifyLarge(largeBundle);
    const comparisonState = readState(largeRelease, {
      params: new URLSearchParams(
        "families=genealogy%2Ccomparison&relations=extends%2Csuccessor%2Csupersedes%2Cablation%2Cbaseline_only%2Ccontrasts",
      ),
    });
    const comparisonProjection = selectFocusProjection(largeRelease, comparisonState);
    expect(comparisonProjection?.comparisonClaims.length).toBeLessThanOrEqual(6);
    expect(
      (comparisonProjection?.genealogyClaims.length ?? 0) +
        (comparisonProjection?.comparisonClaims.length ?? 0),
    ).toBeLessThanOrEqual(18);
  });

  it("projection order is independent of all input array orders", async () => {
    const largeBundle = makeLargeBundle();
    const largeRelease = await verifyLarge(largeBundle);
    const largeProjection = selectFocusProjection(
      largeRelease,
      readState(largeRelease, { params: new URLSearchParams() }),
    );
    const permutedBundle = clone(largeBundle);
    for (const field of ["nodes", "links", "evidence", "claims"] as const) {
      (permutedBundle.artifact as unknown as Record<string, unknown[]>)[field]?.reverse();
    }
    (
      permutedBundle.fixture as unknown as { collections: Array<{ edge_labels: unknown[] }> }
    ).collections[0]!.edge_labels.reverse();
    const permutedRelease = await verifyLarge(permutedBundle);
    const permutedProjection = selectFocusProjection(
      permutedRelease,
      readState(permutedRelease, { params: new URLSearchParams() }),
    );
    expect(permutedProjection?.nodes.map((node) => node.id)).toEqual(
      largeProjection?.nodes.map((node) => node.id),
    );
    expect(permutedProjection?.claims.map((claim) => claim.id)).toEqual(
      largeProjection?.claims.map((claim) => claim.id),
    );
  });

  it("escaped CSV preserves exact comma, backslash, and Unicode node IDs; explicit expansion stays graph-safe or requests list fallback", async () => {
    const largeBundle = makeLargeBundle();
    const largeRelease = await verifyLarge(largeBundle);
    const wideState = readState(largeRelease, { params: new URLSearchParams("limit=50") });
    const wideProjection = selectFocusProjection(largeRelease, wideState);
    const specialId = "node:comma,slash\\雪";
    const expandedIds = [
      ...new Set([...(wideProjection?.nodes.map((node) => node.id) ?? []), specialId]),
    ];
    const expandedState = readState(largeRelease, {
      params: new URLSearchParams({
        limit: "50",
        expanded: expandedIds
          .map((id) => id.replaceAll("\\", "\\\\").replaceAll(",", "\\,"))
          .join(","),
      }),
    });
    const roundTrip = readState(largeRelease, {
      params: writeState("https://paperpilot.local/lineage/", expandedState).searchParams,
    });
    expect(roundTrip?.expandedNodeIds).toContain(specialId);
    const expandedProjection = selectFocusProjection(largeRelease, expandedState);
    const safe =
      expandedProjection?.forceList ||
      ((expandedProjection?.nodes.length ?? 0) <= 50 &&
        (expandedProjection?.claims.length ?? 0) <= 80);
    expect(safe).toBe(true);
  });
});

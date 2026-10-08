/**
 * Cross-document binding verification and the top-level
 * `verifyPilotRelease` entry point -- ported 1:1 from
 * docs/assets/lineage-v2-core.js `verifyBindings`/`verifyPilotRelease`/
 * `resolveFocus` (safety-contracts.md SCR-47).
 *
 * `verifyBindings` is where the four documents (pilot-index entry,
 * artifact, fixture, quality) are checked against EACH OTHER, on top
 * of each one's own internal validation: the quality row's counts must
 * match the artifact's actual claims, every accepted claim must be
 * `verified`-tier, the fixture's one collection must match the
 * artifact's `candidate_universe` and off-topic-focus budget (<=10%),
 * every claim/label pair must exist in both directions with no
 * orphans, recomputed Cohen's kappa (not the publisher's self-reported
 * number) must be >= 0.7 and match the quality row's `agreement`
 * within float tolerance, and every `verified`-tier accepted claim's
 * `review_binding` must resolve to a label with the exact same
 * evidence hash and endpoints.
 */
import { validateArtifact } from "./artifact";
import { isBrandedEntry, releaseBrand, releasePrivate } from "./brand";
import {
  MAX_ARTIFACT_BYTES,
  MAX_FIXTURE_BYTES,
  MAX_JSON_VALUES,
  MAX_QUALITY_BYTES,
  PAPER_ID_RE,
} from "./constants";
import { cohenKappa, validateFixture } from "./fixture";
import {
  asBytes,
  canonicalJson,
  canonicalSha,
  compareText,
  deepFreeze,
  parseBytes,
  sha256,
} from "./json";
import { validQualityShape } from "./quality";
import { timestampValue } from "./time";
import type {
  FixtureCollection,
  LineageV2Artifact,
  LineageV2Claim,
  LineageV2Fixture,
  LineageV2Node,
  LineageV2Quality,
  LineageV2QualityRow,
  PilotIndexEntry,
  Release,
} from "./types";

async function verifyBindings(
  entry: PilotIndexEntry,
  artifact: LineageV2Artifact,
  fixture: LineageV2Fixture,
  quality: LineageV2Quality,
  catalogIds: Set<string>,
): Promise<{
  artifactValidation: { nodeIds: Set<string>; evidenceById: Map<string, unknown> };
  fixtureCollection: FixtureCollection;
  row: LineageV2QualityRow;
} | null> {
  if (!validQualityShape(quality) || !validateFixture(fixture)) return null;
  const row = quality.collections[0];
  const artifactValidation = await validateArtifact(artifact, catalogIds);
  if (
    artifactValidation === null ||
    row.collection_id !== entry.collection_id ||
    row.slug !== entry.conference ||
    row.path !== entry.artifact.path ||
    row.release_id !== entry.release_id ||
    row.artifact_sha256 !== entry.artifact.sha256 ||
    row.fixture_sha256 !== entry.fixture.sha256 ||
    artifact.release_id !== entry.release_id ||
    artifact.meta.kind !== "deep" ||
    row.node_count !== artifact.nodes.length ||
    row.link_count !== artifact.links.length ||
    row.claim_decision_count !== artifact.claims.length
  ) {
    return null;
  }
  const focus = artifact.nodes.filter((node) => node.is_focus);
  if (
    focus.length !== 1 ||
    focus[0]?.seed_paper_id !== entry.paper_id ||
    row.collection_id !==
      `deep:${entry.conference}:paper:${(focus[0] as LineageV2Node).seed_paper_id}`
  ) {
    return null;
  }
  const decisionCounts = { accepted: 0, unknown: 0, abstained: 0, rejected: 0 };
  let acceptedGenealogy = 0;
  let acceptedComparison = 0;
  for (const claim of artifact.claims) {
    decisionCounts[claim.decision]++;
    if (claim.decision === "accepted" && claim.claim_family === "genealogy") acceptedGenealogy++;
    if (claim.decision === "accepted" && claim.claim_family === "comparison") acceptedComparison++;
    if (claim.decision === "accepted" && claim.trust_tier !== "verified") return null;
  }
  if (
    row.accepted_genealogy_count !== acceptedGenealogy ||
    row.accepted_comparison_count !== acceptedComparison ||
    (Object.keys(decisionCounts) as Array<keyof typeof decisionCounts>).some(
      (key) => row.decision_counts[key] !== decisionCounts[key],
    ) ||
    row.review.reviewed_claim_count !== acceptedGenealogy + acceptedComparison ||
    row.review.fixture_id !== fixture.fixture_id
  ) {
    return null;
  }
  const matches = fixture.collections.filter((item) => item.collection_id === entry.collection_id);
  if (matches.length !== 1) return null;
  const fixtureCollection = matches[0] as FixtureCollection;
  if (
    fixtureCollection.release_id !== entry.release_id ||
    fixtureCollection.artifact_sha256 !== entry.artifact.sha256 ||
    canonicalJson(fixtureCollection.candidate_universe) !==
      canonicalJson(artifact.meta.candidate_universe)
  ) {
    return null;
  }
  const nodeIds = artifactValidation.nodeIds;
  const rootLabels = fixtureCollection.focus_labels.filter(
    (label) => label.node_id === artifact.root,
  );
  const offTopic = fixtureCollection.focus_labels.filter((label) => !label.on_topic).length;
  if (
    fixtureCollection.focus_labels.some((label) => !nodeIds.has(label.node_id)) ||
    rootLabels.length !== 1 ||
    !rootLabels[0]?.on_topic ||
    offTopic / fixtureCollection.focus_labels.length > 0.1
  ) {
    return null;
  }
  const generatedAt = timestampValue(artifact.meta.generated_at) as bigint;
  const fixtureAt = timestampValue(fixture.created_at) as bigint;
  const asOf = timestampValue(quality.as_of) as bigint;
  if (generatedAt > fixtureAt) return null;
  const claimRows = new Map<string, LineageV2Claim>();
  for (const claim of artifact.claims) {
    const bound = claim.evidence_ids
      .map((id) => artifactValidation.evidenceById.get(id))
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
      .sort((left, right) => compareText(left.id, right.id));
    const evidenceHash = await canonicalSha(bound);
    const identity = `${claim.src}\u0000${claim.dst}\u0000${evidenceHash}`;
    if (claimRows.has(identity)) return null;
    claimRows.set(identity, claim);
  }
  const labelRows = new Map<string, FixtureCollection["edge_labels"][number]>();
  const labelsByReview = new Map<string, FixtureCollection["edge_labels"][number]>();
  const relationPairs: Array<[unknown, unknown]> = [];
  const supportPairs: Array<[unknown, unknown]> = [];
  for (const label of fixtureCollection.edge_labels) {
    const identity = `${label.src}\u0000${label.dst}\u0000${label.evidence_sha256}`;
    if (labelRows.has(identity) || labelsByReview.has(label.review_id)) return null;
    labelRows.set(identity, label);
    labelsByReview.set(label.review_id, label);
    const times = [
      ...label.reviews.map((review) => timestampValue(review.reviewed_at) as bigint),
      timestampValue(label.adjudication.reviewed_at) as bigint,
    ];
    if (times.some((time) => time < generatedAt || time < fixtureAt || time > asOf)) return null;
    const reviews = [...label.reviews].sort((left, right) =>
      compareText(left.reviewer_id, right.reviewer_id),
    );
    const [reviewA, reviewB] = reviews as [(typeof reviews)[0], (typeof reviews)[0]];
    relationPairs.push([reviewA.gold_relation, reviewB.gold_relation]);
    supportPairs.push([reviewA.evidence_support, reviewB.evidence_support]);
    const fields = ["citation_valid", "gold_family", "gold_relation", "evidence_support"] as const;
    const agreed = fields.every((field) => reviewA[field] === reviewB[field]);
    const final = agreed ? reviewA : label.adjudication;
    const claim = claimRows.get(identity);
    if (
      !claim ||
      (claim.decision === "accepted" &&
        (final.citation_valid !== true ||
          final.evidence_support !== "supports" ||
          final.gold_family !== claim.claim_family ||
          final.gold_relation !== claim.relation))
    ) {
      return null;
    }
  }
  if (claimRows.size !== labelRows.size || [...claimRows.keys()].some((key) => !labelRows.has(key)))
    return null;
  const relationKappa = cohenKappa(relationPairs as Array<[unknown, unknown]>);
  const supportKappa = cohenKappa(supportPairs as Array<[unknown, unknown]>);
  if (relationKappa === null || supportKappa === null) return null;
  const agreement = Math.min(relationKappa, supportKappa);
  if (agreement < 0.7 || Math.abs(row.review.agreement - agreement) > 1e-12) return null;
  for (const claim of artifact.claims) {
    if (claim.decision !== "accepted" || claim.trust_tier !== "verified") continue;
    const binding = claim.review_binding;
    if (!binding) return null;
    const label = labelsByReview.get(binding.review_id);
    if (
      !label ||
      binding.fixture_id !== fixture.fixture_id ||
      label.evidence_sha256 !== binding.evidence_sha256 ||
      label.src !== claim.src ||
      label.dst !== claim.dst
    ) {
      return null;
    }
  }
  return { artifactValidation, fixtureCollection, row };
}

export interface VerifyPilotReleaseInput {
  entry: PilotIndexEntry;
  artifactBytes: unknown;
  fixtureBytes: unknown;
  qualityBytes: unknown;
  catalogPaperIds: string[];
}

/**
 * Verifies a candidate pilot release end to end from raw bytes: hashes
 * each of the three documents and checks the hash against `entry`'s
 * declared `sha256` BEFORE trusting any parsed content, cross-checks
 * every binding (`verifyBindings`), and -- only on full success --
 * returns a deeply frozen, null-prototype `Release` branded for
 * `resolveFocus`/`readState`/`selectFocusProjection` to accept. Returns
 * `null` on ANY failure, including a thrown error from a malformed
 * input; never throws.
 *
 * All three `BufferSource`s are snapshotted into fresh `Uint8Array`s
 * (via `asBytes` inside `parseBytes`, called through `Promise.all`)
 * before any `await` resolves -- a caller that mutates or transfers
 * its buffer immediately after calling this function cannot race the
 * hash/parse with a hidden write (see `json.ts` `asBytes`'s docstring).
 */
export async function verifyPilotRelease({
  entry,
  artifactBytes,
  fixtureBytes,
  qualityBytes,
  catalogPaperIds,
}: VerifyPilotReleaseInput): Promise<Release | null> {
  try {
    if (
      !isBrandedEntry(entry) ||
      !Array.isArray(catalogPaperIds) ||
      catalogPaperIds.length === 0 ||
      catalogPaperIds.length > MAX_JSON_VALUES ||
      new Set(catalogPaperIds).size !== catalogPaperIds.length ||
      !catalogPaperIds.every((id) => PAPER_ID_RE.test(id)) ||
      !catalogPaperIds.includes(entry.paper_id)
    ) {
      return null;
    }
    // Snapshot every caller-owned BufferSource before the first await.
    // Hashing and parsing then consume the same private bytes even if a
    // caller mutates or transfers its buffers while Web Crypto is pending.
    const artifactSnapshot = asBytes(artifactBytes);
    const fixtureSnapshot = asBytes(fixtureBytes);
    const qualitySnapshot = asBytes(qualityBytes);
    if (artifactSnapshot === null || fixtureSnapshot === null || qualitySnapshot === null)
      return null;
    const [artifactInput, fixtureInput, qualityInput] = await Promise.all([
      parseBytes(artifactSnapshot, MAX_ARTIFACT_BYTES),
      parseBytes(fixtureSnapshot, MAX_FIXTURE_BYTES),
      parseBytes(qualitySnapshot, MAX_QUALITY_BYTES),
    ]);
    if (artifactInput === null || fixtureInput === null || qualityInput === null) return null;
    const hashes = await Promise.all([
      sha256(artifactInput.bytes),
      sha256(fixtureInput.bytes),
      sha256(qualityInput.bytes),
    ]);
    if (
      hashes[0] !== entry.artifact.sha256 ||
      hashes[1] !== entry.fixture.sha256 ||
      hashes[2] !== entry.quality.sha256
    ) {
      return null;
    }
    const catalogIds = new Set(catalogPaperIds);
    const binding = await verifyBindings(
      entry,
      artifactInput.parsed as LineageV2Artifact,
      fixtureInput.parsed as LineageV2Fixture,
      qualityInput.parsed as LineageV2Quality,
      catalogIds,
    );
    if (binding === null) return null;
    deepFreeze(artifactInput.parsed);
    deepFreeze(fixtureInput.parsed);
    deepFreeze(qualityInput.parsed);
    const release = Object.create(null) as Release;
    Object.assign(release, {
      entry,
      artifact: artifactInput.parsed,
      fixture: fixtureInput.parsed,
      fixtureCollection: binding.fixtureCollection,
      quality: qualityInput.parsed,
      qualityRow: binding.row,
      row: binding.row,
    });
    deepFreeze(release);
    releaseBrand.add(release as object);
    const artifact = release.artifact;
    releasePrivate.set(release as object, {
      nodeById: new Map(artifact.nodes.map((node) => [node.id, node])),
      claimById: new Map(artifact.claims.map((claim) => [claim.id, claim])),
      evidenceById: new Map(artifact.evidence.map((item) => [item.id, item])),
    });
    return release;
  } catch {
    return null;
  }
}

/**
 * Resolves the displayed focus node: no explicit `focus` returns the
 * artifact's root; a 40-hex value resolves ONLY through a unique
 * `is_focus && seed_paper_id` match (never a graph-local id of the
 * same shape); any other string resolves as a graph-local node id.
 * An unrecognised request returns `null` -- it never falls back to
 * root or the first node (this is the release-scoped counterpart of
 * `lib/lineage/core.ts`'s `resolveFocus`, kept separate because the
 * v2 node/claim shape differs -- SCR-24/SCR-48).
 */
export function resolveFocus(
  release: Release | null,
  requestedFocus: string | null | false | undefined = null,
): LineageV2Node | null {
  if (!release || typeof release !== "object" || !releaseBrand.has(release as object)) return null;
  const indexes = releasePrivate.get(release as object);
  if (!indexes) return null;
  if (requestedFocus === null || requestedFocus === undefined || requestedFocus === "") {
    return (release.artifact.root && indexes.nodeById.get(release.artifact.root)) || null;
  }
  if (typeof requestedFocus !== "string") return null;
  if (/^[0-9a-f]{40}$/.test(requestedFocus)) {
    const matches = release.artifact.nodes.filter(
      (node) => node.is_focus && node.seed_paper_id === requestedFocus,
    );
    return matches.length === 1 ? (matches[0] as LineageV2Node) : null;
  }
  return indexes.nodeById.get(requestedFocus) ?? null;
}

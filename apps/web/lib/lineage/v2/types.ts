/**
 * Shared TypeScript shapes for the lineage-artifact-v2 /
 * lineage-pilot-index-v1 / lineage-audit-fixtures-v2 /
 * lineage-quality-v2 contract. These describe the shape AFTER
 * `parsePilotIndex`/`validateArtifact`/`validateFixture`/
 * `validQualityShape` have accepted a value -- they are not schemas in
 * themselves; the runtime validators in pilot-index.ts/artifact.ts/
 * fixture.ts/quality.ts are the actual (fail-closed) contract. A type
 * assertion here never substitutes for one of those checks.
 */
import type {
  AliasNamespace,
  CheckStatus,
  Decision,
  EvidenceSupport,
  Relation,
  TrustTier,
} from "./constants";

export interface PilotPathRef {
  path: string;
  sha256: string;
}

export interface PilotIndexEntry {
  paper_id: string;
  conference: string;
  collection_id: string;
  release_id: string;
  release_profile: "claim-verified-pilot-v1";
  artifact: PilotPathRef;
  fixture: PilotPathRef;
  quality: PilotPathRef;
}

export interface PilotIndex {
  schema_version: "lineage-pilot-index-v1";
  entries: PilotIndexEntry[];
}

export type NodeAlias = [AliasNamespace, string];

export interface LineageV2Node {
  id: string;
  title: string;
  first_published_at: string;
  is_focus: boolean;
  seed_paper_id: string | null;
  aliases: NodeAlias[];
}

export interface EvidenceLocator {
  page: number | null;
  section: string | null;
  reference_marker: string | null;
  sentence_ordinal: number | null;
  paragraph_ordinal: number | null;
}

export interface LineageV2Evidence {
  id: string;
  source: string;
  kind: string;
  source_work_id: string;
  cited_work_id: string;
  citing_work_id: string;
  url: string;
  locator: EvidenceLocator;
  excerpt: string;
  excerpt_sha256: string;
  input_sha256: string;
  retrieved_at: string;
  snapshot_ref: string;
}

export interface LineageV2Link {
  id: string;
  src: string;
  dst: string;
  type: "citation";
  evidence_ids: string[];
}

export interface ClaimClassification {
  method: string;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  schema_version: string;
}

export interface ReviewBindingRef {
  review_id: string;
  fixture_id: string;
  evidence_sha256: string;
}

export interface LineageV2Claim {
  id: string;
  src: string;
  dst: string;
  claim_family: "genealogy" | "comparison";
  relation: Relation | null;
  decision: Decision;
  trust_tier: TrustTier;
  raw_score: number | null;
  calibrated_probability: number | null;
  calibration_id: string | null;
  evidence_ids: string[];
  rationale: string;
  classification: ClaimClassification;
  reason_codes: string[];
  review_binding: ReviewBindingRef | null;
}

export interface CandidateUniverse {
  snapshot_ref: string;
  input_sha256: string;
  selection_method: string;
  candidate_count: number;
}

export interface ArtifactMeta {
  kind: "conference" | "theme" | "deep";
  producer: { name: string; version: string };
  generated_at: string;
  candidate_universe: CandidateUniverse;
}

export interface LineageV2Artifact {
  schema_version: "lineage-artifact-v2";
  release_id: string;
  root: string | null;
  nodes: LineageV2Node[];
  links: LineageV2Link[];
  evidence: LineageV2Evidence[];
  claims: LineageV2Claim[];
  clusters: unknown[];
  meta: ArtifactMeta;
}

export interface GoldLabel {
  gold_family: "genealogy" | "comparison" | null;
  gold_relation: Relation | null;
}

export interface FixtureReview extends GoldLabel {
  reviewer_id: string;
  blind_to_model: true;
  blind_to_peer: true;
  citation_valid: boolean;
  evidence_support: EvidenceSupport;
  notes: string;
  reviewed_at: string;
}

export interface FixtureAdjudication extends GoldLabel {
  adjudicator_id: string;
  citation_valid: boolean;
  evidence_support: EvidenceSupport;
  notes: string;
  reviewed_at: string;
}

export interface FixtureEdgeLabel {
  review_id: string;
  collection_id: string;
  src: string;
  dst: string;
  evidence_sha256: string;
  reviews: [FixtureReview, FixtureReview];
  adjudication: FixtureAdjudication;
}

export interface FixtureFocusLabel {
  node_id: string;
  on_topic: boolean;
}

export interface FixtureCollection {
  collection_id: string;
  release_id: string;
  artifact_sha256: string;
  candidate_universe: CandidateUniverse;
  focus_labels: FixtureFocusLabel[];
  edge_labels: FixtureEdgeLabel[];
}

export interface LineageV2Fixture {
  schema_version: "lineage-audit-fixtures-v2";
  fixture_id: string;
  created_at: string;
  collections: FixtureCollection[];
}

export interface QualityCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface QualityCalibration {
  status: "not_applicable";
  reason: string;
  sample_count: number;
  wilson_lower_bound: number | null;
  supersedes_wilson_lower_bound: number | null;
  macro_precision: number | null;
  ece: number | null;
  brier: number | null;
  accepted_coverage: number | null;
  unknown_abstained_recall: number | null;
}

export interface QualityReview {
  status: "passed";
  reviewed_claim_count: number;
  agreement: number;
  fixture_id: string;
}

export interface DecisionCounts {
  accepted: number;
  unknown: number;
  abstained: number;
  rejected: number;
}

export interface LineageV2QualityRow {
  collection_id: string;
  kind: "deep";
  slug: string;
  label: string;
  path: string;
  release_id: string;
  release_profile: "claim-verified-pilot-v1";
  availability: "ready";
  audit_status: "passed";
  artifact_schema_version: "lineage-artifact-v2";
  artifact_sha256: string;
  fixture_sha256: string;
  node_count: number;
  link_count: number;
  claim_decision_count: number;
  accepted_genealogy_count: number;
  accepted_comparison_count: number;
  decision_counts: DecisionCounts;
  calibration: QualityCalibration;
  review: QualityReview;
  checks: QualityCheck[];
}

export interface LineageV2Quality {
  schema_version: "lineage-quality-v2";
  audit_version: "audit-v2";
  as_of: string;
  collections: [LineageV2QualityRow];
}

/**
 * An immutable, verified pilot release -- the only object
 * `resolveFocus`/`readState`/`selectFocusProjection` will accept. It
 * is deliberately NOT structurally identifiable: `release.ts` brands
 * the exact object instance returned by `verifyPilotRelease` in a
 * module-private `WeakSet`, so copying its (otherwise fully public,
 * JSON-shaped) fields into a new object -- e.g. via `structuredClone`
 * or object spread -- produces something every consumer here rejects.
 * There is no public "verified" flag to forge.
 */
export interface Release {
  entry: PilotIndexEntry;
  artifact: LineageV2Artifact;
  fixture: LineageV2Fixture;
  fixtureCollection: FixtureCollection;
  quality: LineageV2Quality;
  qualityRow: LineageV2QualityRow;
  /** Alias of `qualityRow`, kept for parity with the JS source's
   * `release.row === release.qualityRow` identity test. */
  row: LineageV2QualityRow;
}

/**
 * lineage-artifact-v2 structural + semantic validation -- ported 1:1
 * from docs/assets/lineage-v2-core.js `validateNode`/`validateLocator`/
 * `validateClassification`/`validateArtifact` (safety-contracts.md
 * SCR-47). This is the richest part of the contract: beyond shape, it
 * enforces evidence/claim endpoint binding, excerpt hash integrity,
 * corroboration (2 distinct sources+works) for `corroborated` accepted
 * claims, verified-tier review-binding requirement, acyclicity +
 * temporal ordering of the accepted genealogy graph, and full-graph
 * connectivity (every non-root node must be touched by some link or
 * claim).
 */
import {
  ARTIFACT_VERSION,
  COMPARISON,
  DECISIONS,
  GENEALOGY,
  MAX_CLAIMS,
  MAX_EVIDENCE,
  MAX_LINKS,
  MAX_NODES,
  METHODS,
  TRUST_TIERS,
} from "./constants";
import {
  canonicalSha,
  compareText,
  exactKeys,
  nonnegativeInteger,
  nullableText,
  record,
  sha256,
  text,
  uniqueTextArray,
  unitNumber,
} from "./json";
import { dateValue, validTimestamp } from "./time";
import type {
  LineageV2Artifact,
  LineageV2Claim,
  LineageV2Evidence,
  LineageV2Link,
  LineageV2Node,
} from "./types";
import { validAlias, validHttpUrl } from "./url-alias";

/**
 * Exact-key lists, named and exported so
 * test/lineage/focus/schema-contract.test.ts can assert they stay
 * byte-identical to `schemas/lineage-artifact-v2.schema.json`'s
 * `required`/`properties` sets -- the schema is meant to document this
 * contract for the producer side (Python), so a silent drift between
 * the two would mean the schema no longer describes what this reader
 * actually accepts.
 */
export const ARTIFACT_KEYS = [
  "schema_version",
  "release_id",
  "root",
  "nodes",
  "links",
  "evidence",
  "claims",
  "clusters",
  "meta",
] as const;
export const NODE_KEYS = [
  "id",
  "title",
  "first_published_at",
  "is_focus",
  "seed_paper_id",
  "aliases",
] as const;
export const LOCATOR_KEYS = [
  "page",
  "section",
  "reference_marker",
  "sentence_ordinal",
  "paragraph_ordinal",
] as const;
export const EVIDENCE_KEYS = [
  "id",
  "source",
  "kind",
  "source_work_id",
  "cited_work_id",
  "citing_work_id",
  "url",
  "locator",
  "excerpt",
  "excerpt_sha256",
  "input_sha256",
  "retrieved_at",
  "snapshot_ref",
] as const;
export const LINK_KEYS = ["id", "src", "dst", "type", "evidence_ids"] as const;
export const CLASSIFICATION_KEYS = [
  "method",
  "provider",
  "model",
  "prompt_version",
  "schema_version",
] as const;
export const REVIEW_BINDING_KEYS = ["review_id", "fixture_id", "evidence_sha256"] as const;
export const CLAIM_KEYS = [
  "id",
  "src",
  "dst",
  "claim_family",
  "relation",
  "decision",
  "trust_tier",
  "raw_score",
  "calibrated_probability",
  "calibration_id",
  "evidence_ids",
  "rationale",
  "classification",
  "reason_codes",
  "review_binding",
] as const;
export const META_KEYS = ["kind", "producer", "generated_at", "candidate_universe"] as const;
export const PRODUCER_KEYS = ["name", "version"] as const;
export const CANDIDATE_UNIVERSE_KEYS = [
  "snapshot_ref",
  "input_sha256",
  "selection_method",
  "candidate_count",
] as const;

function validateNode(
  node: unknown,
  nodeIds: Set<string>,
  aliasOwners: Map<string, string>,
  catalogIds: Set<string>,
): node is LineageV2Node {
  if (!exactKeys(node, NODE_KEYS) || !record(node)) {
    return false;
  }
  if (
    !text(node.id) ||
    !text(node.title) ||
    dateValue(node.first_published_at) === null ||
    typeof node.is_focus !== "boolean" ||
    !Array.isArray(node.aliases)
  ) {
    return false;
  }
  const id = node.id as string;
  if (node.is_focus) {
    if (
      typeof node.seed_paper_id !== "string" ||
      !/^[0-9a-f]{40}$/.test(node.seed_paper_id) ||
      !catalogIds.has(node.seed_paper_id)
    ) {
      return false;
    }
  } else if (node.seed_paper_id !== null) {
    return false;
  }
  if (nodeIds.has(id)) return false;
  nodeIds.add(id);
  const local = new Set<string>();
  for (const alias of node.aliases) {
    if (!Array.isArray(alias) || alias.length !== 2 || !validAlias(alias[0], alias[1]))
      return false;
    const key = `${alias[0]}\u0000${alias[1]}`;
    if (local.has(key) || aliasOwners.has(key)) return false;
    local.add(key);
    aliasOwners.set(key, id);
  }
  return true;
}

function validateLocator(locator: unknown): boolean {
  if (!exactKeys(locator, LOCATOR_KEYS) || !record(locator)) {
    return false;
  }
  const ordinal = (value: unknown, minimum: number) =>
    value === null || (Number.isSafeInteger(value) && (value as number) >= minimum);
  return (
    ordinal(locator.page, 1) &&
    nullableText(locator.section) &&
    nullableText(locator.reference_marker) &&
    ordinal(locator.sentence_ordinal, 0) &&
    ordinal(locator.paragraph_ordinal, 0) &&
    Object.values(locator).some((value) => value !== null)
  );
}

function validateClassification(value: unknown): boolean {
  if (!exactKeys(value, CLASSIFICATION_KEYS) || !record(value)) {
    return false;
  }
  if (
    typeof value.method !== "string" ||
    !METHODS.has(value.method) ||
    !nullableText(value.provider) ||
    !nullableText(value.model) ||
    !nullableText(value.prompt_version) ||
    !text(value.schema_version)
  ) {
    return false;
  }
  return value.method !== "llm" || [value.provider, value.model, value.prompt_version].every(text);
}

export interface ArtifactValidation {
  nodeIds: Set<string>;
  evidenceById: Map<string, LineageV2Evidence>;
}

/**
 * Validates a full lineage-artifact-v2 payload against `catalogIds`
 * (the paper IDs the caller's own catalog verified -- a focus node's
 * `seed_paper_id` must be one of these). Returns `null` on ANY
 * violation; on success, returns the node-id set and an
 * evidence-by-id index for `release.ts` to reuse without re-deriving
 * them.
 */
export async function validateArtifact(
  artifact: unknown,
  catalogIds: Set<string>,
): Promise<ArtifactValidation | null> {
  if (
    !record(artifact) ||
    !exactKeys(artifact, ARTIFACT_KEYS) ||
    artifact.schema_version !== ARTIFACT_VERSION ||
    !text(artifact.release_id) ||
    !Array.isArray(artifact.nodes) ||
    artifact.nodes.length > MAX_NODES ||
    !Array.isArray(artifact.links) ||
    artifact.links.length > MAX_LINKS ||
    !Array.isArray(artifact.evidence) ||
    artifact.evidence.length > MAX_EVIDENCE ||
    !Array.isArray(artifact.claims) ||
    artifact.claims.length > MAX_CLAIMS ||
    !Array.isArray(artifact.clusters)
  ) {
    return null;
  }

  const nodeIds = new Set<string>();
  const aliasOwners = new Map<string, string>();
  const nodeDates = new Map<string, bigint>();
  const focusNodes: LineageV2Node[] = [];
  const nodes = artifact.nodes as unknown[];
  for (const rawNode of nodes) {
    if (!validateNode(rawNode, nodeIds, aliasOwners, catalogIds)) return null;
    const node = rawNode as LineageV2Node;
    nodeDates.set(node.id, dateValue(node.first_published_at) as bigint);
    if (node.is_focus) focusNodes.push(node);
  }
  if (nodeIds.size === 0) {
    if (artifact.root !== null || focusNodes.length !== 0) return null;
  } else if (
    !text(artifact.root) ||
    !nodeIds.has(artifact.root as string) ||
    focusNodes.length !== 1 ||
    focusNodes[0]?.id !== artifact.root
  ) {
    return null;
  }

  const evidenceIds = new Set<string>();
  const evidenceById = new Map<string, LineageV2Evidence>();
  const evidenceList = artifact.evidence as unknown[];
  for (const rawItem of evidenceList) {
    if (!record(rawItem) || !exactKeys(rawItem, EVIDENCE_KEYS)) {
      return null;
    }
    const item = rawItem as unknown as LineageV2Evidence;
    if (
      !text(item.id) ||
      evidenceIds.has(item.id) ||
      ![item.source, item.kind, item.source_work_id, item.url, item.snapshot_ref].every(text) ||
      !validHttpUrl(item.url) ||
      !nodeIds.has(item.cited_work_id) ||
      !nodeIds.has(item.citing_work_id) ||
      item.cited_work_id === item.citing_work_id ||
      !validateLocator(item.locator) ||
      !text(item.excerpt) ||
      [...item.excerpt].length > 280 ||
      !/^[0-9a-f]{64}$/.test(item.excerpt_sha256) ||
      !/^[0-9a-f]{64}$/.test(item.input_sha256) ||
      !validTimestamp(item.retrieved_at)
    ) {
      return null;
    }
    if ((await sha256(new TextEncoder().encode(item.excerpt))) !== item.excerpt_sha256) return null;
    evidenceIds.add(item.id);
    evidenceById.set(item.id, item);
  }

  const connected = new Set<string>();
  const linkIds = new Set<string>();
  const links = artifact.links as unknown[];
  for (const rawLink of links) {
    if (!record(rawLink) || !exactKeys(rawLink, LINK_KEYS)) return null;
    const link = rawLink as unknown as LineageV2Link;
    if (
      !text(link.id) ||
      linkIds.has(link.id) ||
      link.type !== "citation" ||
      !nodeIds.has(link.src) ||
      !nodeIds.has(link.dst) ||
      link.src === link.dst ||
      !uniqueTextArray(link.evidence_ids, true) ||
      link.evidence_ids.some((id) => !evidenceIds.has(id))
    ) {
      return null;
    }
    if (
      link.evidence_ids.some((id) => {
        const evidence = evidenceById.get(id) as LineageV2Evidence;
        return evidence.citing_work_id !== link.src || evidence.cited_work_id !== link.dst;
      })
    ) {
      return null;
    }
    linkIds.add(link.id);
    connected.add(link.src);
    connected.add(link.dst);
  }

  const claimIds = new Set<string>();
  const acceptedPairs = new Set<string>();
  const acceptedGraph = new Map<string, string[]>([...nodeIds].map((id) => [id, []]));
  const claims = artifact.claims as unknown[];
  for (const rawClaim of claims) {
    if (!record(rawClaim) || !exactKeys(rawClaim, CLAIM_KEYS)) {
      return null;
    }
    const claim = rawClaim as unknown as LineageV2Claim;
    if (
      !text(claim.id) ||
      claimIds.has(claim.id) ||
      !nodeIds.has(claim.src) ||
      !nodeIds.has(claim.dst) ||
      !DECISIONS.has(claim.decision) ||
      !["genealogy", "comparison"].includes(claim.claim_family) ||
      !TRUST_TIERS.has(claim.trust_tier) ||
      !unitNumber(claim.raw_score) ||
      !unitNumber(claim.calibrated_probability) ||
      !nullableText(claim.calibration_id) ||
      (claim.calibrated_probability === null) !== (claim.calibration_id === null) ||
      !uniqueTextArray(claim.evidence_ids) ||
      claim.evidence_ids.some((id) => !evidenceIds.has(id)) ||
      typeof claim.rationale !== "string" ||
      !uniqueTextArray(claim.reason_codes) ||
      !validateClassification(claim.classification)
    ) {
      return null;
    }
    const asserted = claim.decision === "accepted" || claim.decision === "rejected";
    const familyRelations = claim.claim_family === "genealogy" ? GENEALOGY : COMPARISON;
    if (
      asserted &&
      (!claim.relation || !familyRelations.has(claim.relation) || !text(claim.rationale))
    ) {
      return null;
    }
    if (!asserted && (claim.relation !== null || claim.reason_codes.length === 0)) return null;
    if (claim.decision === "accepted" && claim.src === claim.dst) return null;
    const bound = claim.evidence_ids.map((id) => evidenceById.get(id) as LineageV2Evidence);
    if (
      bound.some(
        (item) =>
          !(
            (item.cited_work_id === claim.src && item.citing_work_id === claim.dst) ||
            (item.cited_work_id === claim.dst && item.citing_work_id === claim.src)
          ),
      )
    ) {
      return null;
    }
    if (
      claim.decision === "accepted" &&
      (bound.length === 0 ||
        bound.some((item) => item.cited_work_id !== claim.src || item.citing_work_id !== claim.dst))
    ) {
      return null;
    }
    if (claim.trust_tier === "corroborated" && claim.decision === "accepted") {
      if (claim.calibrated_probability === null) return null;
      const sources = new Set(bound.map((item) => `${item.source}\u0000${item.kind}`));
      const works = new Set(bound.map((item) => item.source_work_id));
      if (sources.size < 2 || works.size < 2) return null;
    }
    const binding = claim.review_binding;
    if (binding !== null) {
      if (
        !record(binding) ||
        !exactKeys(binding, REVIEW_BINDING_KEYS) ||
        !text(binding.review_id) ||
        !text(binding.fixture_id) ||
        !/^[0-9a-f]{64}$/.test(binding.evidence_sha256)
      ) {
        return null;
      }
      const sortedEvidence = [...bound].sort((left, right) => compareText(left.id, right.id));
      if ((await canonicalSha(sortedEvidence)) !== binding.evidence_sha256) return null;
    }
    if (claim.decision === "accepted" && claim.trust_tier === "verified" && binding === null)
      return null;
    if (claim.decision === "accepted" && claim.claim_family === "genealogy") {
      const key = `${claim.src}\u0000${claim.dst}`;
      const reverse = `${claim.dst}\u0000${claim.src}`;
      const srcDate = nodeDates.get(claim.src) as bigint;
      const dstDate = nodeDates.get(claim.dst) as bigint;
      if (acceptedPairs.has(reverse) || srcDate > dstDate) return null;
      acceptedPairs.add(key);
      (acceptedGraph.get(claim.src) as string[]).push(claim.dst);
    }
    claimIds.add(claim.id);
    connected.add(claim.src);
    connected.add(claim.dst);
  }

  // Iterative (non-recursive) 3-color DFS cycle detection over the
  // accepted genealogy graph -- a cycle (even one not reachable from
  // the root) must fail closed.
  const color = new Map<string, 0 | 1 | 2>();
  for (const start of nodeIds) {
    if ((color.get(start) ?? 0) !== 0) continue;
    color.set(start, 1);
    const stack: Array<[string, number]> = [[start, 0]];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as [string, number];
      const children = acceptedGraph.get(frame[0]) as string[];
      if (frame[1] >= children.length) {
        color.set(frame[0], 2);
        stack.pop();
        continue;
      }
      const child = children[frame[1]++] as string;
      if ((color.get(child) ?? 0) === 1) return null;
      if ((color.get(child) ?? 0) === 0) {
        color.set(child, 1);
        stack.push([child, 0]);
      }
    }
  }
  for (const id of nodeIds) {
    if (id !== artifact.root && !connected.has(id)) return null;
  }

  if (
    !record(artifact.meta) ||
    !exactKeys(artifact.meta, META_KEYS) ||
    !["conference", "theme", "deep"].includes(String(artifact.meta.kind)) ||
    !record(artifact.meta.producer) ||
    !exactKeys(artifact.meta.producer, PRODUCER_KEYS) ||
    !text(artifact.meta.producer.name) ||
    !text(artifact.meta.producer.version) ||
    !validTimestamp(artifact.meta.generated_at) ||
    !record(artifact.meta.candidate_universe) ||
    !exactKeys(artifact.meta.candidate_universe, CANDIDATE_UNIVERSE_KEYS) ||
    !text(artifact.meta.candidate_universe.snapshot_ref) ||
    !/^[0-9a-f]{64}$/.test(String(artifact.meta.candidate_universe.input_sha256)) ||
    !text(artifact.meta.candidate_universe.selection_method) ||
    !nonnegativeInteger(artifact.meta.candidate_universe.candidate_count) ||
    artifact.meta.candidate_universe.candidate_count !== claims.length
  ) {
    return null;
  }

  return { nodeIds, evidenceById };
}

export type { LineageV2Artifact };

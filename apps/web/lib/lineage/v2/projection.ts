/**
 * Deterministic Focus View graph projection -- ported 1:1 from
 * docs/assets/lineage-v2-core.js `selectFocusProjection`
 * (safety-contracts.md SCR-47/SCR-48). Given a verified `Release` and
 * a normalized `FocusViewState`, this is the single function that
 * decides exactly which nodes/claims the graph and list views render:
 * it filters claims by decision/trust/family/relation/confidence/
 * evidence, BFS-bounds genealogy by hop count from the focus, greedily
 * builds a "spine" (nearer ancestors/successors before farther ones,
 * interleaved by hop) within the node/claim caps, fills remaining
 * budget with branches/other eligible genealogy, then separately
 * layers in explicitly expanded-node branches, a capped tentative
 * sample, and a capped (6) comparison sample -- in that fixed order,
 * so the result depends only on the release's content and the state,
 * never on any input array's original order (pinned by
 * test_lineage_v2_core.mjs's "projection order is independent of all
 * input array orders").
 */
import { releaseBrand, releasePrivate } from "./brand";
import type { Relation, TrustTier } from "./constants";
import { compareText, deepFreeze } from "./json";
import { type FocusViewState, validState } from "./state";
import type { LineageV2Claim, LineageV2Node, Release } from "./types";

export interface HiddenBranch {
  nodeId: string;
  parent: number;
  child: number;
}

export interface ProjectionCounts {
  totalNodes: number;
  rawLinks: number;
  allClaims: number;
  acceptedClaims: number;
  acceptedGenealogyClaims: number;
  acceptedComparisonClaims: number;
  eligibleClaims: number;
  shownNodes: number;
  shownClaims: number;
}

export interface ProjectionExclusions {
  decision: number;
  trust: number;
  family: number;
  relation: number;
  confidence: number;
  evidence: number;
  hop: number;
  branch: number;
  nodeCap: number;
  claimCap: number;
  collapse: number;
}

export interface FocusProjection {
  focus: LineageV2Node;
  nodes: LineageV2Node[];
  claims: LineageV2Claim[];
  genealogyClaims: LineageV2Claim[];
  comparisonClaims: LineageV2Claim[];
  hiddenBranches: HiddenBranch[];
  counts: ProjectionCounts;
  exclusions: ProjectionExclusions;
  expandedNodeIds: string[];
  forceList: boolean;
  statusCodes: string[];
}

const RELATION_RANK = new Map<Relation, number>([
  ["supersedes", 0],
  ["successor", 1],
  ["extends", 2],
  ["ablation", 3],
  ["baseline_only", 4],
  ["contrasts", 5],
]);
const TRUST_RANK = new Map<TrustTier, number>([
  ["verified", 0],
  ["corroborated", 1],
  ["tentative", 2],
]);

export function selectFocusProjection(
  release: Release | null,
  state: unknown,
): FocusProjection | null {
  if (
    !release ||
    typeof release !== "object" ||
    !releaseBrand.has(release as object) ||
    !validState(release, state)
  ) {
    return null;
  }
  const typedState = state as FocusViewState;
  const indexes = releasePrivate.get(release as object);
  const focus = typedState.focusId === null ? null : indexes?.nodeById.get(typedState.focusId);
  if (!focus) return null;

  const trust = new Set(typedState.trustTiers);
  const families = new Set(typedState.families);
  const relations = new Set(typedState.relations);
  const sources = new Set(typedState.evidenceSources);
  const kinds = new Set(typedState.evidenceKinds);
  const exclusions: ProjectionExclusions = {
    decision: 0,
    trust: 0,
    family: 0,
    relation: 0,
    confidence: 0,
    evidence: 0,
    hop: 0,
    branch: 0,
    nodeCap: 0,
    claimCap: 0,
    collapse: 0,
  };

  const acceptedGenealogy = release.artifact.claims.filter(
    (claim) => claim.decision === "accepted" && claim.claim_family === "genealogy",
  );
  const acceptedComparison = release.artifact.claims.filter(
    (claim) => claim.decision === "accepted" && claim.claim_family === "comparison",
  );
  const degree = new Map<string, number>(release.artifact.nodes.map((node) => [node.id, 0]));
  for (const claim of acceptedGenealogy) {
    degree.set(claim.src, (degree.get(claim.src) as number) + 1);
    degree.set(claim.dst, (degree.get(claim.dst) as number) + 1);
  }

  const comparator = (
    left: LineageV2Claim,
    right: LineageV2Claim,
    from: string | null = null,
  ): number => {
    const leftProbability = left.calibrated_probability;
    const rightProbability = right.calibrated_probability;
    const opposite = (claim: LineageV2Claim): number =>
      from === null
        ? Math.max(degree.get(claim.src) as number, degree.get(claim.dst) as number)
        : (degree.get(claim.src === from ? claim.dst : claim.src) as number);
    return (
      (TRUST_RANK.get(left.trust_tier) as number) - (TRUST_RANK.get(right.trust_tier) as number) ||
      (rightProbability === null ? -1 : rightProbability) -
        (leftProbability === null ? -1 : leftProbability) ||
      (RELATION_RANK.get(left.relation as Relation) as number) -
        (RELATION_RANK.get(right.relation as Relation) as number) ||
      opposite(right) - opposite(left) ||
      compareText(left.src, right.src) ||
      compareText(left.dst, right.dst) ||
      compareText(left.id, right.id)
    );
  };

  const eligible: LineageV2Claim[] = [];
  for (const claim of release.artifact.claims) {
    if (claim.decision !== "accepted") {
      exclusions.decision++;
      continue;
    }
    if (!trust.has(claim.trust_tier)) {
      exclusions.trust++;
      continue;
    }
    if (!families.has(claim.claim_family)) {
      exclusions.family++;
      continue;
    }
    if (!claim.relation || !relations.has(claim.relation)) {
      exclusions.relation++;
      continue;
    }
    if (
      claim.trust_tier === "corroborated" &&
      (claim.calibrated_probability === null ||
        claim.calibrated_probability < typedState.minConfidence)
    ) {
      exclusions.confidence++;
      continue;
    }
    const bound = claim.evidence_ids
      .map((id) => indexes?.evidenceById.get(id))
      .filter(Boolean) as Array<{
      source: string;
      kind: string;
    }>;
    if (
      (typedState.evidenceSourcesExplicit && !bound.some((item) => sources.has(item.source))) ||
      (typedState.evidenceKindsExplicit && !bound.some((item) => kinds.has(item.kind)))
    ) {
      exclusions.evidence++;
      continue;
    }
    eligible.push(claim);
  }

  // Tentative exploration is deliberately excluded from the trusted spine
  // and branch budget even when the caller explicitly enables it.
  const genealogy = eligible.filter(
    (claim) => claim.claim_family === "genealogy" && claim.trust_tier !== "tentative",
  );
  const tentative = eligible.filter(
    (claim) => claim.claim_family === "genealogy" && claim.trust_tier === "tentative",
  );
  const comparison = eligible.filter((claim) => claim.claim_family === "comparison");

  const adjacent = new Map<string, LineageV2Claim[]>(
    release.artifact.nodes.map((node) => [node.id, []]),
  );
  for (const claim of genealogy) {
    (adjacent.get(claim.src) as LineageV2Claim[]).push(claim);
    (adjacent.get(claim.dst) as LineageV2Claim[]).push(claim);
  }
  for (const [nodeId, claims] of adjacent) claims.sort((a, b) => comparator(a, b, nodeId));

  const distances = new Map<string, number>([[focus.id, 0]]);
  const distanceQueue = [focus.id];
  for (let index = 0; index < distanceQueue.length; index++) {
    const nodeId = distanceQueue[index] as string;
    const distance = distances.get(nodeId) as number;
    if (distance >= typedState.hops) continue;
    for (const claim of adjacent.get(nodeId) as LineageV2Claim[]) {
      const other = claim.src === nodeId ? claim.dst : claim.src;
      if (!distances.has(other)) {
        distances.set(other, distance + 1);
        distanceQueue.push(other);
      }
    }
  }

  const selectedNodes = new Set<string>([focus.id]);
  const selectedClaims = new Set<string>();
  const traversalOrder: LineageV2Claim[] = [];
  const addClaim = (claim: LineageV2Claim, nodeCap: number, claimCap: number): boolean => {
    if (selectedClaims.has(claim.id)) return true;
    const newNodes = [claim.src, claim.dst].filter((id) => !selectedNodes.has(id));
    if (selectedNodes.size + newNodes.length > nodeCap) return false;
    if (selectedClaims.size >= claimCap) return false;
    newNodes.forEach((id) => {
      selectedNodes.add(id);
    });
    selectedClaims.add(claim.id);
    traversalOrder.push(claim);
    return true;
  };

  const spineNodes = [focus.id];
  const spineCurrent: { parent: string; child: string } = { parent: focus.id, child: focus.id };
  // Interleave directions by hop so a tight cap always preserves nearer
  // ancestors and successors before either direction's more distant node.
  for (let hop = 0; hop < typedState.hops; hop++) {
    for (const direction of ["parent", "child"] as const) {
      const current = spineCurrent[direction];
      const candidates = (adjacent.get(current) as LineageV2Claim[]).filter((claim) =>
        direction === "parent" ? claim.dst === current : claim.src === current,
      );
      const chosen = candidates.find((claim) => !selectedClaims.has(claim.id));
      if (!chosen || !addClaim(chosen, typedState.nodeLimit, typedState.claimLimit)) continue;
      spineCurrent[direction] = direction === "parent" ? chosen.src : chosen.dst;
      spineNodes.push(spineCurrent[direction]);
    }
  }

  const branchQueue = [...new Set(spineNodes)];
  for (let index = 0; index < branchQueue.length; index++) {
    const nodeId = branchQueue[index] as string;
    let branches = 0;
    for (const claim of adjacent.get(nodeId) as LineageV2Claim[]) {
      if (selectedClaims.has(claim.id)) continue;
      const other = claim.src === nodeId ? claim.dst : claim.src;
      if ((distances.get(other) ?? Number.POSITIVE_INFINITY) > typedState.hops) continue;
      if (selectedNodes.has(other)) continue;
      if (branches >= 2) break;
      if (!addClaim(claim, typedState.nodeLimit, typedState.claimLimit)) continue;
      branchQueue.push(other);
      branches++;
    }
  }

  const sortedGenealogy = [...genealogy].sort(comparator);
  for (const claim of sortedGenealogy) {
    if (selectedClaims.size >= typedState.claimLimit) break;
    if (selectedNodes.has(claim.src) && selectedNodes.has(claim.dst)) {
      addClaim(claim, typedState.nodeLimit, typedState.claimLimit);
    }
  }

  const validExpanded = typedState.expandedNodeIds.filter((id) => selectedNodes.has(id));
  const statusCodes = new Set(typedState.statusCodes);
  for (const id of typedState.expandedNodeIds) {
    if (!selectedNodes.has(id)) statusCodes.add("collapsed_expansion_target");
  }
  for (const nodeId of validExpanded) {
    let added = 0;
    for (const claim of adjacent.get(nodeId) as LineageV2Claim[]) {
      if (selectedClaims.has(claim.id)) continue;
      const other = claim.src === nodeId ? claim.dst : claim.src;
      if (selectedNodes.has(other)) continue;
      if (added >= 2) break;
      if (addClaim(claim, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) added++;
    }
  }

  let tentativeAdded = 0;
  for (const claim of [...tentative].sort(comparator)) {
    if (tentativeAdded >= 6 || selectedClaims.size >= typedState.claimLimit) break;
    if (selectedNodes.has(claim.src) || selectedNodes.has(claim.dst)) {
      if (addClaim(claim, typedState.nodeLimit, typedState.claimLimit)) tentativeAdded++;
    }
  }

  let comparisonAdded = 0;
  for (const claim of [...comparison].sort(comparator)) {
    if (comparisonAdded >= 6 || selectedClaims.size >= typedState.claimLimit) break;
    const bothSelected = selectedNodes.has(claim.src) && selectedNodes.has(claim.dst);
    const touchesFocus = claim.src === focus.id || claim.dst === focus.id;
    if (
      (bothSelected || touchesFocus) &&
      addClaim(
        claim,
        bothSelected ? Number.MAX_SAFE_INTEGER : typedState.nodeLimit,
        typedState.claimLimit,
      )
    ) {
      comparisonAdded++;
    }
  }

  const selectedClaimRows = traversalOrder;
  const selectedClaimIds = new Set(selectedClaimRows.map((claim) => claim.id));
  for (const claim of eligible) {
    if (selectedClaimIds.has(claim.id)) continue;
    const srcDistance = distances.get(claim.src) ?? Number.POSITIVE_INFINITY;
    const dstDistance = distances.get(claim.dst) ?? Number.POSITIVE_INFINITY;
    if (
      claim.claim_family === "genealogy" &&
      Math.max(srcDistance, dstDistance) > typedState.hops
    ) {
      exclusions.hop++;
    } else if (
      selectedNodes.size >= typedState.nodeLimit &&
      (!selectedNodes.has(claim.src) || !selectedNodes.has(claim.dst))
    ) {
      exclusions.nodeCap++;
    } else if (selectedClaims.size >= typedState.claimLimit) {
      exclusions.claimCap++;
    } else {
      exclusions.branch++;
    }
  }

  const nodes = [...selectedNodes].map((id) => indexes?.nodeById.get(id) as LineageV2Node);
  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  nodes.sort((left, right) =>
    left.id === focus.id
      ? -1
      : right.id === focus.id
        ? 1
        : (nodeOrder.get(left.id) as number) - (nodeOrder.get(right.id) as number) ||
          compareText(left.id, right.id),
  );
  const hiddenBranches: HiddenBranch[] = nodes
    .map((node) => {
      let parent = 0;
      let child = 0;
      for (const claim of adjacent.get(node.id) as LineageV2Claim[]) {
        if (selectedClaimIds.has(claim.id)) continue;
        if (claim.dst === node.id) parent++;
        if (claim.src === node.id) child++;
      }
      return { nodeId: node.id, parent, child };
    })
    .filter((item) => item.parent > 0 || item.child > 0)
    .sort((a, b) => compareText(a.nodeId, b.nodeId));

  const genealogyClaims = selectedClaimRows.filter((claim) => claim.claim_family === "genealogy");
  const comparisonClaims = selectedClaimRows.filter((claim) => claim.claim_family === "comparison");
  const counts: ProjectionCounts = {
    totalNodes: release.artifact.nodes.length,
    rawLinks: release.artifact.links.length,
    allClaims: release.artifact.claims.length,
    acceptedClaims: release.artifact.claims.filter((claim) => claim.decision === "accepted").length,
    acceptedGenealogyClaims: acceptedGenealogy.length,
    acceptedComparisonClaims: acceptedComparison.length,
    eligibleClaims: eligible.length,
    shownNodes: nodes.length,
    shownClaims: selectedClaimRows.length,
  };

  const projection: FocusProjection = {
    focus,
    nodes,
    claims: selectedClaimRows,
    genealogyClaims,
    comparisonClaims,
    hiddenBranches,
    counts,
    exclusions,
    expandedNodeIds: [...validExpanded].sort(compareText),
    forceList: nodes.length > 50 || selectedClaimRows.length > 80,
    statusCodes: [...statusCodes].sort(compareText),
  };
  return deepFreeze(projection);
}

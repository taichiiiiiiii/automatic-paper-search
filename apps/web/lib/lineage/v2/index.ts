/**
 * Public barrel for the lineage-v2 Focus View contract -- re-exports
 * the same surface as `root.PaperPilotLineageV2` in
 * docs/assets/lineage-v2-core.js (`parsePilotIndex`,
 * `resolvePilotEntry`, `verifyPilotRelease`, `resolveFocus`,
 * `readState`, `writeState`, `selectFocusProjection`), plus this
 * port's loader (`loadVerifiedRelease` and friends, ported from
 * docs/assets/lineage-focus.js) and pure layout helpers. Prefer
 * importing from here rather than reaching into individual v2/*
 * files, except where a test needs a module-internal helper.
 */

export {
  ARTIFACT_KEYS,
  CANDIDATE_UNIVERSE_KEYS,
  CLAIM_KEYS,
  CLASSIFICATION_KEYS,
  EVIDENCE_KEYS,
  LINK_KEYS,
  LOCATOR_KEYS,
  META_KEYS,
  NODE_KEYS,
  PRODUCER_KEYS,
  REVIEW_BINDING_KEYS,
} from "./artifact";
export type {
  AliasNamespace,
  CheckStatus,
  Decision,
  EvidenceSupport,
  Relation,
  TrustTier,
} from "./constants";
export type {
  CanvasBounds,
  HiddenCounts,
  LabelBox,
  LaneDefinition,
  LaneLayout,
  LayeredLayout,
  Point,
} from "./layout";
export {
  EXCLUSION_LABELS,
  fixtureLabel,
  hiddenCounts,
  labelForRelation,
  laneLayout,
  layeredLayout,
  nodeLanes,
  placeEdgeLabel,
  RELATION_LABELS,
  rectangleEdgePoints,
  routeEdge,
  safeEvidenceLink,
  segmentHitsCard,
  shortTitle,
} from "./layout";
export type {
  FetchLike,
  FetchResponseLike,
  LoadOwner,
  LoadVerifiedReleaseDeps,
  TimerLike,
} from "./loader";
export {
  fetchBytes,
  LOAD_TIMEOUT_MS,
  loadOwner,
  loadVerifiedRelease,
  PILOT_RELEASE_MAX_BYTES,
  readBounded,
} from "./loader";
export { ENTRY_KEYS, parsePilotIndex, resolvePilotEntry } from "./pilot-index";
export type {
  FocusProjection,
  HiddenBranch,
  ProjectionCounts,
  ProjectionExclusions,
} from "./projection";
export { selectFocusProjection } from "./projection";
export { resolveFocus, verifyPilotRelease } from "./release";
export type { FocusFamily, FocusViewMode, FocusViewState, ReadStateOptions } from "./state";
export { readState, writeState } from "./state";
export type {
  LineageV2Artifact,
  LineageV2Claim,
  LineageV2Evidence,
  LineageV2Fixture,
  LineageV2Link,
  LineageV2Node,
  LineageV2Quality,
  LineageV2QualityRow,
  PilotIndex,
  PilotIndexEntry,
  Release,
} from "./types";

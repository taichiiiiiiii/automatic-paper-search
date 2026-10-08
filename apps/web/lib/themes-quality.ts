/**
 * Quality-gate reader for the themes area, scoped to exactly what
 * docs/assets/theme.js used from docs/assets/lineage-core.js:
 * `fetchJsonWithSha256`, `parseQualityManifest`, `resolveQualityCollection`,
 * `qualityRowIsEligible`, `qualityRowIsPublishable`, `parseArtifact`
 * (kind="theme"), and `resolveFocus`.
 *
 * P2 parity-gap row 6 (docs/migration/p2-parity-gaps.md): this file
 * used to re-implement all of that validation logic locally, byte-for-
 * byte duplicating apps/web/lib/lineage/core.ts (owned by the lineage
 * area) -- both were independent 1:1 ports of the same
 * docs/assets/lineage-core.js. core.ts already covers every function
 * this file needs, with an identical fail-closed contract (same key
 * lists, same regexes, same hashing/size-bound rules), so there was
 * nothing missing to add there. This file now re-exports/wraps
 * core.ts's functions instead of maintaining a second copy of the
 * logic -- the only reason it still exists as its own module (rather
 * than every themes file importing "./lineage/core" directly) is to
 * keep the richer, theme-card-specific `LineageNode`/`LineageEdge`
 * shape (venue/tldr/arxiv_id/doi/is_trending etc. -- fields core.ts's
 * narrower type doesn't name but that are present on the actual
 * runtime objects, since core.ts's parser spreads every original JSON
 * field through) without widening core.ts's own exported types for
 * every other lineage consumer.
 *
 * Every wrapper below delegates to core.ts for the actual validation;
 * none of them re-implement any parsing/hashing/gating rule.
 */
import type {
  ArtifactKind,
  FetchedJson as CoreFetchedJson,
  LineageArtifact as CoreLineageArtifact,
  QualityAudit as CoreQualityAudit,
  QualityCheck as CoreQualityCheck,
  QualityManifest as CoreQualityManifest,
  QualityRow as CoreQualityRow,
  QualitySelector as CoreQualitySelector,
  Provenance,
} from "./lineage/core";
import {
  ARTIFACT_VERSION as CORE_ARTIFACT_VERSION,
  MAX_JSON_BYTES as CORE_MAX_JSON_BYTES,
  fetchJsonWithSha256 as coreFetchJsonWithSha256,
  parseArtifact as coreParseArtifact,
  parseQualityManifest as coreParseQualityManifest,
  qualityRowIsEligible as coreQualityRowIsEligible,
  qualityRowIsPublishable as coreQualityRowIsPublishable,
  resolveFocus as coreResolveFocus,
  resolveQualityCollection as coreResolveQualityCollection,
  validProvenance as coreValidProvenance,
} from "./lineage/core";

export const ARTIFACT_VERSION = CORE_ARTIFACT_VERSION;
export const MAX_JSON_BYTES = CORE_MAX_JSON_BYTES;

export type LineageProvenance = Provenance;

export function validProvenance(value: unknown): value is LineageProvenance {
  return coreValidProvenance(value);
}

export interface LineageNode {
  id: string;
  is_focus: boolean;
  seed_paper_id?: string;
  aliases?: unknown[];
  title?: string;
  year?: number | null;
  authors?: string[] | null;
  citation_count?: number | null;
  github_stars?: number | null;
  venue?: string;
  venue_tier?: string | number;
  tldr?: string;
  arxiv_id?: string;
  doi?: string;
  is_trending?: boolean;
  [key: string]: unknown;
}

export interface LineageEdge {
  src: string;
  dst: string;
  relation: string;
  confidence: number;
  rationale: string;
  provenance: LineageProvenance;
}

export interface LineageArtifact {
  schema_version: typeof ARTIFACT_VERSION;
  root: string | null;
  nodes: LineageNode[];
  edges: LineageEdge[];
  clusters: unknown[];
  meta: Record<string, unknown>;
}

export type LineageArtifactKind = ArtifactKind;

/**
 * Thin wrapper around core.ts's strict `parseArtifact` -- it does the
 * actual validation; this just re-asserts the richer `LineageNode`
 * shape above (the runtime value already satisfies it: core.ts's
 * parser spreads every original node/meta field through, it just
 * doesn't name the theme-only display fields in its own type).
 */
export function parseArtifact(
  data: unknown,
  options: { kind?: LineageArtifactKind } = {},
): LineageArtifact | null {
  return coreParseArtifact(data, options) as unknown as LineageArtifact | null;
}

// ---- Quality manifest (lineage-quality-v1.json) ------------------------
// core.ts's QualityCheck/QualityAudit/QualityRow/QualityManifest types
// already match exactly what theme code needs field-for-field, so
// these are plain type aliases (no shape differs from core.ts).

export type QualityCheck = CoreQualityCheck;
export type QualityAudit = CoreQualityAudit;
export type QualityRow = CoreQualityRow;
export type QualityManifest = CoreQualityManifest;
export type QualitySelector = CoreQualitySelector;

export function parseQualityManifest(data: unknown): QualityManifest | null {
  return coreParseQualityManifest(data);
}

export function resolveQualityCollection(
  quality: QualityManifest | null,
  selector: QualitySelector,
): QualityRow | null {
  return coreResolveQualityCollection(quality, selector);
}

export const qualityRowIsEligible = coreQualityRowIsEligible;
export const qualityRowIsPublishable = coreQualityRowIsPublishable;

// ---- Bounded fetch + SHA-256 --------------------------------------------

export type FetchedJson = CoreFetchedJson;

export async function fetchJsonWithSha256(
  url: string,
  options?: RequestInit,
  config?: { expectedSha256?: string | null },
): Promise<FetchedJson | null> {
  return coreFetchJsonWithSha256(url, options, config);
}

/**
 * Resolves the canonical focus node (see core.ts's `resolveFocus` for
 * the exact SCR-24 fail-closed rules this enforces). Takes the looser
 * `{ nodes, root }` shape theme callers already use rather than the
 * full `LineageArtifact` core.ts's own signature expects -- core's
 * implementation only ever reads those two fields, so the cast is
 * safe and callers don't need to fabricate `schema_version`/`edges`/etc.
 */
export function resolveFocus(
  data: { nodes: LineageNode[]; root: string | null } | null | undefined,
  raw: string | null | undefined,
): LineageNode | null {
  return coreResolveFocus(
    data as unknown as CoreLineageArtifact | null,
    raw,
  ) as unknown as LineageNode | null;
}

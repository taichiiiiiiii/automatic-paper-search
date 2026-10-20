/**
 * Shared fail-closed reader for lineage-artifact-v1 and
 * lineage-quality-v1 -- a faithful TypeScript port of
 * docs/assets/lineage-core.js (see safety-contracts.md SCR-21..SCR-30).
 *
 * This module is pure (no DOM, no fetch side effects besides
 * `fetchJsonWithSha256`, which takes an injectable `fetch`-like
 * function so tests never hit the network -- absolute rule, see
 * CLAUDE.md "外部 API を叩くテストを書かない"). Every parser returns
 * `null` on any shape it does not recognise; callers must never fall
 * back to a looser read on a `null`.
 *
 * Keep this file behaviourally identical to docs/assets/lineage-core.js.
 * If the two diverge, the fetched JSON could be accepted here but
 * rejected there (or vice versa) -- exactly the drift SCR-23/SCR-45
 * exist to prevent. `test/lineage/core.test.ts` ports
 * paperpilot/tests/viewer/test_lineage_core.mjs's cases 1:1 against
 * this file, not the JS.
 *
 * Deliberate divergence (design doc 41 D1): the quality gate now
 * publishes two tiers -- `audited` (the original ready+passed contract)
 * and `unaudited` (every automatic check passed, golden fixture
 * `unknown`) -- see `qualityRowPublishedTier`. The legacy JS only ever
 * knew the first.
 */

import { abstractContradictsTitle } from "@paperpilot/core/abstract-sanity";

export const ARTIFACT_VERSION = "lineage-artifact-v1" as const;
export const QUALITY_VERSION = "lineage-quality-v1" as const;

const PAPER_ID_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const MAX_JSON_BYTES = 8 * 1024 * 1024;

const EXACT_ALIAS_NAMESPACES = new Set(["arxiv", "openreview", "acl_anthology", "cvf", "doi"]);

export const RELATIONS = new Set([
  "supersedes",
  "successor",
  "extends",
  "ablation",
  "baseline_only",
  "contrasts",
]);

const METHODS = new Set([
  "llm",
  "citation_heuristic",
  "intent_map",
  "context_pattern",
  "year_cite",
  "title_version",
  "foundational_allowlist",
  "s2_context_rule",
  "api_citation",
]);

export type Relation =
  | "supersedes"
  | "successor"
  | "extends"
  | "ablation"
  | "baseline_only"
  | "contrasts";

export interface ProvenanceClassification {
  method: string;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  schema_version: string;
}

export interface Provenance {
  producer: { name: string; version: string };
  evidence: { source: string; kind: string; sha256: string };
  classification: ProvenanceClassification;
}

export interface LineageNode {
  id: string;
  is_focus: boolean;
  title?: string;
  year?: number | null;
  authors?: string[] | null;
  citation_count?: number | null;
  /** R2-36: where `citation_count` came from; absent = OpenAlex. */
  citation_count_source?: "openalex" | "semantic_scholar";
  github_stars?: number | null;
  seed_paper_id?: string;
  aliases?: [string, string][];
  [key: string]: unknown;
}

export interface LineageEdge {
  src: string;
  dst: string;
  relation: Relation;
  confidence: number;
  rationale: string;
  provenance: Provenance;
}

export interface LineageArtifact {
  schema_version: typeof ARTIFACT_VERSION;
  root: string | null;
  nodes: LineageNode[];
  edges: LineageEdge[];
  clusters: Record<string, unknown>[];
  meta: Record<string, unknown>;
}

export interface QualityCheck {
  name: string;
  status: "unknown" | "passed" | "failed";
  observed: unknown;
  expected: unknown;
  evidence: string[];
}

export interface QualityAudit {
  fixture_sha256: string | null;
  evaluated_at: string;
  actor: string;
  checks: QualityCheck[];
}

/** Design doc 41 D1. `audited` and `unaudited` rows are published (the
 * latter with a visible 未監査 badge); `blocked` rows never are. */
export type PublicationTier = "audited" | "unaudited" | "blocked";
/** The two tiers a page may render. */
export type PublishedTier = Exclude<PublicationTier, "blocked">;

export interface QualityRow {
  collection_id: string;
  kind: "conference" | "theme";
  slug: string;
  label: string;
  path: string;
  availability: "unavailable" | "sparse" | "ready" | "failed";
  audit_status: "unknown" | "passed" | "failed";
  /** Written by the quality builder since design doc 41; derived from the
   * checks when absent (older manifests). */
  publication_tier?: PublicationTier;
  freshness: "fresh" | "stale";
  generated_at: string | null;
  snapshot_date: string | null;
  node_count: number;
  edge_count: number;
  artifact_schema_version: string | null;
  input_sha256: string | null;
  audit: QualityAudit;
}

export interface QualityManifest {
  schema_version: typeof QUALITY_VERSION;
  as_of: string;
  audit_version: "audit-v1";
  collections: QualityRow[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function validCalendarParts([year, month, day, hour, minute, second]: number[]): boolean {
  if (
    (month ?? 0) < 1 ||
    (month ?? 0) > 12 ||
    (hour ?? 0) > 23 ||
    (minute ?? 0) > 59 ||
    (second ?? 0) > 59
  )
    return false;
  const y = year ?? 0;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (day ?? 0) >= 1 && (day ?? 0) <= (days[(month ?? 1) - 1] ?? 0);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TIMESTAMP_RE.exec(value);
  if (!match || !validCalendarParts(match.slice(1, 7).map(Number))) return false;
  return Number.isFinite(Date.parse(value));
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_RE.exec(value);
  return (
    !!match && validCalendarParts([Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0])
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedNodeAlias(alias: unknown, kind: ArtifactKind): string | null {
  if (
    !Array.isArray(alias) ||
    alias.length !== 2 ||
    typeof alias[0] !== "string" ||
    typeof alias[1] !== "string"
  )
    return null;
  const [namespace, sourceId] = alias as [string, string];
  if (namespace === "semantic_scholar") {
    return kind !== "theme" && nonempty(sourceId) && sourceId === sourceId.trim()
      ? `${namespace}\u0000${sourceId}`
      : null;
  }
  if (!EXACT_ALIAS_NAMESPACES.has(namespace) || sourceId !== sourceId.trim()) return null;
  if (namespace === "arxiv") {
    if (/^\d{4}\.\d{4,5}$/.test(sourceId)) return `${namespace}\u0000${sourceId}`;
    const legacy = /^([A-Za-z][A-Za-z0-9.-]*)\/(\d{7})$/.exec(sourceId);
    if (!legacy) return null;
    let archive = legacy[1] as string;
    if (archive.includes(".")) {
      const dot = archive.indexOf(".");
      archive = `${archive.slice(0, dot).toLowerCase()}${archive.slice(dot)}`;
    } else {
      archive = archive.toLowerCase();
    }
    return sourceId === `${archive}/${legacy[2]}` ? `${namespace}\u0000${sourceId}` : null;
  }
  if (namespace === "openreview") {
    return /^[A-Za-z0-9_-]{1,256}$/.test(sourceId) ? `${namespace}\u0000${sourceId}` : null;
  }
  if (namespace === "acl_anthology" || namespace === "cvf") {
    return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,511}$/.test(sourceId)
      ? `${namespace}\u0000${sourceId}`
      : null;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: excluding control chars from the DOI suffix is the point (ported from docs/assets/lineage-core.js).
  return /^10\.\d{4,9}\/[^\s\x00-\x1f\x7f]+$/.test(sourceId) && sourceId === sourceId.toLowerCase()
    ? `${namespace}\u0000${sourceId}`
    : null;
}

export function validProvenance(value: unknown): value is Provenance {
  if (
    !record(value) ||
    !record(value.producer) ||
    !record(value.evidence) ||
    !record(value.classification)
  )
    return false;
  const { producer, evidence, classification } = value as {
    producer: Record<string, unknown>;
    evidence: Record<string, unknown>;
    classification: Record<string, unknown>;
  };
  if (
    !exactKeys(value, ["producer", "evidence", "classification"]) ||
    !exactKeys(producer, ["name", "version"]) ||
    !exactKeys(evidence, ["source", "kind", "sha256"]) ||
    !exactKeys(classification, [
      "method",
      "provider",
      "model",
      "prompt_version",
      "schema_version",
    ]) ||
    !nonempty(producer.name) ||
    !nonempty(producer.version) ||
    !nonempty(evidence.source) ||
    !nonempty(evidence.kind) ||
    typeof evidence.sha256 !== "string" ||
    !SHA256_RE.test(evidence.sha256) ||
    typeof classification.method !== "string" ||
    !METHODS.has(classification.method) ||
    !nonempty(classification.schema_version)
  )
    return false;
  for (const field of ["provider", "model", "prompt_version"] as const) {
    const fieldValue = classification[field];
    if (fieldValue !== null && !nonempty(fieldValue)) return false;
  }
  if (classification.method === "llm") {
    return (["provider", "model", "prompt_version"] as const).every((field) =>
      nonempty(classification[field]),
    );
  }
  return true;
}

function optionalCount(value: unknown): boolean {
  return (
    value === undefined || value === null || (Number.isInteger(value) && (value as number) >= 0)
  );
}

/** Mirrors _node_display_issues in _lineage_contract.py: absent or null is
 * legitimate, a wrong type is a projection bug. */
export function validNodeDisplay(node: Record<string, unknown>): boolean {
  const has = (field: string) => Object.hasOwn(node, field);
  if (has("title") && typeof node.title !== "string") return false;
  if (node.year !== undefined && node.year !== null && !Number.isInteger(node.year)) return false;
  if (
    node.authors !== undefined &&
    node.authors !== null &&
    (!Array.isArray(node.authors) || node.authors.some((author) => typeof author !== "string"))
  )
    return false;
  if (!optionalCount(node.citation_count) || !optionalCount(node.github_stars)) return false;
  if (
    has("citation_count_source") &&
    node.citation_count_source !== "openalex" &&
    node.citation_count_source !== "semantic_scholar"
  )
    return false;
  return !has("citationCount");
}

export type ArtifactKind = "conference" | "theme";

/**
 * R2-26: drop a node's abstract excerpt (`tldr` / `short_abstract`) when it
 * evidently belongs to another paper (OpenAlex W3015468748 "Longformer"
 * carries a 2025 "Murmurative Attention" abstract in the published
 * flash-attention lineage). Showing it would attribute another work's
 * text to this paper; the pipeline applies the same check at generation
 * time, this guards artifacts published before it.
 */
export function withoutForeignAbstract(node: Record<string, unknown>): Record<string, unknown> {
  const title = typeof node.title === "string" ? node.title : "";
  const text =
    typeof node.short_abstract === "string" && node.short_abstract
      ? node.short_abstract
      : typeof node.tldr === "string"
        ? node.tldr
        : "";
  if (!title || !text || !abstractContradictsTitle(title, text)) return node;
  const { tldr: _tldr, short_abstract: _short, ...rest } = node;
  return { ...rest, tldr: "" };
}

export function parseArtifact(
  data: unknown,
  { kind = "conference" }: { kind?: ArtifactKind } = {},
): LineageArtifact | null {
  if (
    !record(data) ||
    data.schema_version !== ARTIFACT_VERSION ||
    !Array.isArray(data.nodes) ||
    !Array.isArray(data.edges) ||
    !Array.isArray(data.clusters) ||
    !record(data.meta)
  )
    return null;

  const meta = data.meta;
  if (
    kind === "theme" &&
    (meta.kind !== "theme" ||
      !nonempty(meta.generator) ||
      !validTimestamp(meta.generated_at) ||
      data.clusters.length !== 0)
  )
    return null;

  const requireSeed = kind === "conference" || kind === "theme";
  const ids = new Set<string>();
  const seedIds = new Set<string>();
  const aliasKeys = new Set<string>();
  const nodes: LineageNode[] = [];
  for (const rawNode of data.nodes) {
    if (
      !record(rawNode) ||
      !nonempty(rawNode.id) ||
      rawNode.id !== rawNode.id.trim() ||
      ids.has(rawNode.id) ||
      typeof rawNode.is_focus !== "boolean" ||
      !validNodeDisplay(rawNode)
    )
      return null;
    if (Object.hasOwn(rawNode, "seed_paper_id") && !PAPER_ID_RE.test(String(rawNode.seed_paper_id)))
      return null;
    ids.add(rawNode.id);
    if (rawNode.is_focus) {
      const seedPaperId = rawNode.seed_paper_id;
      if (requireSeed && !PAPER_ID_RE.test(String(seedPaperId))) return null;
      if (PAPER_ID_RE.test(String(seedPaperId ?? ""))) {
        if (seedIds.has(seedPaperId as string)) return null;
        seedIds.add(seedPaperId as string);
      }
    }
    if (Object.hasOwn(rawNode, "aliases")) {
      if (!Array.isArray(rawNode.aliases)) return null;
      const nodeAliases = new Set<string>();
      for (const alias of rawNode.aliases) {
        const key = normalizedNodeAlias(alias, kind);
        if (key === null || nodeAliases.has(key) || aliasKeys.has(key)) return null;
        nodeAliases.add(key);
        aliasKeys.add(key);
      }
    }
    nodes.push(withoutForeignAbstract({ ...rawNode }) as LineageNode);
  }
  const sortedNodeIds = [...ids].sort(compareText);
  if (nodes.some((node, index) => node.id !== sortedNodeIds[index])) return null;
  if (nodes.length === 0) {
    if (data.root !== null) return null;
  } else if (!nonempty(data.root)) {
    return null;
  }
  const rootMatches = nodes.filter((node) => node.id === data.root && node.is_focus === true);
  if (nodes.length > 0 && rootMatches.length !== 1) return null;

  const edgeKeys = new Set<string>();
  const edges: LineageEdge[] = [];
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of data.edges) {
    if (
      !record(edge) ||
      !ids.has(String(edge.src)) ||
      !ids.has(String(edge.dst)) ||
      !RELATIONS.has(String(edge.relation)) ||
      edge.rel !== edge.relation ||
      typeof edge.confidence !== "number" ||
      !Number.isFinite(edge.confidence) ||
      edge.confidence < 0 ||
      edge.confidence > 1 ||
      edge.conf !== edge.confidence ||
      !nonempty(edge.rationale) ||
      !validProvenance(edge.provenance)
    )
      return null;
    const src = edge.src as string;
    const dst = edge.dst as string;
    const relation = edge.relation as Relation;
    const key = `${src}\u0000${dst}\u0000${relation}`;
    if (edgeKeys.has(key)) return null;
    edgeKeys.add(key);
    degree.set(src, (degree.get(src) ?? 0) + 1);
    degree.set(dst, (degree.get(dst) ?? 0) + 1);
    edges.push({
      src,
      dst,
      relation,
      confidence: edge.confidence,
      rationale: edge.rationale as string,
      provenance: edge.provenance as Provenance,
    });
  }
  const sortedEdges = [...edges].sort((left, right) =>
    compareText(
      [left.src, left.dst, left.relation].join("\u0000"),
      [right.src, right.dst, right.relation].join("\u0000"),
    ),
  );
  if (
    edges.some(
      (edge, index) =>
        edge.src !== sortedEdges[index]?.src ||
        edge.dst !== sortedEdges[index]?.dst ||
        edge.relation !== sortedEdges[index]?.relation,
    )
  )
    return null;
  if (nodes.length > 0) {
    const rankedFocus = nodes
      .filter((node) => node.is_focus === true)
      .sort(
        (left, right) =>
          (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) ||
          compareText(left.id, right.id),
      );
    if (rankedFocus.length === 0 || data.root !== rankedFocus[0]?.id) return null;
  }
  return {
    schema_version: ARTIFACT_VERSION,
    root: data.root as string | null,
    nodes,
    edges,
    clusters: data.clusters.map((cluster) => ({ ...(cluster as Record<string, unknown>) })),
    meta: { ...meta },
  };
}

const QUALITY_ROW_KEYS = [
  "collection_id",
  "kind",
  "slug",
  "label",
  "path",
  "availability",
  "audit_status",
  "freshness",
  "generated_at",
  "snapshot_date",
  "node_count",
  "edge_count",
  "artifact_schema_version",
  "input_sha256",
  "audit",
];
const QUALITY_AUDIT_KEYS = ["fixture_sha256", "evaluated_at", "actor", "checks"];
const QUALITY_CHECK_KEYS = ["name", "status", "observed", "expected", "evidence"];

function validQualityAudit(audit: unknown): audit is QualityAudit {
  if (
    !exactKeys(audit, QUALITY_AUDIT_KEYS) ||
    !record(audit) ||
    (audit.fixture_sha256 !== null &&
      (typeof audit.fixture_sha256 !== "string" || !SHA256_RE.test(audit.fixture_sha256))) ||
    !validTimestamp(audit.evaluated_at) ||
    audit.actor !== "ci:audit-v1" ||
    !Array.isArray(audit.checks)
  )
    return false;
  let previousName: string | null = null;
  for (const check of audit.checks) {
    if (
      !exactKeys(check, QUALITY_CHECK_KEYS) ||
      !record(check) ||
      !nonempty(check.name) ||
      !["unknown", "passed", "failed"].includes(String(check.status)) ||
      !Array.isArray(check.evidence) ||
      check.evidence.length > 20 ||
      !check.evidence.every((item) => typeof item === "string")
    )
      return false;
    if (previousName !== null && compareText(previousName, check.name) >= 0) return false;
    previousName = check.name;
  }
  return true;
}

function auditStatusIsConsistent(row: QualityRow): boolean {
  const statuses = row.audit.checks.map((check) => check.status);
  if (row.audit_status === "passed") {
    return statuses.length > 0 && statuses.every((status) => status === "passed");
  }
  if (row.audit_status === "failed") return statuses.includes("failed");
  return true;
}

function rowHasPassedAuditContract(row: QualityRow): boolean {
  if (
    row.artifact_schema_version !== ARTIFACT_VERSION ||
    typeof row.input_sha256 !== "string" ||
    !SHA256_RE.test(row.input_sha256) ||
    typeof row.audit.fixture_sha256 !== "string" ||
    !SHA256_RE.test(row.audit.fixture_sha256) ||
    !auditStatusIsConsistent(row)
  )
    return false;
  const passedNames = new Set(
    row.audit.checks.filter((check) => check.status === "passed").map((check) => check.name),
  );
  return passedNames.has("artifact_contract_v1") && passedNames.has("golden_fixture");
}

const PUBLICATION_TIERS: readonly string[] = ["audited", "unaudited", "blocked"];

/**
 * Tier from availability + checks alone, mirroring the pipeline's
 * `publicationTier` (apps/pipeline/src/lineage/contract/v1.ts): every
 * check other than `golden_fixture` must have passed (including
 * `artifact_contract_v1`, which must be present); `golden_fixture`
 * passed -> audited, unknown -> unaudited, anything else -> blocked.
 */
function derivedPublicationTier(row: QualityRow): PublicationTier {
  if (row.availability !== "ready") return "blocked";
  const checks = row.audit.checks;
  if (!checks.some((c) => c.name === "artifact_contract_v1" && c.status === "passed")) {
    return "blocked";
  }
  let golden: string | null = null;
  for (const c of checks) {
    if (c.name === "golden_fixture") golden = c.status;
    else if (c.status !== "passed") return "blocked";
  }
  if (golden === "passed") return "audited";
  if (golden === "unknown") return "unaudited";
  return "blocked";
}

/** Unaudited rows need everything an audited row needs except the human
 * fixture: the v1 artifact contract and a bound input hash. */
function rowHasUnauditedContract(row: QualityRow): boolean {
  return (
    row.audit_status === "unknown" &&
    row.artifact_schema_version === ARTIFACT_VERSION &&
    typeof row.input_sha256 === "string" &&
    SHA256_RE.test(row.input_sha256) &&
    auditStatusIsConsistent(row)
  );
}

export function parseQualityManifest(data: unknown): QualityManifest | null {
  if (
    !exactKeys(data, ["schema_version", "as_of", "audit_version", "collections"]) ||
    !record(data) ||
    data.schema_version !== QUALITY_VERSION ||
    data.audit_version !== "audit-v1" ||
    !validTimestamp(data.as_of) ||
    !Array.isArray(data.collections)
  )
    return null;
  let previousId: string | null = null;
  const paths = new Set<string>();
  const collections: QualityRow[] = [];
  for (const row of data.collections) {
    if (
      !record(row) ||
      !exactKeys(
        row,
        QUALITY_ROW_KEYS.concat("publication_tier" in row ? ["publication_tier"] : []),
      ) ||
      ("publication_tier" in row && !PUBLICATION_TIERS.includes(String(row.publication_tier))) ||
      !nonempty(row.collection_id) ||
      !["conference", "theme"].includes(String(row.kind)) ||
      typeof row.slug !== "string" ||
      !SLUG_RE.test(row.slug) ||
      !nonempty(row.label) ||
      !nonempty(row.path) ||
      !["unavailable", "sparse", "ready", "failed"].includes(String(row.availability)) ||
      !["unknown", "passed", "failed"].includes(String(row.audit_status)) ||
      !["fresh", "stale"].includes(String(row.freshness)) ||
      (row.generated_at !== null && !validTimestamp(row.generated_at)) ||
      (row.snapshot_date !== null && !validDate(row.snapshot_date)) ||
      !Number.isInteger(row.node_count) ||
      (row.node_count as number) < 0 ||
      !Number.isInteger(row.edge_count) ||
      (row.edge_count as number) < 0 ||
      (row.artifact_schema_version !== null && typeof row.artifact_schema_version !== "string") ||
      (row.input_sha256 !== null &&
        (typeof row.input_sha256 !== "string" || !SHA256_RE.test(row.input_sha256))) ||
      paths.has(row.path as string)
    )
      return null;
    const typedRow = row as unknown as QualityRow;
    if (typedRow.kind === "conference") {
      if (
        typedRow.collection_id !== `conference:${typedRow.slug}` ||
        typedRow.path !== `${typedRow.slug}/lineage.json`
      )
        return null;
    } else if (typedRow.kind === "theme") {
      if (
        typedRow.collection_id !== `theme:${typedRow.slug}` ||
        typedRow.path !== `themes/${typedRow.slug}/lineage.json`
      )
        return null;
    } else {
      return null;
    }
    if (!validQualityAudit(typedRow.audit) || !auditStatusIsConsistent(typedRow)) return null;
    // A written tier that disagrees with the row's own checks means the
    // producer and this reader disagree: reject the whole manifest.
    if (
      typedRow.publication_tier !== undefined &&
      typedRow.publication_tier !== derivedPublicationTier(typedRow)
    )
      return null;
    if (
      typedRow.availability === "ready" &&
      typedRow.audit_status === "passed" &&
      !rowHasPassedAuditContract(typedRow)
    )
      return null;
    if (previousId !== null && compareText(previousId, typedRow.collection_id) >= 0) return null;
    previousId = typedRow.collection_id;
    paths.add(typedRow.path);
    collections.push({
      ...typedRow,
      audit: {
        ...typedRow.audit,
        checks: typedRow.audit.checks.map((check) => ({ ...check, evidence: [...check.evidence] })),
      },
    });
  }
  return { ...(data as Omit<QualityManifest, "collections">), collections };
}

export type QualitySelector =
  | { kind: "conference"; slug: string; path: string }
  | { kind: "theme"; slug: string };

function uniqueMatch<T>(matches: T[]): T | null {
  return matches.length === 1 ? (matches[0] as T) : null;
}

export function resolveQualityCollection(
  quality: QualityManifest | null,
  selector: QualitySelector,
): QualityRow | null {
  if (!quality || !Array.isArray(quality.collections) || !record(selector)) return null;
  const matches = quality.collections.filter((row) => {
    if (row.kind !== selector.kind) return false;
    if (selector.kind === "conference") {
      return row.slug === selector.slug && row.path === selector.path;
    }
    if (selector.kind === "theme") {
      return row.slug === selector.slug && row.path === `themes/${selector.slug}/lineage.json`;
    }
    return false;
  });
  return uniqueMatch(matches);
}

/**
 * The tier a page may publish this row under, or `null` (blocked /
 * malformed). `audited` keeps the original
 * ready+passed contract unchanged; `unaudited` (design doc 41 D1) is a
 * ready row whose every automatic check passed and whose only
 * non-passed check is an `unknown` golden fixture.
 */
export function qualityRowPublishedTier(row: QualityRow | null): PublishedTier | null {
  if (row?.availability !== "ready" || !validQualityAudit(row.audit)) return null;
  const derived = derivedPublicationTier(row);
  if (row.publication_tier !== undefined && row.publication_tier !== derived) return null;
  let tier: PublishedTier | null = null;
  if (derived === "audited" && row.audit_status === "passed" && rowHasPassedAuditContract(row)) {
    tier = "audited";
  } else if (derived === "unaudited" && rowHasUnauditedContract(row)) {
    tier = "unaudited";
  }
  return tier;
}

/** Publication gate: true for `audited` and `unaudited` rows (design doc
 * 41 D1), never for `blocked`. Use `qualityRowPublishedTier` to know
 * which badge to show. */
export function qualityRowIsEligible(row: QualityRow | null): boolean {
  return qualityRowPublishedTier(row) !== null;
}

/** Strict pre-41 gate: ready + passed + human golden fixture. */
export function qualityRowIsAudited(row: QualityRow | null): boolean {
  return qualityRowPublishedTier(row) === "audited";
}

/** Sort key: audited before unaudited (stable otherwise). */
export function publishedTierRank(tier: PublishedTier | null): number {
  return tier === "audited" ? 0 : tier === "unaudited" ? 1 : 2;
}

export function qualityRowIsPublishable(
  row: QualityRow | null,
  { artifactSha256 = null }: { artifactSha256?: string | null } = {},
): boolean {
  return (
    qualityRowIsEligible(row) &&
    typeof row?.input_sha256 === "string" &&
    SHA256_RE.test(row.input_sha256) &&
    row.input_sha256 === artifactSha256
  );
}

interface MinimalResponse {
  ok: boolean;
  headers?: { get?: (name: string) => string | null | undefined };
  body?: { getReader?: () => ReadableStreamDefaultReader<Uint8Array> };
  arrayBuffer: () => Promise<ArrayBuffer>;
}

async function readResponseBytes(
  response: MinimalResponse,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined && declared !== "") {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_JSON_BYTES) return null;
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel();
        return null;
      }
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  const buffer = await response.arrayBuffer();
  return buffer.byteLength <= MAX_JSON_BYTES ? new Uint8Array(buffer) : null;
}

export interface FetchedJson<T = unknown> {
  data: T;
  sha256: string;
}

export type FetchLike = (url: string, options?: unknown) => Promise<MinimalResponse>;

/**
 * Fetches `url`, enforces the 8MB bound (declared Content-Length and the
 * actual stream) before any JSON parsing, hashes the raw bytes, and
 * (optionally) verifies the hash matches `expectedSha256` before
 * returning. Returns `null` on any failure -- never throws, never
 * returns partial data.
 */
export async function fetchJsonWithSha256<T = unknown>(
  url: string,
  options: unknown = undefined,
  { expectedSha256 = null }: { expectedSha256?: string | null } = {},
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<FetchedJson<T> | null> {
  try {
    if (expectedSha256 !== null && !SHA256_RE.test(expectedSha256)) return null;
    const response = await fetchImpl(url, options);
    if (!response.ok || !globalThis.crypto?.subtle) return null;
    const bytes = await readResponseBytes(response);
    if (bytes === null) return null;
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (expectedSha256 !== null && sha256 !== expectedSha256) return null;
    const data = JSON.parse(new TextDecoder().decode(bytes)) as T;
    return { data, sha256 };
  } catch {
    return null;
  }
}

/**
 * Resolves the focus node for a `?focus=` query value. A canonical
 * (40-hex) value resolves ONLY through an exact `seed_paper_id` match
 * (never falling through to a graph-local ID or alias with the same
 * shape); an unrecognised value never falls back to the root or the
 * first node (SCR-24).
 */
export function resolveFocus(
  data: LineageArtifact | null,
  raw: string | null | undefined,
): LineageNode | null {
  if (!data || !Array.isArray(data.nodes)) return null;
  if (!nonempty(raw)) return uniqueMatch(data.nodes.filter((node) => node.id === data.root));
  const canonicalMatches = data.nodes.filter(
    (node) =>
      node.is_focus === true &&
      PAPER_ID_RE.test(String(node.seed_paper_id)) &&
      node.seed_paper_id === raw,
  );
  if (PAPER_ID_RE.test(raw)) return uniqueMatch(canonicalMatches);
  if (canonicalMatches.length > 0) return uniqueMatch(canonicalMatches);
  const aliasMatches = data.nodes.filter(
    (node) =>
      Array.isArray(node.aliases) &&
      node.aliases.some(
        (alias) => Array.isArray(alias) && EXACT_ALIAS_NAMESPACES.has(alias[0]) && alias[1] === raw,
      ),
  );
  if (aliasMatches.length > 0) return uniqueMatch(aliasMatches);
  return uniqueMatch(data.nodes.filter((node) => node.id === raw));
}

/** P2 review M7: a `?focus=` that does not resolve against the audited
 * artifact must not fall back to drawing the root graph -- an unknown
 * id looking like it "worked" (showing some graph, just not the one
 * requested) is worse than showing nothing. Pulled out of
 * app/[conf]/lineage/page.tsx as a pure function so the "don't mount
 * the graph at all" decision is unit-testable without a DOM/React
 * render -- the page only has to call this once and branch on
 * `mount`. */
export interface LineageFocusGate {
  /** Whether `<LineageGraph>` may be mounted at all. */
  mount: boolean;
  /** `initialFocusId` to hand `<LineageGraph>` when `mount` is true. */
  focusId: string | null;
  /** Whether to show the "not found" notice (`requested` was non-empty
   * and did not resolve). */
  notFound: boolean;
}

export function resolveLineageFocusGate(
  data: LineageArtifact | null,
  requested: string | null | undefined,
): LineageFocusGate {
  const focusNode = resolveFocus(data, requested);
  if (nonempty(requested) && !focusNode) {
    return { mount: false, focusId: null, notFound: true };
  }
  return { mount: true, focusId: focusNode?.id ?? data?.root ?? null, notFound: false };
}

export function resolveView({
  urlView = null,
  savedView = null,
  matchMedia = null,
}: {
  urlView?: string | null;
  savedView?: string | null;
  matchMedia?: ((query: string) => { matches: boolean }) | null;
} = {}): "list" | "graph" {
  if (urlView === "list" || urlView === "graph") return urlView;
  if (savedView === "list" || savedView === "graph") return savedView;
  return typeof matchMedia === "function" && matchMedia("(max-width: 720px)").matches
    ? "list"
    : "graph";
}

export function selectActiveEdges(
  edges: LineageEdge[] | null | undefined,
  visibleRelations: Set<string> | string[],
  positionedNodeIds: Set<string> | string[] | null = null,
): LineageEdge[] {
  const relations =
    visibleRelations instanceof Set ? visibleRelations : new Set(visibleRelations || []);
  const positioned =
    positionedNodeIds === null || positionedNodeIds instanceof Set
      ? positionedNodeIds
      : new Set(positionedNodeIds);
  return (edges || []).filter(
    (edge) =>
      relations.has(edge.relation) &&
      (positioned === null || (positioned.has(edge.src) && positioned.has(edge.dst))),
  );
}

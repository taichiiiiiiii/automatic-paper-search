/**
 * Shared fail-closed contracts for public lineage artifacts (lineage-artifact-v1,
 * deep-manifest-v1, lineage-quality-v1).
 *
 * TS port of `paperpilot/scripts/_lineage_contract.py` (LIN-45, LIN-46, LIN-50,
 * LIN-51 of docs/migration/safety-contracts.md). Deliberately dependency-free
 * beyond `@paperpilot/core` pycompat and the identity helpers in
 * `@paperpilot/core/identity` — producers, quality audits and
 * manifest generators all call the same validator here so a JSON Schema
 * implementation detail cannot create a second interpretation of the wire
 * format (same rationale as the Python original's module doc comment).
 *
 * Node/edge/issue ordering matches Python's `sorted(set(issues), key=...)`
 * via {@link codepointCompare}; see packages/core pycompat/sort.ts.
 */

import { createHash } from "node:crypto";
import { codepointCompare, pyJsonDumps } from "@paperpilot/core";
import { ARXIV_MODERN_PATTERN, IdentityError, normalizeAlias } from "@paperpilot/core/identity";

export const LINEAGE_ARTIFACT_VERSION = "lineage-artifact-v1";
export const DEEP_MANIFEST_VERSION = "deep-manifest-v1";
export const LINEAGE_QUALITY_VERSION = "lineage-quality-v1";

export type LineageArtifactKind = "conference" | "theme" | "deep";

const PAPER_ID_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
// Deep artifacts are keyed by modern IDs only (their filenames embed the ID);
// legacy `archive/NNNNNNN` IDs would need a path-safe encoding.
export const ARXIV_ID_RE = new RegExp(`^${ARXIV_MODERN_PATTERN}(?:v\\d+)?$`);
const CONFERENCE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const QUALITY_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const QUALITY_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEEP_ARTIFACT_FILENAME_RE = /^deep-[A-Za-z0-9._-]+\.json$/;

export const RELATIONS = new Set([
  "supersedes",
  "successor",
  "extends",
  "ablation",
  "baseline_only",
  "contrasts",
]);
export const CLASSIFICATION_METHODS = new Set([
  "llm",
  "citation_heuristic",
  "intent_map",
  "context_pattern",
  "year_cite",
  "title_version",
  "foundational_allowlist",
  // R2-10 (design 41 D6): Semantic Scholar citation contexts, rule set v2.
  "s2_context_rule",
]);
const NODE_ALIAS_NAMESPACES = new Set(["arxiv", "openreview", "acl_anthology", "cvf", "doi"]);
const LEGACY_NODE_ALIAS_NAMESPACES = new Set(["semantic_scholar"]);

/** One stable, machine-readable contract failure. */
export interface ContractIssue {
  code: string;
  path: string;
  detail: string;
}

function issue(code: string, path: string, detail: string): ContractIssue {
  return { code, path, detail };
}

function issueKey(i: ContractIssue): string {
  return `${i.code}\u0000${i.path}\u0000${i.detail}`;
}

/** Python's `sorted(set(issues), key=lambda issue: (issue.code, issue.path, issue.detail))`. */
function dedupSortIssues(issues: readonly ContractIssue[]): ContractIssue[] {
  const seen = new Map<string, ContractIssue>();
  for (const i of issues) seen.set(issueKey(i), i);
  return Array.from(seen.values()).sort(
    (a, b) =>
      codepointCompare(a.code, b.code) ||
      codepointCompare(a.path, b.path) ||
      codepointCompare(a.detail, b.detail),
  );
}

/** Return the SHA-256 of canonical UTF-8 JSON used by cache/evidence keys. */
export function canonicalJsonSha256(value: unknown): string {
  const payload = pyJsonDumps(value, {
    ensureAscii: false,
    sortKeys: true,
    separators: [",", ":"],
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function isPaperId(value: unknown): value is string {
  return typeof value === "string" && PAPER_ID_RE.test(value);
}

export function requirePaperId(value: unknown, field = "paper_id"): string {
  if (!isPaperId(value)) {
    throw new Error(`${field} must be a lowercase 40-hex canonical paper ID`);
  }
  return value;
}

export interface MakeProvenanceArgs {
  producerName: string;
  producerVersion: string;
  evidenceSource: string;
  evidenceKind: string;
  evidenceSha256: string;
  method: string;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  classificationSchemaVersion: string;
}

/** Build the canonical structured edge provenance object. */
export function makeProvenance(args: MakeProvenanceArgs): Record<string, unknown> {
  return {
    producer: { name: args.producerName, version: args.producerVersion },
    evidence: {
      source: args.evidenceSource,
      kind: args.evidenceKind,
      sha256: args.evidenceSha256,
    },
    classification: {
      method: args.method,
      provider: args.provider,
      model: args.model,
      prompt_version: args.promptVersion,
      schema_version: args.classificationSchemaVersion,
    },
  };
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.size) return false;
  return keys.every((k) => expected.has(k));
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Validate y/m/d/H/M/S are a real calendar instant, matching `datetime(...)`'s own range checks. */
function isValidCalendarDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]!;
  if (day < 1 || day > maxDay) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;
  return true;
}

/** Python: `_nonempty(value) and "T" in value and datetime.fromisoformat(...).tzinfo is not None`. */
function isTimezoneDatetime(value: unknown): boolean {
  if (!nonempty(value) || !value.includes("T")) return false;
  const normalized = value.endsWith("Z") ? `${value.slice(0, -1)}+00:00` : value;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?([+-]\d{2}:\d{2})$/.exec(
      normalized,
    );
  if (!m) return false;
  const [, y, mo, d, h, mi, s] = m;
  return isValidCalendarDateTime(
    Number(y),
    Number(mo),
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? "0"),
  );
}

/** Matches the browser strict reader's closed timestamp grammar (`QUALITY_TIMESTAMP_RE`). */
function isQualityTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const m = QUALITY_TIMESTAMP_RE.exec(value);
  if (!m) return false;
  const [, y, mo, d, h, mi, s, offSign, offH, offM] = m;
  if (
    !isValidCalendarDateTime(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s))
  ) {
    return false;
  }
  if (offSign !== undefined) {
    const oh = Number(offH);
    const om = Number(offM);
    if (oh > 23 || om > 59) return false;
  }
  return true;
}

function isQualityDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const m = QUALITY_DATE_RE.exec(value);
  if (!m) return false;
  const [, y, mo, d] = m;
  // Date-only: no calendar time component to validate beyond y/m/d.
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(Number(y)) ? 29 : DAYS_IN_MONTH[month - 1]!;
  return day >= 1 && day <= maxDay;
}

/** Nonempty and already trimmed: `" P1 "` is a different key from `"P1"`. */
function exactNonempty(value: unknown): value is string {
  return nonempty(value) && value === value.trim();
}

function nodeId(node: unknown): string | null {
  if (!isMapping(node)) return null;
  const value = node.id;
  return exactNonempty(value) ? value : null;
}

function optionalCount(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

function nodeDisplayIssues(node: Record<string, unknown>, path: string): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if ("title" in node && typeof node.title !== "string") {
    issues.push(issue("node_title", `${path}.title`, "string required"));
  }
  const year = node.year;
  if (
    year !== null &&
    year !== undefined &&
    !(typeof year === "number" && Number.isInteger(year))
  ) {
    issues.push(issue("node_year", `${path}.year`, "integer or null required"));
  }
  const authors = node.authors;
  if (
    authors !== null &&
    authors !== undefined &&
    !(Array.isArray(authors) && authors.every((a) => typeof a === "string"))
  ) {
    issues.push(issue("node_authors", `${path}.authors`, "string array required"));
  }
  for (const field of ["citation_count", "github_stars"] as const) {
    if (!optionalCount(node[field])) {
      issues.push(
        issue(`node_${field}`, `${path}.${field}`, "nonnegative integer or null required"),
      );
    }
  }
  if ("citationCount" in node) {
    issues.push(
      issue(
        "node_raw_citation_count",
        `${path}.citationCount`,
        "provider field must be projected as citation_count",
      ),
    );
  }
  return issues;
}

/** Resolve exactly one declared root focus; never fall back to the first node. */
export function canonicalFocusNode(data: Record<string, unknown>): Record<string, unknown> | null {
  const root = data.root;
  const nodes = data.nodes;
  if (!nonempty(root) || !Array.isArray(nodes)) return null;
  const matches = nodes.filter(
    (node) => isMapping(node) && node.id === root && node.is_focus === true,
  ) as Record<string, unknown>[];
  return matches.length === 1 ? matches[0]! : null;
}

function validateProvenance(value: unknown, path: string): ContractIssue[] {
  if (!isMapping(value)) {
    return [issue("provenance_shape", path, "structured provenance object required")];
  }

  const issues: ContractIssue[] = [];
  if (!hasExactKeys(value, new Set(["producer", "evidence", "classification"]))) {
    issues.push(
      issue(
        "provenance_fields",
        path,
        "only producer/evidence/classification are allowed and all are required",
      ),
    );
  }
  const producer = value.producer;
  const evidence = value.evidence;
  const classification = value.classification;
  if (!isMapping(producer) || !nonempty(producer.name) || !nonempty(producer.version)) {
    issues.push(issue("provenance_producer", `${path}.producer`, "name/version required"));
  } else if (!hasExactKeys(producer, new Set(["name", "version"]))) {
    issues.push(
      issue(
        "provenance_producer_fields",
        `${path}.producer`,
        "closed name/version object required",
      ),
    );
  }
  if (
    !isMapping(evidence) ||
    !nonempty(evidence.source) ||
    !nonempty(evidence.kind) ||
    typeof evidence.sha256 !== "string" ||
    !SHA256_RE.test(evidence.sha256)
  ) {
    issues.push(issue("provenance_evidence", `${path}.evidence`, "source/kind/sha256 required"));
  } else if (!hasExactKeys(evidence, new Set(["source", "kind", "sha256"]))) {
    issues.push(
      issue(
        "provenance_evidence_fields",
        `${path}.evidence`,
        "closed source/kind/sha256 object required",
      ),
    );
  }
  if (!isMapping(classification)) {
    issues.push(
      issue(
        "provenance_classification",
        `${path}.classification`,
        "classification object required",
      ),
    );
    return issues;
  }

  if (
    !hasExactKeys(
      classification,
      new Set(["method", "provider", "model", "prompt_version", "schema_version"]),
    )
  ) {
    issues.push(
      issue(
        "provenance_classification_fields",
        `${path}.classification`,
        "closed classification identity object required",
      ),
    );
  }

  const method = classification.method;
  if (typeof method !== "string" || !CLASSIFICATION_METHODS.has(method)) {
    issues.push(
      issue(
        "classification_method",
        `${path}.classification.method`,
        "unknown classification method",
      ),
    );
  }
  if (!nonempty(classification.schema_version)) {
    issues.push(
      issue(
        "classification_schema",
        `${path}.classification.schema_version`,
        "schema version required",
      ),
    );
  }
  for (const field of ["provider", "model", "prompt_version"] as const) {
    const candidate = classification[field];
    if (candidate !== null && candidate !== undefined && !nonempty(candidate)) {
      issues.push(
        issue(
          "classification_identity",
          `${path}.classification.${field}`,
          "must be a nonempty string or null",
        ),
      );
    }
  }
  if (method === "llm") {
    for (const field of ["provider", "model", "prompt_version"] as const) {
      if (!nonempty(classification[field])) {
        issues.push(
          issue(
            "llm_identity",
            `${path}.classification.${field}`,
            "LLM provenance requires provider/model/prompt version",
          ),
        );
      }
    }
  }
  return issues;
}

export interface ValidateLineageArtifactOptions {
  kind: LineageArtifactKind;
  catalogIds?: ReadonlySet<string> | null;
  expectedSeedPaperId?: string | null;
}

/** Validate the shared public lineage contract without raising on JSON input. */
export function validateLineageArtifact(
  data: unknown,
  options: ValidateLineageArtifactOptions,
): ContractIssue[] {
  const { kind, catalogIds = null, expectedSeedPaperId = null } = options;
  if (!isMapping(data)) {
    return [issue("artifact_shape", "$", "object required")];
  }
  const issues: ContractIssue[] = [];
  if (data.schema_version !== LINEAGE_ARTIFACT_VERSION) {
    issues.push(
      issue("artifact_schema_version", "$.schema_version", `expected ${LINEAGE_ARTIFACT_VERSION}`),
    );
  }

  let nodes: unknown[] = Array.isArray(data.nodes) ? data.nodes : [];
  let edges: unknown[] = Array.isArray(data.edges) ? data.edges : [];
  const clusters = data.clusters;
  const meta = data.meta;
  if (!Array.isArray(data.nodes)) {
    issues.push(issue("nodes_shape", "$.nodes", "array required"));
    nodes = [];
  }
  if (!Array.isArray(data.edges)) {
    issues.push(issue("edges_shape", "$.edges", "array required"));
    edges = [];
  }
  if (!Array.isArray(clusters)) {
    issues.push(issue("clusters_shape", "$.clusters", "array required"));
  }
  if (!isMapping(meta)) {
    issues.push(issue("meta_shape", "$.meta", "object required"));
  } else if (kind === "theme") {
    if (meta.kind !== "theme") {
      issues.push(issue("theme_meta_kind", "$.meta.kind", "theme required"));
    }
    if (!nonempty(meta.generator)) {
      issues.push(issue("theme_meta_generator", "$.meta.generator", "nonempty generator required"));
    }
    if (!isTimezoneDatetime(meta.generated_at)) {
      issues.push(
        issue("theme_meta_generated_at", "$.meta.generated_at", "timezone datetime required"),
      );
    }
  }
  if (kind === "theme" && Array.isArray(clusters) && clusters.length > 0) {
    issues.push(issue("theme_clusters", "$.clusters", "theme clusters must be empty"));
  }

  const ids: (string | null)[] = nodes.map((node) => nodeId(node));
  const counts = new Map<string, number>();
  for (const id of ids) {
    if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  ids.forEach((id, index) => {
    if (id === null) {
      issues.push(issue("node_id", `$.nodes[${index}].id`, "nonempty ID required"));
    } else if (counts.get(id) !== 1) {
      issues.push(issue("node_id_duplicate", `$.nodes[${index}].id`, id));
    }
  });
  const idSet = new Set(counts.keys());

  const root = data.root;
  if (nodes.length > 0) {
    if (!nonempty(root)) {
      issues.push(issue("root_missing", "$.root", "nonempty graph requires root"));
    } else if ((counts.get(root) ?? 0) !== 1) {
      issues.push(issue("root_resolution", "$.root", "root must resolve once"));
    }
  } else if (root !== null && root !== undefined) {
    issues.push(issue("empty_root", "$.root", "empty graph root must be null"));
  }

  const focusSeeds: string[] = [];
  const aliasesSeen = new Map<string, { namespace: string; sourceId: string; count: number }>();
  nodes.forEach((node, index) => {
    if (!isMapping(node)) {
      issues.push(issue("node_shape", `$.nodes[${index}]`, "object required"));
      return;
    }
    if (typeof node.is_focus !== "boolean") {
      issues.push(issue("focus_flag", `$.nodes[${index}].is_focus`, "boolean required"));
    }
    issues.push(...nodeDisplayIssues(node, `$.nodes[${index}]`));
    if (node.is_focus === true) {
      const seed = node.seed_paper_id;
      if (!isPaperId(seed)) {
        issues.push(
          issue("focus_seed", `$.nodes[${index}].seed_paper_id`, "canonical ID required"),
        );
      } else {
        focusSeeds.push(seed);
        if (
          (kind === "conference" || kind === "deep") &&
          catalogIds !== null &&
          !catalogIds.has(seed)
        ) {
          issues.push(issue("catalog_seed_membership", `$.nodes[${index}].seed_paper_id`, seed));
        }
      }
    } else if ("seed_paper_id" in node && !isPaperId(node.seed_paper_id)) {
      issues.push(
        issue(
          "node_seed",
          `$.nodes[${index}].seed_paper_id`,
          "present seed_paper_id must be canonical",
        ),
      );
    }
    const aliases = node.aliases;
    if (aliases === null || aliases === undefined) return;
    if (!Array.isArray(aliases)) {
      issues.push(issue("node_aliases", `$.nodes[${index}].aliases`, "array required"));
      return;
    }
    const nodeAliases = new Set<string>();
    aliases.forEach((alias, aliasIndex) => {
      const aliasPath = `$.nodes[${index}].aliases[${aliasIndex}]`;
      if (
        !(Array.isArray(alias) && alias.length === 2 && alias.every((v) => typeof v === "string"))
      ) {
        issues.push(issue("node_alias_shape", aliasPath, "[namespace, source_id] required"));
        return;
      }
      const [namespace, sourceId] = alias as [string, string];
      let normalized: [string, string] | null = null;
      if (NODE_ALIAS_NAMESPACES.has(namespace)) {
        let candidate: [string, string] | null = null;
        try {
          candidate = normalizeAlias(namespace, sourceId);
        } catch (e) {
          if (!(e instanceof IdentityError)) throw e;
          candidate = null;
        }
        if (candidate !== null && candidate[0] === namespace && candidate[1] === sourceId) {
          normalized = candidate;
        }
      } else if (
        LEGACY_NODE_ALIAS_NAMESPACES.has(namespace) &&
        (kind === "conference" || kind === "deep") &&
        nonempty(sourceId) &&
        sourceId === sourceId.trim()
      ) {
        // Existing deep/conference artifacts expose the S2 graph ID as an
        // alias. Keep it shape-valid for migration compatibility, but
        // consumers must never treat it as a canonical URL alias.
        normalized = [namespace, sourceId];
      }
      if (normalized === null) {
        issues.push(
          issue(
            "node_alias_normalized",
            aliasPath,
            "known namespace with normalized source ID required",
          ),
        );
        return;
      }
      const key = `${normalized[0]}\u0000${normalized[1]}`;
      if (nodeAliases.has(key)) {
        issues.push(issue("node_alias_duplicate", aliasPath, normalized.join(":")));
      }
      nodeAliases.add(key);
      const existing = aliasesSeen.get(key);
      aliasesSeen.set(key, {
        namespace: normalized[0],
        sourceId: normalized[1],
        count: (existing?.count ?? 0) + 1,
      });
    });
  });
  const sortedAliasKeys = Array.from(aliasesSeen.keys()).sort((a, b) => {
    const x = aliasesSeen.get(a)!;
    const y = aliasesSeen.get(b)!;
    return codepointCompare(x.namespace, y.namespace) || codepointCompare(x.sourceId, y.sourceId);
  });
  for (const key of sortedAliasKeys) {
    const entry = aliasesSeen.get(key)!;
    if (entry.count > 1) {
      issues.push(issue("node_alias_ambiguous", "$.nodes", `${entry.namespace}:${entry.sourceId}`));
    }
  }
  const seedCounts = new Map<string, number>();
  for (const seed of focusSeeds) seedCounts.set(seed, (seedCounts.get(seed) ?? 0) + 1);
  const duplicateSeeds = Array.from(seedCounts.entries())
    .filter(([, c]) => c > 1)
    .map(([s]) => s)
    .sort(codepointCompare);
  for (const seed of duplicateSeeds) {
    issues.push(issue("focus_seed_duplicate", "$.nodes", seed));
  }

  const focus = canonicalFocusNode(data);
  if (nodes.length > 0 && focus === null) {
    issues.push(issue("root_focus", "$.root", "root must resolve to exactly one focus node"));
  }
  if (expectedSeedPaperId !== null && expectedSeedPaperId !== undefined) {
    if (!isPaperId(expectedSeedPaperId)) {
      issues.push(issue("expected_seed", "$", "expected seed is not a canonical paper ID"));
    } else if (focus === null || focus.seed_paper_id !== expectedSeedPaperId) {
      issues.push(issue("expected_seed_mismatch", "$.root", "root focus seed does not match"));
    }
  }

  const edgeKeys = new Set<string>();
  edges.forEach((edge, index) => {
    const path = `$.edges[${index}]`;
    if (!isMapping(edge)) {
      issues.push(issue("edge_shape", path, "object required"));
      return;
    }
    const src = edge.src;
    const dst = edge.dst;
    if (!nonempty(src) || !nonempty(dst) || !idSet.has(src) || !idSet.has(dst)) {
      issues.push(issue("edge_endpoint", path, "src/dst must resolve"));
    }
    const relation = edge.relation;
    const legacyRelation = edge.rel;
    if (typeof relation !== "string" || !RELATIONS.has(relation)) {
      issues.push(issue("edge_relation", `${path}.relation`, "invalid relation"));
    }
    if (legacyRelation !== relation) {
      issues.push(issue("edge_relation_alias", path, "rel must equal relation"));
    }
    const confidence = edge.confidence;
    const legacyConfidence = edge.conf;
    const validConfidence =
      typeof confidence === "number" &&
      Number.isFinite(confidence) &&
      confidence >= 0 &&
      confidence <= 1;
    if (!validConfidence) {
      issues.push(issue("edge_confidence", `${path}.confidence`, "number in [0,1] required"));
    }
    if (legacyConfidence !== confidence) {
      issues.push(issue("edge_confidence_alias", path, "conf must equal confidence"));
    }
    if (!nonempty(edge.rationale)) {
      issues.push(issue("edge_rationale", `${path}.rationale`, "nonempty required"));
    }
    issues.push(...validateProvenance(edge.provenance, `${path}.provenance`));
    if (nonempty(src) && nonempty(dst) && typeof relation === "string") {
      const key = `${src}\u0000${dst}\u0000${relation}`;
      if (edgeKeys.has(key)) {
        issues.push(issue("edge_duplicate", path, "duplicate edge"));
      }
      edgeKeys.add(key);
    }
  });

  const orderedNodeIds = ids.filter((id): id is string => id !== null);
  if (orderedNodeIds.length === nodes.length) {
    const sorted = [...orderedNodeIds].sort(codepointCompare);
    if (!arraysEqual(orderedNodeIds, sorted)) {
      issues.push(issue("node_order", "$.nodes", "nodes must be sorted by graph-local ID"));
    }
  }
  const orderedEdgeKeys: [string, string, string][] = edges
    .filter(
      (edge): edge is Record<string, unknown> =>
        isMapping(edge) &&
        nonempty(edge.src) &&
        nonempty(edge.dst) &&
        typeof edge.relation === "string",
    )
    .map((edge) => [edge.src as string, edge.dst as string, edge.relation as string]);
  if (orderedEdgeKeys.length === edges.length) {
    const sorted = [...orderedEdgeKeys].sort(
      (a, b) =>
        codepointCompare(a[0], b[0]) ||
        codepointCompare(a[1], b[1]) ||
        codepointCompare(a[2], b[2]),
    );
    if (!edgeKeysEqual(orderedEdgeKeys, sorted)) {
      issues.push(issue("edge_order", "$.edges", "edges must be sorted by src/dst/relation"));
    }
  }

  const focusIds = nodes
    .filter(
      (node): node is Record<string, unknown> =>
        isMapping(node) && nonempty(node.id) && node.is_focus === true,
    )
    .map((node) => node.id as string)
    .sort(codepointCompare);
  if (focusIds.length > 0 && typeof root === "string") {
    const degree = new Map<string, number>();
    for (const edge of edges) {
      if (!isMapping(edge)) continue;
      const src = edge.src;
      const dst = edge.dst;
      if (typeof src === "string" && typeof dst === "string" && idSet.has(src) && idSet.has(dst)) {
        degree.set(src, (degree.get(src) ?? 0) + 1);
        degree.set(dst, (degree.get(dst) ?? 0) + 1);
      }
    }
    const expectedRoot = focusIds.reduce((best, candidate) => {
      const bestKey = -(degree.get(best) ?? 0);
      const candidateKey = -(degree.get(candidate) ?? 0);
      if (candidateKey < bestKey) return candidate;
      if (candidateKey > bestKey) return best;
      return codepointCompare(candidate, best) < 0 ? candidate : best;
    }, focusIds[0]!);
    if (root !== expectedRoot) {
      issues.push(
        issue("root_deterministic", "$.root", `expected highest-degree focus ${expectedRoot}`),
      );
    }
  }

  return dedupSortIssues(issues);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function edgeKeysEqual(
  a: readonly (readonly string[])[],
  b: readonly (readonly string[])[],
): boolean {
  return (
    a.length === b.length &&
    a.every((v, i) => v[0] === b[i]![0] && v[1] === b[i]![1] && v[2] === b[i]![2])
  );
}

export interface RequireValidLineageArtifactOptions extends ValidateLineageArtifactOptions {
  label?: string;
}

/**
 * Throw if `data` violates the public lineage contract. Builders call this on
 * the exact object they are about to serialize, after the last mutation
 * (completeness meta included), so nothing that reaches disk has skipped
 * validation.
 */
export function requireValidLineageArtifact(
  data: unknown,
  options: RequireValidLineageArtifactOptions,
): void {
  const { label = "generated lineage", ...rest } = options;
  const issues = validateLineageArtifact(data, rest);
  if (issues.length > 0) {
    const detail = issues
      .slice(0, 8)
      .map((i) => `${i.code}:${i.path}`)
      .join("; ");
    throw new Error(`${label} violates ${LINEAGE_ARTIFACT_VERSION}: ${detail}`);
  }
}

export function catalogPaperIds(rows: unknown): Set<string> {
  if (!Array.isArray(rows)) return new Set();
  const out = new Set<string>();
  for (const row of rows) {
    if (isMapping(row) && isPaperId(row.paper_id)) out.add(row.paper_id);
  }
  return out;
}

/** Validate deep-manifest-v1 identity and filename uniqueness. */
export function validateDeepManifest(
  data: unknown,
  options: { catalogIds?: ReadonlySet<string> | null } = {},
): ContractIssue[] {
  const { catalogIds = null } = options;
  if (!isMapping(data)) {
    return [issue("manifest_shape", "$", "object required")];
  }
  const issues: ContractIssue[] = [];
  if (!hasExactKeys(data, new Set(["schema_version", "conference", "generated_at", "entries"]))) {
    issues.push(
      issue(
        "manifest_fields",
        "$",
        "only schema_version/conference/generated_at/entries are allowed",
      ),
    );
  }
  if (data.schema_version !== DEEP_MANIFEST_VERSION) {
    issues.push(
      issue("manifest_schema_version", "$.schema_version", `expected ${DEEP_MANIFEST_VERSION}`),
    );
  }
  const conference = data.conference;
  if (typeof conference !== "string" || !CONFERENCE_SLUG_RE.test(conference)) {
    issues.push(issue("manifest_conference", "$.conference", "valid slug required"));
  }
  if (!isTimezoneDatetime(data.generated_at)) {
    issues.push(issue("manifest_generated_at", "$.generated_at", "timezone datetime required"));
  }
  const entries = data.entries;
  if (!Array.isArray(entries)) {
    issues.push(issue("manifest_entries", "$.entries", "array required"));
    return dedupSortIssuesSimple(issues);
  }

  const paperIds: string[] = [];
  const aliasesSeen = new Map<string, number>();
  const filenames: string[] = [];
  entries.forEach((entry, index) => {
    const path = `$.entries[${index}]`;
    if (!isMapping(entry)) {
      issues.push(issue("manifest_entry", path, "object required"));
      return;
    }
    if (!hasExactKeys(entry, new Set(["paper_id", "aliases", "arxiv_id", "title", "filename"]))) {
      issues.push(
        issue(
          "manifest_entry_fields",
          path,
          "closed paper_id/aliases/arxiv_id/title/filename object required",
        ),
      );
    }
    const paperId = entry.paper_id;
    if (!isPaperId(paperId)) {
      issues.push(issue("manifest_paper_id", `${path}.paper_id`, "invalid"));
    } else {
      paperIds.push(paperId);
      if (catalogIds !== null && !catalogIds.has(paperId)) {
        issues.push(issue("manifest_catalog_membership", `${path}.paper_id`, paperId));
      }
    }
    const arxivId = entry.arxiv_id;
    if (typeof arxivId !== "string" || !ARXIV_ID_RE.test(arxivId)) {
      issues.push(issue("manifest_arxiv", `${path}.arxiv_id`, "invalid"));
    }
    const filename = entry.filename;
    const expectedFilename = typeof arxivId === "string" ? `deep-${arxivId}.json` : null;
    if (filename !== expectedFilename) {
      issues.push(issue("manifest_filename", `${path}.filename`, "must match arxiv_id"));
    } else if (typeof filename === "string") {
      filenames.push(filename);
    }
    const aliases = entry.aliases;
    const expectedKinds = new Set(["arxiv", "semantic_scholar"]);
    const aliasMap = new Map<string, string>();
    if (!Array.isArray(aliases)) {
      issues.push(issue("manifest_aliases", `${path}.aliases`, "array required"));
    } else {
      aliases.forEach((alias, aliasIndex) => {
        if (
          !(
            Array.isArray(alias) &&
            alias.length === 2 &&
            expectedKinds.has(alias[0]) &&
            nonempty(alias[1])
          )
        ) {
          issues.push(
            issue(
              "manifest_alias",
              `${path}.aliases[${aliasIndex}]`,
              "[known namespace, nonempty value] required",
            ),
          );
          return;
        }
        const [kind, value] = alias as [string, string];
        if (aliasMap.has(kind)) {
          issues.push(issue("manifest_alias_kind_duplicate", `${path}.aliases`, kind));
        }
        aliasMap.set(kind, value);
        const key = `${kind}\u0000${value}`;
        aliasesSeen.set(key, (aliasesSeen.get(key) ?? 0) + 1);
      });
      if (
        aliasMap.size !== expectedKinds.size ||
        !Array.from(expectedKinds).every((k) => aliasMap.has(k))
      ) {
        issues.push(
          issue("manifest_alias_kinds", `${path}.aliases`, "arxiv and semantic_scholar required"),
        );
      }
      if (typeof arxivId === "string" && aliasMap.get("arxiv") !== arxivId) {
        issues.push(issue("manifest_arxiv_alias", `${path}.aliases`, "arxiv mismatch"));
      }
    }
    if (!nonempty(entry.title)) {
      issues.push(issue("manifest_title", `${path}.title`, "nonempty required"));
    }
  });

  const paperIdCounts = new Map<string, number>();
  for (const id of paperIds) paperIdCounts.set(id, (paperIdCounts.get(id) ?? 0) + 1);
  for (const id of Array.from(paperIdCounts.entries())
    .filter(([, c]) => c > 1)
    .map(([k]) => k)
    .sort(codepointCompare)) {
    issues.push(issue("manifest_paper_duplicate", "$.entries", id));
  }
  const filenameCounts = new Map<string, number>();
  for (const f of filenames) filenameCounts.set(f, (filenameCounts.get(f) ?? 0) + 1);
  for (const f of Array.from(filenameCounts.entries())
    .filter(([, c]) => c > 1)
    .map(([k]) => k)
    .sort(codepointCompare)) {
    issues.push(issue("manifest_filename_duplicate", "$.entries", f));
  }
  for (const [key, count] of Array.from(aliasesSeen.entries()).sort((a, b) =>
    codepointCompare(a[0], b[0]),
  )) {
    if (count > 1) {
      const [kind, value] = key.split("\u0000");
      issues.push(issue("manifest_alias_duplicate", "$.entries", `${kind}:${value}`));
    }
  }
  return dedupSortIssues(issues);
}

function dedupSortIssuesSimple(issues: readonly ContractIssue[]): ContractIssue[] {
  // Python's early-return path does `sorted(issues)` (no set()) because the
  // caller only ever appends one issue before returning; preserved 1:1.
  return [...issues].sort(
    (a, b) =>
      codepointCompare(a.code, b.code) ||
      codepointCompare(a.path, b.path) ||
      codepointCompare(a.detail, b.detail),
  );
}

/**
 * Publication tier (design doc 41 D1), derived from the checks alone:
 * - `audited`: ready, every automatic check passed AND `golden_fixture` passed;
 * - `unaudited`: ready, every automatic check passed, `golden_fixture` is
 *   `unknown` (no human record for this exact artifact yet);
 * - `blocked`: anything else (not ready, any failed/unknown automatic check,
 *   a failed `golden_fixture`). Blocked rows are never published.
 */
export type PublicationTier = "audited" | "unaudited" | "blocked";

export function publicationTier(
  availability: string,
  checks: readonly { name: string; status: string }[],
): PublicationTier {
  if (availability !== "ready") return "blocked";
  if (!checks.some((c) => c.name === "artifact_contract_v1" && c.status === "passed")) {
    return "blocked";
  }
  let golden: string | null = null;
  for (const c of checks) {
    if (c.name === "golden_fixture") {
      golden = c.status;
    } else if (c.status !== "passed") {
      return "blocked";
    }
  }
  if (golden === "passed") return "audited";
  if (golden === "unknown") return "unaudited";
  return "blocked";
}

const PUBLICATION_TIERS = new Set(["audited", "unaudited", "blocked"]);

const QUALITY_ROW_KEYS = new Set([
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
]);
/** Optional so manifests written before design doc 41 still validate. */
const QUALITY_OPTIONAL_ROW_KEYS = new Set(["publication_tier"]);
const QUALITY_DEEP_KEYS = new Set([
  "conference",
  "paper_id",
  "arxiv_id",
  "manifest_path",
  "manifest_input_sha256",
]);
const QUALITY_AUDIT_KEYS = new Set(["fixture_sha256", "evaluated_at", "actor", "checks"]);
const QUALITY_CHECK_KEYS = new Set(["name", "status", "observed", "expected", "evidence"]);

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

/**
 * Validate the exact quality read model consumed by `lineage-core.js`.
 *
 * This is intentionally stricter than JSON Schema alone: row and check
 * ordering, uniqueness, audit-status consistency and kind/path identity are
 * publication semantics. Any issue rejects the manifest as a whole so the
 * TS/Python builders and browser consumers share one fail-closed decision.
 */
export function validateLineageQualityManifest(data: unknown): ContractIssue[] {
  if (!isMapping(data)) {
    return [issue("quality_shape", "$", "object required")];
  }
  const issues: ContractIssue[] = [];
  if (!hasExactKeys(data, new Set(["schema_version", "as_of", "audit_version", "collections"]))) {
    issues.push(issue("quality_fields", "$", "closed top-level object required"));
  }
  if (data.schema_version !== LINEAGE_QUALITY_VERSION) {
    issues.push(
      issue("quality_schema_version", "$.schema_version", `expected ${LINEAGE_QUALITY_VERSION}`),
    );
  }
  if (data.audit_version !== "audit-v1") {
    issues.push(issue("quality_audit_version", "$.audit_version", "expected audit-v1"));
  }
  if (!isQualityTimestamp(data.as_of)) {
    issues.push(issue("quality_as_of", "$.as_of", "strict timezone datetime required"));
  }
  const collections = data.collections;
  if (!Array.isArray(collections)) {
    issues.push(issue("quality_collections", "$.collections", "array required"));
    return dedupSortIssuesSimple(issues);
  }

  let previousId: string | null = null;
  const paths = new Set<string>();
  collections.forEach((row, index) => {
    const path = `$.collections[${index}]`;
    if (!isMapping(row)) {
      issues.push(issue("quality_row_shape", path, "object required"));
      return;
    }
    const kind = row.kind;
    const expectedKeys =
      kind === "deep" ? new Set([...QUALITY_ROW_KEYS, ...QUALITY_DEEP_KEYS]) : QUALITY_ROW_KEYS;
    const rowWithoutOptional = Object.fromEntries(
      Object.entries(row).filter(([key]) => !QUALITY_OPTIONAL_ROW_KEYS.has(key)),
    );
    if (!hasExactKeys(rowWithoutOptional, expectedKeys)) {
      issues.push(issue("quality_row_fields", path, "closed row object required"));
    }

    const collectionId = row.collection_id;
    const slug = row.slug;
    const artifactPath = row.path;
    if (!nonempty(collectionId)) {
      issues.push(issue("quality_collection_id", `${path}.collection_id`, "nonempty required"));
    }
    if (kind !== "conference" && kind !== "theme" && kind !== "deep") {
      issues.push(issue("quality_kind", `${path}.kind`, "closed kind required"));
    }
    if (typeof slug !== "string" || !CONFERENCE_SLUG_RE.test(slug)) {
      issues.push(issue("quality_slug", `${path}.slug`, "strict slug required"));
    }
    if (!nonempty(row.label)) {
      issues.push(issue("quality_label", `${path}.label`, "nonempty required"));
    }
    if (!nonempty(artifactPath)) {
      issues.push(issue("quality_path", `${path}.path`, "nonempty required"));
    }
    if (!["unavailable", "sparse", "ready", "failed"].includes(row.availability as string)) {
      issues.push(issue("quality_availability", `${path}.availability`, "closed enum required"));
    }
    if (!["unknown", "passed", "failed"].includes(row.audit_status as string)) {
      issues.push(issue("quality_audit_status", `${path}.audit_status`, "closed enum required"));
    }
    if (!["fresh", "stale"].includes(row.freshness as string)) {
      issues.push(issue("quality_freshness", `${path}.freshness`, "closed enum required"));
    }
    const generatedAt = row.generated_at;
    if (generatedAt !== null && generatedAt !== undefined && !isQualityTimestamp(generatedAt)) {
      issues.push(issue("quality_generated_at", `${path}.generated_at`, "invalid"));
    }
    const snapshotDate = row.snapshot_date;
    if (snapshotDate !== null && snapshotDate !== undefined && !isQualityDate(snapshotDate)) {
      issues.push(issue("quality_snapshot_date", `${path}.snapshot_date`, "invalid"));
    }
    for (const field of ["node_count", "edge_count"] as const) {
      const value = row[field];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        issues.push(issue(`quality_${field}`, `${path}.${field}`, "non-negative integer required"));
      }
    }
    const artifactVersion = row.artifact_schema_version;
    if (
      artifactVersion !== null &&
      artifactVersion !== undefined &&
      typeof artifactVersion !== "string"
    ) {
      issues.push(
        issue(
          "quality_artifact_version",
          `${path}.artifact_schema_version`,
          "string or null required",
        ),
      );
    }
    const inputSha256 = row.input_sha256;
    if (inputSha256 !== null && inputSha256 !== undefined && !isSha256(inputSha256)) {
      issues.push(issue("quality_input_sha256", `${path}.input_sha256`, "sha256 or null required"));
    }

    if (typeof collectionId === "string") {
      if (previousId !== null && codepointCompare(previousId, collectionId) >= 0) {
        issues.push(
          issue(
            "quality_collection_order",
            "$.collections",
            "strict ascending unique IDs required",
          ),
        );
      }
      previousId = collectionId;
    }
    if (typeof artifactPath === "string") {
      if (paths.has(artifactPath)) {
        issues.push(issue("quality_path_duplicate", "$.collections", artifactPath));
      }
      paths.add(artifactPath);
    }

    const checkNames = new Set<string>();
    const statuses: string[] = [];
    let auditFixtureSha: unknown;

    if (kind === "conference" && typeof slug === "string") {
      if (collectionId !== `conference:${slug}` || artifactPath !== `${slug}/lineage.json`) {
        issues.push(issue("quality_conference_identity", path, "kind/slug/path mismatch"));
      }
    } else if (kind === "theme" && typeof slug === "string") {
      if (collectionId !== `theme:${slug}` || artifactPath !== `themes/${slug}/lineage.json`) {
        issues.push(issue("quality_theme_identity", path, "kind/slug/path mismatch"));
      }
    } else if (kind === "deep" && typeof slug === "string") {
      const conference = row.conference;
      const paperId = row.paper_id;
      const arxivId = row.arxiv_id;
      const manifestSha256 = row.manifest_input_sha256;
      const deepValid =
        conference === slug &&
        typeof conference === "string" &&
        CONFERENCE_SLUG_RE.test(conference) &&
        typeof collectionId === "string" &&
        collectionId.startsWith(`deep:${conference}:`) &&
        collectionId.length > `deep:${conference}:`.length &&
        (paperId === null || paperId === undefined || isPaperId(paperId)) &&
        (arxivId === null ||
          arxivId === undefined ||
          (typeof arxivId === "string" && ARXIV_ID_RE.test(arxivId))) &&
        row.manifest_path === `${conference}/deep-manifest.json` &&
        (manifestSha256 === null || manifestSha256 === undefined || isSha256(manifestSha256)) &&
        typeof artifactPath === "string" &&
        artifactPath.startsWith(`${conference}/`) &&
        DEEP_ARTIFACT_FILENAME_RE.test(artifactPath.slice(conference.length + 1));
      if (!deepValid) {
        issues.push(issue("quality_deep_identity", path, "deep identity/path mismatch"));
      }
      if (
        row.availability === "ready" &&
        row.audit_status === "passed" &&
        (!isPaperId(paperId) ||
          !(typeof arxivId === "string" && ARXIV_ID_RE.test(arxivId)) ||
          !isSha256(inputSha256) ||
          !isSha256(manifestSha256))
      ) {
        issues.push(
          issue("quality_deep_passed_fields", path, "passed deep identity and hashes required"),
        );
      }
    }

    const audit = row.audit;
    const auditValid = isMapping(audit);
    if (!auditValid) {
      issues.push(issue("quality_audit_shape", `${path}.audit`, "object required"));
    } else {
      if (!hasExactKeys(audit, QUALITY_AUDIT_KEYS)) {
        issues.push(issue("quality_audit_fields", `${path}.audit`, "closed audit object required"));
      }
      const fixtureSha = audit.fixture_sha256;
      auditFixtureSha = fixtureSha;
      if (fixtureSha !== null && fixtureSha !== undefined && !isSha256(fixtureSha)) {
        issues.push(issue("quality_fixture_sha256", `${path}.audit.fixture_sha256`, "invalid"));
      }
      if (!isQualityTimestamp(audit.evaluated_at)) {
        issues.push(issue("quality_evaluated_at", `${path}.audit.evaluated_at`, "invalid"));
      }
      if (audit.actor !== "ci:audit-v1") {
        issues.push(issue("quality_actor", `${path}.audit.actor`, "expected ci:audit-v1"));
      }
      const checks = audit.checks;
      if (!Array.isArray(checks)) {
        issues.push(issue("quality_checks", `${path}.audit.checks`, "array required"));
      } else {
        let previousName: string | null = null;
        checks.forEach((check, checkIndex) => {
          const checkPath = `${path}.audit.checks[${checkIndex}]`;
          if (!isMapping(check)) {
            issues.push(issue("quality_check_shape", checkPath, "object required"));
            return;
          }
          if (!hasExactKeys(check, QUALITY_CHECK_KEYS)) {
            issues.push(issue("quality_check_fields", checkPath, "closed check object required"));
          }
          const name = check.name;
          const status = check.status;
          const evidence = check.evidence;
          if (!nonempty(name)) {
            issues.push(issue("quality_check_name", `${checkPath}.name`, "nonempty required"));
          } else {
            if (previousName !== null && codepointCompare(previousName, name) >= 0) {
              issues.push(
                issue(
                  "quality_check_order",
                  `${path}.audit.checks`,
                  "strict ascending unique names required",
                ),
              );
            }
            previousName = name;
            checkNames.add(name);
          }
          if (!["unknown", "passed", "failed"].includes(status as string)) {
            issues.push(
              issue("quality_check_status", `${checkPath}.status`, "closed enum required"),
            );
          } else if (typeof status === "string") {
            statuses.push(status);
          }
          if (
            !Array.isArray(evidence) ||
            evidence.length > 20 ||
            !evidence.every((item) => typeof item === "string")
          ) {
            issues.push(
              issue(
                "quality_check_evidence",
                `${checkPath}.evidence`,
                "at most 20 strings required",
              ),
            );
          }
        });
      }
    }

    const auditStatus = row.audit_status;
    if (
      auditStatus === "passed" &&
      (statuses.length === 0 || statuses.some((s) => s !== "passed"))
    ) {
      issues.push(
        issue(
          "quality_audit_consistency",
          `${path}.audit_status`,
          "passed requires only passed checks",
        ),
      );
    }
    if (auditStatus === "failed" && !statuses.includes("failed")) {
      issues.push(
        issue(
          "quality_audit_consistency",
          `${path}.audit_status`,
          "failed requires a failed check",
        ),
      );
    }
    if ("publication_tier" in row) {
      const tier = row.publication_tier;
      if (typeof tier !== "string" || !PUBLICATION_TIERS.has(tier)) {
        issues.push(
          issue("quality_publication_tier", `${path}.publication_tier`, "closed enum required"),
        );
      } else if (isMapping(audit) && Array.isArray(audit.checks)) {
        const derived = publicationTier(
          String(row.availability),
          (audit.checks as unknown[]).filter(isMapping).map((c) => ({
            name: String(c.name),
            status: String(c.status),
          })),
        );
        if (derived !== tier) {
          issues.push(
            issue(
              "quality_publication_tier",
              `${path}.publication_tier`,
              `expected ${derived} from availability/checks`,
            ),
          );
        }
      }
    }
    if (row.availability === "ready" && auditStatus === "passed") {
      if (
        artifactVersion !== LINEAGE_ARTIFACT_VERSION ||
        !isSha256(inputSha256) ||
        !isSha256(auditFixtureSha) ||
        !checkNames.has("artifact_contract_v1") ||
        !checkNames.has("golden_fixture")
      ) {
        issues.push(
          issue("quality_passed_contract", path, "passed artifact and fixture contract required"),
        );
      }
    }
  });

  return dedupSortIssues(issues);
}

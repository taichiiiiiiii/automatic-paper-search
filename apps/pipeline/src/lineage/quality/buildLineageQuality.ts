/**
 * Build the fail-closed conference/theme/deep lineage quality read model —
 * TS port of `paperpilot/scripts/build_lineage_quality.py` (LIN-48 .. LIN-52
 * of docs/migration/safety-contracts.md). Entirely read-only over the
 * published `docs/` tree plus two data files (audit fixtures, quality
 * policy); no S2/OpenAlex/LLM calls, so this builder needs no injected
 * `fetch` and no `LLMProvider`.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codepointCompare, pyJsonDumps } from "@paperpilot/core";
import { IdentityError, normalizeAlias } from "../../catalog/identity.js";
import {
  canonicalFocusNode,
  isPaperId,
  type LineageArtifactKind,
  validateDeepManifest,
  validateLineageArtifact,
} from "../contract/v1.js";

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort(codepointCompare);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python `str(value)` for the handful of types that can land in an f-string here. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

// ---- time parsing (Python `datetime.fromisoformat` subset actually used) ----

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
function assertValidCalendar(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): void {
  if (mo < 1 || mo > 12) throw new Error(`invalid isoformat string: month ${mo}`);
  const maxDay = mo === 2 && isLeapYear(y) ? 29 : DAYS_IN_MONTH[mo - 1]!;
  if (d < 1 || d > maxDay || h > 23 || mi > 59 || s > 59) {
    throw new Error("invalid isoformat string");
  }
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([+-]\d{2}:\d{2})?$/;

/** TS port of `_parse_time`: parse an ISO datetime, require a timezone, return the UTC instant. */
export function parseTime(value: string): Date {
  const normalized = value.endsWith("Z") ? `${value.slice(0, -1)}+00:00` : value;
  const m = ISO_RE.exec(normalized);
  if (!m) throw new Error(`invalid isoformat string: ${JSON.stringify(value)}`);
  const [, y, mo, d, h, mi, s, , offset] = m;
  assertValidCalendar(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s ?? "0"));
  if (offset === undefined) {
    throw new Error("timestamp must include a timezone");
  }
  const ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? "0"),
  );
  const offSign = offset.startsWith("-") ? -1 : 1;
  const offH = Number(offset.slice(1, 3));
  const offM = Number(offset.slice(4, 6));
  const offMs = offSign * (offH * 3_600_000 + offM * 60_000);
  return new Date(ms - offMs);
}

/** Date-only (`YYYY-MM-DD`) parsed as UTC midnight, matching `datetime.fromisoformat(s).replace(tzinfo=utc)`. */
function parseDateOnlyUtc(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new Error(`invalid isoformat string: ${JSON.stringify(value)}`);
  const [, y, mo, d] = m;
  assertValidCalendar(Number(y), Number(mo), Number(d), 0, 0, 0);
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
}

function hashBytes(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

function canonicalHash(value: unknown): string {
  const payload = pyJsonDumps(value, {
    ensureAscii: false,
    sortKeys: true,
    separators: [",", ":"],
  });
  return hashBytes(Buffer.from(payload, "utf8"));
}

/** Return exact, unambiguous same-row paper_id/arXiv pairs. */
function catalogIdentity(rows: unknown): {
  catalogIds: Set<string>;
  arxivByPaper: Map<string, string>;
  failures: string[];
} {
  if (!Array.isArray(rows)) {
    return { catalogIds: new Set(), arxivByPaper: new Map(), failures: ["catalog-not-array"] };
  }
  const catalogIds = new Set<string>();
  const arxivByPaper = new Map<string, string>();
  const paperByArxiv = new Map<string, string>();
  const failures: string[] = [];
  rows.forEach((row, index) => {
    if (!isMapping(row) || !isPaperId(row.paper_id)) return;
    const paperId = row.paper_id;
    catalogIds.add(paperId);
    const candidates: string[] = [];
    if (typeof row.arxiv_id === "string" && row.arxiv_id.trim()) candidates.push(row.arxiv_id);
    if (row.source === "arxiv" && typeof row.source_id === "string") candidates.push(row.source_id);
    const normalized = new Set<string>();
    for (const candidate of candidates) {
      try {
        const [, arxivId] = normalizeAlias("arxiv", candidate);
        normalized.add(arxivId);
      } catch (e) {
        if (!(e instanceof IdentityError)) throw e;
        failures.push(`catalog-row-${index}-invalid-arxiv`);
      }
    }
    if (normalized.size > 1) {
      failures.push(`catalog-paper-${paperId}-ambiguous-arxiv`);
      return;
    }
    if (normalized.size === 0) return;
    const arxivId = normalized.values().next().value as string;
    const previousArxiv = arxivByPaper.get(paperId);
    const previousPaper = paperByArxiv.get(arxivId);
    if (
      (previousArxiv !== undefined && previousArxiv !== arxivId) ||
      (previousPaper !== undefined && previousPaper !== paperId)
    ) {
      failures.push("catalog-ambiguous-paper-arxiv-mapping");
      return;
    }
    arxivByPaper.set(paperId, arxivId);
    paperByArxiv.set(arxivId, paperId);
  });
  return { catalogIds, arxivByPaper, failures: sortedUnique(failures) };
}

export interface QualityCheck {
  name: string;
  status: "unknown" | "passed" | "failed";
  observed: number | string | null;
  expected: number | string | null;
  evidence: string[];
}

function check(
  name: string,
  status: QualityCheck["status"],
  observed: number | string | null,
  expected: number | string | null,
  evidence: readonly string[] = [],
): QualityCheck {
  return { name, status, observed, expected, evidence: evidence.slice(0, 20) };
}

function nodeId(node: unknown): string | null {
  if (!isMapping(node)) return null;
  const value = node.id ?? node.paperId;
  return typeof value === "string" && value ? value : null;
}

function edgeConfidence(edge: Record<string, unknown>): unknown {
  return "confidence" in edge ? edge.confidence : edge.conf;
}

export interface GoldenFixture {
  input_sha256?: unknown;
  reviewer?: unknown;
  reviewed_at?: unknown;
  focus_labels?: unknown;
  sample_labels?: unknown;
  collection_id?: string;
  [key: string]: unknown;
}

function artifactChecks(
  data: Record<string, unknown>,
  options: {
    kind: LineageArtifactKind;
    fixture: GoldenFixture | null;
    inputSha256: string;
    asOf: Date;
    generatedAt: string | null;
    catalogIds: ReadonlySet<string> | null;
    expectedSeedPaperId?: string | null;
  },
): { checks: QualityCheck[]; fixtureSha256: string | null } {
  const {
    kind,
    fixture,
    inputSha256,
    asOf,
    generatedAt,
    catalogIds,
    expectedSeedPaperId = null,
  } = options;
  const checks: QualityCheck[] = [];
  const nodes = data.nodes;
  const edges = data.edges;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return {
      checks: [check("artifact_shape", "failed", "invalid", "nodes/edges arrays")],
      fixtureSha256: null,
    };
  }
  checks.push(check("artifact_shape", "passed", 0, 0));

  const contractIssues = validateLineageArtifact(data, {
    kind,
    catalogIds,
    expectedSeedPaperId,
  });
  checks.push(
    check(
      "artifact_contract_v1",
      contractIssues.length > 0 ? "failed" : "passed",
      contractIssues.length,
      0,
      contractIssues.map((i) => `${i.code}:${i.path}`),
    ),
  );

  const ids = nodes.map((node) => nodeId(node));
  const missingIds = ids
    .map((v, i) => (v === null ? String(i) : null))
    .filter((v): v is string => v !== null);
  const idCounts = new Map<string, number>();
  for (const id of ids) if (id !== null) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  const duplicateIds = sortedUnique(
    ids.filter((v): v is string => v !== null && (idCounts.get(v) ?? 0) > 1),
  );
  const idFailures = [...missingIds, ...duplicateIds];
  checks.push(
    check(
      "node_ids_unique",
      idFailures.length > 0 ? "failed" : "passed",
      idFailures.length,
      0,
      idFailures,
    ),
  );
  const idSet = new Set(ids.filter((v): v is string => v !== null));

  const dangling: string[] = [];
  const degree = new Set<string>();
  const badSemantics: string[] = [];
  edges.forEach((edge, index) => {
    if (!isMapping(edge)) {
      dangling.push(`edge:${index}:not-object`);
      badSemantics.push(`edge:${index}:not-object`);
      return;
    }
    const src = edge.src;
    const dst = edge.dst;
    if (typeof src !== "string" || typeof dst !== "string" || !idSet.has(src) || !idSet.has(dst)) {
      dangling.push(`edge:${index}:${pyStr(src)}->${pyStr(dst)}`);
    } else {
      degree.add(src);
      degree.add(dst);
    }
    const relation = edge.relation;
    const confidence = edgeConfidence(edge);
    const rationale = edge.rationale;
    const provenance = edge.provenance;
    const edgePathPrefix = `$.edges[${index}].provenance`;
    const bad =
      typeof relation !== "string" ||
      !relation.trim() ||
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      typeof rationale !== "string" ||
      !rationale.trim() ||
      edge.rel !== relation ||
      edge.conf !== confidence ||
      !isMapping(provenance) ||
      contractIssues.some((issue) => issue.path.startsWith(edgePathPrefix));
    if (bad) badSemantics.push(`edge:${index}:${pyStr(src)}->${pyStr(dst)}`);
  });
  checks.push(
    check(
      "edge_endpoints_resolve",
      dangling.length > 0 ? "failed" : "passed",
      dangling.length,
      0,
      dangling,
    ),
  );
  checks.push(
    check(
      "edge_semantics_complete",
      badSemantics.length > 0 ? "failed" : "passed",
      badSemantics.length,
      0,
      badSemantics,
    ),
  );

  const root = data.root;
  const focusIds = new Set<string>();
  ids.forEach((id, i) => {
    const node = nodes[i];
    if (id && isMapping(node) && node.is_focus === true) focusIds.add(id);
  });
  const rootFocusFailures: string[] = [];
  if (
    typeof root !== "string" ||
    ids.filter((v) => v === root).length !== 1 ||
    !focusIds.has(root)
  ) {
    rootFocusFailures.push(`root:${pyStr(root)}`);
  }
  if (focusIds.size === 0) rootFocusFailures.push("focus:none");
  checks.push(
    check(
      "root_focus_resolve",
      rootFocusFailures.length > 0 ? "failed" : "passed",
      rootFocusFailures.length,
      0,
      rootFocusFailures,
    ),
  );

  const orphanIds = Array.from(idSet)
    .filter((id) => !degree.has(id) && id !== root && !focusIds.has(id))
    .sort(codepointCompare);
  checks.push(
    check(
      "orphan_node_count",
      orphanIds.length > 0 ? "failed" : "passed",
      orphanIds.length,
      0,
      orphanIds,
    ),
  );

  const seedFailures: string[] = [];
  const seedValues: string[] = [];
  const membershipFailures: string[] = [];
  ids.forEach((id, i) => {
    const node = nodes[i];
    if (id !== null && focusIds.has(id) && isMapping(node)) {
      const seed = node.seed_paper_id;
      if (!isPaperId(seed)) {
        seedFailures.push(String(id));
        return;
      }
      seedValues.push(seed);
      if (
        (kind === "conference" || kind === "deep") &&
        (catalogIds === null || !catalogIds.has(seed))
      ) {
        membershipFailures.push(String(id));
      }
    }
  });
  const seedCounts = new Map<string, number>();
  for (const s of seedValues) seedCounts.set(s, (seedCounts.get(s) ?? 0) + 1);
  const duplicateSeeds = sortedUnique(seedValues.filter((s) => (seedCounts.get(s) ?? 0) > 1));
  seedFailures.push(...duplicateSeeds.map((s) => `duplicate:${s}`));
  checks.push(
    check(
      "catalog_seed_ids",
      seedFailures.length > 0 ? "failed" : "passed",
      seedFailures.length,
      0,
      seedFailures,
    ),
  );
  checks.push(
    check(
      "catalog_seed_membership",
      membershipFailures.length > 0 ? "failed" : "passed",
      membershipFailures.length,
      0,
      membershipFailures,
    ),
  );

  const timestampFailures: string[] = [];
  if (generatedAt) {
    try {
      if (parseTime(generatedAt).getTime() > asOf.getTime()) timestampFailures.push(generatedAt);
    } catch {
      timestampFailures.push(generatedAt);
    }
  }
  checks.push(
    check(
      "timestamp_not_future",
      timestampFailures.length > 0 ? "failed" : "passed",
      timestampFailures.length,
      0,
      timestampFailures,
    ),
  );

  let fixtureSha256: string | null = null;
  if (fixture === null) {
    checks.push(check("golden_fixture", "unknown", null, "matching frozen fixture"));
  } else {
    fixtureSha256 = canonicalHash(fixture);
    const fixtureFailures: string[] = [];
    if (fixture.input_sha256 !== inputSha256) fixtureFailures.push("input-sha-mismatch");
    if (!fixture.reviewer || !fixture.reviewed_at) fixtureFailures.push("review-metadata-missing");
    let focusLabels = fixture.focus_labels;
    let sampleLabels = fixture.sample_labels;
    if (!Array.isArray(focusLabels) || !Array.isArray(sampleLabels)) {
      fixtureFailures.push("labels-missing");
      focusLabels = [];
      sampleLabels = [];
    }
    const labelledFocus = new Set(
      (focusLabels as unknown[])
        .filter((row): row is Record<string, unknown> => isMapping(row) && row.on_topic === true)
        .map((row) => row.node_id),
    );
    const missingFocus = Array.from(focusIds)
      .filter((id) => !labelledFocus.has(id))
      .sort(codepointCompare);
    fixtureFailures.push(...missingFocus.map((id) => `focus:${id}`));
    if ((sampleLabels as unknown[]).length > 20) fixtureFailures.push("sample-limit-exceeded");
    const invalidSamples = (sampleLabels as unknown[])
      .filter(
        (row) =>
          !isMapping(row) || !idSet.has(row.node_id as string) || typeof row.on_topic !== "boolean",
      )
      .map((row) => String(isMapping(row) ? row.node_id : row));
    fixtureFailures.push(...invalidSamples.map((id) => `sample:${id}`));
    const labelledSamples = (sampleLabels as unknown[]).filter(
      (row): row is Record<string, unknown> => isMapping(row),
    );
    const offTopic = labelledSamples.filter((row) => row.on_topic === false).length;
    if (labelledSamples.length > 0 && offTopic / labelledSamples.length > 0.1) {
      fixtureFailures.push("sample-off-topic-rate");
    }
    checks.push(
      check(
        "golden_fixture",
        fixtureFailures.length > 0 ? "failed" : "passed",
        fixtureFailures.length,
        0,
        fixtureFailures,
      ),
    );
  }
  const sorted = [...checks].sort((a, b) => codepointCompare(a.name, b.name));
  return { checks: sorted, fixtureSha256 };
}

function labelFromSlug(slug: string): string {
  const m = /^(.+)-(\d{4})$/.exec(slug);
  if (!m) return slug;
  return `${m[1]!.toUpperCase()} ${m[2]}`;
}

function freshness(options: {
  generatedAt: string | null;
  snapshotDate: string | null;
  asOf: Date;
  maxAgeDays: number;
}): "fresh" | "stale" {
  const { generatedAt, snapshotDate, asOf, maxAgeDays } = options;
  const reference = generatedAt || snapshotDate;
  if (!reference) return "stale";
  let observed: Date;
  try {
    observed = reference.length === 10 ? parseDateOnlyUtc(reference) : parseTime(reference);
  } catch {
    return "stale";
  }
  const ageDays = (asOf.getTime() - observed.getTime()) / 86_400_000;
  return ageDays >= 0 && ageDays <= maxAgeDays ? "fresh" : "stale";
}

export interface CollectionRow {
  collection_id: string;
  kind: string;
  slug: string;
  label: string;
  path: string;
  availability: "unavailable" | "sparse" | "ready" | "failed";
  audit_status: "unknown" | "passed" | "failed";
  freshness: "fresh" | "stale";
  generated_at: string | null;
  snapshot_date: string | null;
  node_count: number;
  edge_count: number;
  artifact_schema_version: string | null;
  input_sha256: string | null;
  audit: {
    fixture_sha256: string | null;
    evaluated_at: string;
    actor: string;
    checks: QualityCheck[];
  };
  [key: string]: unknown;
}

function readFileBytesOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function collectionRow(options: {
  docsRoot: string;
  kind: LineageArtifactKind;
  slug: string;
  label: string;
  relativePath: string;
  snapshotDate: string | null;
  generatedHint: string | null;
  fixture: GoldenFixture | null;
  asOfText: string;
  maxAgeDays: number;
  catalogIds: ReadonlySet<string> | null;
  collectionId?: string | null;
  expectedSeedPaperId?: string | null;
}): CollectionRow {
  const {
    docsRoot,
    kind,
    slug,
    label,
    relativePath,
    snapshotDate,
    generatedHint,
    fixture,
    asOfText,
    maxAgeDays,
    catalogIds,
    collectionId = null,
    expectedSeedPaperId = null,
  } = options;
  const path = join(docsRoot, relativePath);
  const asOf = parseTime(asOfText);
  const payload = readFileBytesOrNull(path);
  if (payload === null) {
    return {
      collection_id: collectionId ?? `${kind}:${slug}`,
      kind,
      slug,
      label,
      path: relativePath,
      availability: "unavailable",
      audit_status: "unknown",
      freshness: "stale",
      generated_at: generatedHint,
      snapshot_date: snapshotDate,
      node_count: 0,
      edge_count: 0,
      artifact_schema_version: null,
      input_sha256: null,
      audit: {
        fixture_sha256: null,
        evaluated_at: asOfText,
        actor: "ci:audit-v1",
        checks: [check("artifact_present", "unknown", 0, 1)],
      },
    };
  }

  const inputSha256 = hashBytes(payload);
  let data: unknown;
  try {
    data = JSON.parse(payload.toString("utf8"));
    if (!isMapping(data)) throw new Error("lineage artifact must be an object");
  } catch (exc) {
    return {
      collection_id: collectionId ?? `${kind}:${slug}`,
      kind,
      slug,
      label,
      path: relativePath,
      availability: "failed",
      audit_status: "failed",
      freshness: "stale",
      generated_at: generatedHint,
      snapshot_date: snapshotDate,
      node_count: 0,
      edge_count: 0,
      artifact_schema_version: null,
      input_sha256: inputSha256,
      audit: {
        fixture_sha256: null,
        evaluated_at: asOfText,
        actor: "ci:audit-v1",
        checks: [
          check(
            "artifact_parse",
            "failed",
            String((exc as Error).message ?? exc),
            "valid JSON object",
          ),
        ],
      },
    };
  }

  const record = data as Record<string, unknown>;
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  const edges = Array.isArray(record.edges) ? record.edges : [];
  let availability: CollectionRow["availability"];
  if (nodes.length === 0) availability = "unavailable";
  else if (edges.length === 0) availability = "sparse";
  else if (nodes.length >= 2) availability = "ready";
  else availability = "failed";
  const meta = isMapping(record.meta) ? record.meta : {};
  const generatedAt: unknown = meta.generated_at || record.generated_at || generatedHint;
  const generatedAtStr = typeof generatedAt === "string" ? generatedAt : null;
  const { checks, fixtureSha256 } = artifactChecks(record, {
    kind,
    fixture,
    inputSha256,
    asOf,
    generatedAt: generatedAtStr,
    catalogIds,
    expectedSeedPaperId,
  });
  let auditStatus: CollectionRow["audit_status"];
  if (availability !== "ready" && availability !== "failed") {
    auditStatus = "unknown";
  } else if (availability === "failed" || checks.some((c) => c.status === "failed")) {
    auditStatus = "failed";
  } else if (checks.some((c) => c.status === "unknown")) {
    auditStatus = "unknown";
  } else {
    auditStatus = "passed";
  }
  return {
    collection_id: collectionId ?? `${kind}:${slug}`,
    kind,
    slug,
    label,
    path: relativePath,
    availability,
    audit_status: auditStatus,
    freshness: freshness({ generatedAt: generatedAtStr, snapshotDate, asOf, maxAgeDays }),
    generated_at: generatedAtStr,
    snapshot_date: snapshotDate,
    node_count: nodes.length,
    edge_count: edges.length,
    artifact_schema_version: (record.schema_version || meta.schema_version || null) as
      | string
      | null,
    input_sha256: inputSha256,
    audit: {
      fixture_sha256: fixtureSha256,
      evaluated_at: asOfText,
      actor: "ci:audit-v1",
      checks,
    },
  };
}

interface DeepManifestEntry {
  paper_id?: unknown;
  arxiv_id?: unknown;
  aliases?: unknown;
  title?: unknown;
  filename?: unknown;
  [key: string]: unknown;
}

/** Compare one trusted manifest entry with its artifact without inference. */
function deepIdentityFailures(options: {
  data: unknown;
  entry: DeepManifestEntry | null;
  filename: string;
  artifactPresent: boolean;
  catalogArxivByPaper: ReadonlyMap<string, string>;
  catalogIdentityFailures: readonly string[];
}): string[] {
  const { data, entry, filename, artifactPresent, catalogArxivByPaper, catalogIdentityFailures } =
    options;
  if (entry === null) return ["manifest-entry-missing"];
  const failures: string[] = [...catalogIdentityFailures];
  if (catalogArxivByPaper.get(entry.paper_id as string) !== entry.arxiv_id) {
    failures.push("catalog-paper-arxiv-pair");
  }
  if (!artifactPresent) return ["artifact-missing"];
  if (!isMapping(data)) return ["artifact-unreadable"];
  const meta = data.meta;
  const focus = canonicalFocusNode(data);
  const aliases = entry.aliases;
  let semanticAlias: unknown = null;
  if (Array.isArray(aliases)) {
    const semanticValues = aliases
      .filter(
        (a): a is [string, string] =>
          Array.isArray(a) && a.length === 2 && a[0] === "semantic_scholar",
      )
      .map((a) => a[1]);
    if (semanticValues.length === 1) semanticAlias = semanticValues[0];
  }
  const expected: Record<string, unknown> = {
    paper_id: entry.paper_id,
    arxiv_id: entry.arxiv_id,
    aliases,
    root: semanticAlias,
    title: entry.title,
    filename: entry.filename,
  };
  const observed: Record<string, unknown> = {
    paper_id: isMapping(meta) ? meta.seed_paper_id : null,
    arxiv_id: isMapping(meta) ? meta.arxiv_id : null,
    aliases: isMapping(meta) ? meta.aliases : null,
    root: data.root,
    title: focus ? focus.title : null,
    filename,
  };
  for (const field of Object.keys(expected)) {
    if (!deepEqual(observed[field], expected[field])) failures.push(field);
  }
  if (focus === null || focus.seed_paper_id !== entry.paper_id) failures.push("root_focus_seed");
  if (focus === null || !deepEqual(focus.aliases, aliases)) failures.push("root_focus_aliases");
  return sortedUnique(failures);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isMapping(a) && isMapping(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** Collect every deep artifact/reference and audit exact manifest identity. */
function deepCollectionRows(options: {
  docsRoot: string;
  conference: string;
  catalogIds: ReadonlySet<string>;
  catalogArxivByPaper: ReadonlyMap<string, string>;
  catalogIdentityFailures: readonly string[];
  fixtureMap: ReadonlyMap<string, GoldenFixture>;
  asOf: string;
  maxAgeDays: number;
}): CollectionRow[] {
  const {
    docsRoot,
    conference,
    catalogIds,
    catalogArxivByPaper,
    catalogIdentityFailures,
    fixtureMap,
    asOf,
    maxAgeDays,
  } = options;
  const conferenceDir = join(docsRoot, conference);
  const manifestRelative = `${conference}/deep-manifest.json`;
  const manifestPath = join(docsRoot, manifestRelative);
  let manifestSha256: string | null = null;
  let manifest: unknown = null;
  const manifestIssues: string[] = [];
  const manifestPayload = readFileBytesOrNull(manifestPath);
  if (manifestPayload === null) {
    manifestIssues.push("OSError");
  } else {
    manifestSha256 = hashBytes(manifestPayload);
    try {
      manifest = JSON.parse(manifestPayload.toString("utf8"));
    } catch {
      manifestIssues.push("JSONDecodeError");
    }
  }
  if (manifestIssues.length === 0) {
    for (const issue of validateDeepManifest(manifest, { catalogIds })) {
      manifestIssues.push(`${issue.code}:${issue.path}`);
    }
    if (isMapping(manifest) && manifest.conference !== conference) {
      manifestIssues.push("manifest_conference_mismatch");
    }
  }

  const trustedEntries = new Map<string, DeepManifestEntry>();
  if (manifestIssues.length === 0 && isMapping(manifest) && Array.isArray(manifest.entries)) {
    for (const entry of manifest.entries as DeepManifestEntry[]) {
      trustedEntries.set(entry.filename as string, entry);
    }
  }

  let dirEntries: string[] = [];
  try {
    dirEntries = readdirSync(conferenceDir);
  } catch {
    dirEntries = [];
  }
  const filenames = new Set<string>();
  for (const name of dirEntries) {
    if (name.startsWith(".")) continue;
    if (name === "deep-manifest.json") continue;
    if (/^deep-.*\.json$/.test(name)) filenames.add(name);
  }
  for (const name of trustedEntries.keys()) filenames.add(name);

  const rows: CollectionRow[] = [];
  for (const filename of Array.from(filenames).sort(codepointCompare)) {
    const entry = trustedEntries.get(filename) ?? null;
    const paperId = entry ? entry.paper_id : null;
    const collectionId = isPaperId(paperId)
      ? `deep:${conference}:${paperId}`
      : `deep:${conference}:file:${filename}`;
    const relativePath = `${conference}/${filename}`;
    const artifactPath = join(docsRoot, relativePath);
    const artifactBytes = readFileBytesOrNull(artifactPath);
    const artifactPresent = artifactBytes !== null;
    let artifactData: unknown = null;
    if (artifactBytes !== null) {
      try {
        artifactData = JSON.parse(artifactBytes.toString("utf8"));
      } catch {
        artifactData = null;
      }
    }
    const row = collectionRow({
      docsRoot,
      kind: "deep",
      slug: conference,
      label: `${labelFromSlug(conference)} deep: ${entry ? String(entry.title) : filename}`,
      relativePath,
      snapshotDate: null,
      generatedHint: null,
      fixture: fixtureMap.get(collectionId) ?? null,
      asOfText: asOf,
      maxAgeDays,
      catalogIds,
      collectionId,
      expectedSeedPaperId: isPaperId(paperId) ? paperId : null,
    });
    const identityFailures =
      manifestIssues.length > 0
        ? ["manifest-invalid", ...manifestIssues]
        : deepIdentityFailures({
            data: artifactData,
            entry,
            filename,
            artifactPresent,
            catalogArxivByPaper,
            catalogIdentityFailures,
          });
    const checks = [
      ...row.audit.checks,
      check(
        "deep_manifest_contract",
        manifestIssues.length > 0 ? "failed" : "passed",
        manifestIssues.length,
        0,
        manifestIssues,
      ),
      check(
        "deep_manifest_identity",
        identityFailures.length > 0 ? "failed" : "passed",
        identityFailures.length,
        0,
        identityFailures,
      ),
    ].sort((a, b) => codepointCompare(a.name, b.name));
    row.audit.checks = checks;
    if (checks.some((c) => c.status === "failed")) row.audit_status = "failed";
    row.conference = conference;
    row.paper_id = isPaperId(paperId) ? paperId : null;
    row.arxiv_id = entry ? (entry.arxiv_id ?? null) : null;
    row.manifest_path = manifestRelative;
    row.manifest_input_sha256 = manifestSha256;
    rows.push(row);
  }
  return rows;
}

export interface QualityPolicy {
  conference_max_age_days: number;
  theme_max_age_days: number;
  deep_max_age_days?: number;
  [key: string]: unknown;
}

export interface QualityManifest {
  schema_version: "lineage-quality-v1";
  as_of: string;
  audit_version: "audit-v1";
  collections: CollectionRow[];
}

/** Build a deterministic quality manifest without using filesystem mtimes. */
export function buildManifest(options: {
  docsRoot: string;
  asOf: string;
  fixtures: { collections?: unknown };
  policy: QualityPolicy;
}): QualityManifest {
  const { docsRoot, asOf, fixtures, policy } = options;
  parseTime(asOf); // validates, matching the Python call's side-effect-only use
  const fixtureMap = new Map<string, GoldenFixture>();
  if (Array.isArray(fixtures.collections)) {
    for (const row of fixtures.collections) {
      if (isMapping(row) && typeof row.collection_id === "string") {
        fixtureMap.set(row.collection_id, row as GoldenFixture);
      }
    }
  }
  const collections: CollectionRow[] = [];
  const conferences = JSON.parse(readFileSync(join(docsRoot, "conferences.json"), "utf8")) as Array<
    Record<string, unknown>
  >;
  for (const conference of conferences) {
    const slug = conference.name as string;
    let conferenceCatalogIds: Set<string>;
    let catalogArxivByPaper: Map<string, string>;
    let catalogIdentityFailures: string[];
    try {
      const catalog = JSON.parse(readFileSync(join(docsRoot, slug, "papers.json"), "utf8"));
      const identity = catalogIdentity(catalog);
      conferenceCatalogIds = identity.catalogIds;
      catalogArxivByPaper = identity.arxivByPaper;
      catalogIdentityFailures = identity.failures;
    } catch {
      conferenceCatalogIds = new Set();
      catalogArxivByPaper = new Map();
      catalogIdentityFailures = ["catalog-unavailable"];
    }
    collections.push(
      collectionRow({
        docsRoot,
        kind: "conference",
        slug,
        label: labelFromSlug(slug),
        relativePath: `${slug}/lineage.json`,
        snapshotDate: (conference.generated as string) ?? null,
        generatedHint: null,
        fixture: fixtureMap.get(`conference:${slug}`) ?? null,
        asOfText: asOf,
        maxAgeDays: Number(policy.conference_max_age_days),
        catalogIds: conferenceCatalogIds,
      }),
    );
    collections.push(
      ...deepCollectionRows({
        docsRoot,
        conference: slug,
        catalogIds: conferenceCatalogIds,
        catalogArxivByPaper,
        catalogIdentityFailures,
        fixtureMap,
        asOf,
        maxAgeDays: Number(policy.deep_max_age_days ?? policy.conference_max_age_days),
      }),
    );
  }
  const themeManifest = JSON.parse(
    readFileSync(join(docsRoot, "themes", "themes-manifest.json"), "utf8"),
  ) as Array<Record<string, unknown>>;
  for (const theme of themeManifest) {
    const slug = theme.slug as string;
    collections.push(
      collectionRow({
        docsRoot,
        kind: "theme",
        slug,
        label: (theme.theme as string) || slug,
        relativePath: `themes/${slug}/lineage.json`,
        snapshotDate: null,
        generatedHint: (theme.generated_at as string) ?? null,
        fixture: fixtureMap.get(`theme:${slug}`) ?? null,
        asOfText: asOf,
        maxAgeDays: Number(policy.theme_max_age_days),
        catalogIds: null,
      }),
    );
  }
  return {
    schema_version: "lineage-quality-v1",
    as_of: asOf,
    audit_version: "audit-v1",
    collections: collections.sort((a, b) => codepointCompare(a.collection_id, b.collection_id)),
  };
}

/** Matches Python's `json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"`. */
export function manifestPayload(manifest: QualityManifest): Buffer {
  return Buffer.from(`${pyJsonDumps(manifest, { ensureAscii: false, indent: 2 })}\n`, "utf8");
}

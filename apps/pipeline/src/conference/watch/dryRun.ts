/**
 * Pure comparison of a C3 conference candidate with a supplied local
 * baseline — TS port of `paperpilot/conference_watch/dry_run.py`
 * (CNF-34/35). Produces review artifacts only: no file/network I/O, and
 * no staging/promotion/publication authority.
 */

import { createHash } from "node:crypto";
import { pyJsonDumps } from "@paperpilot/core";
import { IdentityError, identityFromUrl } from "../../release/identity/sourceIds.js";
import {
  buildCatalogCandidate,
  CandidateValidationError,
  type CatalogCandidate,
} from "./candidate.js";
import { canonicalJsonBytes } from "./canonicalJson.js";
import type { Edition, EditionState, SourceSnapshot } from "./models.js";
import { DuplicateKeyError, StrictJsonSyntaxError, strictJsonLoads } from "./strictJson.js";

export const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
export const MAX_DETAILS_BYTES = 128 * 1024 * 1024;
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
export const MAX_STAGING_PLAN_BYTES = 16 * 1024 * 1024;
export const MAX_ROWS = 25_000;

const MAX_TITLE_CHARS = 2_048;
const MAX_ABSTRACT_CHARS = 2_048;
const MAX_DETAIL_ABSTRACT_CHARS = 200_000;
const MAX_URL_CHARS = 4_096;
const MAX_SCALAR_CHARS = 512;
const MAX_TAGS = 128;
const MAX_TAG_CHARS = 128;
const MAX_AUTHORS = 512;
const MAX_AUTHOR_CHARS = 512;
const MAX_METRIC = 2 ** 53 - 1;
/** Abstract preview length — TS port of `build_pages.py`'s `_abstract_preview` (not exported by `../../catalog/buildPages.ts`; duplicated here, see that file's `ABSTRACT_PREVIEW_CHARS`). */
const ABSTRACT_PREVIEW_CHARS = 320;

const CATALOG_KEYS = new Set([
  "title",
  "type",
  "tags",
  "venue",
  "authors",
  "arxiv_url",
  "pdf_url",
  "abstract",
  "arxiv_id",
  "citation_count",
  "venue_tier",
  "github_stars",
  "paper_id",
  "source",
  "source_id",
]);

const AUTHORITY = {
  trusted_persistent_state_proof: false,
  baseline_state_trusted: false,
  fresh_tip_checked: false,
  staging_materialized: false,
  promotion_authorized: false,
  publication_authorized: false,
};

const REQUIRED_REGENERATION = [
  "catalog_date",
  "paper_links",
  "conferences_index",
  "identity_aliases_and_coverage",
  "search_indexes_and_id_blocks",
  "full_detail_shards",
  "lineage_quality",
  "asset_versions",
];

export class CatalogDryRunError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

function fail(code: string): never {
  throw new CatalogDryRunError(code);
}

function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

/** TS port of `build_pages.py`'s `_abstract_preview` (code-point aware, matching Python's `str` slicing). */
export function abstractPreview(text: string | null | undefined): string {
  const trimmed = (text ?? "").trim();
  const chars = Array.from(trimmed);
  if (chars.length <= ABSTRACT_PREVIEW_CHARS) return trimmed;
  const head = chars.slice(0, ABSTRACT_PREVIEW_CHARS).join("");
  const lastSpace = head.lastIndexOf(" ");
  const cut = (lastSpace === -1 ? head : head.slice(0, lastSpace)).replace(/\s+$/, "");
  return `${cut || head.replace(/\s+$/, "")}…`;
}

/** Strict UTF-8 decode — TS equivalent of Python's `bytes.decode("utf-8", errors="strict")`: throws on any invalid byte sequence instead of silently substituting U+FFFD (what `Buffer#toString("utf-8")` does). */
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function parseJson(payload: unknown, prefix: string, maximum: number): unknown {
  if (!Buffer.isBuffer(payload)) fail(`${prefix}_bytes_required`);
  if (payload.length === 0 || payload.length > maximum) fail(`${prefix}_size`);
  let text: string;
  try {
    text = strictUtf8Decoder.decode(payload);
  } catch {
    return fail(`${prefix}_invalid`);
  }
  if (text.startsWith("﻿")) fail(`${prefix}_invalid`);
  try {
    return strictJsonLoads(text);
  } catch (e) {
    if (
      e instanceof DuplicateKeyError ||
      e instanceof StrictJsonSyntaxError ||
      e instanceof RangeError
    ) {
      fail(`${prefix}_invalid`);
    }
    throw e;
  }
}

function text(value: unknown, maximum: number, required = false, abstract = false): string | null {
  if (typeof value !== "string" || value.length > maximum || (required && !value)) return null;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const isTabNewlineCr = abstract && (ch === "\t" || ch === "\n" || ch === "\r");
    // C0 (<0x20, excluding \t\n\r in an abstract) and C1 (0x80-0x9f) controls.
    const isControl = (code < 0x20 && !isTabNewlineCr) || (code >= 0x80 && code <= 0x9f);
    if (isControl) return null;
  }
  return value;
}

function metric(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_METRIC)
  );
}

function validateRow(row: unknown, prefix: string): Record<string, unknown> {
  if (typeof row !== "object" || row === null || Array.isArray(row)) fail(`${prefix}_row_invalid`);
  const obj = row as Record<string, unknown>;
  const keys = new Set(Object.keys(obj));
  if (keys.size !== CATALOG_KEYS.size || [...CATALOG_KEYS].some((k) => !keys.has(k))) {
    fail(`${prefix}_row_invalid`);
  }

  const scalarLimits: [string, number, boolean, boolean][] = [
    ["title", MAX_TITLE_CHARS, true, false],
    ["venue", MAX_SCALAR_CHARS, true, false],
    ["arxiv_url", MAX_URL_CHARS, true, false],
    ["pdf_url", MAX_URL_CHARS, true, false],
    ["abstract", MAX_ABSTRACT_CHARS, false, true],
    ["arxiv_id", MAX_SCALAR_CHARS, false, false],
    ["paper_id", MAX_SCALAR_CHARS, true, false],
    ["source", MAX_SCALAR_CHARS, true, false],
    ["source_id", MAX_SCALAR_CHARS, true, false],
  ];
  for (const [field, maximum, required, abstract] of scalarLimits) {
    if (text(obj[field], maximum, required, abstract) === null) fail(`${prefix}_row_invalid`);
  }
  if (obj.type !== "Oral" && obj.type !== "Poster") fail(`${prefix}_row_invalid`);

  const tags = obj.tags;
  if (
    !Array.isArray(tags) ||
    tags.length > MAX_TAGS ||
    tags.some((item) => text(item, MAX_TAG_CHARS, true) === null)
  ) {
    fail(`${prefix}_row_invalid`);
  }
  const authors = obj.authors;
  if (
    !Array.isArray(authors) ||
    !(authors.length >= 1 && authors.length <= MAX_AUTHORS) ||
    authors.some((item) => text(item, MAX_AUTHOR_CHARS, true) === null)
  ) {
    fail(`${prefix}_row_invalid`);
  }
  if (!metric(obj.citation_count) || !metric(obj.venue_tier) || !metric(obj.github_stars)) {
    fail(`${prefix}_row_invalid`);
  }

  const sourceId = obj.source_id as string;
  const forumUrl = `https://openreview.net/forum?id=${sourceId}`;
  const pdfUrl = `https://openreview.net/pdf?id=${sourceId}`;
  if (
    obj.source !== "openreview" ||
    obj.arxiv_id !== "" ||
    obj.arxiv_url !== forumUrl ||
    obj.pdf_url !== pdfUrl
  ) {
    fail(`${prefix}_identity_invalid`);
  }
  let identity: ReturnType<typeof identityFromUrl>;
  try {
    identity = identityFromUrl(forumUrl);
  } catch (e) {
    if (e instanceof IdentityError) fail(`${prefix}_identity_invalid`);
    throw e;
  }
  if (
    identity.source !== obj.source ||
    identity.sourceId !== sourceId ||
    identity.paperId !== obj.paper_id
  ) {
    fail(`${prefix}_identity_invalid`);
  }
  return obj;
}

/** TS port of `_validate_catalog`. Exported for `baseline.ts`'s revalidation. */
export function validateCatalog(payload: unknown, prefix: string): Record<string, unknown>[] {
  const value = parseJson(payload, prefix, MAX_CATALOG_BYTES);
  if (!Array.isArray(value) || !(value.length >= 1 && value.length <= MAX_ROWS))
    fail(`${prefix}_shape`);
  const rows = value.map((row) => validateRow(row, prefix));
  const paperIds = rows.map((row) => row.paper_id);
  const sourceIds = rows.map((row) => row.source_id);
  if (new Set(paperIds).size !== rows.length || new Set(sourceIds).size !== rows.length) {
    fail(`${prefix}_duplicate_id`);
  }
  return rows;
}

function validateDetails(
  payload: unknown,
  editionId: string,
  currentRows: Record<string, unknown>[],
): Map<string, string> {
  const value = parseJson(payload, "current_details", MAX_DETAILS_BYTES);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !sameKeySet(Object.keys(value as Record<string, unknown>), [
      "schema_version",
      "edition_id",
      "papers",
    ])
  ) {
    fail("current_details_shape");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== "conference-current-details-v1") fail("current_details_shape");
  if (obj.edition_id !== editionId) fail("current_details_edition");
  const papers = obj.papers;
  if (!Array.isArray(papers) || papers.length > MAX_ROWS) fail("current_details_shape");

  const details = new Map<string, string>();
  for (const item of papers) {
    if (!Array.isArray(item) || item.length !== 2) fail("current_details_row_invalid");
    const paperId = text(item[0], MAX_SCALAR_CHARS, true);
    const abstract = text(item[1], MAX_DETAIL_ABSTRACT_CHARS, false, true);
    if (paperId === null || abstract === null) fail("current_details_row_invalid");
    if (details.has(paperId)) fail("current_details_duplicate_id");
    details.set(paperId, abstract);
  }

  const currentById = new Map(currentRows.map((row) => [String(row.paper_id), row]));
  if (!sameKeySet([...details.keys()], [...currentById.keys()])) fail("current_details_id_set");
  for (const [paperId, abstract] of details) {
    if (currentById.get(paperId)?.abstract !== abstractPreview(abstract))
      fail("current_details_preview_mismatch");
  }
  return details;
}

function sameKeySet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((item) => setB.has(item)) && new Set(a).size === a.length;
}

function projectCandidate(candidate: CatalogCandidate): Record<string, unknown>[] {
  return candidate.rows.map((row) => ({
    title: row.title,
    type: row.paperType,
    tags: [...row.tags],
    venue: row.venue,
    authors: [...row.authors],
    arxiv_url: row.landingUrl,
    pdf_url: row.pdfUrl,
    abstract: abstractPreview(row.abstract),
    arxiv_id: row.arxivId,
    citation_count: row.citationCount,
    venue_tier: row.venueTier,
    github_stars: row.githubStars,
    paper_id: row.paperId,
    source: row.source,
    source_id: row.sourceId,
  }));
}

function artifactBinding(payload: Buffer): { sha256: string; size_bytes: number } {
  return { sha256: sha256(payload), size_bytes: payload.length };
}

function boundedCanonical(value: unknown, maximum: number, code: string): Buffer {
  let payload: Buffer;
  try {
    payload = canonicalJsonBytes(value);
  } catch {
    return fail(code);
  }
  if (payload.length > maximum) fail(code);
  return payload;
}

export interface CatalogUpdateDryRun {
  outcome: "changes_detected" | "no_change" | "blocked" | "indeterminate";
  candidateCatalogBytes: Buffer;
  reportBytes: Buffer;
  stagingPlanBytes: Buffer;
  catalogRowsBytes: Buffer;
  detailsBytes: Buffer;
  summaryCsvBytes: Buffer;
  sourceQualityBytes: Buffer;
  runBindingBytes: Buffer;
}

/** Build deterministic review bytes without touching local or remote state — TS port of `build_catalog_update_dry_run`. */
export function buildCatalogUpdateDryRun(
  edition: Edition,
  readiness: EditionState,
  snapshot: SourceSnapshot,
  options: { currentCatalogBytes: Buffer; currentDetailsBytes?: Buffer | null },
): CatalogUpdateDryRun {
  let candidate: CatalogCandidate;
  try {
    candidate = buildCatalogCandidate(edition, readiness, snapshot);
  } catch (e) {
    if (e instanceof CandidateValidationError) return fail(e.code);
    throw e;
  }

  const currentRows = validateCatalog(options.currentCatalogBytes, "current_catalog");
  const publicRows = projectCandidate(candidate);
  let candidateCatalogBytes: Buffer;
  try {
    // Python: `json.dumps(public_rows, ensure_ascii=False, indent=0,
    // allow_nan=False)` — `indent=0` means newline-separated, NOT
    // single-line (that's what distinguishes it from a bare
    // `JSON.stringify`); see pyJsonDumps's module doc "Separators and
    // indent" section.
    candidateCatalogBytes = Buffer.from(
      pyJsonDumps(publicRows, { indent: 0, ensureAscii: false }),
      "utf-8",
    );
  } catch {
    return fail("candidate_catalog_invalid");
  }
  const candidateRows = validateCatalog(candidateCatalogBytes, "candidate_catalog");

  let currentDetails: Map<string, string> | null = null;
  if (options.currentDetailsBytes != null) {
    currentDetails = validateDetails(options.currentDetailsBytes, candidate.editionId, currentRows);
  }

  const currentById = new Map(currentRows.map((row) => [String(row.paper_id), row]));
  const candidateById = new Map(candidateRows.map((row) => [String(row.paper_id), row]));
  const currentIds = new Set(currentById.keys());
  const candidateIds = new Set(candidateById.keys());
  const commonIds = [...currentIds].filter((id) => candidateIds.has(id)).sort();
  const metadataChanged: { paper_id: string; fields: string[] }[] = [];
  const unchanged: string[] = [];
  for (const paperId of commonIds) {
    const fields = [...CATALOG_KEYS]
      .filter((field) => currentById.get(paperId)?.[field] !== candidateById.get(paperId)?.[field])
      .sort();
    if (fields.length > 0) metadataChanged.push({ paper_id: paperId, fields });
    else unchanged.push(paperId);
  }

  let fullAbstractChanged: string[] = [];
  if (currentDetails !== null) {
    const candidateDetails = new Map(candidate.details.map((d) => [d.paperId, d.abstract]));
    fullAbstractChanged = commonIds
      .filter((id) => currentDetails?.get(id) !== candidateDetails.get(id))
      .sort();
  }
  const added = [...candidateIds].filter((id) => !currentIds.has(id)).sort();
  const removed = [...currentIds].filter((id) => !candidateIds.has(id)).sort();
  const catalogBytesChanged = !options.currentCatalogBytes.equals(candidateCatalogBytes);
  const orderChanged =
    currentIds.size === candidateIds.size &&
    sameKeySet([...currentIds], [...candidateIds]) &&
    JSON.stringify(currentRows.map((r) => r.paper_id)) !==
      JSON.stringify(candidateRows.map((r) => r.paper_id));

  let outcome: CatalogUpdateDryRun["outcome"];
  let changed: boolean | null;
  if (removed.length > 0) {
    outcome = "blocked";
    changed = true;
  } else if (catalogBytesChanged || fullAbstractChanged.length > 0) {
    outcome = "changes_detected";
    changed = true;
  } else if (currentDetails === null) {
    outcome = "indeterminate";
    changed = null;
  } else {
    outcome = "no_change";
    changed = false;
  }

  const blockers = ["catalog_date_projection_unresolved", "shared_projection_not_materialized"];
  if (removed.length > 0) blockers.push("current_catalog_removal_detected");
  blockers.sort();

  const artifacts = {
    candidate_catalog: artifactBinding(candidateCatalogBytes),
    catalog_rows: artifactBinding(candidate.catalogRowsBytes),
    details: artifactBinding(candidate.detailsBytes),
    summary_csv: artifactBinding(candidate.summaryCsvBytes),
    source_quality: artifactBinding(candidate.sourceQualityBytes),
    run_binding: artifactBinding(candidate.runBindingBytes),
  };
  const delta = {
    added,
    removed,
    metadata_changed: metadataChanged,
    unchanged,
    full_abstract_changed: fullAbstractChanged,
    catalog_bytes_changed: catalogBytesChanged,
    order_changed: orderChanged,
  };
  const report = {
    schema_version: "conference-catalog-dry-run-v1",
    scope: "local_dry_run_only",
    edition_id: candidate.editionId,
    source_fingerprint: candidate.sourceFingerprint,
    source_observed_at: candidate.sourceObservedAt,
    current_catalog_sha256: sha256(options.currentCatalogBytes),
    current_details_sha256:
      options.currentDetailsBytes != null ? sha256(options.currentDetailsBytes) : null,
    generation_key: candidate.generationKey,
    run_binding_sha256: sha256(candidate.runBindingBytes),
    counts: {
      current: currentRows.length,
      candidate: candidateRows.length,
      added: added.length,
      removed: removed.length,
      metadata_changed: metadataChanged.length,
      unchanged: unchanged.length,
      full_abstract_changed: fullAbstractChanged.length,
    },
    delta,
    changed,
    outcome,
    detail_comparison: currentDetails !== null ? "complete" : "not_checked",
    errors: [],
    blockers,
    gates: { previous_edition_ratio: "not_checked", first_edition_human_dry_run: "not_checked" },
    authority: AUTHORITY,
    artifacts,
  };
  const reportBytes = boundedCanonical(report, MAX_REPORT_BYTES, "report_size");

  const statuses: Record<CatalogUpdateDryRun["outcome"], string> = {
    changes_detected: "planned_not_materialized",
    no_change: "not_required",
    blocked: "blocked",
    indeterminate: "blocked",
  };
  const repositoryCandidates =
    outcome === "changes_detected"
      ? [
          {
            path: `docs/${candidate.editionId}/papers.json`,
            ...artifactBinding(candidateCatalogBytes),
          },
          {
            path: `paperpilot/output/${candidate.editionId}/summary.csv`,
            ...artifactBinding(candidate.summaryCsvBytes),
          },
        ]
      : [];
  const plan = {
    schema_version: "conference-catalog-staging-plan-v1",
    scope: "local_dry_run_only",
    status: statuses[outcome],
    edition_id: candidate.editionId,
    source_fingerprint: candidate.sourceFingerprint,
    generation_key: candidate.generationKey,
    outcome,
    report: artifactBinding(reportBytes),
    repository_candidates: repositoryCandidates,
    artifact_only: ["catalog_rows", "details", "source_quality", "run_binding"],
    required_regeneration: REQUIRED_REGENERATION,
    blockers,
    authority: AUTHORITY,
  };
  const stagingPlanBytes = boundedCanonical(plan, MAX_STAGING_PLAN_BYTES, "staging_plan_size");

  return {
    outcome,
    candidateCatalogBytes,
    reportBytes,
    stagingPlanBytes,
    catalogRowsBytes: candidate.catalogRowsBytes,
    detailsBytes: candidate.detailsBytes,
    summaryCsvBytes: candidate.summaryCsvBytes,
    sourceQualityBytes: candidate.sourceQualityBytes,
    runBindingBytes: candidate.runBindingBytes,
  };
}

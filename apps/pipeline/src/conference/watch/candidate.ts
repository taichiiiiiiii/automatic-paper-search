/**
 * Pure, local-only catalog candidates from revalidated ready snapshots —
 * TS port of `paperpilot/conference_watch/candidate.py` (CNF-31/33).
 *
 * The returned bytes do not prove that the supplied state came from
 * trusted persistent storage and do not authorize staging, promotion, or
 * publication.
 */

import { createHash } from "node:crypto";
import { pyFloat, pyIsoformat } from "@paperpilot/core";
import { IdentityError, identityFromUrl, makePaperId } from "@paperpilot/core/identity";
import { classifyTags } from "../../catalog/buildSummary.js";
import { neutralizeRow } from "../../collect/exporters/csvSafety.js";
import { canonicalJsonBytes } from "./canonicalJson.js";
import { sourceFingerprint } from "./fingerprint.js";
import {
  type CountGate,
  type Edition,
  type EditionState,
  HASH_RE,
  type NormalizedPaper,
  type ProbeObservation,
  type SourceSnapshot,
  type TrackPolicy,
} from "./models.js";
import {
  ADAPTER_NAME,
  ADAPTER_VERSION,
  normalizeDecision,
  OPENREVIEW_FORUM_URL,
  OPENREVIEW_PDF_URL,
} from "./openreview.js";
import { STABLE_PROBE_COUNT } from "./registry.js";

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SOURCE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const FIELD_RE = /^[a-z][a-z0-9_.-]{0,127}$/;
const EDITION_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const VENUE_RE = /^[a-z0-9-]+$/;
const LABEL_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_AUTHORS_PER_PAPER = 512;
const MAX_PROJECTED_TEXT_BYTES = 128 * 1024 * 1024;

const SUMMARY_FIELDS = [
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
  "source",
  "source_id",
] as const;

export type CandidateErrorCode =
  | "CONF_CANDIDATE_READINESS_INVALID"
  | "CONF_CANDIDATE_MISMATCH"
  | "CONF_IDENTITY_CONFLICT"
  | "CONF_DUPLICATE_ID"
  | "CONF_COUNT_SHRINK"
  | "CONF_VALIDATION_FAILED";

export class CandidateValidationError extends Error {
  readonly field: string;
  constructor(
    public readonly code: CandidateErrorCode,
    field: string,
  ) {
    const safeField = FIELD_RE.test(field) ? field : "candidate";
    super(`${code}:${safeField}`);
    this.field = safeField;
  }
}

function fail(code: CandidateErrorCode, field: string): never {
  throw new CandidateValidationError(code, field);
}

export interface CandidateCatalogRow {
  title: string;
  paperType: "Oral" | "Poster";
  tags: readonly string[];
  venue: string;
  authors: readonly string[];
  landingUrl: string;
  pdfUrl: string;
  abstract: string;
  arxivId: string;
  citationCount: number | null;
  venueTier: number | null;
  githubStars: number | null;
  paperId: string;
  source: string;
  sourceId: string;
}

export interface CandidateDetail {
  paperId: string;
  abstract: string;
}

export interface CatalogCandidate {
  schemaVersion: "conference-catalog-candidate-v1";
  editionId: string;
  sourceFingerprint: string;
  sourceObservedAt: string;
  readinessRunId: string;
  generationKey: string;
  rows: readonly CandidateCatalogRow[];
  details: readonly CandidateDetail[];
  catalogRowsBytes: Buffer;
  detailsBytes: Buffer;
  summaryCsvBytes: Buffer;
  sourceQualityBytes: Buffer;
  runBindingBytes: Buffer;
}

function plainInt(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    fail("CONF_VALIDATION_FAILED", field);
  }
  return value;
}

function finiteRatio(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !(value > 0 && value <= 10)) {
    fail("CONF_VALIDATION_FAILED", field);
  }
  return value;
}

/** Plain-text field check: no control chars, no leading/trailing/doubled whitespace, bounded length. */
function text(value: unknown, field: string, required: boolean, maximum: number): string {
  if (typeof value !== "string") fail("CONF_VALIDATION_FAILED", field);
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) fail("CONF_VALIDATION_FAILED", field);
  }
  const collapsed = value.split(/\s+/).filter(Boolean).join(" ");
  if (value !== collapsed || value.length > maximum || (required && value === "")) {
    fail("CONF_VALIDATION_FAILED", field);
  }
  return value;
}

function utc(value: unknown, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail("CONF_CANDIDATE_READINESS_INVALID", field);
  }
  return value;
}

/**
 * `_timestamp` port: `value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")`.
 * `pyIsoformat` keeps Python's microsecond-field rule — omitted entirely
 * when the sub-second value is exactly 0, otherwise always a full 6-digit
 * `.ffffff` — rather than JS's native 3-digit millisecond text.
 */
function timestamp(value: Date): string {
  return pyIsoformat(value).replace("+00:00", "Z");
}

function jsonBytes(value: unknown): Buffer {
  try {
    return canonicalJsonBytes(value);
  } catch {
    return fail("CONF_VALIDATION_FAILED", "candidate.serialization");
  }
}

function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

/** TS port of `_validate_edition`. */
export function validateEdition(edition: Edition): void {
  text(edition.editionId, "edition.edition_id", true, 40);
  if (!EDITION_RE.test(edition.editionId) || edition.editionId === "daily") {
    fail("CONF_VALIDATION_FAILED", "edition.edition_id");
  }
  text(edition.venueKey, "edition.venue_key", true, 40);
  if (!VENUE_RE.test(edition.venueKey) || edition.venueKey === "daily") {
    fail("CONF_VALIDATION_FAILED", "edition.venue_key");
  }
  plainInt(edition.year, "edition.year", 2000, 2100);
  text(edition.displayName, "edition.display_name", true, 200);
  if (edition.adapter !== ADAPTER_NAME) fail("CONF_CANDIDATE_MISMATCH", "edition.adapter");
  text(edition.sourceId, "edition.source_id", true, 256);
  const sourceMatch = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}\/([0-9]{4})\/Conference$/.exec(
    edition.sourceId,
  );
  if (!sourceMatch || Number(sourceMatch[1]) !== edition.year) {
    fail("CONF_VALIDATION_FAILED", "edition.source_id");
  }
  const gate: CountGate = edition.countGate;
  const tracks: TrackPolicy = edition.tracks;
  plainInt(gate.minimumAbsolute, "edition.minimum_absolute", 1, 25_000);
  const minRatio = finiteRatio(gate.previousEditionMinRatio, "edition.minimum_ratio");
  const maxRatio = finiteRatio(gate.previousEditionMaxRatio, "edition.maximum_ratio");
  const accepted = tracks.acceptedDecisionLabels;
  const highlighted = tracks.highlightedLabels;
  if (
    maxRatio < minRatio ||
    tracks.acceptedOnly !== true ||
    !(accepted.length >= 1 && accepted.length <= 32) ||
    accepted.some((l) => !LABEL_RE.test(l)) ||
    new Set(accepted).size !== accepted.length ||
    !(highlighted.length >= 1 && highlighted.length <= 32) ||
    highlighted.some((l) => !LABEL_RE.test(l)) ||
    new Set(highlighted).size !== highlighted.length ||
    !highlighted.every((l) => accepted.includes(l))
  ) {
    fail("CONF_VALIDATION_FAILED", "edition.policy");
  }
  plainInt(edition.stableMinSeparationHours, "edition.min_separation", 1, 168);
  plainInt(edition.stableMaxSeparationHours, "edition.max_separation", 1, 336);
  if (edition.stableMaxSeparationHours < edition.stableMinSeparationHours) {
    fail("CONF_VALIDATION_FAILED", "edition.separation");
  }
}

function validateReadiness(
  edition: Edition,
  state: EditionState,
  snapshot: SourceSnapshot,
): { lastQualifyingAt: Date; lastQualifyingRunId: string } {
  if (
    state.editionId !== edition.editionId ||
    state.venueKey !== edition.venueKey ||
    state.year !== edition.year ||
    state.phase !== "ready" ||
    state.stableObservations !== STABLE_PROBE_COUNT ||
    typeof state.stableFingerprint !== "string" ||
    !HASH_RE.test(state.stableFingerprint) ||
    state.stableFingerprint !== snapshot.sourceFingerprint
  ) {
    fail("CONF_CANDIDATE_READINESS_INVALID", "readiness.state");
  }
  const first = utc(state.stableSinceAt, "readiness.stable_since_at");
  const last = utc(state.lastQualifyingAt, "readiness.last_qualifying_at");
  if (typeof state.lastQualifyingRunId !== "string" || !RUN_ID_RE.test(state.lastQualifyingRunId)) {
    fail("CONF_CANDIDATE_READINESS_INVALID", "readiness.run_id");
  }
  const separation = (last.getTime() - first.getTime()) / 3_600_000;
  if (
    !(
      edition.stableMinSeparationHours <= separation &&
      separation <= edition.stableMaxSeparationHours
    )
  ) {
    fail("CONF_CANDIDATE_READINESS_INVALID", "readiness.separation");
  }

  const observation: ProbeObservation | null = state.lastObservation;
  if (observation === null) fail("CONF_CANDIDATE_READINESS_INVALID", "readiness.last_observation");
  if (
    observation.sourceIds.length > 25_000 ||
    observation.sourceIds.some((id) => !SOURCE_ID_RE.test(id)) ||
    new Set(observation.sourceIds).size !== observation.sourceIds.length
  ) {
    fail("CONF_CANDIDATE_READINESS_INVALID", "readiness.source_ids");
  }
  if (
    observation.schemaVersion !== "conference-probe-observation-v1" ||
    !RUN_ID_RE.test(observation.runId) ||
    observation.editionId !== edition.editionId ||
    observation.adapter !== edition.adapter ||
    observation.adapterVersion !== snapshot.adapterVersion ||
    observation.sourceId !== edition.sourceId ||
    utc(observation.observedAt, "readiness.observed_at").getTime() < last.getTime()
  ) {
    fail("CONF_CANDIDATE_READINESS_INVALID", "readiness.last_observation");
  }
  if (observation.status === "failed") {
    if (
      observation.httpClass !== "error" ||
      observation.sourceFingerprint !== null ||
      observation.sourceIds.length !== 0 ||
      observation.acceptedCount !== 0 ||
      observation.errorCode === null ||
      state.lastFailureCode !== observation.errorCode ||
      observation.unknownLabelCount !== 0
    ) {
      fail("CONF_CANDIDATE_READINESS_INVALID", "readiness.failure");
    }
  } else if (
    observation.status !== "stabilizing" ||
    observation.httpClass !== "ok" ||
    observation.errorCode !== null ||
    state.lastFailureCode !== null ||
    observation.sourceFingerprint !== snapshot.sourceFingerprint ||
    observation.acceptedCount !== snapshot.rows.length ||
    !sameSet(
      observation.sourceIds,
      snapshot.rows.map((row) => row.sourceId),
    ) ||
    observation.sourceIds.length !== snapshot.rows.length ||
    observation.unknownLabelCount !== snapshot.unknownDecisions.reduce((sum, [, n]) => sum + n, 0)
  ) {
    fail("CONF_CANDIDATE_READINESS_INVALID", "readiness.qualifying_observation");
  }
  return { lastQualifyingAt: last, lastQualifyingRunId: state.lastQualifyingRunId as string };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}

function validateSnapshotHeader(edition: Edition, snapshot: SourceSnapshot): void {
  if (
    snapshot.schemaVersion !== "conference-source-snapshot-v1" ||
    snapshot.editionId !== edition.editionId ||
    snapshot.adapter !== edition.adapter ||
    snapshot.adapterVersion !== ADAPTER_VERSION ||
    snapshot.sourceId !== edition.sourceId ||
    typeof snapshot.sourceFingerprint !== "string" ||
    !HASH_RE.test(snapshot.sourceFingerprint)
  ) {
    fail("CONF_CANDIDATE_MISMATCH", "snapshot.header");
  }
  if (!(snapshot.rows.length >= 1 && snapshot.rows.length <= 25_000)) {
    fail("CONF_VALIDATION_FAILED", "snapshot.rows");
  }
  plainInt(snapshot.requestCount, "snapshot.request_count", 1, 100);
  const pageCount = plainInt(snapshot.pageCount, "snapshot.page_count", 1, 25);
  if (snapshot.requestCount < pageCount) fail("CONF_VALIDATION_FAILED", "snapshot.request_count");
  plainInt(snapshot.responseBytes, "snapshot.response_bytes", 0, 128 * 1024 * 1024);
  plainInt(snapshot.duplicateTitleCount, "snapshot.duplicate_titles", 0, 24_999);
  if (snapshot.unknownDecisions.length > 25_000)
    fail("CONF_VALIDATION_FAILED", "snapshot.unknown_decisions");
  let unknownTotal = 0;
  const unknownLabels: string[] = [];
  for (const [label, amount] of snapshot.unknownDecisions) {
    const checked = text(label, "snapshot.unknown_decision", true, 1_000);
    if (checked !== checked.toLowerCase())
      fail("CONF_VALIDATION_FAILED", "snapshot.unknown_decision");
    unknownLabels.push(checked);
    unknownTotal += plainInt(amount, "snapshot.unknown_decision_count", 1, 25_000);
  }
  const sortedLabels = [...unknownLabels].sort();
  if (
    unknownLabels.some((label, i) => label !== sortedLabels[i]) ||
    new Set(unknownLabels).size !== unknownLabels.length ||
    unknownTotal > snapshot.rows.length ||
    snapshot.duplicateTitleCount >= snapshot.rows.length
  ) {
    fail("CONF_VALIDATION_FAILED", "snapshot.unknown_decisions");
  }
}

function validatedRows(
  edition: Edition,
  snapshot: SourceSnapshot,
): { rows: CandidateCatalogRow[]; unknownDecisions: [string, number][]; duplicateTitles: number } {
  const seenSourceIds = new Set<string>();
  const seenPaperIds = new Set<string>();
  const seenLandingUrls = new Set<string>();
  const unknown = new Map<string, number>();
  const projected: CandidateCatalogRow[] = [];
  let projectedTextBytes = 0;

  for (const raw of snapshot.rows as NormalizedPaper[]) {
    if (raw.source !== "openreview" || !SOURCE_ID_RE.test(raw.sourceId)) {
      fail("CONF_IDENTITY_CONFLICT", "snapshot.row_identity");
    }
    let expectedPaperId: string;
    let landingIdentity: ReturnType<typeof identityFromUrl>;
    try {
      expectedPaperId = makePaperId(raw.source, raw.sourceId);
      landingIdentity = identityFromUrl(raw.landingUrl);
    } catch (e) {
      if (e instanceof IdentityError) fail("CONF_IDENTITY_CONFLICT", "snapshot.row_identity");
      throw e;
    }
    if (
      raw.paperId !== expectedPaperId ||
      landingIdentity.paperId !== expectedPaperId ||
      raw.landingUrl !== `${OPENREVIEW_FORUM_URL}${raw.sourceId}` ||
      raw.pdfUrl !== `${OPENREVIEW_PDF_URL}${raw.sourceId}`
    ) {
      fail("CONF_IDENTITY_CONFLICT", "snapshot.row_identity");
    }
    if (
      seenSourceIds.has(raw.sourceId) ||
      seenPaperIds.has(raw.paperId) ||
      seenLandingUrls.has(raw.landingUrl)
    ) {
      fail("CONF_DUPLICATE_ID", "snapshot.row_identity");
    }
    seenSourceIds.add(raw.sourceId);
    seenPaperIds.add(raw.paperId);
    seenLandingUrls.add(raw.landingUrl);

    const title = text(raw.title, "snapshot.title", true, 10_000);
    const abstract = text(raw.abstract, "snapshot.abstract", false, 100_000);
    const decisionLabel = text(raw.decisionLabel, "snapshot.decision_label", true, 1_000);
    if (!(raw.authors.length >= 1 && raw.authors.length <= MAX_AUTHORS_PER_PAPER)) {
      fail("CONF_IDENTITY_CONFLICT", "snapshot.authors");
    }
    const authors = raw.authors.map((author) => text(author, "snapshot.author", true, 1_000));
    if (authors.some((author) => author.includes(",") || author.includes(";"))) {
      fail("CONF_VALIDATION_FAILED", "snapshot.author_delimiter");
    }
    projectedTextBytes += Buffer.byteLength(
      title + abstract + decisionLabel + authors.join(""),
      "utf-8",
    );
    if (projectedTextBytes > MAX_PROJECTED_TEXT_BYTES)
      fail("CONF_VALIDATION_FAILED", "snapshot.text_bytes");

    let decision: string | null;
    try {
      decision = normalizeDecision(decisionLabel, edition.tracks.acceptedDecisionLabels);
    } catch {
      fail("CONF_VALIDATION_FAILED", "snapshot.decision_label");
    }
    if (decision === null) {
      const key = decisionLabel.toLowerCase();
      unknown.set(key, (unknown.get(key) ?? 0) + 1);
    }
    const paperType: "Oral" | "Poster" =
      decision !== null && edition.tracks.highlightedLabels.includes(decision) ? "Oral" : "Poster";
    const tags = classifyTags(title, abstract);
    projected.push({
      title,
      paperType,
      tags: tags.length > 0 ? tags : ["Other"],
      venue: edition.displayName,
      authors,
      landingUrl: raw.landingUrl,
      pdfUrl: raw.pdfUrl,
      abstract,
      arxivId: "",
      citationCount: null,
      venueTier: null,
      githubStars: null,
      paperId: raw.paperId,
      source: raw.source,
      sourceId: raw.sourceId,
    });
  }
  const titleCounts = new Map<string, number>();
  for (const row of projected) titleCounts.set(row.title, (titleCounts.get(row.title) ?? 0) + 1);
  let duplicateTitles = 0;
  for (const count of titleCounts.values()) if (count > 1) duplicateTitles += count - 1;

  const sortedRows = [...projected].sort((a, b) =>
    a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0,
  );
  const sortedUnknown = [...unknown.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  ) as [string, number][];
  return { rows: sortedRows, unknownDecisions: sortedUnknown, duplicateTitles };
}

function summaryCsv(rows: readonly CandidateCatalogRow[]): Buffer {
  const lines = [SUMMARY_FIELDS.join(",")];
  for (const row of rows) {
    const record: Record<string, string> = {
      title: row.title,
      type: row.paperType,
      tags: row.tags.join(" "),
      venue: row.venue,
      authors: row.authors.join("; "),
      arxiv_url: row.landingUrl,
      pdf_url: row.pdfUrl,
      abstract: row.abstract,
      arxiv_id: "",
      citation_count: "",
      venue_tier: "",
      github_stars: "",
      source: row.source,
      source_id: row.sourceId,
    };
    const neutralized = neutralizeRow(record);
    lines.push(
      SUMMARY_FIELDS.map((field) => {
        const value = neutralized[field] ?? "";
        return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
      }).join(","),
    );
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf-8");
}

/** TS port of `_validate_candidate_snapshot`. Exported for `baseline.ts`'s revalidation. */
export function validateCandidateSnapshot(
  edition: Edition,
  snapshot: SourceSnapshot,
): { rows: CandidateCatalogRow[]; unknownDecisions: [string, number][]; duplicateTitles: number } {
  validateEdition(edition);
  validateSnapshotHeader(edition, snapshot);
  const { rows, unknownDecisions, duplicateTitles } = validatedRows(edition, snapshot);
  if (
    JSON.stringify(unknownDecisions) !== JSON.stringify(snapshot.unknownDecisions) ||
    duplicateTitles !== snapshot.duplicateTitleCount
  ) {
    fail("CONF_CANDIDATE_MISMATCH", "snapshot.statistics");
  }
  let recomputed: string;
  try {
    recomputed = sourceFingerprint({
      adapterVersion: snapshot.adapterVersion,
      editionId: snapshot.editionId,
      sourceId: snapshot.sourceId,
      rows: snapshot.rows,
    });
  } catch {
    return fail("CONF_VALIDATION_FAILED", "snapshot.fingerprint");
  }
  if (recomputed !== snapshot.sourceFingerprint)
    fail("CONF_CANDIDATE_MISMATCH", "snapshot.fingerprint");
  return { rows, unknownDecisions, duplicateTitles };
}

const AUTHORITY = {
  trusted_persistent_state_proof: false,
  promotion_authorized: false,
  publication_authorized: false,
};

/** Revalidate caller-supplied evidence and return deterministic local bytes — TS port of `build_catalog_candidate`. */
export function buildCatalogCandidate(
  edition: Edition,
  readiness: EditionState,
  snapshot: SourceSnapshot,
): CatalogCandidate {
  const { rows, unknownDecisions, duplicateTitles } = validateCandidateSnapshot(edition, snapshot);
  if (rows.length < edition.countGate.minimumAbsolute)
    fail("CONF_CANDIDATE_READINESS_INVALID", "readiness.count");
  const { lastQualifyingAt, lastQualifyingRunId } = validateReadiness(edition, readiness, snapshot);

  if (readiness.publishedSourceIds.length > 25_000) {
    fail("CONF_COUNT_SHRINK", "readiness.published_source_ids");
  }
  const publishedFieldsPresent = [
    readiness.publishedFingerprint !== null,
    readiness.publishedCount !== null,
    readiness.publishedSourceIds.length > 0,
  ];
  if (publishedFieldsPresent.some(Boolean) && !publishedFieldsPresent.every(Boolean)) {
    fail("CONF_COUNT_SHRINK", "readiness.published_evidence");
  }
  if (readiness.publishedCount !== null) {
    const publishedCount = plainInt(
      readiness.publishedCount,
      "readiness.published_count",
      0,
      25_000,
    );
    const rowSourceIds = new Set(rows.map((row) => row.sourceId));
    if (
      readiness.publishedSourceIds.some((id) => !SOURCE_ID_RE.test(id)) ||
      new Set(readiness.publishedSourceIds).size !== readiness.publishedSourceIds.length ||
      publishedCount !== readiness.publishedSourceIds.length ||
      rows.length < publishedCount ||
      !readiness.publishedSourceIds.every((id) => rowSourceIds.has(id))
    ) {
      fail("CONF_COUNT_SHRINK", "readiness.published_continuity");
    }
  }
  if (readiness.publishedFingerprint !== null && !HASH_RE.test(readiness.publishedFingerprint)) {
    fail("CONF_COUNT_SHRINK", "readiness.published_fingerprint");
  }

  const sourceObservedAt = timestamp(lastQualifyingAt);
  const generationKey = sha256(
    jsonBytes({
      schema_version: "conference-catalog-generation-key-v1",
      edition_id: edition.editionId,
      source_fingerprint: snapshot.sourceFingerprint,
    }),
  );
  const details: CandidateDetail[] = [...rows]
    .sort((a, b) => (a.paperId < b.paperId ? -1 : a.paperId > b.paperId ? 1 : 0))
    .map((row) => ({ paperId: row.paperId, abstract: row.abstract }));
  const catalogRowsBytes = jsonBytes({
    schema_version: "conference-catalog-rows-v1",
    edition_id: edition.editionId,
    source_fingerprint: snapshot.sourceFingerprint,
    source_observed_at: sourceObservedAt,
    rows: rows.map((row) => ({
      title: row.title,
      paper_type: row.paperType,
      tags: [...row.tags],
      venue: row.venue,
      authors: [...row.authors],
      landing_url: row.landingUrl,
      pdf_url: row.pdfUrl,
      abstract: row.abstract,
      arxiv_id: row.arxivId,
      citation_count: row.citationCount,
      venue_tier: row.venueTier,
      github_stars: row.githubStars,
      paper_id: row.paperId,
      source: row.source,
      source_id: row.sourceId,
    })),
  });
  const detailsBytes = jsonBytes({
    schema_version: "conference-candidate-details-v1",
    edition_id: edition.editionId,
    source_fingerprint: snapshot.sourceFingerprint,
    papers: details.map((detail) => [detail.paperId, detail.abstract]),
  });
  const summaryCsvBytes = summaryCsv(rows);
  const sourceQualityBytes = jsonBytes({
    schema_version: "conference-source-quality-v1",
    status: "local_checks_passed",
    scope: "local_candidate_only",
    edition_id: edition.editionId,
    adapter: snapshot.adapter,
    adapter_version: snapshot.adapterVersion,
    source_id: snapshot.sourceId,
    source_fingerprint: snapshot.sourceFingerprint,
    source_observed_at: sourceObservedAt,
    accepted_count: snapshot.rows.length,
    projected_count: rows.length,
    identity_resolved_count: rows.length,
    identity_coverage: pyFloat(1),
    duplicate_title_count: duplicateTitles,
    unknown_decision_count: unknownDecisions.reduce((sum, [, n]) => sum + n, 0),
    unknown_decisions: unknownDecisions.map(([label, n]) => [label, n]),
    gates: {
      readiness: "passed",
      snapshot_binding: "passed",
      identity: "passed",
      minimum_absolute: "passed",
      previous_edition_ratio: "not_checked",
      first_edition_human_dry_run: "not_checked",
      published_continuity: "passed",
    },
  });
  const outputs: Record<string, Buffer> = {
    catalog_rows: catalogRowsBytes,
    details: detailsBytes,
    summary_csv: summaryCsvBytes,
    source_quality: sourceQualityBytes,
  };
  const runBindingBytes = jsonBytes({
    schema_version: "conference-candidate-run-binding-v1",
    scope: "local_candidate_only",
    edition_id: edition.editionId,
    source_fingerprint: snapshot.sourceFingerprint,
    source_observed_at: sourceObservedAt,
    readiness_run_id: lastQualifyingRunId,
    generation_key: generationKey,
    ...AUTHORITY,
    outputs: Object.fromEntries(
      Object.entries(outputs)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, payload]) => [name, { sha256: sha256(payload), size_bytes: payload.length }]),
    ),
  });

  return {
    schemaVersion: "conference-catalog-candidate-v1",
    editionId: edition.editionId,
    sourceFingerprint: snapshot.sourceFingerprint,
    sourceObservedAt,
    readinessRunId: lastQualifyingRunId,
    generationKey,
    rows,
    details,
    catalogRowsBytes,
    detailsBytes,
    summaryCsvBytes,
    sourceQualityBytes,
    runBindingBytes,
  };
}

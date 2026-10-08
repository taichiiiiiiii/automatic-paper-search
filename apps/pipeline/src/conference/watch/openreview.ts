/**
 * Strict OpenReview v2 adapter for complete, read-only source snapshots —
 * TS port of `paperpilot/conference_watch/openreview.py`'s
 * `OpenReviewV2Adapter` (CNF-22/23). Transport-level policy
 * (DNS pinning, retries, byte limits) lives in `./transport.ts`.
 */

import { IdentityError, makePaperId } from "@paperpilot/core/identity";
import { pySplit } from "@paperpilot/core/pycompat";
import { sourceFingerprint } from "./fingerprint.js";
import {
  type DetectionResult,
  type Edition,
  errorResult,
  type FetchLimits,
  type NormalizedPaper,
  type SourceSnapshot,
  snapshotResult,
} from "./models.js";
import {
  OPENREVIEW_API_URL,
  type ResponseLike,
  SecurePinnedTransport,
  TransportError,
} from "./transport.js";

export const OPENREVIEW_FORUM_URL = "https://openreview.net/forum?id=";
export const OPENREVIEW_PDF_URL = "https://openreview.net/pdf?id=";
export const ADAPTER_NAME = "openreview-v2";
export const ADAPTER_VERSION = "1";

const NOTE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const WORD_RE = /[a-z0-9_-]+/g;

export interface StrictTransport {
  get(
    url: string,
    options: { params: Record<string, string | number>; limits: FetchLimits; deadlineMs: number },
  ): Promise<ResponseLike>;
}

function contentValue(content: Record<string, unknown>, key: string): unknown {
  const node = content[key];
  if (typeof node !== "object" || node === null || !("value" in node)) return undefined;
  return (node as Record<string, unknown>).value;
}

function normalizedText(value: unknown, required: boolean, maximum = 100_000): string {
  if (typeof value !== "string") {
    if (required) throw new RangeError("required text is missing");
    return "";
  }
  // `" ".join(value.split())` (p4-followups #28): Python's no-arg
  // `str.split()` whitespace set differs slightly from JS's `\s` — see
  // `@paperpilot/core/pycompat`'s `pySplit` doc comment — and this feeds
  // `sourceFingerprint` below, so using the real set (not `.filter(Boolean)`
  // over `\s+`) matters for byte-identical fingerprints on exotic input.
  const normalized = pySplit(value).join(" ");
  if ((required && !normalized) || normalized.length > maximum) {
    throw new RangeError("text field is empty or oversized");
  }
  return normalized;
}

/** TS port of `_normalize_decision`. */
export function normalizeDecision(label: string, accepted: readonly string[]): string | null {
  const tokens = new Set((label.toLowerCase().match(WORD_RE) ?? []) as string[]);
  const matches = accepted.filter((candidate) => tokens.has(candidate.toLowerCase()));
  if (matches.length > 1)
    throw new RangeError("decision label matches multiple configured decisions");
  return matches[0] ?? null;
}

function normalizeNote(
  note: unknown,
  edition: Edition,
): { row: NormalizedPaper; decision: string | null } {
  if (typeof note !== "object" || note === null) throw new RangeError("note must be an object");
  const noteObj = note as Record<string, unknown>;
  const noteId = noteObj.id;
  if (typeof noteId !== "string" || !NOTE_ID_RE.test(noteId)) {
    throw new IdentityError("OpenReview note ID is missing or invalid");
  }
  const content = noteObj.content;
  if (typeof content !== "object" || content === null)
    throw new RangeError("note content must be an object");
  const contentObj = content as Record<string, unknown>;
  const venueId = contentValue(contentObj, "venueid");
  if (venueId !== edition.sourceId)
    throw new IdentityError("OpenReview note venueid does not match the edition");
  const title = normalizedText(contentValue(contentObj, "title"), true, 10_000);
  const rawAuthors = contentValue(contentObj, "authors");
  if (!Array.isArray(rawAuthors) || rawAuthors.length === 0) {
    throw new IdentityError("OpenReview authors must be a non-empty array");
  }
  const authors = rawAuthors.map((author) => normalizedText(author, true, 1_000));
  const abstract = normalizedText(contentValue(contentObj, "abstract"), false, 100_000);
  const decisionLabel = normalizedText(contentValue(contentObj, "venue"), true, 1_000);
  const decision = normalizeDecision(decisionLabel, edition.tracks.acceptedDecisionLabels);
  const row: NormalizedPaper = {
    source: "openreview",
    sourceId: noteId,
    paperId: makePaperId("openreview", noteId),
    title,
    authors,
    abstract,
    landingUrl: `${OPENREVIEW_FORUM_URL}${noteId}`,
    pdfUrl: `${OPENREVIEW_PDF_URL}${noteId}`,
    decisionLabel,
  };
  return { row, decision };
}

/** Fetch every accepted page or return a typed result without any rows — TS port of `OpenReviewV2Adapter`. */
export class OpenReviewV2Adapter {
  readonly name = ADAPTER_NAME;
  readonly version = ADAPTER_VERSION;
  private readonly transport: StrictTransport;
  private readonly monotonicMs: () => number;

  constructor(options: { transport?: StrictTransport; monotonicMs?: () => number } = {}) {
    this.transport = options.transport ?? new SecurePinnedTransport();
    this.monotonicMs = options.monotonicMs ?? (() => performance.now());
  }

  async probe(edition: Edition, limits: FetchLimits): Promise<DetectionResult> {
    return this.retrieve(edition, limits);
  }

  async collect(edition: Edition, limits: FetchLimits): Promise<DetectionResult> {
    return this.retrieve(edition, limits);
  }

  private async retrieve(edition: Edition, limits: FetchLimits): Promise<DetectionResult> {
    if (edition.adapter !== this.name) return errorResult("error", "CONF_REGISTRY_INVALID");
    const started = this.monotonicMs();
    const deadlineMs = started + limits.jobDeadlineSeconds * 1000;
    const notes: unknown[] = [];
    let responseBytes = 0;
    let requestsMade = 0;
    let pagesFetched = 0;
    let expectedCount: number | null = null;
    let completed = false;

    for (let page = 0; page < limits.maxPages; page++) {
      if (this.monotonicMs() >= deadlineMs) return errorResult("error", "CONF_SOURCE_TIMEOUT");
      const requestDeadlineMs = Math.min(
        deadlineMs,
        this.monotonicMs() + limits.requestTimeoutSeconds * 1000,
      );
      let response: ResponseLike;
      try {
        response = await this.transport.get(OPENREVIEW_API_URL, {
          params: {
            "content.venueid": edition.sourceId,
            limit: limits.pageSize,
            offset: page * limits.pageSize,
            count: "true",
          },
          limits,
          deadlineMs: requestDeadlineMs,
        });
      } catch (e) {
        if (e instanceof TransportError) return errorResult("error", e.code);
        return errorResult("error", "CONF_SOURCE_HTTP_ERROR");
      }
      if (this.monotonicMs() >= requestDeadlineMs)
        return errorResult("error", "CONF_SOURCE_TIMEOUT");
      if (
        typeof response.requestCount !== "number" ||
        !Number.isInteger(response.requestCount) ||
        response.requestCount < 1 ||
        response.requestCount > limits.maxRetries + 1
      ) {
        return errorResult("error", "CONF_SOURCE_HTTP_ERROR");
      }
      requestsMade += response.requestCount;
      pagesFetched += 1;
      if (response.statusCode === 404) return errorResult("unavailable", "CONF_SOURCE_UNAVAILABLE");
      if (response.statusCode === 429) return errorResult("error", "CONF_SOURCE_RATE_LIMITED");
      if (response.statusCode !== 200) return errorResult("error", "CONF_SOURCE_HTTP_ERROR");

      const bodyBytes = response.content;
      responseBytes += bodyBytes.length;
      if (responseBytes > limits.maxResponseBytes)
        return errorResult("error", "CONF_SOURCE_PARTIAL");

      let body: unknown;
      try {
        body = JSON.parse(bodyBytes.toString("utf-8"));
      } catch {
        return errorResult("error", "CONF_SOURCE_PARSE_ERROR");
      }
      if (
        typeof body !== "object" ||
        body === null ||
        !Array.isArray((body as Record<string, unknown>).notes)
      ) {
        return errorResult("error", "CONF_SOURCE_PARSE_ERROR");
      }
      const bodyObj = body as Record<string, unknown>;
      const rawCount = bodyObj.count;
      if (rawCount !== undefined) {
        if (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 0) {
          return errorResult("error", "CONF_SOURCE_PARSE_ERROR");
        }
        if (expectedCount === null) {
          expectedCount = rawCount;
        } else if (rawCount !== expectedCount) {
          return errorResult("error", "CONF_SOURCE_PARTIAL");
        }
        if (rawCount > limits.maxNotes) return errorResult("error", "CONF_SOURCE_PARTIAL");
      }
      const batch = bodyObj.notes as unknown[];
      if (batch.length > limits.pageSize) return errorResult("error", "CONF_SOURCE_PARSE_ERROR");
      notes.push(...batch);
      if (notes.length > limits.maxNotes) return errorResult("error", "CONF_SOURCE_PARTIAL");

      if (expectedCount !== null) {
        if (notes.length > expectedCount) return errorResult("error", "CONF_SOURCE_PARTIAL");
        if (notes.length === expectedCount) {
          completed = true;
          break;
        }
        if (batch.length < limits.pageSize) return errorResult("error", "CONF_SOURCE_PARTIAL");
      } else if (batch.length < limits.pageSize) {
        completed = true;
        break;
      }
    }

    if (!completed) return errorResult("error", "CONF_SOURCE_PARTIAL");
    if (notes.length === 0) return errorResult("unavailable", "CONF_SOURCE_UNAVAILABLE");

    const rows: NormalizedPaper[] = [];
    const unknown = new Map<string, number>();
    const seenIds = new Set<string>();
    const seenPaperIds = new Set<string>();
    const seenUrls = new Set<string>();
    for (const note of notes) {
      if (this.monotonicMs() >= deadlineMs) return errorResult("error", "CONF_SOURCE_TIMEOUT");
      let row: NormalizedPaper;
      let decision: string | null;
      try {
        ({ row, decision } = normalizeNote(note, edition));
      } catch (e) {
        if (e instanceof IdentityError) return errorResult("error", "CONF_IDENTITY_MISSING");
        return errorResult("error", "CONF_SOURCE_PARSE_ERROR");
      }
      if (seenIds.has(row.sourceId) || seenPaperIds.has(row.paperId)) {
        return errorResult("error", "CONF_DUPLICATE_ID");
      }
      if (seenUrls.has(row.landingUrl)) return errorResult("error", "CONF_IDENTITY_CONFLICT");
      seenIds.add(row.sourceId);
      seenPaperIds.add(row.paperId);
      seenUrls.add(row.landingUrl);
      rows.push(row);
      if (decision === null) {
        const key = row.decisionLabel.toLowerCase();
        unknown.set(key, (unknown.get(key) ?? 0) + 1);
      }
    }

    const immutableRows = [...rows].sort((a, b) =>
      a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0,
    );
    if (this.monotonicMs() >= deadlineMs) return errorResult("error", "CONF_SOURCE_TIMEOUT");
    const fingerprint = sourceFingerprint({
      adapterVersion: this.version,
      editionId: edition.editionId,
      sourceId: edition.sourceId,
      rows: immutableRows,
    });
    const titleCounts = new Map<string, number>();
    for (const row of immutableRows)
      titleCounts.set(row.title, (titleCounts.get(row.title) ?? 0) + 1);
    let duplicateTitleCount = 0;
    for (const count of titleCounts.values()) if (count > 1) duplicateTitleCount += count - 1;

    const snapshot: SourceSnapshot = {
      schemaVersion: "conference-source-snapshot-v1",
      editionId: edition.editionId,
      adapter: this.name,
      adapterVersion: this.version,
      sourceId: edition.sourceId,
      rows: immutableRows,
      sourceFingerprint: fingerprint,
      unknownDecisions: [...unknown.entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      ) as [string, number][],
      duplicateTitleCount,
      requestCount: requestsMade,
      pageCount: pagesFetched,
      responseBytes,
    };
    return snapshotResult(snapshot);
  }
}

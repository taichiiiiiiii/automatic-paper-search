/**
 * Typed domain objects for the read-only conference release detector — TS
 * port of `paperpilot/conference_watch/models.py`. Uses `zod` (per
 * docs/migration/safety-contracts.md CNF-25's "移植先" column) so the
 * extensive runtime revalidation `candidate.ts`/`dry_run.ts`/`baseline.ts`
 * need (never trusting a caller-supplied value's static type, matching the
 * Python modules' own `type(x) is not Foo` paranoia) is built on composable
 * schemas instead of hand-rolled type guards per field.
 */

import { z } from "zod";

export class ConferenceWatchError extends Error {}
export class RegistryError extends ConferenceWatchError {}

export const DetectionKind = z.enum(["snapshot", "unavailable", "error"]);
export type DetectionKind = z.infer<typeof DetectionKind>;

export const ErrorCode = z.enum([
  "CONF_REGISTRY_INVALID",
  "CONF_EDITION_OUT_OF_RANGE",
  "CONF_SOURCE_UNAVAILABLE",
  "CONF_SOURCE_RATE_LIMITED",
  "CONF_SOURCE_TIMEOUT",
  "CONF_SOURCE_HTTP_ERROR",
  "CONF_SOURCE_PARSE_ERROR",
  "CONF_SOURCE_PARTIAL",
  "CONF_SOURCE_FINGERPRINT_CHANGED",
  "CONF_COUNT_BELOW_MINIMUM",
  "CONF_COUNT_ABOVE_MAXIMUM",
  "CONF_COUNT_SHRINK",
  "CONF_IDENTITY_MISSING",
  "CONF_IDENTITY_CONFLICT",
  "CONF_DUPLICATE_ID",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

// ---------------------------------------------------------------------------
// FetchLimits (CNF-25)
// ---------------------------------------------------------------------------

export const FetchLimitsSchema = z
  .object({
    pageSize: z.number().int().min(1).max(1000).default(1000),
    maxPages: z.number().int().min(1).max(25).default(25),
    maxNotes: z.number().int().min(1).max(25_000).default(25_000),
    maxResponseBytes: z
      .number()
      .int()
      .min(1)
      .max(128 * 1024 * 1024)
      .default(128 * 1024 * 1024),
    connectTimeoutSeconds: z.number().finite().gt(0).max(10).default(10),
    readTimeoutSeconds: z.number().finite().gt(0).max(30).default(30),
    requestTimeoutSeconds: z.number().finite().gt(0).max(60).default(60),
    jobDeadlineSeconds: z
      .number()
      .finite()
      .gt(0)
      .max(20 * 60)
      .default(20 * 60),
    maxRetries: z.number().int().min(0).max(3).default(3),
  })
  .strict();
export type FetchLimits = z.infer<typeof FetchLimitsSchema>;

/** `FetchLimits()` equivalent: all-defaults, or a validated partial override. */
export function makeFetchLimits(partial: Partial<FetchLimits> = {}): FetchLimits {
  return FetchLimitsSchema.parse(partial);
}
export const DEFAULT_FETCH_LIMITS: FetchLimits = makeFetchLimits();

// ---------------------------------------------------------------------------
// CountGate / TrackPolicy / Venue / Edition
// ---------------------------------------------------------------------------

export const CountGateSchema = z
  .object({
    minimumAbsolute: z.number().int().min(1).max(25_000),
    previousEditionMinRatio: z.number().finite().gt(0).max(10),
    previousEditionMaxRatio: z.number().finite().gt(0).max(10),
  })
  .strict()
  .refine((g) => g.previousEditionMaxRatio >= g.previousEditionMinRatio, {
    message: "previous edition maximum ratio must be >= minimum ratio",
  });
export type CountGate = z.infer<typeof CountGateSchema>;

const LABEL_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const labelArray = z
  .array(z.string().regex(LABEL_RE))
  .min(1)
  .max(32)
  .refine((labels) => new Set(labels).size === labels.length, "labels must not contain duplicates");

export const TrackPolicySchema = z
  .object({
    acceptedOnly: z.literal(true),
    acceptedDecisionLabels: labelArray,
    highlightedLabels: labelArray,
  })
  .strict()
  .refine((t) => t.highlightedLabels.every((l) => t.acceptedDecisionLabels.includes(l)), {
    message: "highlighted labels must be accepted decision labels",
  });
export type TrackPolicy = z.infer<typeof TrackPolicySchema>;

const EDITION_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const VENUE_KEY_RE = /^[a-z0-9-]+$/;

export const VenueSchema = z
  .object({
    venueKey: z.string().regex(VENUE_KEY_RE),
    enabled: z.boolean(),
    curatedClass: z.literal("top"),
    displayTemplate: z.string().min(1),
    slugTemplate: z.string().min(1),
    adapter: z.literal("openreview-v2"),
    sourceIdTemplate: z.string().min(1),
    firstYear: z.number().int().min(2000).max(2100),
    activeMonthsUtc: z
      .array(z.number().int().min(1).max(12))
      .min(1)
      .refine((m) => new Set(m).size === m.length, "months must not contain duplicates"),
    countGate: CountGateSchema,
    tracks: TrackPolicySchema,
  })
  .strict();
export type Venue = z.infer<typeof VenueSchema>;

export const RegistryDefaultsSchema = z
  .object({
    probeIntervalHours: z.number().int().min(1).max(24),
    stableMinSeparationHours: z.number().int().min(1).max(168),
    stableMaxSeparationHours: z.number().int().min(1).max(336),
    maxFutureYears: z.number().int().min(0).max(1),
  })
  .strict()
  .refine((d) => d.stableMaxSeparationHours >= d.stableMinSeparationHours, {
    message: "stable_max_separation_hours must be >= minimum",
  });
export type RegistryDefaults = z.infer<typeof RegistryDefaultsSchema>;

export const ConferenceRegistrySchema = z
  .object({
    schemaVersion: z.literal("conference-sources-v1"),
    applyEnabled: z.boolean(),
    defaults: RegistryDefaultsSchema,
    venues: z.array(VenueSchema).min(1).max(32),
  })
  .strict();
export type ConferenceRegistry = z.infer<typeof ConferenceRegistrySchema>;

export const EditionSchema = z
  .object({
    editionId: z.string().regex(EDITION_RE),
    venueKey: z.string().regex(VENUE_KEY_RE),
    year: z.number().int().min(2000).max(2100),
    displayName: z.string().min(1).max(200),
    adapter: z.literal("openreview-v2"),
    sourceId: z.string().min(1).max(256),
    countGate: CountGateSchema,
    tracks: TrackPolicySchema,
    stableMinSeparationHours: z.number().int().min(1).max(168),
    stableMaxSeparationHours: z.number().int().min(1).max(336),
  })
  .strict()
  .refine((e) => e.editionId !== "daily", { message: "edition_id must not be the reserved slug" })
  .refine((e) => e.stableMaxSeparationHours >= e.stableMinSeparationHours, {
    message: "stable separation bounds must be ordered",
  });
export type Edition = z.infer<typeof EditionSchema>;

// ---------------------------------------------------------------------------
// NormalizedPaper / SourceSnapshot
// ---------------------------------------------------------------------------

export const NormalizedPaperSchema = z
  .object({
    source: z.literal("openreview"),
    sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
    paperId: z.string().regex(/^[0-9a-f]{40}$/),
    title: z.string().min(1).max(10_000),
    authors: z.array(z.string().min(1).max(1_000)).min(1).max(512),
    abstract: z.string().max(100_000),
    landingUrl: z.string().min(1).max(4_096),
    pdfUrl: z.string().min(1).max(4_096),
    decisionLabel: z.string().min(1).max(1_000),
  })
  .strict();
export type NormalizedPaper = z.infer<typeof NormalizedPaperSchema>;

/** Exactly the fields included in the source fingerprint (`fingerprintFields` equivalent). */
export function fingerprintFields(row: NormalizedPaper): Record<string, unknown> {
  return {
    source_id: row.sourceId,
    title: row.title,
    authors: [...row.authors],
    abstract: row.abstract,
    landing_url: row.landingUrl,
    pdf_url: row.pdfUrl,
    decision_label: row.decisionLabel,
  };
}

export const HASH_RE = /^[0-9a-f]{64}$/;

export const SourceSnapshotSchema = z
  .object({
    schemaVersion: z.literal("conference-source-snapshot-v1"),
    editionId: z.string().regex(EDITION_RE),
    adapter: z.literal("openreview-v2"),
    adapterVersion: z.string().min(1),
    sourceId: z.string().min(1).max(256),
    rows: z.array(NormalizedPaperSchema).min(1).max(25_000),
    sourceFingerprint: z.string().regex(HASH_RE),
    unknownDecisions: z.array(z.tuple([z.string(), z.number().int().min(1).max(25_000)])),
    duplicateTitleCount: z.number().int().min(0).max(24_999),
    requestCount: z.number().int().min(1).max(100),
    pageCount: z.number().int().min(1).max(25),
    responseBytes: z
      .number()
      .int()
      .min(0)
      .max(128 * 1024 * 1024),
  })
  .strict();
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;

export function acceptedCount(snapshot: SourceSnapshot): number {
  return snapshot.rows.length;
}

// ---------------------------------------------------------------------------
// DetectionResult (discriminated: a snapshot XOR a typed error/unavailable)
// ---------------------------------------------------------------------------

export type DetectionResult =
  | { kind: "snapshot"; snapshot: SourceSnapshot; errorCode: null }
  | { kind: "unavailable" | "error"; snapshot: null; errorCode: ErrorCode };

export function snapshotResult(snapshot: SourceSnapshot): DetectionResult {
  return { kind: "snapshot", snapshot, errorCode: null };
}
export function errorResult(kind: "unavailable" | "error", errorCode: ErrorCode): DetectionResult {
  return { kind, snapshot: null, errorCode };
}

// ---------------------------------------------------------------------------
// ProbeObservation / EditionState / reducer results
// ---------------------------------------------------------------------------

export const ObservationStatus = z.enum([
  "unavailable",
  "partial",
  "stabilizing",
  "anomaly",
  "failed",
]);
export type ObservationStatus = z.infer<typeof ObservationStatus>;

export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ProbeObservation {
  schemaVersion: "conference-probe-observation-v1";
  editionId: string;
  adapter: string;
  adapterVersion: string;
  sourceId: string;
  /** Always UTC. */
  observedAt: Date;
  runId: string;
  httpClass: "ok" | "unavailable" | "error";
  acceptedCount: number;
  unknownLabelCount: number;
  sourceFingerprint: string | null;
  sourceIds: readonly string[];
  status: ObservationStatus;
  errorCode: ErrorCode | null;
}

export const ReadinessPhase = z.enum([
  "unavailable",
  "partial",
  "stabilizing",
  "ready",
  "published",
  "anomaly",
]);
export type ReadinessPhase = z.infer<typeof ReadinessPhase>;

export interface EditionState {
  editionId: string;
  venueKey: string;
  year: number;
  phase: ReadinessPhase;
  lastObservation: ProbeObservation | null;
  stableFingerprint: string | null;
  stableObservations: number;
  stableSinceAt: Date | null;
  lastQualifyingAt: Date | null;
  lastQualifyingRunId: string | null;
  publishedFingerprint: string | null;
  publishedCount: number | null;
  publishedSourceIds: readonly string[];
  lastFailureCode: ErrorCode | null;
}

export function initialState(
  edition: Pick<Edition, "editionId" | "venueKey" | "year">,
): EditionState {
  return {
    editionId: edition.editionId,
    venueKey: edition.venueKey,
    year: edition.year,
    phase: "unavailable",
    lastObservation: null,
    stableFingerprint: null,
    stableObservations: 0,
    stableSinceAt: null,
    lastQualifyingAt: null,
    lastQualifyingRunId: null,
    publishedFingerprint: null,
    publishedCount: null,
    publishedSourceIds: [],
    lastFailureCode: null,
  };
}

export const ReductionAction = z.enum(["no_op", "observed", "ready", "anomaly", "failed"]);
export type ReductionAction = z.infer<typeof ReductionAction>;

export interface ReductionResult {
  state: EditionState;
  action: ReductionAction;
  reason: ErrorCode | null;
}

// Note: unlike Python's `public_dict` (a generic `dataclasses.asdict` +
// Enum/datetime/tuple conversion that works on ANY dataclass because
// Python preserves each dataclass's declared field names verbatim), this
// port's domain types use idiomatic TS camelCase field names, so there is
// no single generic "convert any domain value to its JSON shape"
// function here — each schema-shaped type gets its own explicit
// `xToJson` mapper (see `stability.ts`'s `probeObservationToJson` /
// `editionStateToJson`) that both renames fields to the schema's
// snake_case and formats `Date`s as `pyIsoformat`-equivalent strings.

/**
 * Pure probe classification and fixed two-observation readiness reduction
 * — TS port of `paperpilot/conference_watch/stability.py` (CNF-27/28/29).
 */

import { pyIsoformat, pyJsonDumps } from "@paperpilot/core";
import {
  type DetectionResult,
  type Edition,
  type EditionState,
  type ErrorCode,
  type ProbeObservation,
  type ReductionResult,
  RUN_ID_RE,
} from "./models.js";
import { STABLE_PROBE_COUNT } from "./registry.js";

/**
 * Port of the Python side's `value.isoformat().replace("+00:00", "Z")`.
 * `pyIsoformat` keeps Python's microsecond-field rule — omitted entirely
 * when the sub-second value is exactly 0, otherwise always a full 6-digit
 * `.ffffff` — rather than JS's native 3-digit millisecond text.
 */
function isoTimestamp(value: Date): string {
  return pyIsoformat(value).replace("+00:00", "Z");
}

/** `public_dict(observation)` equivalent: the exact snake_case shape `conference-probe-observation-v1` requires. */
export function probeObservationToJson(o: ProbeObservation): Record<string, unknown> {
  return {
    schema_version: o.schemaVersion,
    edition_id: o.editionId,
    adapter: o.adapter,
    adapter_version: o.adapterVersion,
    source_id: o.sourceId,
    observed_at: isoTimestamp(o.observedAt),
    run_id: o.runId,
    http_class: o.httpClass,
    accepted_count: o.acceptedCount,
    unknown_label_count: o.unknownLabelCount,
    source_fingerprint: o.sourceFingerprint,
    source_ids: [...o.sourceIds],
    status: o.status,
    error_code: o.errorCode,
  };
}

/** `public_dict(state)` equivalent: the exact snake_case shape `conference-release-state-v1`'s `editions[]` items require. */
export function editionStateToJson(s: EditionState): Record<string, unknown> {
  return {
    edition_id: s.editionId,
    venue_key: s.venueKey,
    year: s.year,
    phase: s.phase,
    last_observation: s.lastObservation ? probeObservationToJson(s.lastObservation) : null,
    stable_fingerprint: s.stableFingerprint,
    stable_observations: s.stableObservations,
    stable_since_at: s.stableSinceAt ? isoTimestamp(s.stableSinceAt) : null,
    last_qualifying_at: s.lastQualifyingAt ? isoTimestamp(s.lastQualifyingAt) : null,
    last_qualifying_run_id: s.lastQualifyingRunId,
    published_fingerprint: s.publishedFingerprint,
    published_count: s.publishedCount,
    published_source_ids: [...s.publishedSourceIds],
    last_failure_code: s.lastFailureCode,
  };
}

function toUtc(value: Date): Date {
  return value;
}

/** Classify one typed adapter result without mutating durable state — TS port of `observation_from_detection`. */
export function observationFromDetection(
  edition: Edition,
  result: DetectionResult,
  options: { observedAt: Date; runId: string; previousEditionCount?: number | null },
): ProbeObservation {
  const observedAt = toUtc(options.observedAt);
  if (!RUN_ID_RE.test(options.runId)) throw new RangeError("run_id is invalid");

  const previousEditionCount = options.previousEditionCount ?? null;
  if (previousEditionCount !== null) {
    if (!Number.isInteger(previousEditionCount))
      throw new RangeError("previous_edition_count_invalid");
    if (previousEditionCount < 0 || previousEditionCount > 25_000) {
      throw new RangeError("previous_edition_count_invalid");
    }
  }

  const common = {
    schemaVersion: "conference-probe-observation-v1" as const,
    editionId: edition.editionId,
    adapter: edition.adapter,
    adapterVersion: "1",
    sourceId: edition.sourceId,
    observedAt,
    runId: options.runId,
  };

  if (result.kind !== "snapshot") {
    if (result.kind === "unavailable") {
      return {
        ...common,
        httpClass: "unavailable",
        acceptedCount: 0,
        unknownLabelCount: 0,
        sourceFingerprint: null,
        sourceIds: [],
        status: "unavailable",
        errorCode: "CONF_SOURCE_UNAVAILABLE",
      };
    }
    return {
      ...common,
      httpClass: "error",
      acceptedCount: 0,
      unknownLabelCount: 0,
      sourceFingerprint: null,
      sourceIds: [],
      status: "failed",
      errorCode: result.errorCode,
    };
  }

  const snapshot = result.snapshot;
  const count = snapshot.rows.length;
  let effectiveMinimum = edition.countGate.minimumAbsolute;
  let effectiveMaximum: number | null = null;
  if (previousEditionCount !== null) {
    effectiveMinimum = Math.max(
      effectiveMinimum,
      Math.floor(previousEditionCount * edition.countGate.previousEditionMinRatio),
    );
    effectiveMaximum = Math.ceil(previousEditionCount * edition.countGate.previousEditionMaxRatio);
  }

  let status: ProbeObservation["status"] = "stabilizing";
  let errorCode: ErrorCode | null = null;
  if (count < effectiveMinimum) {
    status = "partial";
    errorCode = "CONF_COUNT_BELOW_MINIMUM";
  } else if (effectiveMaximum !== null && count > effectiveMaximum) {
    status = "anomaly";
    errorCode = "CONF_COUNT_ABOVE_MAXIMUM";
  }
  return {
    ...common,
    httpClass: "ok",
    acceptedCount: count,
    unknownLabelCount: snapshot.unknownDecisions.reduce((sum, [, amount]) => sum + amount, 0),
    sourceFingerprint: snapshot.sourceFingerprint,
    sourceIds: snapshot.rows.map((row) => row.sourceId),
    status,
    errorCode,
  };
}

/** Apply one observation with v1's immutable two-probe readiness rule — TS port of `reduce_readiness`. */
export function reduceReadiness(
  previous: EditionState,
  observation: ProbeObservation,
  edition: Edition,
): ReductionResult {
  if (previous.editionId !== edition.editionId || observation.editionId !== edition.editionId) {
    throw new RangeError("state, observation, and edition must have the same edition_id");
  }
  if (sameObservation(previous.lastObservation, observation)) {
    return { state: previous, action: "no_op", reason: null };
  }

  const updated: EditionState = { ...previous, lastObservation: observation };

  if (observation.status === "failed") {
    return {
      state: { ...updated, lastFailureCode: observation.errorCode },
      action: "failed",
      reason: observation.errorCode,
    };
  }

  if (observation.status === "unavailable") {
    const phase = previous.phase === "published" ? "published" : "unavailable";
    const keepPublished = phase === "published";
    return {
      state: {
        ...updated,
        phase,
        stableFingerprint: keepPublished ? previous.stableFingerprint : null,
        stableObservations: keepPublished ? previous.stableObservations : 0,
        stableSinceAt: keepPublished ? previous.stableSinceAt : null,
        lastQualifyingAt: keepPublished ? previous.lastQualifyingAt : null,
        lastQualifyingRunId: keepPublished ? previous.lastQualifyingRunId : null,
        lastFailureCode: null,
      },
      action: "observed",
      reason: null,
    };
  }

  // Every positive source snapshot must protect the published identity set
  // before count-gate classification can return `partial` or `anomaly`.
  if (observation.httpClass === "ok" && previous.publishedCount !== null) {
    if (observation.acceptedCount < previous.publishedCount) {
      const anomaly: EditionState = {
        ...updated,
        phase: "anomaly",
        stableFingerprint: null,
        stableObservations: 0,
        stableSinceAt: null,
        lastQualifyingAt: null,
        lastQualifyingRunId: null,
        lastFailureCode: "CONF_COUNT_SHRINK",
      };
      return { state: anomaly, action: "anomaly", reason: "CONF_COUNT_SHRINK" };
    }
    const publishedIds = new Set(previous.publishedSourceIds);
    const observedIds = new Set(observation.sourceIds);
    const subset = [...publishedIds].every((id) => observedIds.has(id));
    if (!subset) {
      const anomaly: EditionState = {
        ...updated,
        phase: "anomaly",
        stableFingerprint: null,
        stableObservations: 0,
        stableSinceAt: null,
        lastQualifyingAt: null,
        lastQualifyingRunId: null,
        lastFailureCode: "CONF_IDENTITY_CONFLICT",
      };
      return { state: anomaly, action: "anomaly", reason: "CONF_IDENTITY_CONFLICT" };
    }
  }

  if (observation.status === "partial") {
    const phase = previous.phase === "published" ? "published" : "partial";
    const keepPublished = phase === "published";
    return {
      state: {
        ...updated,
        phase,
        stableFingerprint: keepPublished ? previous.stableFingerprint : null,
        stableObservations: keepPublished ? previous.stableObservations : 0,
        stableSinceAt: keepPublished ? previous.stableSinceAt : null,
        lastQualifyingAt: keepPublished ? previous.lastQualifyingAt : null,
        lastQualifyingRunId: keepPublished ? previous.lastQualifyingRunId : null,
        lastFailureCode: null,
      },
      action: "observed",
      reason: observation.errorCode,
    };
  }
  if (observation.status === "anomaly") {
    return {
      state: {
        ...updated,
        phase: "anomaly",
        stableFingerprint: null,
        stableObservations: 0,
        stableSinceAt: null,
        lastQualifyingAt: null,
        lastQualifyingRunId: null,
        lastFailureCode: observation.errorCode,
      },
      action: "anomaly",
      reason: observation.errorCode,
    };
  }

  const fingerprint = observation.sourceFingerprint;
  if (fingerprint === null)
    throw new RangeError("successful observation must contain a fingerprint");
  if (previous.publishedFingerprint === fingerprint) {
    return {
      state: { ...updated, phase: "published", lastFailureCode: null },
      action: "no_op",
      reason: null,
    };
  }

  if (previous.stableFingerprint !== fingerprint) {
    const reset: EditionState = {
      ...updated,
      phase: "stabilizing",
      stableFingerprint: fingerprint,
      stableObservations: 1,
      stableSinceAt: observation.observedAt,
      lastQualifyingAt: observation.observedAt,
      lastQualifyingRunId: observation.runId,
      lastFailureCode: null,
    };
    const reason = previous.stableFingerprint !== null ? "CONF_SOURCE_FINGERPRINT_CHANGED" : null;
    return { state: reset, action: "observed", reason };
  }

  if (previous.phase === "ready") {
    return {
      state: { ...updated, phase: "ready", lastFailureCode: null },
      action: "no_op",
      reason: null,
    };
  }

  if (previous.lastQualifyingRunId === observation.runId) {
    // `previous.phase === "ready"` was already excluded above (the function
    // returned early in that case), so only PUBLISHED needs to survive here
    // — matching Python's `previous.phase in {READY, PUBLISHED}` check,
    // which is equivalently redundant by this point in the Python source too.
    const phase = previous.phase === "published" ? previous.phase : "stabilizing";
    return { state: { ...updated, phase, lastFailureCode: null }, action: "no_op", reason: null };
  }
  if (previous.lastQualifyingAt === null) {
    throw new RangeError("stable fingerprint is missing its qualifying timestamp");
  }
  const separationHours =
    (observation.observedAt.getTime() - previous.lastQualifyingAt.getTime()) / 3_600_000;
  if (separationHours < 0) throw new RangeError("observations must not move backwards in time");
  if (separationHours < edition.stableMinSeparationHours) {
    // `previous.phase === "ready"` was already excluded above (the function
    // returned early in that case), so only PUBLISHED needs to survive here
    // — matching Python's `previous.phase in {READY, PUBLISHED}` check,
    // which is equivalently redundant by this point in the Python source too.
    const phase = previous.phase === "published" ? previous.phase : "stabilizing";
    return { state: { ...updated, phase, lastFailureCode: null }, action: "no_op", reason: null };
  }
  if (separationHours > edition.stableMaxSeparationHours) {
    const reset: EditionState = {
      ...updated,
      phase: "stabilizing",
      stableObservations: 1,
      stableSinceAt: observation.observedAt,
      lastQualifyingAt: observation.observedAt,
      lastQualifyingRunId: observation.runId,
      lastFailureCode: null,
    };
    return { state: reset, action: "observed", reason: null };
  }

  const count = Math.min(STABLE_PROBE_COUNT, previous.stableObservations + 1);
  const phase: EditionState["phase"] = count === STABLE_PROBE_COUNT ? "ready" : "stabilizing";
  const action: ReductionResult["action"] = phase === "ready" ? "ready" : "observed";
  return {
    state: {
      ...updated,
      phase,
      stableObservations: count,
      lastQualifyingAt: observation.observedAt,
      lastQualifyingRunId: observation.runId,
      lastFailureCode: null,
    },
    action,
    reason: null,
  };
}

function sameObservation(a: ProbeObservation | null, b: ProbeObservation): boolean {
  if (a === null) return false;
  return (
    a.schemaVersion === b.schemaVersion &&
    a.editionId === b.editionId &&
    a.adapter === b.adapter &&
    a.adapterVersion === b.adapterVersion &&
    a.sourceId === b.sourceId &&
    a.observedAt.getTime() === b.observedAt.getTime() &&
    a.runId === b.runId &&
    a.httpClass === b.httpClass &&
    a.acceptedCount === b.acceptedCount &&
    a.unknownLabelCount === b.unknownLabelCount &&
    a.sourceFingerprint === b.sourceFingerprint &&
    a.sourceIds.length === b.sourceIds.length &&
    a.sourceIds.every((id, i) => id === b.sourceIds[i]) &&
    a.status === b.status &&
    a.errorCode === b.errorCode
  );
}

/** Serialize reducer state deterministically for compare-and-swap candidates — TS port of `canonical_state_bytes`. */
export function canonicalStateBytes(state: EditionState): Buffer {
  const payload = {
    schema_version: "conference-release-state-v1",
    editions: [editionStateToJson(state)],
  };
  const text = pyJsonDumps(payload, { ensureAscii: false, sortKeys: true, separators: [",", ":"] });
  return Buffer.from(`${text}\n`, "utf-8");
}

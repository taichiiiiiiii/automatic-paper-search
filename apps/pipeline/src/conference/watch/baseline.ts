/**
 * Pure, bounded previous-edition checks; never a publication authorization
 * — TS port of `paperpilot/conference_watch/baseline.py` (CNF-36, and the
 * previous-edition half of CNF-32). Caller-supplied values are
 * revalidated just like transport input; catalog and snapshot rules are
 * reused rather than weakened for the ratio assessment.
 */

import { createHash } from "node:crypto";
import { validateCandidateSnapshot, validateEdition } from "./candidate.js";
import { canonicalJsonBytes } from "./canonicalJson.js";
import { MAX_ROWS, validateCatalog } from "./dryRun.js";
import {
  type ConferenceRegistry,
  ConferenceRegistrySchema,
  type Edition,
  type EditionState,
  HASH_RE,
  type SourceSnapshot,
} from "./models.js";
import { buildEdition, MAX_REGISTRY_BYTES, parseRegistry } from "./registry.js";

const SOURCE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

const ERROR_CODES = new Set(
  [
    "INPUT_INVALID",
    "REGISTRY_INVALID",
    "EDITION_MISMATCH",
    "FIRST_EDITION",
    "STATE_INVALID",
    "CATALOG_INVALID",
    "CATALOG_MISMATCH",
    "SNAPSHOT_INVALID",
  ].map((suffix) => `CONF_BASELINE_${suffix}`),
);

export class PreviousEditionRatioAssessmentError extends Error {
  readonly code: string;
  constructor(code: string) {
    const safeCode = ERROR_CODES.has(code) ? code : "CONF_BASELINE_INPUT_INVALID";
    super(safeCode);
    this.code = safeCode;
  }
}

function fail(suffix: string): never {
  throw new PreviousEditionRatioAssessmentError(`CONF_BASELINE_${suffix}`);
}

function wrap<T>(suffix: string, body: () => T): T {
  try {
    return body();
  } catch (e) {
    if (e instanceof PreviousEditionRatioAssessmentError) throw e;
    return fail(suffix);
  }
}

/** Revalidate a caller-supplied registry by reconstructing it from its own closed fields — TS port of `_validated_registry`. */
function validatedRegistry(registry: ConferenceRegistry): ConferenceRegistry {
  return wrap("REGISTRY_INVALID", () => {
    const raw = {
      schema_version: registry.schemaVersion,
      apply_enabled: registry.applyEnabled,
      defaults: {
        probe_interval_hours: registry.defaults.probeIntervalHours,
        stable_min_separation_hours: registry.defaults.stableMinSeparationHours,
        stable_max_separation_hours: registry.defaults.stableMaxSeparationHours,
        max_future_years: registry.defaults.maxFutureYears,
      },
      venues: registry.venues.map((venue) => ({
        venue_key: venue.venueKey,
        enabled: venue.enabled,
        curated_class: venue.curatedClass,
        display_template: venue.displayTemplate,
        slug_template: venue.slugTemplate,
        adapter: venue.adapter,
        source_id_template: venue.sourceIdTemplate,
        first_year: venue.firstYear,
        active_months_utc: [...venue.activeMonthsUtc],
        count_gate: {
          minimum_absolute: venue.countGate.minimumAbsolute,
          previous_edition_min_ratio: venue.countGate.previousEditionMinRatio,
          previous_edition_max_ratio: venue.countGate.previousEditionMaxRatio,
        },
        tracks: {
          accepted_only: venue.tracks.acceptedOnly,
          accepted_decision_labels: [...venue.tracks.acceptedDecisionLabels],
          highlighted_labels: [...venue.tracks.highlightedLabels],
        },
      })),
    };
    if (canonicalJsonBytes(raw).length > MAX_REGISTRY_BYTES)
      throw new RangeError("registry too large");
    const validated = parseRegistry(raw);
    if (JSON.stringify(ConferenceRegistrySchema.parse(validated)) !== JSON.stringify(registry)) {
      throw new RangeError("registry round-trip mismatch");
    }
    return validated;
  });
}

interface ValidatedPreviousBaseline {
  previousEditionId: string;
  previousYear: number;
  previousCount: number;
  publishedFingerprint: string;
  previousCatalogSha256: string;
}

function validatePreviousBaseline(
  registry: ConferenceRegistry,
  edition: Edition,
  previousState: EditionState,
  previousCatalogBytes: Buffer,
): ValidatedPreviousBaseline {
  const validatedReg = validatedRegistry(registry);
  const venue = wrap("EDITION_MISMATCH", () => {
    validateEdition(edition);
    const matches = validatedReg.venues.filter((v) => v.venueKey === edition.venueKey);
    if (matches.length !== 1) throw new RangeError("no unique matching venue");
    const candidateVenue = matches[0];
    if (!candidateVenue) throw new RangeError("no unique matching venue");
    const rebuilt = buildEdition(validatedReg, candidateVenue, edition.year, edition.year);
    if (JSON.stringify(rebuilt) !== JSON.stringify(edition))
      throw new RangeError("edition mismatch");
    return candidateVenue;
  });
  if (edition.year === venue.firstYear) fail("FIRST_EDITION");
  const previous = buildEdition(validatedReg, venue, edition.year - 1, edition.year);

  const { count, ids, fingerprint } = wrap("STATE_INVALID", () => {
    if (
      previousState.editionId !== previous.editionId ||
      previousState.venueKey !== previous.venueKey ||
      previousState.year !== previous.year ||
      previousState.phase !== "published"
    ) {
      throw new RangeError("previous state is not a matching published state");
    }
    const publishedCount = previousState.publishedCount;
    if (publishedCount === null || !(publishedCount >= 1 && publishedCount <= MAX_ROWS)) {
      throw new RangeError("invalid published_count");
    }
    const publishedIds = previousState.publishedSourceIds;
    if (publishedIds.length !== publishedCount || new Set(publishedIds).size !== publishedCount) {
      throw new RangeError("invalid published_source_ids");
    }
    if (publishedIds.some((id) => !SOURCE_ID_RE.test(id)))
      throw new RangeError("invalid published_source_ids");
    const fp = previousState.publishedFingerprint;
    if (fp === null || !HASH_RE.test(fp)) throw new RangeError("invalid published_fingerprint");
    return { count: publishedCount, ids: publishedIds, fingerprint: fp };
  });

  let rows: Record<string, unknown>[];
  try {
    rows = validateCatalog(previousCatalogBytes, "previous_catalog");
  } catch {
    return fail("CATALOG_INVALID");
  }
  const rowSourceIds = new Set(rows.map((row) => String(row.source_id)));
  if (
    rows.length !== count ||
    rowSourceIds.size !== new Set(ids).size ||
    ![...ids].every((id) => rowSourceIds.has(id))
  ) {
    fail("CATALOG_MISMATCH");
  }

  return {
    previousEditionId: previous.editionId,
    previousYear: previous.year,
    previousCount: count,
    publishedFingerprint: fingerprint,
    previousCatalogSha256: createHash("sha256").update(previousCatalogBytes).digest("hex"),
  };
}

export interface PreviousEditionRatioAssessment {
  status: "passed" | "below_minimum" | "above_maximum";
  previousEditionId: string;
  previousYear: number;
  previousCount: number;
  currentCount: number;
  effectiveMinimum: number;
  effectiveMaximum: number;
  previousCatalogSha256: string;
  publishedFingerprint: string;
  currentSourceFingerprint: string;
  reportBytes: Buffer;
}

/**
 * Revalidate bounded caller inputs and calculate inclusive count bounds —
 * TS port of `assess_previous_edition_ratio`. Performs no I/O or state
 * changes. A `passed` result does not grant readiness, provenance,
 * staging, promotion, or publication authority (CNF-36).
 */
export function assessPreviousEditionRatio(
  registry: ConferenceRegistry,
  edition: Edition,
  snapshot: SourceSnapshot,
  previousState: EditionState,
  options: { previousCatalogBytes: Buffer },
): PreviousEditionRatioAssessment {
  const previous = validatePreviousBaseline(
    registry,
    edition,
    previousState,
    options.previousCatalogBytes,
  );
  let currentCount: number;
  try {
    const { rows } = validateCandidateSnapshot(edition, snapshot);
    currentCount = rows.length;
  } catch {
    return fail("SNAPSHOT_INVALID");
  }
  const minimum = Math.max(
    edition.countGate.minimumAbsolute,
    Math.floor(previous.previousCount * edition.countGate.previousEditionMinRatio),
  );
  const maximum = Math.ceil(previous.previousCount * edition.countGate.previousEditionMaxRatio);
  let status: PreviousEditionRatioAssessment["status"] = "passed";
  if (currentCount < minimum) status = "below_minimum";
  else if (currentCount > maximum) status = "above_maximum";

  const report = {
    schema_version: "conference-baseline-assessment-v1",
    scope: "local_assessment_only",
    edition_id: edition.editionId,
    venue_key: edition.venueKey,
    year: edition.year,
    status,
    previous_edition_id: previous.previousEditionId,
    previous_year: previous.previousYear,
    previous_count: previous.previousCount,
    current_count: currentCount,
    effective_minimum: minimum,
    effective_maximum: maximum,
    previous_catalog_sha256: previous.previousCatalogSha256,
    published_fingerprint: previous.publishedFingerprint,
    current_source_fingerprint: snapshot.sourceFingerprint,
    authority: {
      trusted_persistent_state_proof: false,
      baseline_state_trusted: false,
      fresh_tip_checked: false,
      staging_materialized: false,
      promotion_authorized: false,
      publication_authorized: false,
    },
  };
  return {
    status,
    previousEditionId: previous.previousEditionId,
    previousYear: previous.previousYear,
    previousCount: previous.previousCount,
    currentCount,
    effectiveMinimum: minimum,
    effectiveMaximum: maximum,
    previousCatalogSha256: previous.previousCatalogSha256,
    publishedFingerprint: previous.publishedFingerprint,
    currentSourceFingerprint: snapshot.sourceFingerprint,
    reportBytes: canonicalJsonBytes(report),
  };
}

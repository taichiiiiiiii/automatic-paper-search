/**
 * lineage-quality-v2 single-row shape validation -- ported 1:1 from
 * docs/assets/lineage-v2-core.js `validQualityShape`
 * (safety-contracts.md SCR-47). The pilot profile publishes exactly
 * one `deep` collection row per quality.json, already `ready`+`passed`
 * with every required check name present and `passed` -- there is no
 * "maybe eligible" state for this contract; `release.ts` binds the
 * row's counts to the artifact it accompanies on top of this.
 */
import {
  ARTIFACT_VERSION,
  type CheckStatus,
  PILOT_PROFILE,
  QUALITY_VERSION,
  SHA_RE,
  SLUG_RE,
  STATUS,
} from "./constants";
import { exactKeys, nonnegativeInteger, record, text, unitNumber } from "./json";
import { validTimestamp } from "./time";
import type { LineageV2Quality } from "./types";
import { safeJsonPath } from "./url-alias";

const REQUIRED_CHECKS = new Set([
  "artifact_contract_v2",
  "identity",
  "evidence_binding",
  "review_binding",
  "accepted_dag",
  "accepted_temporal",
  "frozen_candidate_ledger",
]);

export function validQualityShape(quality: unknown): quality is LineageV2Quality {
  if (
    !record(quality) ||
    !exactKeys(quality, ["schema_version", "audit_version", "as_of", "collections"]) ||
    quality.schema_version !== QUALITY_VERSION ||
    quality.audit_version !== "audit-v2" ||
    !validTimestamp(quality.as_of) ||
    !Array.isArray(quality.collections) ||
    quality.collections.length !== 1
  ) {
    return false;
  }
  const row = quality.collections[0];
  if (
    !record(row) ||
    !exactKeys(row, [
      "collection_id",
      "kind",
      "slug",
      "label",
      "path",
      "release_id",
      "release_profile",
      "availability",
      "audit_status",
      "artifact_schema_version",
      "artifact_sha256",
      "fixture_sha256",
      "node_count",
      "link_count",
      "claim_decision_count",
      "accepted_genealogy_count",
      "accepted_comparison_count",
      "decision_counts",
      "calibration",
      "review",
      "checks",
    ])
  ) {
    return false;
  }
  if (
    !text(row.collection_id) ||
    row.kind !== "deep" ||
    typeof row.slug !== "string" ||
    !SLUG_RE.test(row.slug) ||
    !text(row.label) ||
    !safeJsonPath(row.path) ||
    !(row.path as string).split("/").includes(row.slug) ||
    !text(row.release_id) ||
    row.release_profile !== PILOT_PROFILE ||
    row.availability !== "ready" ||
    row.audit_status !== "passed" ||
    row.artifact_schema_version !== ARTIFACT_VERSION ||
    !SHA_RE.test(String(row.artifact_sha256)) ||
    !SHA_RE.test(String(row.fixture_sha256)) ||
    ![
      row.node_count,
      row.link_count,
      row.claim_decision_count,
      row.accepted_genealogy_count,
      row.accepted_comparison_count,
    ].every(nonnegativeInteger)
  ) {
    return false;
  }
  if (
    !record(row.decision_counts) ||
    !exactKeys(row.decision_counts, ["accepted", "unknown", "abstained", "rejected"]) ||
    !Object.values(row.decision_counts).every(nonnegativeInteger) ||
    Object.values(row.decision_counts).reduce(
      (sum: number, value) => sum + (value as number),
      0,
    ) !== row.claim_decision_count
  ) {
    return false;
  }
  const calibrationKeys = [
    "status",
    "reason",
    "sample_count",
    "wilson_lower_bound",
    "supersedes_wilson_lower_bound",
    "macro_precision",
    "ece",
    "brier",
    "accepted_coverage",
    "unknown_abstained_recall",
  ] as const;
  if (
    !record(row.calibration) ||
    !exactKeys(row.calibration, calibrationKeys) ||
    row.calibration.status !== "not_applicable" ||
    !text(row.calibration.reason) ||
    !nonnegativeInteger(row.calibration.sample_count) ||
    calibrationKeys
      .slice(3)
      .some((key) => !unitNumber((row.calibration as Record<string, unknown>)[key]))
  ) {
    return false;
  }
  if (
    !record(row.review) ||
    !exactKeys(row.review, ["status", "reviewed_claim_count", "agreement", "fixture_id"]) ||
    row.review.status !== "passed" ||
    !nonnegativeInteger(row.review.reviewed_claim_count) ||
    !unitNumber(row.review.agreement) ||
    !text(row.review.fixture_id)
  ) {
    return false;
  }
  if (!Array.isArray(row.checks) || row.checks.length === 0) return false;
  const seen = new Set<string>();
  for (const check of row.checks) {
    if (
      !record(check) ||
      !exactKeys(check, ["name", "status", "detail"]) ||
      !text(check.name) ||
      !STATUS.has(check.status as CheckStatus) ||
      typeof check.detail !== "string" ||
      check.status !== "passed" ||
      seen.has(check.name)
    ) {
      return false;
    }
    seen.add(check.name);
  }
  return [...REQUIRED_CHECKS].every((name) => seen.has(name));
}

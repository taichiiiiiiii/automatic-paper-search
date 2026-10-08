/**
 * lineage-audit-fixtures-v2 validation -- ported 1:1 from
 * docs/assets/lineage-v2-core.js `validGold`/`validateReview`/
 * `validateAdjudication`/`validateFixture`/`cohenKappa`
 * (safety-contracts.md SCR-47). Enforces the double-blind review
 * shape: exactly two reviews per edge label from two DISTINCT
 * reviewers who are not the adjudicator, a single consistent panel
 * (the same two reviewer IDs) across every edge label in a
 * collection, adjudication no earlier than the latest review, and --
 * when both reviewers already agree -- the adjudication must repeat
 * their agreed values rather than silently overriding them.
 */

import type { EvidenceSupport } from "./constants";
import { COMPARISON, FIXTURE_VERSION, GENEALOGY, RELATIONS, SHA_RE, SUPPORT } from "./constants";
import { exactKeys, nonnegativeInteger, record, text } from "./json";
import { timestampValue, validTimestamp } from "./time";
import type {
  FixtureAdjudication,
  FixtureCollection,
  FixtureEdgeLabel,
  FixtureReview,
  LineageV2Fixture,
} from "./types";

type Gold = Pick<FixtureReview, "gold_family" | "gold_relation">;

function validGold(value: Gold): boolean {
  const family = value.gold_family;
  const relation = value.gold_relation;
  if (
    !(family === null || family === "genealogy" || family === "comparison") ||
    !(relation === null || RELATIONS.has(relation)) ||
    (family === null) !== (relation === null)
  ) {
    return false;
  }
  return relation === null || (family === "genealogy" ? GENEALOGY : COMPARISON).has(relation);
}

function validateReview(value: unknown): value is FixtureReview {
  if (
    !record(value) ||
    !exactKeys(value, [
      "reviewer_id",
      "blind_to_model",
      "blind_to_peer",
      "citation_valid",
      "gold_family",
      "gold_relation",
      "evidence_support",
      "notes",
      "reviewed_at",
    ])
  ) {
    return false;
  }
  return (
    text(value.reviewer_id) &&
    value.blind_to_model === true &&
    value.blind_to_peer === true &&
    typeof value.citation_valid === "boolean" &&
    SUPPORT.has(value.evidence_support as EvidenceSupport) &&
    typeof value.notes === "string" &&
    validTimestamp(value.reviewed_at) &&
    validGold(value as unknown as Gold)
  );
}

function validateAdjudication(value: unknown): value is FixtureAdjudication {
  if (
    !record(value) ||
    !exactKeys(value, [
      "adjudicator_id",
      "citation_valid",
      "gold_family",
      "gold_relation",
      "evidence_support",
      "notes",
      "reviewed_at",
    ])
  ) {
    return false;
  }
  return (
    text(value.adjudicator_id) &&
    typeof value.citation_valid === "boolean" &&
    SUPPORT.has(value.evidence_support as EvidenceSupport) &&
    typeof value.notes === "string" &&
    validTimestamp(value.reviewed_at) &&
    validGold(value as unknown as Gold)
  );
}

/** Cohen's kappa for a list of `[left, right]` category pairs (null
 * when there are no pairs, or when the expected-agreement denominator
 * is degenerate -- both mirror the JS exactly, including the
 * `Math.abs(expected - 1) <= 1e-12` guard against dividing by ~0). */
export function cohenKappa(pairs: Array<[unknown, unknown]>): number | null {
  if (pairs.length === 0) return null;
  const first = new Map<unknown, number>();
  const second = new Map<unknown, number>();
  let agreements = 0;
  for (const [left, right] of pairs) {
    first.set(left, (first.get(left) ?? 0) + 1);
    second.set(right, (second.get(right) ?? 0) + 1);
    if (left === right) agreements++;
  }
  const categories = new Set([...first.keys(), ...second.keys()]);
  const total = pairs.length;
  let expected = 0;
  for (const category of categories) {
    expected += (first.get(category) ?? 0) * (second.get(category) ?? 0);
  }
  expected /= total * total;
  if (Math.abs(expected - 1) <= 1e-12) return null;
  return (agreements / total - expected) / (1 - expected);
}

/**
 * Validates a full lineage-audit-fixtures-v2 payload: one entry per
 * collection (no duplicate `collection_id`/`review_id`), focus labels
 * keyed by unique `node_id`, exactly one `edge_labels` row per
 * candidate (`candidate_count`-sized), unique `(src, dst,
 * evidence_sha256)` identities, a consistent 2-reviewer panel that
 * excludes the adjudicator, adjudication timed at/after the later
 * review, and -- when the two reviews already agree on every
 * confirmation field -- the adjudication must match them rather than
 * override an agreed call.
 */
export function validateFixture(fixture: unknown): fixture is LineageV2Fixture {
  if (
    !record(fixture) ||
    !exactKeys(fixture, ["schema_version", "fixture_id", "created_at", "collections"]) ||
    fixture.schema_version !== FIXTURE_VERSION ||
    !text(fixture.fixture_id) ||
    !validTimestamp(fixture.created_at) ||
    !Array.isArray(fixture.collections)
  ) {
    return false;
  }
  const collectionIds = new Set<string>();
  const reviewIds = new Set<string>();
  for (const rawCollection of fixture.collections) {
    if (
      !record(rawCollection) ||
      !exactKeys(rawCollection, [
        "collection_id",
        "release_id",
        "artifact_sha256",
        "candidate_universe",
        "focus_labels",
        "edge_labels",
      ])
    ) {
      return false;
    }
    const collection = rawCollection as unknown as FixtureCollection;
    if (
      !text(collection.collection_id) ||
      collectionIds.has(collection.collection_id) ||
      !text(collection.release_id) ||
      !SHA_RE.test(collection.artifact_sha256) ||
      !record(collection.candidate_universe) ||
      !exactKeys(collection.candidate_universe, [
        "snapshot_ref",
        "input_sha256",
        "selection_method",
        "candidate_count",
      ]) ||
      !text(collection.candidate_universe.snapshot_ref) ||
      !SHA_RE.test(collection.candidate_universe.input_sha256) ||
      !text(collection.candidate_universe.selection_method) ||
      !nonnegativeInteger(collection.candidate_universe.candidate_count) ||
      !Array.isArray(collection.focus_labels) ||
      collection.focus_labels.length === 0 ||
      !Array.isArray(collection.edge_labels) ||
      collection.edge_labels.length !== collection.candidate_universe.candidate_count
    ) {
      return false;
    }
    collectionIds.add(collection.collection_id);
    const focusIds = new Set<string>();
    for (const label of collection.focus_labels) {
      if (
        !record(label) ||
        !exactKeys(label, ["node_id", "on_topic"]) ||
        !text(label.node_id) ||
        typeof label.on_topic !== "boolean" ||
        focusIds.has(label.node_id)
      ) {
        return false;
      }
      focusIds.add(label.node_id);
    }
    const candidates = new Set<string>();
    let panel: string | null = null;
    for (const rawLabel of collection.edge_labels) {
      if (
        !record(rawLabel) ||
        !exactKeys(rawLabel, [
          "review_id",
          "collection_id",
          "src",
          "dst",
          "evidence_sha256",
          "reviews",
          "adjudication",
        ])
      ) {
        return false;
      }
      const label = rawLabel as unknown as FixtureEdgeLabel;
      if (
        !text(label.review_id) ||
        reviewIds.has(label.review_id) ||
        label.collection_id !== collection.collection_id ||
        !text(label.src) ||
        !text(label.dst) ||
        !SHA_RE.test(label.evidence_sha256) ||
        !Array.isArray(label.reviews) ||
        label.reviews.length !== 2 ||
        !label.reviews.every(validateReview) ||
        !validateAdjudication(label.adjudication)
      ) {
        return false;
      }
      reviewIds.add(label.review_id);
      const identity = `${label.src}\u0000${label.dst}\u0000${label.evidence_sha256}`;
      if (candidates.has(identity)) return false;
      candidates.add(identity);
      const reviewers = label.reviews.map((review) => review.reviewer_id).sort();
      if (reviewers[0] === reviewers[1] || reviewers.includes(label.adjudication.adjudicator_id))
        return false;
      const panelKey = reviewers.join("\u0000");
      if (panel === null) panel = panelKey;
      else if (panel !== panelKey) return false;
      const reviewTimes = label.reviews.map(
        (review) => timestampValue(review.reviewed_at) as bigint,
      );
      const latestReview = reviewTimes.reduce((left, right) => (left > right ? left : right));
      if ((timestampValue(label.adjudication.reviewed_at) as bigint) < latestReview) return false;
      const confirmationFields = [
        "citation_valid",
        "gold_family",
        "gold_relation",
        "evidence_support",
      ] as const;
      const [reviewA, reviewB] = label.reviews;
      const agreed = confirmationFields.every((field) => reviewA[field] === reviewB[field]);
      if (
        agreed &&
        confirmationFields.some((field) => label.adjudication[field] !== reviewA[field])
      ) {
        return false;
      }
    }
  }
  return true;
}

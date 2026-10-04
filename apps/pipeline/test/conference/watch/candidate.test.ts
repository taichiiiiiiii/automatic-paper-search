/**
 * Port of `test_conference_watch_candidate.py` (CNF-31/33,
 * docs/migration/safety-contracts.md). Builds a real READY `EditionState`
 * + `SourceSnapshot` via `openreview.ts`/`stability.ts` (rather than
 * hand-building every dataclass field) so the happy path is an
 * integration check across the whole watch pipeline, then tampers with
 * individual fields to exercise each rejection.
 */
import { describe, expect, it } from "vitest";
import {
  buildCatalogCandidate,
  CandidateValidationError,
  validateCandidateSnapshot,
  validateEdition,
} from "../../../src/conference/watch/candidate.js";
import {
  type Edition,
  initialState,
  makeFetchLimits,
} from "../../../src/conference/watch/models.js";
import {
  OpenReviewV2Adapter,
  type StrictTransport,
} from "../../../src/conference/watch/openreview.js";
import {
  observationFromDetection,
  reduceReadiness,
} from "../../../src/conference/watch/stability.js";

const EDITION: Edition = {
  editionId: "iclr-2026",
  venueKey: "iclr",
  year: 2026,
  displayName: "ICLR 2026",
  adapter: "openreview-v2",
  sourceId: "ICLR.cc/2026/Conference",
  countGate: { minimumAbsolute: 1, previousEditionMinRatio: 0.5, previousEditionMaxRatio: 2.0 },
  tracks: {
    acceptedOnly: true,
    acceptedDecisionLabels: ["accept", "reject"],
    highlightedLabels: ["accept"],
  },
  stableMinSeparationHours: 12,
  stableMaxSeparationHours: 72,
};

function note(id: string, venue: string) {
  return {
    id,
    content: {
      venueid: { value: EDITION.sourceId },
      title: { value: `Title ${id}` },
      authors: { value: ["A One", "B Two"] },
      abstract: { value: "An abstract about machine learning." },
      venue: { value: venue },
    },
  };
}

async function readySnapshotAndState() {
  const notes = [note("n1", "accept"), note("n2", "reject")];
  const transport: StrictTransport = {
    get: async () => ({
      statusCode: 200,
      content: Buffer.from(JSON.stringify({ notes, count: notes.length })),
      requestCount: 1,
    }),
  };
  const adapter = new OpenReviewV2Adapter({ transport });
  const limits = makeFetchLimits();
  const result = await adapter.collect(EDITION, limits);
  if (result.kind !== "snapshot") throw new Error("expected a snapshot");
  const snapshot = result.snapshot;

  let state = initialState(EDITION);
  const obs1 = observationFromDetection(EDITION, result, {
    observedAt: new Date("2026-01-01T00:00:00Z"),
    runId: "run-1",
  });
  state = reduceReadiness(state, obs1, EDITION).state;
  const obs2 = observationFromDetection(EDITION, result, {
    observedAt: new Date("2026-01-02T00:00:00Z"),
    runId: "run-2",
  });
  const r2 = reduceReadiness(state, obs2, EDITION);
  expect(r2.state.phase).toBe("ready");
  return { snapshot, readiness: r2.state };
}

describe("validateCandidateSnapshot / buildCatalogCandidate (CNF-31/33)", () => {
  it("builds deterministic candidate bytes from a real READY state", async () => {
    const { snapshot, readiness } = await readySnapshotAndState();
    const candidate1 = buildCatalogCandidate(EDITION, readiness, snapshot);
    const candidate2 = buildCatalogCandidate(EDITION, readiness, snapshot);
    expect(candidate1.catalogRowsBytes.equals(candidate2.catalogRowsBytes)).toBe(true);
    expect(candidate1.rows).toHaveLength(2);
    expect(candidate1.rows.every((r) => r.source === "openreview")).toBe(true);
    expect(candidate1.runBindingBytes.toString("utf-8")).not.toContain("true"); // all authority flags false
  });

  it("CNF-31: rejects a readiness state that is not READY", async () => {
    const { snapshot, readiness } = await readySnapshotAndState();
    const notReady = { ...readiness, phase: "stabilizing" as const };
    expect(() => buildCatalogCandidate(EDITION, notReady, snapshot)).toThrow(
      CandidateValidationError,
    );
  });

  it("CNF-31: rejects a snapshot whose recomputed fingerprint does not match its header", async () => {
    const { snapshot } = await readySnapshotAndState();
    const tampered = { ...snapshot, sourceFingerprint: "f".repeat(64) };
    expect(() => validateCandidateSnapshot(EDITION, tampered)).toThrow(CandidateValidationError);
  });

  it("CNF-31: rejects a forged row identity (paper_id does not match source_id)", async () => {
    const { snapshot, readiness } = await readySnapshotAndState();
    const forgedRow = { ...snapshot.rows[0]!, paperId: "0".repeat(40) };
    const forged = { ...snapshot, rows: [forgedRow, ...snapshot.rows.slice(1)] };
    expect(() => validateCandidateSnapshot(EDITION, forged)).toThrow(CandidateValidationError);
    void readiness;
  });

  it("CNF-31: rejects a duplicate source_id across rows", async () => {
    const { snapshot } = await readySnapshotAndState();
    const dupRow = {
      ...snapshot.rows[1]!,
      sourceId: snapshot.rows[0]!.sourceId,
      paperId: snapshot.rows[0]!.paperId,
    };
    const dup = { ...snapshot, rows: [snapshot.rows[0]!, dupRow] };
    expect(() => validateCandidateSnapshot(EDITION, dup)).toThrow(CandidateValidationError);
  });

  it("CNF-33: rejects a malformed edition (non-matching adapter)", async () => {
    const { snapshot, readiness } = await readySnapshotAndState();
    const badEdition = { ...EDITION, adapter: "something-else" as never };
    expect(() => buildCatalogCandidate(badEdition, readiness, snapshot)).toThrow(
      CandidateValidationError,
    );
  });

  it("CNF-33: rejects a malformed nested edition value (min ratio > max ratio)", () => {
    const badEdition: Edition = {
      ...EDITION,
      countGate: { ...EDITION.countGate, previousEditionMinRatio: 5, previousEditionMaxRatio: 1 },
    };
    expect(() => validateEdition(badEdition)).toThrow(CandidateValidationError);
  });
});

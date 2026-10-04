/**
 * Port of `paperpilot/tests/test_conference_watch_stability.py` /
 * `test_conference_count_validation.py` (CNF-27/28/29/30,
 * docs/migration/safety-contracts.md). Outputs are validated against the
 * real `schemas/conference-*.schema.json` files via `@paperpilot/core`.
 */
import { validateArtifact } from "@paperpilot/core";
import { describe, expect, it } from "vitest";
import { sourceFingerprint } from "../../../src/conference/watch/fingerprint.js";
import {
  type DetectionResult,
  type Edition,
  initialState,
  type NormalizedPaper,
  type SourceSnapshot,
} from "../../../src/conference/watch/models.js";
import {
  canonicalStateBytes,
  editionStateToJson,
  observationFromDetection,
  probeObservationToJson,
  reduceReadiness,
} from "../../../src/conference/watch/stability.js";

const EDITION: Edition = {
  editionId: "iclr-2026",
  venueKey: "iclr",
  year: 2026,
  displayName: "ICLR 2026",
  adapter: "openreview-v2",
  sourceId: "ICLR.cc/2026/Conference",
  countGate: { minimumAbsolute: 2, previousEditionMinRatio: 0.5, previousEditionMaxRatio: 2.0 },
  tracks: {
    acceptedOnly: true,
    acceptedDecisionLabels: ["accept", "reject"],
    highlightedLabels: ["accept"],
  },
  stableMinSeparationHours: 12,
  stableMaxSeparationHours: 72,
};

function makeRow(sourceId: string): NormalizedPaper {
  return {
    source: "openreview",
    sourceId,
    paperId: sourceId.padStart(40, "0"),
    title: `Paper ${sourceId}`,
    authors: ["A"],
    abstract: "abs",
    landingUrl: `https://openreview.net/forum?id=${sourceId}`,
    pdfUrl: `https://openreview.net/pdf?id=${sourceId}`,
    decisionLabel: "accept",
  };
}

function snapshotWith(rows: NormalizedPaper[]): SourceSnapshot {
  return {
    schemaVersion: "conference-source-snapshot-v1",
    editionId: EDITION.editionId,
    adapter: EDITION.adapter,
    adapterVersion: "1",
    sourceId: EDITION.sourceId,
    rows,
    sourceFingerprint: sourceFingerprint({
      adapterVersion: "1",
      editionId: EDITION.editionId,
      sourceId: EDITION.sourceId,
      rows,
    }),
    unknownDecisions: [],
    duplicateTitleCount: 0,
    requestCount: 1,
    pageCount: 1,
    responseBytes: 100,
  };
}

describe("observationFromDetection (CNF-27)", () => {
  it("validates against the real schema", () => {
    const snapshot = snapshotWith([makeRow("1"), makeRow("2"), makeRow("3")]);
    const observation = observationFromDetection(
      EDITION,
      { kind: "snapshot", snapshot, errorCode: null },
      { observedAt: new Date("2026-01-01T00:00:00Z"), runId: "run-1" },
    );
    const result = validateArtifact(
      "conference-probe-observation-v1",
      probeObservationToJson(observation),
    );
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  });

  it("CNF-27: classifies below absolute minimum as partial", () => {
    const snapshot = snapshotWith([makeRow("1")]);
    const observation = observationFromDetection(
      EDITION,
      { kind: "snapshot", snapshot, errorCode: null },
      { observedAt: new Date("2026-01-01T00:00:00Z"), runId: "run-1" },
    );
    expect(observation.status).toBe("partial");
    expect(observation.errorCode).toBe("CONF_COUNT_BELOW_MINIMUM");
  });

  it("CNF-27: classifies above the previous-edition maximum as anomaly", () => {
    const rows = Array.from({ length: 10 }, (_, i) => makeRow(String(i + 1)));
    const snapshot = snapshotWith(rows);
    const observation = observationFromDetection(
      EDITION,
      { kind: "snapshot", snapshot, errorCode: null },
      { observedAt: new Date("2026-01-01T00:00:00Z"), runId: "run-1", previousEditionCount: 3 },
    );
    expect(observation.status).toBe("anomaly");
    expect(observation.errorCode).toBe("CONF_COUNT_ABOVE_MAXIMUM");
  });

  it("rejects an invalid previous_edition_count", () => {
    const snapshot = snapshotWith([makeRow("1")]);
    const result: DetectionResult = { kind: "snapshot", snapshot, errorCode: null };
    expect(() =>
      observationFromDetection(EDITION, result, {
        observedAt: new Date(),
        runId: "r",
        previousEditionCount: -1,
      }),
    ).toThrow();
    expect(() =>
      observationFromDetection(EDITION, result, {
        observedAt: new Date(),
        runId: "r",
        previousEditionCount: 1.5,
      }),
    ).toThrow();
  });
});

describe("reduceReadiness (CNF-28/29)", () => {
  function okObservation(rows: NormalizedPaper[], observedAt: Date, runId: string) {
    const snapshot = snapshotWith(rows);
    return observationFromDetection(
      EDITION,
      { kind: "snapshot", snapshot, errorCode: null },
      { observedAt, runId },
    );
  }

  it("CNF-29: exactly two distinct, separated successes become READY", () => {
    const rows = [makeRow("1"), makeRow("2"), makeRow("3")];
    let state = initialState(EDITION);
    const obs1 = okObservation(rows, new Date("2026-01-01T00:00:00Z"), "run-1");
    const r1 = reduceReadiness(state, obs1, EDITION);
    expect(r1.state.phase).toBe("stabilizing");
    state = r1.state;

    const obs2 = okObservation(rows, new Date("2026-01-02T00:00:00Z"), "run-2");
    const r2 = reduceReadiness(state, obs2, EDITION);
    expect(r2.state.phase).toBe("ready");
    expect(r2.action).toBe("ready");
  });

  it("CNF-29: the same run and too-soon observations are no-ops that don't advance the count", () => {
    const rows = [makeRow("1"), makeRow("2"), makeRow("3")];
    let state = initialState(EDITION);
    const obs1 = okObservation(rows, new Date("2026-01-01T00:00:00Z"), "run-1");
    state = reduceReadiness(state, obs1, EDITION).state;

    // Same run_id again: no-op.
    const sameRunResult = reduceReadiness(state, obs1, EDITION);
    expect(sameRunResult.action).toBe("no_op");

    // A different run but too soon (< stableMinSeparationHours): no-op, stays stabilizing.
    const tooSoon = okObservation(rows, new Date("2026-01-01T01:00:00Z"), "run-2");
    const tooSoonResult = reduceReadiness(state, tooSoon, EDITION);
    expect(tooSoonResult.action).toBe("no_op");
    expect(tooSoonResult.state.stableObservations).toBe(1);
  });

  it("CNF-29: a fingerprint change restarts stabilization at one", () => {
    const rows1 = [makeRow("1"), makeRow("2"), makeRow("3")];
    const rows2 = [makeRow("1"), makeRow("2"), makeRow("4")];
    let state = initialState(EDITION);
    state = reduceReadiness(
      state,
      okObservation(rows1, new Date("2026-01-01T00:00:00Z"), "run-1"),
      EDITION,
    ).state;
    const changed = okObservation(rows2, new Date("2026-01-02T00:00:00Z"), "run-2");
    const r = reduceReadiness(state, changed, EDITION);
    expect(r.state.stableObservations).toBe(1);
    expect(r.reason).toBe("CONF_SOURCE_FINGERPRINT_CHANGED");
  });

  it("CNF-28: a published count shrink is an anomaly, erasing stability evidence", () => {
    const rows = [makeRow("1"), makeRow("2"), makeRow("3")];
    const published: ReturnType<typeof initialState> = {
      ...initialState(EDITION),
      phase: "published",
      publishedFingerprint: "x".repeat(64),
      publishedCount: 5,
      publishedSourceIds: ["1", "2", "3", "4", "5"],
    };
    const shrunk = okObservation(rows, new Date("2026-01-01T00:00:00Z"), "run-1");
    const r = reduceReadiness(published, shrunk, EDITION);
    expect(r.action).toBe("anomaly");
    expect(r.reason).toBe("CONF_COUNT_SHRINK");
  });

  it("CNF-28: an unchanged published snapshot is a no-op", () => {
    const rows = [makeRow("1"), makeRow("2"), makeRow("3")];
    const obs = okObservation(rows, new Date("2026-01-01T00:00:00Z"), "run-1");
    const published: ReturnType<typeof initialState> = {
      ...initialState(EDITION),
      phase: "published",
      publishedFingerprint: obs.sourceFingerprint ?? "",
      publishedCount: 3,
      publishedSourceIds: ["1", "2", "3"],
    };
    const r = reduceReadiness(published, obs, EDITION);
    expect(r.action).toBe("no_op");
    expect(r.state.phase).toBe("published");
  });

  it("validates reduceReadiness's state against the real schema", () => {
    const rows = [makeRow("1"), makeRow("2"), makeRow("3")];
    let state = initialState(EDITION);
    state = reduceReadiness(
      state,
      okObservation(rows, new Date("2026-01-01T00:00:00Z"), "run-1"),
      EDITION,
    ).state;
    state = reduceReadiness(
      state,
      okObservation(rows, new Date("2026-01-02T00:00:00Z"), "run-2"),
      EDITION,
    ).state;
    const result = validateArtifact("conference-release-state-v1", {
      schema_version: "conference-release-state-v1",
      editions: [editionStateToJson(state)],
    });
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  });
});

describe("canonicalStateBytes (CNF-30)", () => {
  it("is byte-identical and order-independent across retries", () => {
    const rows = [makeRow("1"), makeRow("2")];
    let state = initialState(EDITION);
    state = reduceReadiness(
      state,
      observationFromDetection(
        EDITION,
        { kind: "snapshot", snapshot: snapshotWith(rows), errorCode: null },
        { observedAt: new Date("2026-01-01T00:00:00Z"), runId: "run-1" },
      ),
      EDITION,
    ).state;
    const bytes1 = canonicalStateBytes(state);
    const bytes2 = canonicalStateBytes(state);
    expect(bytes1.equals(bytes2)).toBe(true);
    expect(bytes1.toString("utf-8").endsWith("\n")).toBe(true);
  });
});

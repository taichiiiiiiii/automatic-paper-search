// #428: an observation older than the last reduced one must not rewind
// the readiness state on any branch (failed / unavailable / ready); CNF-29
// makes time moving backwards an exception, so it throws before any branch.
import { describe, expect, it } from "vitest";
import {
  type Edition,
  initialState,
  type ProbeObservation,
} from "../../../src/conference/watch/models.js";
import { reduceReadiness } from "../../../src/conference/watch/stability.js";

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

function obs(
  observedAt: string,
  runId: string,
  extra: Partial<ProbeObservation> = {},
): ProbeObservation {
  return {
    editionId: EDITION.editionId,
    observedAt: new Date(observedAt),
    runId,
    status: "ready",
    count: 2,
    fingerprint: "fp-1",
    sourceIds: ["a", "b"],
    errorCode: null,
    ...extra,
  } as ProbeObservation;
}

describe("reduceReadiness ignores out-of-order observations (#428)", () => {
  it("a late 'failed' observation from an earlier run does not touch a newer state", () => {
    const after = reduceReadiness(
      initialState(EDITION),
      obs("2026-01-02T00:00:00Z", "run-2"),
      EDITION,
    ).state;
    expect(() =>
      reduceReadiness(
        after,
        obs("2026-01-01T00:00:00Z", "run-1", {
          status: "failed",
          errorCode: "CONF_SOURCE_TIMEOUT",
        }),
        EDITION,
      ),
    ).toThrow(/backwards/);
    expect(after.lastObservation?.runId).toBe("run-2");
  });
  it("a late 'unavailable' observation does not clear a newer stable fingerprint", () => {
    let state = initialState(EDITION);
    state = reduceReadiness(state, obs("2026-01-02T00:00:00Z", "run-2"), EDITION).state;
    state = reduceReadiness(state, obs("2026-01-03T00:00:00Z", "run-3"), EDITION).state;
    expect(() =>
      reduceReadiness(
        state,
        obs("2026-01-01T00:00:00Z", "run-1", { status: "unavailable" }),
        EDITION,
      ),
    ).toThrow(/backwards/);
    expect(state.lastObservation?.runId).toBe("run-3");
  });
  it("the same instant is not out of order", () => {
    const first = reduceReadiness(
      initialState(EDITION),
      obs("2026-01-02T00:00:00Z", "run-2"),
      EDITION,
    ).state;
    expect(() =>
      reduceReadiness(first, obs("2026-01-02T00:00:00Z", "run-2b"), EDITION),
    ).not.toThrow();
  });
});

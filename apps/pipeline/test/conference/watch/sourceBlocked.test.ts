/**
 * R3-1: the strict watch adapter maps OpenReview's 403 to the explicit
 * `CONF_SOURCE_BLOCKED` error, and the readiness reducer keeps a published
 * edition's identity set instead of treating the refusal as "0 papers".
 */
import { describe, expect, it } from "vitest";
import {
  type Edition,
  type EditionState,
  initialState,
  makeFetchLimits,
} from "../../../src/conference/watch/models.js";
import { OpenReviewV2Adapter } from "../../../src/conference/watch/openreview.js";
import {
  observationFromDetection,
  reduceReadiness,
} from "../../../src/conference/watch/stability.js";

const EDITION: Edition = {
  editionId: "icml-2026",
  venueKey: "icml",
  year: 2026,
  displayName: "ICML 2026",
  adapter: "openreview-v2",
  sourceId: "ICML.cc/2026/Conference",
  countGate: { minimumAbsolute: 1, previousEditionMinRatio: 0.5, previousEditionMaxRatio: 2.0 },
  tracks: {
    acceptedOnly: true,
    acceptedDecisionLabels: ["oral", "spotlight", "poster"],
    highlightedLabels: ["oral"],
  },
  stableMinSeparationHours: 6,
  stableMaxSeparationHours: 48,
};

const blockedTransport = {
  get: async () => ({ statusCode: 403, content: Buffer.alloc(0), requestCount: 1 }),
};

describe("OpenReviewV2Adapter: 403", () => {
  it("returns error CONF_SOURCE_BLOCKED (not unavailable, not a snapshot)", async () => {
    const adapter = new OpenReviewV2Adapter({ transport: blockedTransport });
    const r = await adapter.probe(EDITION, makeFetchLimits({ pageSize: 10 }));
    expect(r).toEqual({ kind: "error", snapshot: null, errorCode: "CONF_SOURCE_BLOCKED" });
  });

  it("keeps a published edition's count and ids through a blocked probe", async () => {
    const adapter = new OpenReviewV2Adapter({ transport: blockedTransport });
    const result = await adapter.probe(EDITION, makeFetchLimits({ pageSize: 10 }));
    const obs = observationFromDetection(EDITION, result, {
      observedAt: new Date("2026-10-11T00:00:00Z"),
      runId: "run-1",
    });
    expect(obs.status).toBe("failed");
    expect(obs.errorCode).toBe("CONF_SOURCE_BLOCKED");

    const published: EditionState = {
      ...initialState(EDITION),
      phase: "published",
      publishedCount: 6552,
      publishedSourceIds: ["a", "b"],
      publishedFingerprint: "f".repeat(64),
    };
    const { state, action, reason } = reduceReadiness(published, obs, EDITION);
    expect(action).toBe("failed");
    expect(reason).toBe("CONF_SOURCE_BLOCKED");
    expect(state.phase).toBe("published");
    expect(state.publishedCount).toBe(6552);
    expect(state.publishedSourceIds).toEqual(["a", "b"]);
    expect(state.lastFailureCode).toBe("CONF_SOURCE_BLOCKED");
  });
});

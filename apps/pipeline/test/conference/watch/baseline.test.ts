/**
 * Port of `test_conference_watch_baseline.py` / `test_conference_ratio_assessment.py`
 * (CNF-36, docs/migration/safety-contracts.md).
 */

import { validateArtifact } from "@paperpilot/core";
import { makePaperId } from "@paperpilot/core/identity";
import { describe, expect, it } from "vitest";
import {
  assessPreviousEditionRatio,
  PreviousEditionRatioAssessmentError,
} from "../../../src/conference/watch/baseline.js";
import {
  type Edition,
  type EditionState,
  initialState,
  makeFetchLimits,
} from "../../../src/conference/watch/models.js";
import {
  OpenReviewV2Adapter,
  type StrictTransport,
} from "../../../src/conference/watch/openreview.js";
import { parseRegistry } from "../../../src/conference/watch/registry.js";

const REGISTRY_OBJECT = {
  schema_version: "conference-sources-v1",
  apply_enabled: true,
  defaults: {
    probe_interval_hours: 6,
    stable_min_separation_hours: 12,
    stable_max_separation_hours: 72,
    max_future_years: 1,
  },
  venues: [
    {
      venue_key: "iclr",
      enabled: true,
      curated_class: "top",
      display_template: "ICLR {year}",
      slug_template: "iclr-{year}",
      adapter: "openreview-v2",
      source_id_template: "ICLR.cc/{year}/Conference",
      first_year: 2025,
      active_months_utc: [1, 2, 3],
      count_gate: {
        minimum_absolute: 1,
        previous_edition_min_ratio: 0.5,
        previous_edition_max_ratio: 2.0,
      },
      tracks: {
        accepted_only: true,
        accepted_decision_labels: ["accept", "reject"],
        highlighted_labels: ["accept"],
      },
    },
  ],
};
const REGISTRY = parseRegistry(REGISTRY_OBJECT);
const VENUE = REGISTRY.venues[0];
if (!VENUE) throw new Error("fixture registry has no venue");

const EDITION_2026: Edition = {
  editionId: "iclr-2026",
  venueKey: "iclr",
  year: 2026,
  displayName: "ICLR 2026",
  adapter: "openreview-v2",
  sourceId: "ICLR.cc/2026/Conference",
  countGate: VENUE.countGate,
  tracks: VENUE.tracks,
  stableMinSeparationHours: REGISTRY.defaults.stableMinSeparationHours,
  stableMaxSeparationHours: REGISTRY.defaults.stableMaxSeparationHours,
};

function note(id: string, venue: string) {
  return {
    id,
    content: {
      venueid: { value: EDITION_2026.sourceId },
      title: { value: `Title ${id}` },
      authors: { value: ["A One"] },
      abstract: { value: "An abstract." },
      venue: { value: venue },
    },
  };
}

async function readySnapshot(noteIds: [string, string][]) {
  const notes = noteIds.map(([id, venue]) => note(id, venue));
  const transport: StrictTransport = {
    get: async () => ({
      statusCode: 200,
      content: Buffer.from(JSON.stringify({ notes, count: notes.length })),
      requestCount: 1,
    }),
  };
  const adapter = new OpenReviewV2Adapter({ transport });
  const result = await adapter.collect(EDITION_2026, makeFetchLimits());
  if (result.kind !== "snapshot") throw new Error("expected snapshot");
  return result.snapshot;
}

function publishedPreviousState(sourceIds: string[], fingerprint: string): EditionState {
  return {
    ...initialState({ editionId: "iclr-2025", venueKey: "iclr", year: 2025 }),
    phase: "published",
    publishedFingerprint: fingerprint,
    publishedCount: sourceIds.length,
    publishedSourceIds: sourceIds,
  };
}

function previousCatalogBytesFor(sourceIds: string[]): Buffer {
  const rows = sourceIds.map((id) => ({
    title: `Title ${id}`,
    type: "Poster",
    tags: ["Other"],
    venue: "ICLR 2025",
    authors: ["A One"],
    arxiv_url: `https://openreview.net/forum?id=${id}`,
    pdf_url: `https://openreview.net/pdf?id=${id}`,
    abstract: "",
    arxiv_id: "",
    citation_count: null,
    venue_tier: null,
    github_stars: null,
    paper_id: makePaperId("openreview", id),
    source: "openreview",
    source_id: id,
  }));
  return Buffer.from(JSON.stringify(rows));
}

describe("assessPreviousEditionRatio (CNF-36)", () => {
  it("passes when the current count is within the previous edition's ratio bounds", async () => {
    const snapshot = await readySnapshot([
      ["n1", "accept"],
      ["n2", "reject"],
    ]);
    const previousIds = ["p1", "p2"];
    const previousState = publishedPreviousState(previousIds, "e".repeat(64));
    const assessment = assessPreviousEditionRatio(REGISTRY, EDITION_2026, snapshot, previousState, {
      previousCatalogBytes: previousCatalogBytesFor(previousIds),
    });
    expect(assessment.status).toBe("passed");
    expect(assessment.previousCount).toBe(2);
    expect(assessment.currentCount).toBe(2);
    // Inclusive bound check: 2 editions * 0.5 = 1 (min), * 2.0 = 4 (max).
    expect(assessment.effectiveMinimum).toBe(1);
    expect(assessment.effectiveMaximum).toBe(4);
    // `schemas/conference-baseline-assessment-v1.schema.json` now has an
    // `$id` (p4-followups.md #16 — it previously lacked one, so ajv could
    // not look it up by name), so the report shape can be checked against
    // the real schema directly, matching `test_conference_ratio_assessment.py`.
    const report = JSON.parse(assessment.reportBytes.toString("utf-8"));
    expect(validateArtifact("conference-baseline-assessment-v1", report).ok).toBe(true);
  });

  it("reports below_minimum when the current count undershoots the ratio", async () => {
    const snapshot = await readySnapshot([["n1", "accept"]]);
    const previousIds = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const previousState = publishedPreviousState(previousIds, "e".repeat(64));
    const assessment = assessPreviousEditionRatio(REGISTRY, EDITION_2026, snapshot, previousState, {
      previousCatalogBytes: previousCatalogBytesFor(previousIds),
    });
    expect(assessment.status).toBe("below_minimum");
  });

  it("reports above_maximum when the current count overshoots the ratio", async () => {
    const snapshot = await readySnapshot([
      ["n1", "accept"],
      ["n2", "reject"],
      ["n3", "accept"],
    ]);
    const previousIds = ["p1"];
    const previousState = publishedPreviousState(previousIds, "e".repeat(64));
    const assessment = assessPreviousEditionRatio(REGISTRY, EDITION_2026, snapshot, previousState, {
      previousCatalogBytes: previousCatalogBytesFor(previousIds),
    });
    expect(assessment.status).toBe("above_maximum");
  });

  it("CNF-36: a first edition (year === venue.first_year) is never a valid baseline", async () => {
    const snapshot = await readySnapshot([["n1", "accept"]]);
    const firstEdition: Edition = {
      ...EDITION_2026,
      editionId: "iclr-2025",
      year: 2025,
      sourceId: "ICLR.cc/2025/Conference",
    };
    const previousState = publishedPreviousState(["p1"], "e".repeat(64));
    expect(() =>
      assessPreviousEditionRatio(REGISTRY, firstEdition, snapshot, previousState, {
        previousCatalogBytes: previousCatalogBytesFor(["p1"]),
      }),
    ).toThrow(PreviousEditionRatioAssessmentError);
  });

  it("CNF-36: rejects a previous state that is not PUBLISHED", async () => {
    const snapshot = await readySnapshot([["n1", "accept"]]);
    const previousState: EditionState = {
      ...publishedPreviousState(["p1"], "e".repeat(64)),
      phase: "ready",
    };
    expect(() =>
      assessPreviousEditionRatio(REGISTRY, EDITION_2026, snapshot, previousState, {
        previousCatalogBytes: previousCatalogBytesFor(["p1"]),
      }),
    ).toThrow(PreviousEditionRatioAssessmentError);
  });

  it("CNF-36: rejects a previous catalog whose id set disagrees with published_source_ids", async () => {
    const snapshot = await readySnapshot([["n1", "accept"]]);
    const previousState = publishedPreviousState(["p1", "p2"], "e".repeat(64));
    expect(() =>
      assessPreviousEditionRatio(REGISTRY, EDITION_2026, snapshot, previousState, {
        previousCatalogBytes: previousCatalogBytesFor(["p1", "different"]),
      }),
    ).toThrow(PreviousEditionRatioAssessmentError);
  });

  it("CNF-36: rejects a malformed/truncated previous catalog", async () => {
    const snapshot = await readySnapshot([["n1", "accept"]]);
    const previousState = publishedPreviousState(["p1"], "e".repeat(64));
    expect(() =>
      assessPreviousEditionRatio(REGISTRY, EDITION_2026, snapshot, previousState, {
        previousCatalogBytes: Buffer.from("not json"),
      }),
    ).toThrow(PreviousEditionRatioAssessmentError);
  });

  it("is a pure local assessment: authority flags in the report are all false", async () => {
    const snapshot = await readySnapshot([["n1", "accept"]]);
    const previousState = publishedPreviousState(["p1"], "e".repeat(64));
    const assessment = assessPreviousEditionRatio(REGISTRY, EDITION_2026, snapshot, previousState, {
      previousCatalogBytes: previousCatalogBytesFor(["p1"]),
    });
    const report = JSON.parse(assessment.reportBytes.toString("utf-8"));
    expect(Object.values(report.authority)).toEqual([false, false, false, false, false, false]);
  });
});

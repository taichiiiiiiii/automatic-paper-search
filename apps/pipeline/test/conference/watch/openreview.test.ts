/**
 * Port of `test_conference_watch_openreview.py`'s adapter-level cases
 * (CNF-22/23, docs/migration/safety-contracts.md). Injects a fake
 * `StrictTransport` instead of mocking `requests`/`arxiv`.
 */

import { validateArtifact } from "@paperpilot/core";
import { describe, expect, it } from "vitest";
import { type Edition, makeFetchLimits } from "../../../src/conference/watch/models.js";
import {
  normalizeDecision,
  OpenReviewV2Adapter,
  type StrictTransport,
} from "../../../src/conference/watch/openreview.js";
import type { ResponseLike } from "../../../src/conference/watch/transport.js";

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

function note(id: string, venue: string, title = "T", authors: string[] = ["A"]) {
  return {
    id,
    content: {
      venueid: { value: EDITION.sourceId },
      title: { value: title },
      authors: { value: authors },
      abstract: { value: "abs" },
      venue: { value: venue },
    },
  };
}

function okResponse(notes: unknown[], count?: number): ResponseLike {
  return {
    statusCode: 200,
    content: Buffer.from(JSON.stringify({ notes, count: count ?? notes.length })),
    requestCount: 1,
  };
}

function singlePageTransport(notes: unknown[]): StrictTransport {
  return { get: async () => okResponse(notes) };
}

const limits = makeFetchLimits({ pageSize: 100 });

describe("normalizeDecision", () => {
  it("matches a single configured decision by token", () => {
    expect(normalizeDecision("Accept (Oral)", ["accept", "reject"])).toBe("accept");
  });
  it("returns null for an unmatched label", () => {
    expect(normalizeDecision("Withdraw", ["accept", "reject"])).toBeNull();
  });
  it("throws when multiple configured decisions match", () => {
    expect(() => normalizeDecision("accept or reject", ["accept", "reject"])).toThrow();
  });
});

// p4-followups #28: normalizedText() now uses pySplit (Python's no-arg
// str.split() whitespace set) instead of JS's `\s`. This feeds
// sourceFingerprint, so it's worth pinning the one case where the two
// whitespace sets actually disagree — see @paperpilot/core/pycompat's
// pySplit doc comment — not just ordinary-whitespace titles the rest of
// this suite already exercises identically either way.
describe("normalizedText whitespace set (p4-followups #28)", () => {
  it("collapses Python-only whitespace (U+0085 NEL) that JS's \\s does not match", async () => {
    const notes = [note("n1", "accept", "Title\u0085With\u0085NEL")];
    const adapter = new OpenReviewV2Adapter({ transport: singlePageTransport(notes) });
    const result = await adapter.collect(EDITION, limits);
    expect(result.kind).toBe("snapshot");
    if (result.kind === "snapshot") {
      expect(result.snapshot.rows[0]?.title).toBe("Title With NEL");
    }
  });

  it("does NOT treat U+FEFF (BOM) as whitespace, unlike JS's .trim()/\\s", async () => {
    const notes = [note("n1", "accept", "﻿Kept Together")];
    const adapter = new OpenReviewV2Adapter({ transport: singlePageTransport(notes) });
    const result = await adapter.collect(EDITION, limits);
    expect(result.kind).toBe("snapshot");
    if (result.kind === "snapshot") {
      expect(result.snapshot.rows[0]?.title).toBe("﻿Kept Together");
    }
  });
});

describe("OpenReviewV2Adapter (CNF-22/23)", () => {
  it("returns a complete snapshot for a single, fully-fetched page", async () => {
    const notes = [note("n1", "accept"), note("n2", "reject")];
    const adapter = new OpenReviewV2Adapter({ transport: singlePageTransport(notes) });
    const result = await adapter.collect(EDITION, limits);
    expect(result.kind).toBe("snapshot");
    if (result.kind === "snapshot") {
      expect(result.snapshot.rows).toHaveLength(2);
      const check = validateArtifact("conference-source-snapshot-v1", {
        schema_version: result.snapshot.schemaVersion,
        edition_id: result.snapshot.editionId,
        adapter: result.snapshot.adapter,
        adapter_version: result.snapshot.adapterVersion,
        source_id: result.snapshot.sourceId,
        source_fingerprint: result.snapshot.sourceFingerprint,
        rows: result.snapshot.rows.map((r) => ({
          source: r.source,
          source_id: r.sourceId,
          paper_id: r.paperId,
          title: r.title,
          authors: r.authors,
          abstract: r.abstract,
          landing_url: r.landingUrl,
          pdf_url: r.pdfUrl,
          decision_label: r.decisionLabel,
        })),
        unknown_decisions: result.snapshot.unknownDecisions,
        duplicate_title_count: result.snapshot.duplicateTitleCount,
        request_count: result.snapshot.requestCount,
        page_count: result.snapshot.pageCount,
        response_bytes: result.snapshot.responseBytes,
      });
      expect(check.ok, JSON.stringify(check.errors)).toBe(true);
    }
  });

  it("CNF-22: a mid-pagination failure never returns a partial snapshot", async () => {
    let calls = 0;
    const transport: StrictTransport = {
      get: async () => {
        calls += 1;
        if (calls === 1) return okResponse([note("n1", "accept")], 2);
        return { statusCode: 500, content: Buffer.alloc(0), requestCount: 1 };
      },
    };
    const adapter = new OpenReviewV2Adapter({ transport });
    const result = await adapter.collect(EDITION, makeFetchLimits({ pageSize: 1 }));
    expect(result.kind).toBe("error");
    expect(result.snapshot).toBeNull();
  });

  it("CNF-22: a count drift between pages fails closed (SOURCE_PARTIAL)", async () => {
    let calls = 0;
    const transport: StrictTransport = {
      get: async () => {
        calls += 1;
        if (calls === 1) return okResponse([note("n1", "accept")], 2);
        return okResponse([note("n2", "accept")], 3); // count changed mid-fetch
      },
    };
    const adapter = new OpenReviewV2Adapter({ transport });
    const result = await adapter.collect(EDITION, makeFetchLimits({ pageSize: 1 }));
    expect(result.kind).toBe("error");
    expect(result.errorCode).toBe("CONF_SOURCE_PARTIAL");
  });

  it("CNF-22: a 404 is reported as unavailable, not an empty snapshot", async () => {
    const transport: StrictTransport = {
      get: async () => ({ statusCode: 404, content: Buffer.alloc(0), requestCount: 1 }),
    };
    const adapter = new OpenReviewV2Adapter({ transport });
    const result = await adapter.collect(EDITION, limits);
    expect(result.kind).toBe("unavailable");
  });

  it("CNF-22: an empty but 'completed' fetch (0 notes) is unavailable, not a 0-row snapshot", async () => {
    const adapter = new OpenReviewV2Adapter({ transport: singlePageTransport([]) });
    const result = await adapter.collect(EDITION, limits);
    expect(result.kind).toBe("unavailable");
  });

  it("CNF-22: a short page before the expected count is reached fails closed (SOURCE_PARTIAL)", async () => {
    // count=4 promised; page 1 delivers a full page (2/2, count matches,
    // not yet reached); page 2 comes back SHORT (1 note, less than
    // pageSize) while still short of the expected total of 4 — this is a
    // distinct branch from the "count drift" case above (the count never
    // changes here).
    let calls = 0;
    const transport: StrictTransport = {
      get: async () => {
        calls += 1;
        if (calls === 1) return okResponse([note("n1", "accept"), note("n2", "accept")], 4);
        return okResponse([note("n3", "accept")], 4);
      },
    };
    const adapter = new OpenReviewV2Adapter({ transport });
    const result = await adapter.collect(EDITION, makeFetchLimits({ pageSize: 2 }));
    expect(result.kind).toBe("error");
    expect(result.errorCode).toBe("CONF_SOURCE_PARTIAL");
  });

  it("CNF-22: a response exceeding maxResponseBytes fails closed (SOURCE_PARTIAL)", async () => {
    const bigNotes = [note("n1", "accept"), note("n2", "accept"), note("n3", "accept")];
    const transport: StrictTransport = { get: async () => okResponse(bigNotes, bigNotes.length) };
    const adapter = new OpenReviewV2Adapter({ transport });
    const tinyLimits = makeFetchLimits({ pageSize: 100, maxResponseBytes: 10 });
    const result = await adapter.collect(EDITION, tinyLimits);
    expect(result.kind).toBe("error");
    expect(result.errorCode).toBe("CONF_SOURCE_PARTIAL");
  });

  it("CNF-22: exhausting maxPages without ever confirming completion fails closed (SOURCE_PARTIAL, not !completed silently)", async () => {
    // No `count` header at all, and every page comes back exactly
    // pageSize-full, so the loop never gets a chance to decide the fetch
    // is done — it just runs out of maxPages iterations.
    const transport: StrictTransport = {
      get: async () => ({
        statusCode: 200,
        content: Buffer.from(JSON.stringify({ notes: [note("n", "accept")] })), // no "count"
        requestCount: 1,
      }),
    };
    const adapter = new OpenReviewV2Adapter({ transport });
    const result = await adapter.collect(EDITION, makeFetchLimits({ pageSize: 1, maxPages: 2 }));
    expect(result.kind).toBe("error");
    expect(result.errorCode).toBe("CONF_SOURCE_PARTIAL");
  });

  it("CNF-22: a malformed (non-JSON) body is a typed parse error", async () => {
    const transport: StrictTransport = {
      get: async () => ({ statusCode: 200, content: Buffer.from("not json"), requestCount: 1 }),
    };
    const adapter = new OpenReviewV2Adapter({ transport });
    const result = await adapter.collect(EDITION, limits);
    expect(result.kind).toBe("error");
    expect(result.errorCode).toBe("CONF_SOURCE_PARSE_ERROR");
  });

  it("CNF-23: an invalid single row (bad note id) fails the entire snapshot", async () => {
    const badNote = note("bad id with spaces", "accept");
    const adapter = new OpenReviewV2Adapter({
      transport: singlePageTransport([note("n1", "accept"), badNote]),
    });
    const result = await adapter.collect(EDITION, limits);
    expect(result.kind).toBe("error");
    expect(result.errorCode).toBe("CONF_IDENTITY_MISSING");
  });

  it("CNF-23: a venueid mismatch fails the entire snapshot", async () => {
    const mismatched = {
      ...note("n1", "accept"),
      content: { ...note("n1", "accept").content, venueid: { value: "other/venue" } },
    };
    const adapter = new OpenReviewV2Adapter({ transport: singlePageTransport([mismatched]) });
    const result = await adapter.collect(EDITION, limits);
    expect(result.kind).toBe("error");
    expect(result.errorCode).toBe("CONF_IDENTITY_MISSING");
  });

  it("CNF-23: duplicate note ids fail the entire snapshot", async () => {
    const adapter = new OpenReviewV2Adapter({
      transport: singlePageTransport([note("dup", "accept"), note("dup", "reject")]),
    });
    const result = await adapter.collect(EDITION, limits);
    expect(result.kind).toBe("error");
    expect(result.errorCode).toBe("CONF_DUPLICATE_ID");
  });

  it("CNF-23: an ambiguous decision label is reported under unknown_decisions, not dropped", async () => {
    const adapter = new OpenReviewV2Adapter({
      transport: singlePageTransport([note("n1", "withdrawn")]),
    });
    const result = await adapter.collect(EDITION, limits);
    expect(result.kind).toBe("snapshot");
    if (result.kind === "snapshot") {
      expect(result.snapshot.unknownDecisions).toEqual([["withdrawn", 1]]);
    }
  });
});

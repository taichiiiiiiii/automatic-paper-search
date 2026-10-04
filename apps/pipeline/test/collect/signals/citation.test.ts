/**
 * Port of `paperpilot/tests/test_citation_signal.py`.
 */
import { expect, it } from "vitest";
import type { FetchLike, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { createPaper } from "../../../src/collect/model/paper.js";
import { CitationSignal } from "../../../src/collect/signals/citation.js";

function mockResp(status: number, body: unknown = null): HttpResponseLike {
  return { status, json: async () => body };
}

function mkPaper(arxivId = "2604.00001", pubDaysAgo = 100) {
  const today = new Date("2026-04-10T00:00:00Z");
  const pub = new Date(today.getTime() - pubDaysAgo * 86_400_000);
  return createPaper({
    title: "T",
    authors: ["A"],
    abstract: "a",
    url: "u",
    publishedDate: pub.toISOString().slice(0, 10),
    source: "arxiv",
    arxivId,
  });
}

const TODAY = () => new Date("2026-04-10T00:00:00Z");

function fetchReturning(resp: HttpResponseLike | null): FetchLike {
  return async () => {
    if (resp === null) throw new Error("network down");
    return resp;
  };
}

it("test_enrich_fills_citation_fields", async () => {
  const paper = mkPaper("2604.00001", 100);
  const payload = [
    {
      paperId: "abc",
      citationCount: 200,
      influentialCitationCount: 10,
      publicationDate: "2026-01-01",
      authors: [{ authorId: "AID_1", name: "A" }],
      venue: "ICLR",
    },
  ];
  const sig = new CitationSignal(
    { enabled: true, velocity_saturation: 2.0 },
    { fetchImpl: fetchReturning(mockResp(200, payload)), today: TODAY },
  );
  const out = await sig.enrichBatch([paper]);
  expect(out[0]?.citationCount).toBe(200);
  expect(out[0]?.influentialCitations).toBe(10);
  expect(out[0]?.citationScore).toBe(100.0);
  expect(out[0]?.firstAuthorId).toBe("AID_1");
  expect(out[0]?.venue).toBe("ICLR");
});

it("test_skips_papers_without_ids", async () => {
  const paper = createPaper({
    title: "T",
    authors: ["A"],
    abstract: "a",
    url: "u",
    publishedDate: "2026-01-01",
    source: "openalex",
  });
  let called = false;
  const sig = new CitationSignal(
    { enabled: true },
    {
      fetchImpl: async () => {
        called = true;
        return mockResp(200, []);
      },
      today: TODAY,
    },
  );
  await sig.enrichBatch([paper]);
  expect(called).toBe(false);
});

it("test_api_failure_leaves_paper_untouched", async () => {
  const paper = mkPaper();
  const sig = new CitationSignal(
    { enabled: true },
    { fetchImpl: fetchReturning(null), today: TODAY },
  );
  const out = await sig.enrichBatch([paper]);
  expect(out[0]?.citationCount).toBe(0);
  expect(out[0]?.citationScore).toBe(0.0);
  expect(sig.runFailures.length).toBe(1);
  expect(sig.runFailures[0]).toContain("n=1");
});

it("test_unexpected_response_shape_is_recorded", async () => {
  const paper = mkPaper();
  const sig = new CitationSignal(
    { enabled: true },
    { fetchImpl: fetchReturning(mockResp(200, { error: "not a list" })), today: TODAY },
  );
  await sig.enrichBatch([paper]);
  expect(sig.runFailures.length).toBe(1);
  expect(sig.runFailures[0]).toContain("object instead of a list");
});

it("test_short_batch_body_records_the_lost_tail", async () => {
  const papers = [mkPaper("2604.00001"), mkPaper("2604.00002")];
  const payload = [
    {
      paperId: "abc",
      citationCount: 4,
      influentialCitationCount: 0,
      publicationDate: "2026-04-06",
      authors: [],
      venue: null,
    },
  ];
  const sig = new CitationSignal(
    { enabled: true },
    { fetchImpl: fetchReturning(mockResp(200, payload)), today: TODAY },
  );
  const out = await sig.enrichBatch(papers);
  expect(out[1]?.citationCount).toBe(0);
  expect(sig.runFailures).toEqual(["batch answered 1 of 2 ids"]);
});

it("test_run_failures_is_a_per_run_channel", async () => {
  const paper = mkPaper();
  const payload = [
    {
      paperId: "abc",
      citationCount: 4,
      influentialCitationCount: 0,
      publicationDate: "2026-04-06",
      authors: [],
      venue: null,
    },
  ];
  let fail = true;
  const fetchImpl: FetchLike = async () => {
    if (fail) throw new Error("down");
    return mockResp(200, payload);
  };
  const sig = new CitationSignal({ enabled: true }, { fetchImpl, today: TODAY });

  await sig.enrichBatch([paper]);
  expect(sig.runFailures.length).toBeGreaterThan(0);

  fail = false;
  await sig.enrichBatch([paper]);
  expect(sig.runFailures).toEqual([]);
  expect(await sig.enrichBatch([])).toEqual([]);
  expect(sig.runFailures).toEqual([]);
});

it("test_velocity_clamps_future_publication_date", async () => {
  const paper2 = mkPaper("2604.00001", 100);
  const payload2 = [
    {
      paperId: "abc",
      citationCount: 1,
      influentialCitationCount: 0,
      publicationDate: new Date(TODAY().getTime() + 30 * 86_400_000).toISOString().slice(0, 10),
      authors: [],
      venue: null,
    },
  ];
  const sig = new CitationSignal(
    { enabled: true, velocity_saturation: 2.0 },
    { fetchImpl: fetchReturning(mockResp(200, payload2)), today: TODAY },
  );
  const out2 = await sig.enrichBatch([paper2]);
  expect(out2[0]?.citationVelocity).toBe(1.0);
  expect(out2[0]?.citationScore).toBe(50.0);
});

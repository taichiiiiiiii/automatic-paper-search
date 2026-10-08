/**
 * Port of the `stage_collect` cases of `paperpilot/tests/test_stages.py`
 * (the fake-source cases). The cases that drive the REAL
 * ArxivSource/S2Source/OpenAlexSource through `collect()` are not
 * duplicated here: part-1's `sources/arxiv.test.ts`, `sources/s2.test.ts`,
 * `sources/openalex.test.ts` and `parity.test.ts` already exercise those
 * sources' own completeness/failure behavior directly, and the
 * "first-degraded-keyword-reason" and "incomplete keyword" wiring this
 * stage adds on top is covered below with fakes (and again at the runner
 * level in `runner.test.ts`).
 */
import { expect, it } from "vitest";
import { createPaper, type Paper } from "../../../src/collect/model/paper.js";
import {
  AllKeywordsFailedError,
  type FetchParams,
  type FetchResult,
  type Source,
} from "../../../src/collect/sources/source.js";
import { collect, type SourceEntry } from "../../../src/collect/stages/collect.js";

class FakeSource implements Source {
  constructor(
    readonly name: string,
    private readonly papers: Paper[],
    private readonly fail = false,
  ) {}

  async fetch(_params: FetchParams): Promise<FetchResult> {
    if (this.fail) throw new Error("boom");
    return { papers: this.papers, truncatedKeywords: [], degradedKeywords: [] };
  }
}

function mkPaper(suffix: string): Paper {
  return createPaper({
    title: `Paper ${suffix}`,
    authors: ["A"],
    abstract: "abs",
    url: `http://x/${suffix}`,
    publishedDate: "2026-04-10",
    source: "arxiv",
    arxivId: `2604.${suffix}`,
  });
}

it("test_collect_aggregates_enabled_sources_only", async () => {
  const s1: SourceEntry = {
    source: new FakeSource("fake", [mkPaper("a"), mkPaper("b")]),
    enabled: true,
  };
  const s2: SourceEntry = { source: new FakeSource("fake2", [mkPaper("c")]), enabled: false };
  const result = await collect([s1, s2], {
    keywords: ["x"],
    categories: [],
    daysBack: 7,
    maxResultsPerKeyword: 10,
  });
  expect(result.papers.length).toBe(2);
  expect(result.status.fake?.ok).toBe(true);
  expect(result.status.fake2).toBeUndefined();
});

it("test_collect_dedups_across_sources", async () => {
  const shared = mkPaper("same");
  const s1: SourceEntry = { source: new FakeSource("fake", [shared]), enabled: true };
  const s2: SourceEntry = { source: new FakeSource("fake2", [mkPaper("same")]), enabled: true };
  const result = await collect([s1, s2], {
    keywords: ["x"],
    categories: [],
    daysBack: 7,
    maxResultsPerKeyword: 10,
  });
  expect(result.papers.length).toBe(1);
});

it("test_collect_records_source_failure_in_status", async () => {
  const good: SourceEntry = { source: new FakeSource("fake", [mkPaper("1")]), enabled: true };
  const bad: SourceEntry = { source: new FakeSource("bad", [], true), enabled: true };
  const result = await collect([good, bad], {
    keywords: ["x"],
    categories: [],
    daysBack: 7,
    maxResultsPerKeyword: 10,
  });
  expect(result.papers.length).toBe(1);
  expect(result.status.fake?.ok).toBe(true);
  expect(result.status.bad?.ok).toBe(false);
  expect(result.status.bad?.error).toBe("boom");
});

it("test_collect_no_enabled_sources_returns_empty", async () => {
  const s: SourceEntry = { source: new FakeSource("fake", [mkPaper("1")]), enabled: false };
  const result = await collect([s], {
    keywords: ["x"],
    categories: [],
    daysBack: 7,
    maxResultsPerKeyword: 10,
  });
  expect(result.papers).toEqual([]);
  expect(result.status).toEqual({});
});

it("test_collect_names_the_first_keyword_reason_in_a_source_failure (fake-source analogue)", async () => {
  class PartialFailSource implements Source {
    readonly name = "partial";
    async fetch(): Promise<FetchResult> {
      throw new AllKeywordsFailedError("partial fetch failed for all 2 keyword(s)", {
        truncatedKeywords: [],
        degradedKeywords: [["a", "RuntimeError: boom (status=503)"]],
      });
    }
  }
  const entry: SourceEntry = { source: new PartialFailSource(), enabled: true };
  const result = await collect([entry], {
    keywords: ["a", "b"],
    categories: [],
    daysBack: 7,
    maxResultsPerKeyword: 10,
  });
  expect(result.status.partial?.ok).toBe(false);
  expect(result.status.partial?.error).toBe(
    "partial fetch failed for all 2 keyword(s); first keyword 'a': RuntimeError: boom (status=503)",
  );
});

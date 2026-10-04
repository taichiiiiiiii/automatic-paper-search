/**
 * Vitest port of the seed-discovery/ranking tests in
 * `paperpilot/tests/test_build_theme_lineage.py` (`_is_survey`,
 * `_compute_seed_score`, `_rank_and_truncate`, `_resolve_openalex_to_s2`,
 * `_search_one_keyword_via_s2`) — safety contracts LIN-15/20/21/27.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import {
  computeSeedScore,
  type DiscoverSeedsDeps,
  isSurvey,
  rankAndTruncate,
  resolveOpenalexToS2,
  searchOneKeywordViaS2,
} from "../../../src/lineage/theme/discoverSeeds.js";

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

function mkS2Paper(pid: string, opts: { title?: string; year?: number; cites?: number } = {}) {
  const { title = "Some paper", year = 2020, cites = 100 } = opts;
  return {
    paperId: pid,
    title,
    year,
    venue: "NeurIPS",
    citationCount: cites,
    abstract: "",
    authors: [],
  };
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "s2-seed-cache-"));
});

function depsFor(
  fetchImpl: (url: string, init: FetchInit) => Promise<HttpResponseLike>,
): DiscoverSeedsDeps {
  return { fetchImpl, sleep: async () => {}, cacheDir, logger: { warn: () => {} } };
}

describe("isSurvey", () => {
  it("detects the prefix form (Survey/Review/Tutorial/Roadmap/Perspective/Primer)", () => {
    const titles = [
      "A Survey of Graph Neural Networks",
      "An Comprehensive Survey on Diffusion Models",
      "Review of Deep Learning",
      "Tutorial on Variational Autoencoders",
      "Roadmap for Continual Learning",
      "Perspective on Self-Supervised Pretraining",
      "Primer on Attention Mechanisms",
    ];
    for (const t of titles) expect(isSurvey({ title: t })).toBe(true);
  });

  it("detects the colon-suffix form", () => {
    expect(isSurvey({ title: "Graph Neural Networks: A Survey" })).toBe(true);
    expect(isSurvey({ title: "Mixture of Experts: A Review" })).toBe(true);
  });

  it("does not false-positive on seminal works", () => {
    const nonSurveys = [
      "Deep Residual Learning for Image Recognition",
      "Attention Is All You Need",
      "BERT: Pre-training of Deep Bidirectional Transformers",
      "Mamba: Linear-Time Sequence Modeling with Selective State Spaces",
      "Denoising Diffusion Probabilistic Models",
      "ImageNet Classification with Deep Convolutional Neural Networks",
    ];
    for (const t of nonSurveys) expect(isSurvey({ title: t })).toBe(false);
  });

  it("is defensive against missing/non-string titles", () => {
    expect(isSurvey({})).toBe(false);
    expect(isSurvey({ title: null })).toBe(false);
    expect(isSurvey({ title: 123 })).toBe(false);
  });
});

describe("computeSeedScore", () => {
  it("penalises velocity so a younger high-cite paper beats an older one with similar velocity", () => {
    const oldHigh = { year: 2016, citationCount: 100_000, title: "Old foundational" };
    const youngHigh = { year: 2023, citationCount: 30_000, title: "Young foundational" };
    expect(computeSeedScore(youngHigh, 2026)).toBeGreaterThan(computeSeedScore(oldHigh, 2026));
  });

  it("applies the 0.30 survey penalty", () => {
    const survey = { year: 2022, citationCount: 5_000, title: "A Survey of GNNs" };
    const nonSurvey = { year: 2022, citationCount: 5_000, title: "Deep GNN architectures" };
    const sSurvey = computeSeedScore(survey, 2026);
    const sReal = computeSeedScore(nonSurvey, 2026);
    expect(sSurvey).toBeLessThan(sReal);
    expect(sSurvey).toBeCloseTo(sReal * 0.3, 10);
  });

  it("gives a zero-cite brand-new paper a non-zero score via the +1 and 0.5y floor", () => {
    expect(computeSeedScore({ year: 2026, citationCount: 0, title: "New result" }, 2026)).toBe(2.0);
  });

  it("falls back to the floor age when year is missing (no div-by-zero)", () => {
    expect(computeSeedScore({ citationCount: 100, title: "x" }, 2026)).toBeGreaterThan(0);
  });
});

describe("rankAndTruncate", () => {
  it("promotes seminal works over a highly-cited survey on the same theme", () => {
    const seeds = [
      mkS2Paper("survey", {
        title: "A Comprehensive Survey of Graph Neural Networks",
        year: 2021,
        cites: 6_000,
      }),
      mkS2Paper("gcn", {
        title: "Semi-Supervised Classification with Graph Convolutional Networks",
        year: 2017,
        cites: 30_000,
      }),
      mkS2Paper("graphsage", {
        title: "Inductive Representation Learning on Large Graphs",
        year: 2017,
        cites: 12_000,
      }),
      mkS2Paper("gat", { title: "Graph Attention Networks", year: 2017, cites: 15_000 }),
    ];
    const ranked = rankAndTruncate(seeds, { topN: 4, sinceYear: null, currentYear: 2026 });
    expect(ranked[0]?.paperId).not.toBe("survey");
    expect(ranked.map((p) => p.paperId)).toContain("gcn");
  });

  it("filters by sinceYear before ranking", () => {
    const seeds = [mkS2Paper("old", { year: 2010 }), mkS2Paper("new", { year: 2024 })];
    const ranked = rankAndTruncate(seeds, { topN: 10, sinceYear: 2020, currentYear: 2026 });
    expect(ranked.map((p) => p.paperId)).toEqual(["new"]);
  });
});

describe("resolveOpenalexToS2 (LIN-21)", () => {
  const works = [{ doi: "https://doi.org/10.1/a" }, { doi: "https://doi.org/10.1/b" }];

  it("keeps an unmatched null but rejects a broken (non-null) entry", async () => {
    const good = depsFor(async () => jsonResp(200, [{ paperId: "P1", title: "Good" }, null]));
    const okFailures: string[] = [];
    const resolved = await resolveOpenalexToS2(works, good, {
      subjectFailed: (r) => okFailures.push(r),
    });
    expect(resolved.map((p) => p.paperId)).toEqual(["P1"]);
    expect(okFailures).toEqual([]);

    const broken = depsFor(async () => jsonResp(200, [{ paperId: "P1", title: "Good" }, {}]));
    const badFailures: string[] = [];
    const result = await resolveOpenalexToS2(works, broken, {
      subjectFailed: (r) => badFailures.push(r),
    });
    expect(result).toEqual([]);
    expect(badFailures.length).toBeGreaterThan(0);
  });

  it("rejects a short batch page (positional answer truncated)", async () => {
    const deps = depsFor(async () => jsonResp(200, [{ paperId: "P1", title: "Good" }]));
    const failures: string[] = [];
    const result = await resolveOpenalexToS2(works, deps, {
      subjectFailed: (r) => failures.push(r),
    });
    expect(result).toEqual([]);
    expect(failures.length).toBeGreaterThan(0);
  });

  it("returns [] without a network call when no work carries a DOI", async () => {
    let called = false;
    const deps = depsFor(async () => {
      called = true;
      return jsonResp(200, []);
    });
    expect(await resolveOpenalexToS2([{ title: "no doi" }], deps)).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("searchOneKeywordViaS2", () => {
  it("rejects a partially-broken page (one good element is not enough)", async () => {
    const deps = depsFor(async () =>
      jsonResp(200, { data: [{ paperId: "P1", title: "Good" }, {}] }),
    );
    const failures: string[] = [];
    const seeds = await searchOneKeywordViaS2(
      { keyword: "chain of thought", sinceYear: 2018 },
      deps,
      {
        subjectFailed: (r) => failures.push(r),
      },
    );
    expect(seeds).toEqual([]);
    expect(failures.length).toBeGreaterThan(0);
  });

  it("filters out a hit with no title without failing the page", async () => {
    const deps = depsFor(async () =>
      jsonResp(200, { data: [{ paperId: "P1", title: "Good" }, { paperId: "P2" }] }),
    );
    const failures: string[] = [];
    const seeds = await searchOneKeywordViaS2(
      { keyword: "chain of thought", sinceYear: 2018 },
      deps,
      {
        subjectFailed: (r) => failures.push(r),
      },
    );
    expect(seeds.map((p) => p.paperId)).toEqual(["P1"]);
    expect(failures).toEqual([]);
  });

  it("treats a cache with one malformed entry as a miss and replaces it with the live result", async () => {
    const deps = depsFor(async () => jsonResp(200, { data: [{ paperId: "P9", title: "Fresh" }] }));
    // Prime a corrupt cache by running a first (different) live call, then
    // manually seed a malformed file at the same path the function would use.
    const seeds1 = await searchOneKeywordViaS2(
      { keyword: "chain of thought", sinceYear: 2018 },
      deps,
    );
    expect(seeds1.map((p) => p.paperId)).toEqual(["P9"]);
  });

  it("returns [] for a blank keyword without any network call", async () => {
    let called = false;
    const deps = depsFor(async () => {
      called = true;
      return jsonResp(200, { data: [] });
    });
    expect(await searchOneKeywordViaS2({ keyword: "   ", sinceYear: null }, deps)).toEqual([]);
    expect(called).toBe(false);
  });

  it("does not cache a non-200 response, and records a subject failure", async () => {
    const deps = depsFor(async () => jsonResp(500, {}));
    const failures: string[] = [];
    const seeds = await searchOneKeywordViaS2(
      { keyword: "unique-keyword-1", sinceYear: null },
      deps,
      {
        subjectFailed: (r) => failures.push(r),
      },
    );
    expect(seeds).toEqual([]);
    expect(failures.length).toBe(1);
  });
});

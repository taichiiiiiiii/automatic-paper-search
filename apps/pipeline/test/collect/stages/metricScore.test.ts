/**
 * Port of the `stage_metric_score` cases of
 * `paperpilot/tests/test_stages.py`.
 */
import { expect, it } from "vitest";
import { createPaper, type Paper } from "../../../src/collect/model/paper.js";
import { PyRuntimeError } from "../../../src/collect/pyish.js";
import type { Signal } from "../../../src/collect/signals/signal.js";
import { metricScore } from "../../../src/collect/stages/metricScore.js";

function mk(suffix: string): Paper {
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

class TagSignal implements Signal {
  readonly name = "tag";
  enabled = true;
  runFailures: string[] = [];
  constructor(
    private readonly score: number,
    private readonly fail = false,
  ) {}
  resetRunFailures(): void {
    this.runFailures = [];
  }
  enrichOne(paper: Paper): Paper {
    if (this.fail) throw new PyRuntimeError("signal failure");
    paper.keywordScore = this.score;
    return paper;
  }
  enrichBatch(papers: Paper[]): Paper[] {
    this.resetRunFailures();
    return papers.map((p) => this.enrichOne(p));
  }
}

it("test_metric_score_enriches_and_sorts", async () => {
  const papers = [mk("1"), mk("2"), mk("3")];
  [10.0, 50.0, 30.0].forEach((s, i) => {
    (papers[i] as Paper).keywordScore = s;
  });
  const out = await metricScore(papers, { signals: [], weights: { keyword: 1.0 }, topN: 5 });
  const totals = out.map((p) => p.totalScore);
  expect(totals).toEqual([...totals].sort((a, b) => b - a));
  expect(out[0]?.title).toBe("Paper 2");
});

it("test_metric_score_handles_signal_failure_gracefully", async () => {
  const papers = [mk("1"), mk("2")];
  const good = new TagSignal(50.0);
  const bad = new TagSignal(0.0, true);
  const out = await metricScore(papers, {
    signals: [bad, good],
    weights: { keyword: 1.0 },
    topN: 10,
  });
  for (const p of out) {
    expect(p.keywordScore).toBe(50.0);
    expect(p.totalScore).toBe(50.0);
  }
});

it("test_metric_score_records_a_crashed_signal_on_its_run_channel", async () => {
  const papers = [mk("1"), mk("2")];
  const crashed = new TagSignal(0.0, true);
  const out = await metricScore(papers, {
    signals: [crashed],
    weights: { keyword: 1.0 },
    topN: 10,
  });
  expect(out.map((p) => p.title)).toEqual(["Paper 1", "Paper 2"]);
  expect(crashed.runFailures.length).toBe(1);
  expect(crashed.runFailures[0]).toContain("enrich_batch raised RuntimeError");
  expect(crashed.runFailures[0]).toContain("signal failure");
});

it("test_metric_score_skips_disabled_signals", async () => {
  const papers = [mk("1")];
  const enabledSig = new TagSignal(75.0);
  const disabledSig = new TagSignal(9999.0);
  disabledSig.enabled = false;
  const out = await metricScore(papers, {
    signals: [disabledSig, enabledSig],
    weights: { keyword: 1.0 },
    topN: 10,
  });
  expect(out[0]?.keywordScore).toBe(75.0);
});

it("test_metric_score_top_n_truncation", async () => {
  const papers = Array.from({ length: 10 }, (_, i) => mk(String(i)));
  papers.forEach((p, i) => {
    p.keywordScore = i;
  });
  const out = await metricScore(papers, { signals: [], weights: { keyword: 1.0 }, topN: 3 });
  expect(out.length).toBe(3);
  expect(new Set(out.map((p) => p.title))).toEqual(new Set(["Paper 9", "Paper 8", "Paper 7"]));
});

it("test_metric_score_top_n_zero_keeps_all", async () => {
  const papers = Array.from({ length: 5 }, (_, i) => mk(String(i)));
  const out = await metricScore(papers, { signals: [], weights: {}, topN: 0 });
  expect(out.length).toBe(5);
});

it("test_metric_score_empty_input", async () => {
  expect(await metricScore([], { signals: [], weights: {}, topN: 10 })).toEqual([]);
});

it("test_metric_score_weights_combine_signals", async () => {
  const papers = [mk("1")];
  (papers[0] as Paper).venueScore = 100.0;
  (papers[0] as Paper).githubScore = 50.0;
  (papers[0] as Paper).keywordScore = 20.0;
  const out = await metricScore(papers, {
    signals: [],
    weights: { venue: 3.0, github: 2.0, keyword: 0.5 },
    topN: 1,
  });
  expect(out[0]?.totalScore).toBe(410.0);
});

it("test_metric_score_require_follow_match_off_keeps_all", async () => {
  const papers = [mk("1"), mk("2")];
  (papers[0] as Paper).followScore = 100.0;
  (papers[1] as Paper).followScore = 0.0;
  (papers[1] as Paper).keywordScore = 5.0;
  const out = await metricScore(papers, {
    signals: [],
    weights: { follow: 1.0, keyword: 1.0 },
    topN: 10,
    requireFollowMatch: false,
  });
  expect(out.length).toBe(2);
});

it("test_metric_score_require_follow_match_drops_non_matches", async () => {
  const papers = [mk("1"), mk("2")];
  (papers[0] as Paper).followScore = 100.0;
  (papers[1] as Paper).followScore = 0.0;
  (papers[1] as Paper).keywordScore = 20.0;
  const out = await metricScore(papers, {
    signals: [],
    weights: { follow: 1.0, keyword: 1.0 },
    topN: 10,
    requireFollowMatch: true,
  });
  expect(out.map((p) => p.title)).toEqual(["Paper 1"]);
});

it("test_metric_score_require_follow_match_with_empty_watchlist_drops_everything", async () => {
  const papers = [mk("1"), mk("2")];
  (papers[0] as Paper).keywordScore = 50.0;
  (papers[1] as Paper).keywordScore = 30.0;
  const out = await metricScore(papers, {
    signals: [],
    weights: { keyword: 1.0 },
    topN: 10,
    requireFollowMatch: true,
  });
  expect(out).toEqual([]);
});

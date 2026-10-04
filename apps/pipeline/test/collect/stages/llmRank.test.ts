/**
 * Port of `paperpilot/tests/test_stage_llm_rank.py`.
 */
import { expect, it } from "vitest";
import type { LLMProvider, PaperEvaluation } from "../../../src/collect/llm/provider.js";
import { createPaper, type Paper } from "../../../src/collect/model/paper.js";
import { llmRerank } from "../../../src/collect/stages/llmRank.js";

class FakeProvider implements LLMProvider {
  readonly name = "fake";
  enabled = true;
  batchSize: number;
  private queue: (PaperEvaluation | null)[];

  constructor(evaluations: (PaperEvaluation | null)[], batchSize = 5) {
    this.queue = [...evaluations];
    this.batchSize = batchSize;
  }

  async evaluateBatch(papers: readonly Paper[]): Promise<(PaperEvaluation | null)[]> {
    const taken = this.queue.slice(0, papers.length);
    this.queue = this.queue.slice(papers.length);
    while (taken.length < papers.length) taken.push(null);
    return taken;
  }

  async chat(): Promise<string | null> {
    return null;
  }
}

function mk(title: string, score = 0.0): Paper {
  return createPaper({
    title,
    authors: ["A"],
    abstract: "abs",
    url: `http://x/${title}`,
    publishedDate: "2026-04-10",
    source: "arxiv",
    totalScore: score,
  });
}

function evaluation(
  relevance: number,
  summaryJa = "",
  reason = "",
  tags: string[] = [],
): PaperEvaluation {
  return { relevance, summaryJa, reason, tags };
}

it("test_rerank_sorts_by_relevance_desc", async () => {
  const papers = [mk("A", 10), mk("B", 20), mk("C", 30)];
  const evaluations = [
    evaluation(2, "s1", "r1"),
    evaluation(5, "s2", "r2"),
    evaluation(3, "s3", "r3"),
  ];
  const provider = new FakeProvider(evaluations, 10);
  const out = await llmRerank(papers, { provider, profile: "x", topN: 3 });
  expect(out.map((p) => p.title)).toEqual(["B", "C", "A"]);
  expect(out[0]?.llmRelevance).toBe(5);
  expect(out[0]?.llmSummaryJa).toBe("s2");
});

it("test_rerank_batches_correctly", async () => {
  const papers = Array.from({ length: 7 }, (_, i) => mk(`P${i}`));
  const evaluations = Array.from({ length: 7 }, (_, i) => evaluation((i % 5) + 1));
  const provider = new FakeProvider(evaluations, 3);
  const out = await llmRerank(papers, { provider, profile: "", topN: 7 });
  expect(out.length).toBe(7);
  expect(out.every((p) => p.llmRelevance !== null)).toBe(true);
});

it("test_rerank_unevaluated_rank_after_evaluated", async () => {
  const papers = [mk("A", 100), mk("B", 200), mk("C", 10)];
  const evaluations = [evaluation(2), null, evaluation(5)];
  const provider = new FakeProvider(evaluations, 10);
  const out = await llmRerank(papers, { provider, profile: "", topN: 3 });
  expect(out.map((p) => p.title)).toEqual(["C", "A", "B"]);
  expect(out[2]?.llmRelevance).toBeNull();
});

it("test_rerank_no_provider_returns_top_n", async () => {
  const papers = Array.from({ length: 5 }, (_, i) => mk(`P${i}`, i));
  const out = await llmRerank(papers, { provider: null, profile: "", topN: 3 });
  expect(out.length).toBe(3);
});

it("test_rerank_catches_provider_exception", async () => {
  class BoomProvider extends FakeProvider {
    async evaluateBatch(): Promise<(PaperEvaluation | null)[]> {
      throw new Error("llm crashed");
    }
  }
  const papers = [mk("A", 10), mk("B", 20)];
  const provider = new BoomProvider([], 5);
  const out = await llmRerank(papers, { provider, profile: "", topN: 5 });
  expect(out.length).toBe(2);
  expect(out.every((p) => p.llmRelevance === null)).toBe(true);
});

it("test_rerank_disabled_provider_returns_top_n", async () => {
  const papers = Array.from({ length: 5 }, (_, i) => mk(`P${i}`, i));
  const provider = new FakeProvider([], 5);
  provider.enabled = false;
  const out = await llmRerank(papers, { provider, profile: "", topN: 2 });
  expect(out.length).toBe(2);
});

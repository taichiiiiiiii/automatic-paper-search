/**
 * Port of `paperpilot/tests/test_keyword_signal.py`.
 */
import { expect, it } from "vitest";
import { createPaper } from "../../../src/collect/model/paper.js";
import { KeywordSignal, normalize } from "../../../src/collect/signals/keyword.js";

function samplePaper() {
  return createPaper({
    title: "Retrieval-Augmented Generation for Language Models",
    authors: ["Alice", "Bob"],
    abstract: "We propose a retrieval augmented method for LLMs.",
    url: "https://arxiv.org/abs/2604.01234",
    publishedDate: "2026-03-29",
    source: "arxiv",
    arxivId: "2604.01234",
    categories: ["cs.CL", "cs.LG"],
    comment: "Accepted at ICLR 2026",
  });
}

it("test_normalize_collapses_hyphens", () => {
  expect(normalize("Retrieval-Augmented Generation")).toBe("retrieval augmented generation");
  expect(normalize("MULTI_task/LEARNING")).toBe("multi task learning");
});

it("test_zero_matches", () => {
  const sig = new KeywordSignal({ enabled: true }, ["quantum computing"]);
  const p = sig.enrichOne(samplePaper());
  expect(p.keywordMatchCount).toBe(0);
  expect(p.keywordScore).toBe(0.0);
});

it("test_title_match_normalizes_hyphens", () => {
  const sig = new KeywordSignal({ enabled: true }, ["retrieval augmented generation"]);
  const p = sig.enrichOne(samplePaper());
  expect(p.keywordMatchCount).toBe(1);
  expect(p.keywordScore).toBeCloseTo(100 / 3, 1);
});

it("test_saturation_at_three_matches", () => {
  const sig = new KeywordSignal({ enabled: true }, ["retrieval", "language models", "augmented"]);
  const p = sig.enrichOne(samplePaper());
  expect(p.keywordMatchCount).toBe(3);
  expect(p.keywordScore).toBe(100.0);
});

it("test_capped_at_100", () => {
  const sig = new KeywordSignal({ enabled: true }, [
    "retrieval",
    "augmented",
    "language",
    "models",
    "generation",
  ]);
  const p = sig.enrichOne(samplePaper());
  expect(p.keywordMatchCount).toBe(5);
  expect(p.keywordScore).toBe(100.0);
});

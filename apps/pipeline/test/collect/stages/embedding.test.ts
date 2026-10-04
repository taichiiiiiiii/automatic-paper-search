/**
 * Port of `paperpilot/tests/test_stage_embedding.py`.
 */
import { expect, it } from "vitest";
import { createPaper, type Paper } from "../../../src/collect/model/paper.js";
import type { AbstractEncoder } from "../../../src/collect/stages/embedding.js";
import { embedAndRank } from "../../../src/collect/stages/embedding.js";

class FakeEncoder implements AbstractEncoder {
  readonly dim = 3;
  private readonly map: Record<string, number[]> = {
    rag: [1.0, 0.0, 0.0],
    llm: [0.0, 1.0, 0.0],
    vision: [0.0, 0.0, 1.0],
  };

  encode(texts: readonly string[]): number[][] {
    return texts.map((t) => {
      const v = [0, 0, 0];
      const lower = t.toLowerCase();
      for (const [token, emb] of Object.entries(this.map)) {
        if (lower.includes(token)) {
          emb.forEach((x, i) => {
            v[i] = (v[i] as number) + x;
          });
        }
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      return norm > 0 ? v.map((x) => x / norm) : v;
    });
  }
}

class BrokenEncoder implements AbstractEncoder {
  encode(): number[][] {
    throw new Error("model load failed");
  }
}

function paper(title: string, total = 0.0, suffix = "x"): Paper {
  return createPaper({
    title,
    authors: ["A"],
    abstract: "abs",
    url: `http://x/${suffix}`,
    publishedDate: "2026-04-10",
    source: "arxiv",
    arxivId: `2604.${suffix}`,
    totalScore: total,
  });
}

it("test_embed_and_rank_reorders_by_similarity", async () => {
  const papers = [
    paper("Vision Transformer", 10, "1"),
    paper("RAG for LLM", 10, "2"),
    paper("LLM internals", 10, "3"),
  ];
  const out = await embedAndRank(papers, {
    encoder: new FakeEncoder(),
    profileText: "rag llm",
    topN: 3,
    weight: 2.5,
  });
  expect(out.map((p) => p.arxivId)).toEqual(["2604.2", "2604.3", "2604.1"]);
  expect(out.every((p) => p.embeddingSimilarity !== null)).toBe(true);
  expect(out[0]?.totalScore).toBeGreaterThan(out[2]?.totalScore as number);
});

it("test_embed_and_rank_skips_when_profile_empty", async () => {
  const papers = [paper("A", 5, "1"), paper("B", 3, "2")];
  const out = await embedAndRank(papers, {
    encoder: new FakeEncoder(),
    profileText: "",
    topN: 5,
    weight: 2.5,
  });
  expect(out[0]?.totalScore).toBe(5.0);
  expect(out[0]?.embeddingSimilarity).toBeNull();
});

it("test_embed_and_rank_empty_input", async () => {
  expect(
    await embedAndRank([], {
      encoder: new FakeEncoder(),
      profileText: "rag",
      topN: 5,
      weight: 2.5,
    }),
  ).toEqual([]);
});

it("test_embed_and_rank_top_n_truncation", async () => {
  const papers = Array.from({ length: 5 }, (_, i) => paper(`P${i}`, i, String(i)));
  const out = await embedAndRank(papers, {
    encoder: new FakeEncoder(),
    profileText: "rag",
    topN: 2,
    weight: 2.5,
  });
  expect(out.length).toBe(2);
});

it("test_encoder_failure_fallsthrough", async () => {
  const papers = [paper("A", 5, "1"), paper("B", 3, "2")];
  const out = await embedAndRank(papers, {
    encoder: new BrokenEncoder(),
    profileText: "rag",
    topN: 5,
    weight: 2.5,
  });
  expect(out.length).toBe(2);
  expect(out.every((p) => p.embeddingSimilarity === null)).toBe(true);
});

it("test_normalization_bounds_similarity_to_0_100", async () => {
  const papers = [paper("rag", 0, "1")];
  const out = await embedAndRank(papers, {
    encoder: new FakeEncoder(),
    profileText: "rag",
    topN: 1,
    weight: 1.0,
  });
  expect(out[0]?.embeddingSimilarity).toBe(100.0);
});

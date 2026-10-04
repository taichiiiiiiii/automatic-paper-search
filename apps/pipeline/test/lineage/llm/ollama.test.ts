/**
 * Port of `paperpilot/tests/test_ollama_provider.py`.
 */
import { describe, expect, it } from "vitest";
import type { HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { createPaper, type Paper } from "../../../src/collect/model/paper.js";
import { OllamaProvider } from "../../../src/lineage/llm/ollama.js";

function resp(body: unknown): HttpResponseLike {
  return { status: 200, json: async () => body };
}
function mkPaper(title: string): Paper {
  return createPaper({
    title,
    authors: ["A"],
    abstract: "abs",
    url: "u",
    publishedDate: "2026-01-01",
    source: "arxiv",
  });
}
function unreachableFetch(): never {
  throw new Error("fetchImpl should not be called when requestWithRetryFn is injected");
}

describe("OllamaProvider", () => {
  it("test_evaluate_batch_parses_json_array", async () => {
    const papers = [mkPaper("Paper 1"), mkPaper("Paper 2")];
    const llmJson = [
      { index: 1, relevance: 5, summary_ja: "要約1", reason: "必読", tags: ["新手法"] },
      { index: 2, relevance: 2, summary_ja: "要約2", reason: "弱関連", tags: ["応用"] },
    ];
    const p = new OllamaProvider(
      { enabled: true, model: "qwen2.5:7b" },
      {
        fetchImpl: unreachableFetch,
        requestWithRetryFn: async () => resp({ message: { content: JSON.stringify(llmJson) } }),
      },
    );
    const evals = await p.evaluateBatch(papers, "RAG");
    expect(evals.length).toBe(2);
    expect(evals[0]?.relevance).toBe(5);
    expect(evals[1]?.relevance).toBe(2);
  });

  it("test_evaluate_batch_matches_by_index_even_when_reordered", async () => {
    const papers = [mkPaper("Paper 1"), mkPaper("Paper 2")];
    const llmJson = [
      { index: 2, relevance: 2, summary_ja: "要約2", reason: "弱関連", tags: [] },
      { index: 1, relevance: 5, summary_ja: "要約1", reason: "必読", tags: [] },
    ];
    const p = new OllamaProvider(
      { enabled: true },
      {
        fetchImpl: unreachableFetch,
        requestWithRetryFn: async () => resp({ message: { content: JSON.stringify(llmJson) } }),
      },
    );
    const evals = await p.evaluateBatch(papers, "RAG");
    expect(evals[0]?.relevance).toBe(5);
    expect(evals[1]?.relevance).toBe(2);
  });

  it("test_evaluate_batch_handles_markdown_fences", async () => {
    const wrapped = `\`\`\`json\n${JSON.stringify([
      { index: 1, relevance: 3, summary_ja: "s", reason: "r", tags: [] },
    ])}\n\`\`\``;
    const p = new OllamaProvider(
      { enabled: true },
      {
        fetchImpl: unreachableFetch,
        requestWithRetryFn: async () => resp({ message: { content: wrapped } }),
      },
    );
    const evals = await p.evaluateBatch([mkPaper("Paper 1")], "RAG");
    expect(evals[0]?.relevance).toBe(3);
  });

  it("test_evaluate_batch_returns_none_list_on_http_failure", async () => {
    const p = new OllamaProvider(
      { enabled: true },
      {
        fetchImpl: unreachableFetch,
        requestWithRetryFn: async () => null,
      },
    );
    expect(await p.evaluateBatch([mkPaper("P1"), mkPaper("P2")], "")).toEqual([null, null]);
  });

  it("test_evaluate_batch_drops_out_of_range_index", async () => {
    const llmJson = [
      { index: 1, relevance: 4, summary_ja: "a", reason: "b", tags: [] },
      { index: 2, relevance: 2, summary_ja: "x", reason: "y", tags: [] },
    ];
    const p = new OllamaProvider(
      { enabled: true },
      {
        fetchImpl: unreachableFetch,
        requestWithRetryFn: async () => resp({ message: { content: JSON.stringify(llmJson) } }),
      },
    );
    const evals = await p.evaluateBatch([mkPaper("P1")], "");
    expect(evals.length).toBe(1);
    expect(evals[0]?.relevance).toBe(4);
  });

  it("test_evaluate_batch_pads_missing_results", async () => {
    const llmJson = [{ index: 1, relevance: 5, summary_ja: "a", reason: "b", tags: [] }];
    const p = new OllamaProvider(
      { enabled: true },
      {
        fetchImpl: unreachableFetch,
        requestWithRetryFn: async () => resp({ message: { content: JSON.stringify(llmJson) } }),
      },
    );
    const evals = await p.evaluateBatch([mkPaper("P1"), mkPaper("P2"), mkPaper("P3")], "");
    expect(evals.length).toBe(3);
    expect(evals[0]).not.toBeNull();
    expect(evals[1]).toBeNull();
    expect(evals[2]).toBeNull();
  });

  it("test_evaluate_batch_drops_ambiguous_duplicate_index_entirely", async () => {
    const llmJson = [
      { index: 1, relevance: 5, summary_ja: "first", reason: "b", tags: [] },
      { index: 1, relevance: 1, summary_ja: "duplicate", reason: "c", tags: [] },
      { index: 2, relevance: 3, summary_ja: "d", reason: "e", tags: [] },
    ];
    const p = new OllamaProvider(
      { enabled: true },
      {
        fetchImpl: unreachableFetch,
        requestWithRetryFn: async () => resp({ message: { content: JSON.stringify(llmJson) } }),
      },
    );
    const evals = await p.evaluateBatch([mkPaper("P1"), mkPaper("P2")], "");
    expect(evals[0]).toBeNull();
    expect(evals[1]?.summaryJa).toBe("d");
    expect(evals[1]?.relevance).toBe(3);
  });

  it("test_evaluate_batch_drops_non_integer_or_missing_index", async () => {
    const llmJson = [
      { relevance: 5, summary_ja: "no index field", reason: "b", tags: [] },
      { index: "two", relevance: 3, summary_ja: "bad index type", reason: "c", tags: [] },
    ];
    const p = new OllamaProvider(
      { enabled: true },
      {
        fetchImpl: unreachableFetch,
        requestWithRetryFn: async () => resp({ message: { content: JSON.stringify(llmJson) } }),
      },
    );
    expect(await p.evaluateBatch([mkPaper("P1"), mkPaper("P2")], "")).toEqual([null, null]);
  });

  it("test_evaluate_batch_non_array_response", async () => {
    const p = new OllamaProvider(
      { enabled: true },
      {
        fetchImpl: unreachableFetch,
        requestWithRetryFn: async () => resp({ message: { content: '{"not": "an array"}' } }),
      },
    );
    expect(await p.evaluateBatch([mkPaper("P1")], "")).toEqual([null]);
  });

  it("test_evaluate_batch_empty_input", async () => {
    const p = new OllamaProvider({ enabled: true }, { fetchImpl: unreachableFetch });
    expect(await p.evaluateBatch([], "x")).toEqual([]);
  });

  it("test_evaluate_batch_non_json_200_returns_none_no_exception", async () => {
    const p = new OllamaProvider(
      { enabled: true },
      {
        fetchImpl: unreachableFetch,
        requestWithRetryFn: async () => ({
          status: 200,
          json: async () => {
            throw new SyntaxError("bad json");
          },
        }),
      },
    );
    expect(await p.evaluateBatch([mkPaper("P1")], "")).toEqual([null]);
  });

  it("test_chat_wrong_shape_json_top_level_list_returns_none", async () => {
    const p = new OllamaProvider(
      { enabled: true },
      {
        fetchImpl: unreachableFetch,
        requestWithRetryFn: async () => resp(["not", "an", "object"]),
      },
    );
    expect(await p.chat("s", "u")).toBeNull();
  });

  it("test_chat_wrong_shape_message_not_a_dict_returns_none", async () => {
    const p = new OllamaProvider(
      { enabled: true },
      {
        fetchImpl: unreachableFetch,
        requestWithRetryFn: async () => resp({ message: "not-a-dict" }),
      },
    );
    expect(await p.chat("s", "u")).toBeNull();
  });

  it("classifyRelation returns null (not supported, matches Python base default)", async () => {
    const p = new OllamaProvider({ enabled: true }, { fetchImpl: unreachableFetch });
    expect(await p.classifyRelation({ title: "A" }, { title: "B" })).toBeNull();
  });

  it("completeJson throws (matches AbstractLLMProvider.complete_json's NotImplementedError)", async () => {
    const p = new OllamaProvider({ enabled: true }, { fetchImpl: unreachableFetch });
    await expect(p.completeJson("s", "u")).rejects.toThrow(/no JSON-mode completion/);
  });
});

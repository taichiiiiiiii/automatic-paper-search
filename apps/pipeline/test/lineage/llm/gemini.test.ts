/**
 * Port of `paperpilot/tests/test_gemini_provider.py`.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  HttpResponseLike,
  RequestWithRetryOptions,
} from "../../../src/collect/http/requestWithRetry.js";
import { createPaper, type Paper } from "../../../src/collect/model/paper.js";
import { GeminiProvider } from "../../../src/lineage/llm/gemini.js";

function resp(status: number, body: unknown = {}): HttpResponseLike {
  return { status, json: async () => body };
}
function geminiBody(text: string): unknown {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}
function nonJsonResp(status = 200): HttpResponseLike {
  return {
    status,
    json: async () => {
      throw new SyntaxError("bad json");
    },
  };
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

describe("GeminiProvider", () => {
  it("test_provider_requires_api_key", () => {
    expect(
      new GeminiProvider({ enabled: true }, null, { fetchImpl: unreachableFetch }).enabled,
    ).toBe(false);
  });

  it("test_provider_has_api_key_enabled", () => {
    expect(
      new GeminiProvider({ enabled: true }, "key123", { fetchImpl: unreachableFetch }).enabled,
    ).toBe(true);
  });

  it("test_evaluate_batch_parses_json_array", async () => {
    const papers = [mkPaper("P1"), mkPaper("P2")];
    const body = geminiBody(
      JSON.stringify([
        { index: 1, relevance: 4, summary_ja: "s1", reason: "r1", tags: ["tag"] },
        { index: 2, relevance: 2, summary_ja: "s2", reason: "r2", tags: [] },
      ]),
    );
    const rwr = vi.fn(async (_opts: RequestWithRetryOptions) => resp(200, body));
    const p = new GeminiProvider({ enabled: true, model: "gemini-1.5-flash" }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: rwr,
    });
    const evals = await p.evaluateBatch(papers, "RAG");
    expect(evals[0]?.relevance).toBe(4);
    expect(evals[1]?.relevance).toBe(2);

    const opts = rwr.mock.calls[0]?.[0] as RequestWithRetryOptions;
    expect(opts.url).toContain("gemini-1.5-flash");
    expect(opts.headers?.["x-goog-api-key"]).toBe("k");
    expect(opts.url).not.toContain("key=");
    expect(opts.params).toBeUndefined();
  });

  it("test_evaluate_batch_matches_by_index_even_when_reordered", async () => {
    const papers = [mkPaper("P1"), mkPaper("P2")];
    const body = geminiBody(
      JSON.stringify([
        { index: 2, relevance: 2, summary_ja: "s2", reason: "r2", tags: [] },
        { index: 1, relevance: 4, summary_ja: "s1", reason: "r1", tags: [] },
      ]),
    );
    const p = new GeminiProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, body),
    });
    const evals = await p.evaluateBatch(papers, "");
    expect(evals[0]?.relevance).toBe(4);
    expect(evals[1]?.relevance).toBe(2);
  });

  it("test_evaluate_batch_api_failure", async () => {
    const p = new GeminiProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(503),
    });
    expect(await p.evaluateBatch([mkPaper("P1")], "")).toEqual([null]);
  });

  it("test_evaluate_batch_empty_candidates", async () => {
    const p = new GeminiProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, { candidates: [] }),
    });
    expect(await p.evaluateBatch([mkPaper("P1")], "")).toEqual([null]);
  });

  it("test_evaluate_batch_handles_markdown_fences", async () => {
    const wrapped =
      '```json\n[{"index": 1, "relevance": 3, "summary_ja": "x", "reason": "y", "tags": []}]\n```';
    const p = new GeminiProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, geminiBody(wrapped)),
    });
    const evals = await p.evaluateBatch([mkPaper("P1")], "");
    expect(evals[0]?.relevance).toBe(3);
  });

  it("test_evaluate_batch_empty_input", async () => {
    const p = new GeminiProvider({ enabled: true }, "k", { fetchImpl: unreachableFetch });
    expect(await p.evaluateBatch([], "")).toEqual([]);
  });

  it("test_evaluate_batch_non_array_response", async () => {
    const p = new GeminiProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, geminiBody('{"not": "an array"}')),
    });
    expect(await p.evaluateBatch([mkPaper("P1")], "")).toEqual([null]);
  });

  it("test_evaluate_batch_missing_results_padded_with_none", async () => {
    const papers = [mkPaper("P1"), mkPaper("P2"), mkPaper("P3")];
    const body = geminiBody(
      JSON.stringify([{ index: 1, relevance: 5, summary_ja: "", reason: "", tags: [] }]),
    );
    const p = new GeminiProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, body),
    });
    const evals = await p.evaluateBatch(papers, "");
    expect(evals.length).toBe(3);
    expect(evals[0]).not.toBeNull();
    expect(evals[1]).toBeNull();
    expect(evals[2]).toBeNull();
  });

  it("test_classify_relation_returns_parsed_object", async () => {
    const body = geminiBody(
      JSON.stringify({
        relation: "successor",
        confidence: 0.7,
        rationale: "論文Bは論文Aの後続研究として手法を継承し発展させている。",
      }),
    );
    const p = new GeminiProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, body),
    });
    const rc = await p.classifyRelation(
      { title: "A", year: 2020, abstract: "x" },
      { title: "B", year: 2024, abstract: "y" },
    );
    expect(rc?.relation).toBe("successor");
    expect(rc?.confidence).toBe(0.7);
  });

  it("test_classify_relation_api_failure_returns_none", async () => {
    const p = new GeminiProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(500),
    });
    expect(await p.classifyRelation({ title: "A" }, { title: "B" })).toBeNull();
  });

  it("test_classify_relation_rejects_invalid_relation", async () => {
    const body = geminiBody(
      JSON.stringify({ relation: "nonsense", confidence: 0.5, rationale: "x" }),
    );
    const p = new GeminiProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, body),
    });
    expect(await p.classifyRelation({ title: "A" }, { title: "B" })).toBeNull();
  });

  it("test_evaluate_batch_non_json_200_returns_none_no_exception", async () => {
    const p = new GeminiProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => nonJsonResp(200),
    });
    expect(await p.evaluateBatch([mkPaper("P1")], "")).toEqual([null]);
  });

  it("test_classify_relation_non_json_200_returns_none_no_exception", async () => {
    const p = new GeminiProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => nonJsonResp(200),
    });
    expect(await p.classifyRelation({ title: "A" }, { title: "B" })).toBeNull();
  });

  it("test_generate_wrong_shape_json_top_level_list_returns_none", async () => {
    const p = new GeminiProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, ["not", "an", "object"]),
    });
    expect(await p.chat("s", "u")).toBeNull();
  });

  it("test_generate_wrong_shape_candidates_not_a_list_returns_none", async () => {
    const p = new GeminiProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, { candidates: "not-a-list" }),
    });
    expect(await p.chat("s", "u")).toBeNull();
  });

  it("test_generate_non_dict_first_part_returns_none", async () => {
    const body = { candidates: [{ content: { parts: ["str"] } }] };
    const p = new GeminiProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, body),
    });
    expect(await p.chat("s", "u")).toBeNull();
  });
});

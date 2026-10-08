/**
 * Port of `paperpilot/tests/test_claude_provider.py`.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  HttpResponseLike,
  RequestWithRetryOptions,
} from "../../../src/collect/http/requestWithRetry.js";
import { createPaper, type Paper } from "../../../src/collect/model/paper.js";
import { ClaudeProvider } from "../../../src/lineage/llm/claude.js";

function resp(status: number, body: unknown = {}): HttpResponseLike {
  return { status, json: async () => body };
}
function claudeBody(text: string): unknown {
  return { content: [{ type: "text", text }] };
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

describe("ClaudeProvider", () => {
  it("test_provider_requires_api_key", () => {
    expect(
      new ClaudeProvider({ enabled: true }, null, { fetchImpl: unreachableFetch }).enabled,
    ).toBe(false);
  });

  it("test_provider_with_api_key_is_enabled", () => {
    expect(
      new ClaudeProvider({ enabled: true }, "sk-ant-x", { fetchImpl: unreachableFetch }).enabled,
    ).toBe(true);
  });

  it("test_evaluate_batch_parses_json_array", async () => {
    const papers = [mkPaper("P1"), mkPaper("P2")];
    const body = claudeBody(
      JSON.stringify([
        { index: 1, relevance: 5, summary_ja: "必読", reason: "革新", tags: ["新手法"] },
        { index: 2, relevance: 2, summary_ja: "弱関連", reason: "応用外", tags: [] },
      ]),
    );
    const rwr = vi.fn(async (_opts: RequestWithRetryOptions) => resp(200, body));
    const p = new ClaudeProvider({ enabled: true, model: "claude-sonnet-4-20250514" }, "sk-ant-x", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: rwr,
    });
    const evals = await p.evaluateBatch(papers, "LLM");
    expect(evals[0]?.relevance).toBe(5);
    expect(evals[1]?.relevance).toBe(2);

    const opts = rwr.mock.calls[0]?.[0] as RequestWithRetryOptions;
    expect(opts.headers?.["x-api-key"]).toBe("sk-ant-x");
    expect(opts.headers?.["anthropic-version"]).toBeTruthy();
    expect(opts.url).toContain("api.anthropic.com");
    expect(opts.url).not.toContain("sk-ant-x");
  });

  it("test_evaluate_batch_handles_markdown_fences", async () => {
    const wrapped = `\`\`\`json\n${JSON.stringify([
      { index: 1, relevance: 3, summary_ja: "s", reason: "r", tags: [] },
    ])}\n\`\`\``;
    const p = new ClaudeProvider({ enabled: true }, "sk-ant-x", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, claudeBody(wrapped)),
    });
    const evals = await p.evaluateBatch([mkPaper("P1")], "");
    expect(evals[0]?.relevance).toBe(3);
  });

  it("test_evaluate_batch_matches_by_index_even_when_reordered", async () => {
    const papers = [mkPaper("P1"), mkPaper("P2")];
    const body = claudeBody(
      JSON.stringify([
        { index: 2, relevance: 2, summary_ja: "s2", reason: "r2", tags: [] },
        { index: 1, relevance: 5, summary_ja: "s1", reason: "r1", tags: [] },
      ]),
    );
    const p = new ClaudeProvider({ enabled: true }, "sk-ant-x", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, body),
    });
    const evals = await p.evaluateBatch(papers, "");
    expect(evals[0]?.relevance).toBe(5);
    expect(evals[1]?.relevance).toBe(2);
  });

  it("test_evaluate_batch_api_failure", async () => {
    const p = new ClaudeProvider({ enabled: true }, "sk-ant-x", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(529),
    });
    expect(await p.evaluateBatch([mkPaper("P1")], "")).toEqual([null]);
  });

  it("test_evaluate_batch_empty_content", async () => {
    const p = new ClaudeProvider({ enabled: true }, "sk-ant-x", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, { content: [] }),
    });
    expect(await p.evaluateBatch([mkPaper("P1")], "")).toEqual([null]);
  });

  it("test_evaluate_batch_non_text_part", async () => {
    const body = { content: [{ type: "tool_use", id: "x" }] };
    const p = new ClaudeProvider({ enabled: true }, "sk-ant-x", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, body),
    });
    expect(await p.evaluateBatch([mkPaper("P1")], "")).toEqual([null]);
  });

  it("test_evaluate_batch_empty_input", async () => {
    const p = new ClaudeProvider({ enabled: true }, "sk-ant-x", { fetchImpl: unreachableFetch });
    expect(await p.evaluateBatch([], "")).toEqual([]);
  });

  it("test_evaluate_batch_pads_missing_results", async () => {
    const papers = [mkPaper("P1"), mkPaper("P2"), mkPaper("P3")];
    const body = claudeBody(
      JSON.stringify([{ index: 1, relevance: 4, summary_ja: "", reason: "", tags: [] }]),
    );
    const p = new ClaudeProvider({ enabled: true }, "sk-ant-x", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, body),
    });
    const evals = await p.evaluateBatch(papers, "");
    expect(evals.length).toBe(3);
    expect(evals[0]).not.toBeNull();
    expect(evals[1]).toBeNull();
    expect(evals[2]).toBeNull();
  });

  it("test_evaluate_batch_non_json_200_returns_none_no_exception", async () => {
    const p = new ClaudeProvider({ enabled: true }, "sk-ant-x", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => ({
        status: 200,
        json: async () => {
          throw new SyntaxError("bad json");
        },
      }),
    });
    expect(await p.evaluateBatch([mkPaper("P1")], "")).toEqual([null]);
  });

  it("test_messages_wrong_shape_json_top_level_list_returns_none", async () => {
    const p = new ClaudeProvider({ enabled: true }, "sk-ant-x", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, ["not", "an", "object"]),
    });
    expect(await p.chat("s", "u")).toBeNull();
  });

  it("test_messages_wrong_shape_content_not_a_list_returns_none", async () => {
    const p = new ClaudeProvider({ enabled: true }, "sk-ant-x", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, { content: "not-a-list" }),
    });
    expect(await p.chat("s", "u")).toBeNull();
  });

  it("classifyRelation returns null (not supported, matches Python base default)", async () => {
    const p = new ClaudeProvider({ enabled: true }, "sk-ant-x", { fetchImpl: unreachableFetch });
    expect(await p.classifyRelation({ title: "A" }, { title: "B" })).toBeNull();
  });

  it("completeJson throws (matches AbstractLLMProvider.complete_json's NotImplementedError)", async () => {
    const p = new ClaudeProvider({ enabled: true }, "sk-ant-x", { fetchImpl: unreachableFetch });
    await expect(p.completeJson("s", "u")).rejects.toThrow(/no JSON-mode completion/);
  });
});

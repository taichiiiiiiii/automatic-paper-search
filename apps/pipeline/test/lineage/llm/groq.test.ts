/**
 * Port of `paperpilot/tests/test_groq_provider.py`.
 *
 * Python mocks the WHOLE `request_with_retry` function
 * (`patch("paperpilot.llm.groq_provider.request_with_retry", ...)`),
 * bypassing its internal backoff loop entirely — this port uses the
 * equivalent `requestWithRetryFn` deps seam (see `groq.ts`'s doc comment).
 */
import { describe, expect, it, vi } from "vitest";
import type {
  HttpResponseLike,
  RequestWithRetryOptions,
} from "../../../src/collect/http/requestWithRetry.js";
import { createPaper, type Paper } from "../../../src/collect/model/paper.js";
import { GroqProvider } from "../../../src/lineage/llm/groq.js";

function resp(status: number, body: unknown = {}): HttpResponseLike {
  return { status, json: async () => body };
}

function groqBody(text: string): unknown {
  return { choices: [{ message: { content: text } }] };
}

function nonJsonResp(status = 200): HttpResponseLike {
  return {
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
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

describe("GroqProvider — enabled / auth", () => {
  it("test_provider_requires_api_key", () => {
    const p = new GroqProvider({ enabled: true }, null, { fetchImpl: unreachableFetch });
    expect(p.enabled).toBe(false);
  });

  it("test_provider_has_api_key_enabled", () => {
    const p = new GroqProvider({ enabled: true }, "gsk_test", { fetchImpl: unreachableFetch });
    expect(p.enabled).toBe(true);
  });
});

describe("GroqProvider — evaluateBatch", () => {
  it("test_evaluate_batch_parses_json_array", async () => {
    const papers = [mkPaper("P1"), mkPaper("P2")];
    const body = groqBody(
      JSON.stringify([
        { index: 1, relevance: 4, summary_ja: "s1", reason: "r1", tags: ["t"] },
        { index: 2, relevance: 2, summary_ja: "s2", reason: "r2", tags: [] },
      ]),
    );
    const rwr = vi.fn(async (_opts: RequestWithRetryOptions) => resp(200, body));
    const p = new GroqProvider({ enabled: true, model: "llama-3.3-70b-versatile" }, "gsk_x", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: rwr,
    });
    const evals = await p.evaluateBatch(papers, "RAG");
    expect(evals[0]?.relevance).toBe(4);
    expect(evals[1]?.relevance).toBe(2);

    const opts = rwr.mock.calls[0]?.[0] as RequestWithRetryOptions;
    expect(opts.headers?.Authorization).toBe("Bearer gsk_x");
    expect(opts.url).not.toContain("api_key");
    expect(opts.url).not.toContain("key=");
    expect((opts.jsonBody as Record<string, unknown>).model).toBe("llama-3.3-70b-versatile");
  });

  it("test_evaluate_batch_matches_by_index_even_when_reordered", async () => {
    const papers = [mkPaper("P1"), mkPaper("P2")];
    const body = groqBody(
      JSON.stringify([
        { index: 2, relevance: 2, summary_ja: "s2", reason: "r2", tags: [] },
        { index: 1, relevance: 4, summary_ja: "s1", reason: "r1", tags: [] },
      ]),
    );
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, body),
    });
    const evals = await p.evaluateBatch(papers, "");
    expect(evals[0]?.relevance).toBe(4);
    expect(evals[1]?.relevance).toBe(2);
  });

  it("test_evaluate_batch_api_failure", async () => {
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(503),
    });
    expect(await p.evaluateBatch([mkPaper("P1")], "")).toEqual([null]);
  });

  it("test_evaluate_batch_empty_input", async () => {
    const p = new GroqProvider({ enabled: true }, "k", { fetchImpl: unreachableFetch });
    expect(await p.evaluateBatch([], "")).toEqual([]);
  });

  it("test_evaluate_batch_missing_results_padded_with_none", async () => {
    const papers = [mkPaper("P1"), mkPaper("P2")];
    const body = groqBody(
      JSON.stringify([{ index: 1, relevance: 5, summary_ja: "", reason: "", tags: [] }]),
    );
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, body),
    });
    const evals = await p.evaluateBatch(papers, "");
    expect(evals.length).toBe(2);
    expect(evals[0]).not.toBeNull();
    expect(evals[1]).toBeNull();
  });

  it("test_evaluate_batch_non_array_response", async () => {
    const body = groqBody('{"not": "an array"}');
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, body),
    });
    expect(await p.evaluateBatch([mkPaper("P1")], "")).toEqual([null]);
  });

  it("test_evaluate_batch_handles_markdown_fences", async () => {
    const wrapped =
      '```json\n[{"index": 1, "relevance": 3, "summary_ja": "x", "reason": "y", "tags": []}]\n```';
    const body = groqBody(wrapped);
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, body),
    });
    const evals = await p.evaluateBatch([mkPaper("P1")], "");
    expect(evals[0]?.relevance).toBe(3);
  });
});

describe("GroqProvider — classifyRelation", () => {
  it("test_classify_relation_returns_parsed_object", async () => {
    const body = groqBody(
      JSON.stringify({
        relation: "extends",
        confidence: 0.8,
        rationale: "同じ課題を別領域へ適用する手法の拡張",
      }),
    );
    const rwr = vi.fn(async (_opts: RequestWithRetryOptions) => resp(200, body));
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: rwr,
    });
    const rc = await p.classifyRelation(
      { title: "A", year: 2020, abstract: "first" },
      { title: "B", year: 2024, abstract: "applied" },
    );
    expect(rc?.relation).toBe("extends");
    expect(rc?.confidence).toBe(0.8);
    const opts = rwr.mock.calls[0]?.[0] as RequestWithRetryOptions;
    expect((opts.jsonBody as Record<string, unknown>).response_format).toEqual({
      type: "json_object",
    });
  });

  it("test_classify_relation_rejects_invalid_relation", async () => {
    const body = groqBody(JSON.stringify({ relation: "bogus", confidence: 0.5, rationale: "x" }));
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, body),
    });
    expect(await p.classifyRelation({ title: "A" }, { title: "B" })).toBeNull();
  });

  it("test_classify_relation_api_failure_returns_none", async () => {
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(500),
    });
    expect(await p.classifyRelation({ title: "A" }, { title: "B" })).toBeNull();
  });
});

describe("GroqProvider — malformed 200 response body", () => {
  it("test_evaluate_batch_non_json_200_returns_none_no_exception", async () => {
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => nonJsonResp(200),
    });
    expect(await p.evaluateBatch([mkPaper("P1")], "")).toEqual([null]);
  });

  it("test_classify_relation_non_json_200_returns_none_no_exception", async () => {
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => nonJsonResp(200),
    });
    expect(await p.classifyRelation({ title: "A" }, { title: "B" })).toBeNull();
  });

  it("test_chat_wrong_shape_json_top_level_list_returns_none", async () => {
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, ["not", "an", "object"]),
    });
    expect(await p.chat("s", "u")).toBeNull();
  });

  it("test_chat_wrong_shape_choices_not_a_list_returns_none", async () => {
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      requestWithRetryFn: async () => resp(200, { choices: "not-a-list" }),
    });
    expect(await p.chat("s", "u")).toBeNull();
  });
});

describe("GroqProvider — rate limiter (#129)", () => {
  it("test_groq_provider_rate_limits_consecutive_calls", async () => {
    const sleeps: number[] = [];
    const times = [0.0, 0.0, 0.0, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2];
    let i = 0;
    const now = () => (times[i] !== undefined ? (times[i++] as number) * 1000 : 0);
    const sleep = async (ms: number) => {
      sleeps.push(ms / 1000);
    };
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      now,
      sleep,
      requestWithRetryFn: async () => resp(200, groqBody("hi")),
    });
    await p.chat("sys", "u1");
    await p.chat("sys", "u2");
    await p.chat("sys", "u3");
    expect(sleeps.length).toBe(2);
    for (const s of sleeps) expect(s).toBeGreaterThan(2.0);
  });

  it("test_groq_provider_no_sleep_when_interval_already_elapsed", async () => {
    const times = [0.0, 10.0, 10.0];
    let i = 0;
    const now = () => (times[i] !== undefined ? (times[i++] as number) * 1000 : 999_000);
    const sleeps: number[] = [];
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      requestWithRetryFn: async () => resp(200, groqBody("hi")),
    });
    await p.chat("sys", "u1");
    await p.chat("sys", "u2");
    expect(sleeps).toEqual([]);
  });

  it("test_groq_provider_rate_limit_configurable", async () => {
    const sleeps: number[] = [];
    const p = new GroqProvider({ enabled: true, rateLimitRpm: 1000 }, "k", {
      fetchImpl: unreachableFetch,
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      requestWithRetryFn: async () => resp(200, groqBody("hi")),
    });
    await p.chat("sys", "u1");
    await p.chat("sys", "u2");
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeLessThan(100); // < 0.1s in ms
  });

  it("test_groq_provider_no_throttle_for_first_call", async () => {
    const sleeps: number[] = [];
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      now: () => 5000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      requestWithRetryFn: async () => resp(200, groqBody("hi")),
    });
    await p.chat("sys", "u1");
    expect(sleeps).toEqual([]);
  });
});

describe("GroqProvider — quota-exhausted circuit breaker (#30)", () => {
  it("test_groq_provider_short_circuits_after_consecutive_429", async () => {
    let callCount = 0;
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      now: () => 0,
      sleep: async () => {},
      requestWithRetryFn: async () => {
        callCount += 1;
        return resp(429);
      },
    });
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    expect(callCount).toBe(3);
  });

  it("test_groq_provider_failure_counter_resets_on_success", async () => {
    const responses = [resp(429), resp(429), resp(200, groqBody("ok")), resp(429), resp(429)];
    let i = 0;
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      now: () => 0,
      sleep: async () => {},
      requestWithRetryFn: async () => responses[i++] as HttpResponseLike,
    });
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBe("ok");
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
  });

  it("test_groq_provider_latches_on_consecutive_empty_content_200s", async () => {
    const emptyBody = { choices: [{ message: { content: "" } }] };
    const rwr = vi.fn(async (_opts: RequestWithRetryOptions) => resp(200, emptyBody));
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      now: () => 0,
      sleep: async () => {},
      requestWithRetryFn: rwr,
    });
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    expect(rwr.mock.calls.length).toBe(3);
  });

  it("test_groq_provider_latches_on_consecutive_non_json_200s", async () => {
    const rwr = vi.fn(async (_opts: RequestWithRetryOptions) => nonJsonResp(200));
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      now: () => 0,
      sleep: async () => {},
      requestWithRetryFn: rwr,
    });
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    expect(rwr.mock.calls.length).toBe(3);
  });
});

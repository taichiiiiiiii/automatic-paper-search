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
import { GroqProvider, isDailyLimit429 } from "../../../src/lineage/llm/groq.js";

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
  // `requestWithRetryFn` is mocked here, so each scripted 429 is a call
  // whose FINAL response is 429 (all retries already spent): three in a
  // row still latch (PERSISTENT_429_THRESHOLD). Retried-then-successful
  // 429s never latch — see "rate-limit resilience" below.
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
    // LLM-19 (#review: this test previously "cannot fail"): with only 2
    // failures on either side of the success, the breaker never latches
    // EITHER WAY (threshold is 3) — a missing reset and a working reset
    // produce the exact same `chat()` return sequence
    // (null,null,"ok",null,null), so the assertions below alone can't
    // tell them apart. The discriminator is a 6th call: WITH the reset,
    // the post-success run of failures is only 3 long by the 6th call,
    // so the breaker latches only AT that 6th call (which still goes out
    // for real before latching); WITHOUT the reset, the pre-success 2
    // failures carry over and the 4th call alone already hits the
    // threshold (2 carried + 1 new = 3), latching early and silently
    // short-circuiting calls 5 and 6 — both still return `null`, but
    // never reach the network. Asserting the real call COUNT (not just
    // the return values) is what pins the reset.
    const responses = [
      resp(429),
      resp(429),
      resp(200, groqBody("ok")),
      resp(429),
      resp(429),
      resp(429),
    ];
    const rwr = vi.fn(async (_opts: RequestWithRetryOptions) => {
      const next = responses[rwr.mock.calls.length - 1];
      if (next === undefined) throw new Error("unexpected extra network call");
      return next;
    });
    const p = new GroqProvider({ enabled: true }, "k", {
      fetchImpl: unreachableFetch,
      now: () => 0,
      sleep: async () => {},
      requestWithRetryFn: rwr,
    });
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBe("ok");
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    // All 6 scripted responses were consumed by a REAL call — the
    // breaker never latched early, proving the post-success failure
    // run started back at zero.
    expect(rwr.mock.calls.length).toBe(6);
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

/**
 * End-to-end through the REAL `requestWithRetry` (no `requestWithRetryFn`
 * seam) with a fake clock: `sleep` advances `now`, `fetchImpl` replays
 * scripted responses carrying Groq-style headers/bodies.
 */
function fakeClock() {
  let t = 1_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function hresp(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseLike {
  return { status, headers: new Headers(headers), json: async () => body };
}

const OK = (text = "ok", totalTokens?: number) =>
  hresp(200, {
    choices: [{ message: { content: text } }],
    ...(totalTokens !== undefined ? { usage: { total_tokens: totalTokens } } : {}),
  });
const TPM_429 = (retryAfter: string) =>
  hresp(
    429,
    {
      error: {
        message:
          "Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 900. Please try again in 6.5s.",
        type: "tokens",
        code: "rate_limit_exceeded",
      },
    },
    {
      "retry-after": retryAfter,
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-reset-tokens": "6.5s",
    },
  );
const TPD_429 = hresp(
  429,
  {
    error: {
      message:
        "Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD): Limit 200000, Used 199500, Requested 1200. Please try again in 4m12s.",
      type: "tokens",
      code: "rate_limit_exceeded",
    },
  },
  { "retry-after": "252" },
);

function scripted(responses: HttpResponseLike[]) {
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected extra network call");
    return next;
  });
  return fetchImpl;
}

function mkProvider(fetchImpl: ReturnType<typeof scripted>, extra: Record<string, unknown> = {}) {
  const clock = fakeClock();
  const warns: string[] = [];
  const p = new GroqProvider({ enabled: true, rateLimitTpm: 0, ...extra }, "k", {
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    logger: { warn: (m) => warns.push(m) },
  });
  return { p, clock, warns };
}

describe("GroqProvider — rate-limit resilience (real requestWithRetry, fake clock)", () => {
  it("honours Retry-After (+250ms margin) and completes the call", async () => {
    const fetchImpl = scripted([TPM_429("7"), TPM_429("3"), OK("done")]);
    const { p, clock } = mkProvider(fetchImpl);
    expect(await p.chat("s", "u")).toBe("done");
    expect(clock.sleeps).toEqual([7250, 3250]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const st = p.usageStats();
    expect(st.rateLimited).toBe(2);
    expect(st.finalRateLimited).toBe(0);
    expect(st.throttleWaitMs).toBe(10_500);
    expect(st.latched).toBe(false);
  });

  it("transient 429s (retried successfully) never latch, however many calls see them", async () => {
    const script: HttpResponseLike[] = [];
    for (let i = 0; i < 8; i++) script.push(TPM_429("2"), TPM_429("2"), OK(`r${i}`));
    const fetchImpl = scripted(script);
    const { p, warns } = mkProvider(fetchImpl);
    for (let i = 0; i < 8; i++) expect(await p.chat("s", "u")).toBe(`r${i}`);
    expect(fetchImpl).toHaveBeenCalledTimes(24);
    expect(p.usageStats().latched).toBe(false);
    expect(warns.some((w) => w.includes("latching"))).toBe(false);
  });

  it("retries a 429 up to 6 times, capping each wait at 90s", async () => {
    const fetchImpl = scripted([
      hresp(429, {}, { "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "5m" }),
      TPM_429("1"),
      TPM_429("1"),
      TPM_429("1"),
      TPM_429("1"),
      TPM_429("1"),
      OK("late"),
    ]);
    const { p, clock } = mkProvider(fetchImpl);
    expect(await p.chat("s", "u")).toBe("late");
    expect(clock.sleeps[0]).toBe(90_000);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it("a daily-limit 429 (TPD message) latches immediately", async () => {
    const fetchImpl = scripted([TPD_429]);
    const { p, warns, clock } = mkProvider(fetchImpl);
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    // Retry-After is only 252s (< 10 min), but the body names the daily
    // quota, so requestWithRetry stops without sleeping.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
    expect(p.usageStats().latched).toBe(true);
    expect(p.usageStats().latchReason).toMatch(/daily rate limit/);
    expect(warns.some((w) => w.includes("tokens per day"))).toBe(true);
  });

  it("a 429 whose reset is > 10 minutes is a daily limit: no retry, latch", async () => {
    const fetchImpl = scripted([hresp(429, {}, { "retry-after": "3600" })]);
    const { p, clock } = mkProvider(fetchImpl);
    expect(await p.chat("s", "u")).toBeNull();
    expect(await p.chat("s", "u")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
    expect(p.usageStats().latched).toBe(true);
  });

  it("non-429 failures still latch after 3 consecutive calls", async () => {
    const bad = () => hresp(400, { error: { message: "bad request" } });
    const fetchImpl = scripted([bad(), bad(), bad()]);
    const { p } = mkProvider(fetchImpl);
    for (let i = 0; i < 5; i++) expect(await p.chat("s", "u")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(p.usageStats().latched).toBe(true);
    expect(p.usageStats().latchReason).toMatch(/3 consecutive unusable/);
  });

  it("a final 429 between non-429 failures does not reset or advance the non-429 counter", async () => {
    const bad = () => hresp(400, {});
    const fetchImpl = scripted([bad(), bad(), ...Array(7).fill(TPM_429("1")), bad()]);
    const { p } = mkProvider(fetchImpl);
    for (let i = 0; i < 4; i++) expect(await p.chat("s", "u")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(p.usageStats().latchReason).toMatch(/3 consecutive unusable/);
  });

  it("latches once the total 429 back-off budget is spent", async () => {
    const fetchImpl = scripted([TPM_429("60"), OK("a"), TPM_429("60"), OK("b")]);
    const { p } = mkProvider(fetchImpl, { maxThrottleWaitSeconds: 100 });
    expect(await p.chat("s", "u")).toBe("a");
    expect(await p.chat("s", "u")).toBe("b");
    expect(await p.chat("s", "u")).toBeNull();
    expect(p.usageStats().latchReason).toMatch(/back-off budget/);
  });

  it("logs a concise usage summary", async () => {
    const fetchImpl = scripted([TPM_429("2"), OK("a", 900), OK("b", 1100)]);
    const { p } = mkProvider(fetchImpl);
    await p.chat("s", "u");
    await p.chat("s", "u");
    expect(p.usageSummary()).toBe(
      "groq summary: model=openai/gpt-oss-120b, calls=2 (ok=2, failed=0), 429s=1 (final=0), " +
        "throttle_wait=2.3s, pacing_wait=0.8s, tokens=2000, latched=no",
    );
  });

  it("summary reports the latch reason", async () => {
    const fetchImpl = scripted([TPD_429]);
    const { p } = mkProvider(fetchImpl);
    await p.chat("s", "u");
    expect(p.usageSummary()).toContain("429s=1 (final=1)");
    expect(p.usageSummary()).toMatch(/latched=yes \(daily rate limit exhausted/);
  });
});

describe("GroqProvider — free-tier pacing", () => {
  it("defaults gpt-oss-120b to 20 RPM (3s spacing)", async () => {
    const fetchImpl = scripted([OK(), OK()]);
    const { p, clock } = mkProvider(fetchImpl);
    await p.chat("s", "u");
    await p.chat("s", "u");
    expect(clock.sleeps).toEqual([3000]);
  });

  it("token-aware pacing waits for the 60s window when the TPM budget would be exceeded", async () => {
    const fetchImpl = scripted([OK("a", 3000), OK("b", 2500), OK("c", 100)]);
    const { p, clock } = mkProvider(fetchImpl, { rateLimitTpm: 6000, rateLimitRpm: 60 });
    await p.chat("s", "u"); // t=1000, 3000 tokens
    await p.chat("s", "u"); // t=2000, 2500 tokens (5500 in window)
    await p.chat("s", "u"); // est 601 → 6101 > 6000: wait until t=61000
    expect(clock.sleeps).toEqual([1000, 1000, 58_000]);
    expect(p.usageStats().pacingWaitMs).toBe(60_000);
  });
});

describe("isDailyLimit429", () => {
  it.each([
    ["Rate limit reached ... on requests per day (RPD): Limit 1000", null, true],
    ["... tokens per day (TPD) ...", null, true],
    ["... tokens per minute (TPM) ...", 6_000, false],
    ["", 11 * 60_000, true],
    ["", 9 * 60_000, false],
  ])("%j / %j → %j", (msg, hint, want) => {
    expect(isDailyLimit429(msg, hint)).toBe(want);
  });
});

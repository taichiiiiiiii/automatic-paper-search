/**
 * Port of `paperpilot/tests/test_http.py`.
 *
 * INTENTIONAL DIFFERENCE: all durations here are milliseconds, not seconds
 * (`requestWithRetry.ts`'s backoff/timeout constants are in ms — a more
 * natural unit for `setTimeout`-based Node code). The retry COUNTS,
 * multipliers, and clamping behaviour are otherwise identical to
 * `utils/http.py`; a caller only has to scale durations by 1000.
 *
 * N/A (no TS port): the Python suite's malformed-URL tests exercise
 * `urlsplit`'s specific leniency (`http://[`, invalid port strings) against
 * logging only — covered here by `safeUrlForLog`'s own dedicated cases below
 * (ported from the same assertions), so there is no separate "through the
 * full retry path" duplicate the way Python needed one for its three-case
 * matrix of urlsplit vs. `.port` raising.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type HttpResponseLike,
  parseDurationMs,
  type RetryEvent,
  rateLimitHintMs,
  requestWithRetry,
  safeUrlForLog,
  TimeoutError,
} from "../../../src/collect/http/requestWithRetry.js";

function resp(status: number, body: unknown = {}): HttpResponseLike {
  return { status, json: async () => body };
}

describe("requestWithRetry", () => {
  it("succeeds on the first try", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { a: 1 }));
    const r = await requestWithRetry({ method: "GET", url: "http://x" }, { fetchImpl });
    expect(r).not.toBeNull();
    expect(r?.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries 429 with exponential backoff", async () => {
    const responses = [resp(429), resp(429), resp(200)];
    const fetchImpl = vi.fn(async () => responses.shift() as HttpResponseLike);
    const sleeps: number[] = [];
    const r = await requestWithRetry(
      { method: "GET", url: "http://x" },
      { fetchImpl, sleep: async (s) => void sleeps.push(s) },
    );
    expect(r?.status).toBe(200);
    expect(sleeps).toEqual([2000, 4000]);
  });

  it("gives up after max 429 retries, returning the 429 response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(429));
    const r = await requestWithRetry(
      { method: "GET", url: "http://x" },
      { fetchImpl, sleep: async () => {} },
    );
    expect(r?.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it("retries 5xx with a fixed wait", async () => {
    const responses = [resp(503), resp(200)];
    const fetchImpl = vi.fn(async () => responses.shift() as HttpResponseLike);
    const r = await requestWithRetry(
      { method: "GET", url: "http://x" },
      { fetchImpl, sleep: async () => {} },
    );
    expect(r?.status).toBe(200);
  });

  it("retries a timeout once", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TimeoutError();
      return resp(200);
    });
    const r = await requestWithRetry(
      { method: "GET", url: "http://x" },
      { fetchImpl, sleep: async () => {} },
    );
    expect(r?.status).toBe(200);
    expect(calls).toBe(2);
  });

  // LOW (P4 review round 2): `isTimeoutError`'s `e.name === "TimeoutError"`
  // branch exists for a REAL fetch adapter's `AbortSignal.timeout()`,
  // which rejects with a DOMException named "TimeoutError" — a distinct
  // class from this module's own `TimeoutError` (already covered just
  // above). Only that branch, not the custom class, was ever exercised.
  it("retries once on a DOMException-shaped timeout (name === 'TimeoutError', not the custom class)", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      }
      return resp(200);
    });
    const r = await requestWithRetry(
      { method: "GET", url: "http://x" },
      { fetchImpl, sleep: async () => {} },
    );
    expect(r?.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("returns null on a generic request exception", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    const r = await requestWithRetry({ method: "GET", url: "http://x" }, { fetchImpl });
    expect(r).toBeNull();
  });

  it("passes a 404 through without retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(404));
    const r = await requestWithRetry({ method: "GET", url: "http://x" }, { fetchImpl });
    expect(r?.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bails out once the overall deadline elapses", async () => {
    let now = 0;
    const sleep = async (s: number) => {
      now += s;
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(429));
    const r = await requestWithRetry(
      { method: "GET", url: "http://x", timeoutMs: 1000, overallDeadlineMs: 5000 },
      { fetchImpl, sleep, now: () => now },
    );
    expect(r).toBeNull();
  });

  it("defaults the overall deadline to 3x the per-attempt timeout", async () => {
    let now = 0;
    const sleep = async (s: number) => {
      now += s;
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(429));
    const r = await requestWithRetry(
      { method: "GET", url: "http://x", timeoutMs: 1000 },
      { fetchImpl, sleep, now: () => now },
    );
    expect(r).toBeNull();
  });

  it("clamps the 429 backoff sleep to the remaining deadline budget (regression, closes #394)", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const sleep = async (s: number) => {
      sleeps.push(s);
      now += s;
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(429));
    const r = await requestWithRetry(
      { method: "GET", url: "http://x", timeoutMs: 1000, overallDeadlineMs: 3000 },
      { fetchImpl, sleep, now: () => now },
    );
    expect(r).toBeNull();
    expect(sleeps[0]).toBe(2000);
    expect(sleeps[1]).toBeLessThan(4000);
    expect(sleeps[1]).toBeLessThanOrEqual(1000 + 1e-6);
    expect(now).toBeLessThanOrEqual(3000 + 1e-6);
  });

  it("clamps the per-attempt timeout passed to fetchImpl to the remaining deadline budget (regression, closes #394)", async () => {
    let now = 0;
    const sleep = async (s: number) => {
      now += s;
    };
    const capturedTimeouts: number[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: { timeoutMs: number }) => {
      capturedTimeouts.push(init.timeoutMs);
      return resp(429);
    });
    await requestWithRetry(
      { method: "GET", url: "http://x", timeoutMs: 10000, overallDeadlineMs: 3000 },
      { fetchImpl, sleep, now: () => now },
    );
    expect(capturedTimeouts[0]).toBeLessThanOrEqual(3000 + 1e-6);
  });
});

describe("safeUrlForLog", () => {
  it("strips path and query (regression, closes #385)", () => {
    const masked = safeUrlForLog("https://hooks.slack.com/services/T000/B000/SUPERSECRETTOKEN?x=1");
    expect(masked).toBe("https://hooks.slack.com");
    expect(masked).not.toContain("SUPERSECRETTOKEN");
    expect(masked).not.toContain("T000");
  });

  it("strips userinfo credentials", () => {
    const masked = safeUrlForLog("https://user:SUPERSECRET@example.com/path");
    expect(masked).toBe("https://example.com");
    expect(masked).not.toContain("SUPERSECRET");
    expect(masked).not.toContain("user");
  });

  it("degrades gracefully on malformed input instead of throwing", () => {
    expect(safeUrlForLog("http://[")).toBe("<unparseable-url>");
    expect(safeUrlForLog("not a url")).toBe("<url>");
  });

  it("degrades gracefully on an invalid port", () => {
    expect(safeUrlForLog("http://example.com:notaport/path")).toBe("<unparseable-url>");
    expect(safeUrlForLog("http://example.com:99999/path")).toBe("<unparseable-url>");
  });

  it("formats an IPv6 host with brackets", () => {
    const masked = safeUrlForLog("https://[::1]:8443/path?token=SECRET");
    expect(masked).toBe("https://[::1]:8443");
    expect(masked).not.toContain("SECRET");
  });
});

describe("request failure logging never leaks a secret URL", () => {
  it("logs only scheme://host on a connection failure", async () => {
    const warnings: string[] = [];
    const secretUrl = "https://hooks.slack.com/services/T000/B000/SUPERSECRETTOKEN";
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    const r = await requestWithRetry(
      { method: "POST", url: secretUrl },
      { fetchImpl, logger: { warn: (m) => warnings.push(m) } },
    );
    expect(r).toBeNull();
    const joined = warnings.join("\n");
    expect(joined).not.toContain("SUPERSECRETTOKEN");
    expect(joined).not.toContain("T000");
    expect(joined).toContain("hooks.slack.com");
  });

  it("logs only the exception class name, never a message that embeds the raw URL", async () => {
    const warnings: string[] = [];
    const secretUrl = "https://hooks.slack.com/services/T000/B000/SUPERSECRETTOKEN";
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error(`Max retries exceeded with url: ${secretUrl} (Caused by ...)`));
    const r = await requestWithRetry(
      { method: "POST", url: secretUrl },
      { fetchImpl, logger: { warn: (m) => warnings.push(m) } },
    );
    expect(r).toBeNull();
    const joined = warnings.join("\n");
    expect(joined).not.toContain("SUPERSECRETTOKEN");
    expect(joined).toContain("Error");
  });

  it("masks the URL in the overall-deadline-exceeded log line too", async () => {
    let now = 0;
    const sleep = async (s: number) => {
      now += s;
    };
    const warnings: string[] = [];
    const secretUrl = "https://hooks.slack.com/services/T000/B000/SUPERSECRETTOKEN";
    const fetchImpl = vi.fn().mockResolvedValue(resp(429));
    const r = await requestWithRetry(
      { method: "POST", url: secretUrl, timeoutMs: 1000, overallDeadlineMs: 5000 },
      { fetchImpl, sleep, now: () => now, logger: { warn: (m) => warnings.push(m) } },
    );
    expect(r).toBeNull();
    const joined = warnings.join("\n");
    expect(joined).not.toContain("SUPERSECRETTOKEN");
    expect(joined).not.toContain("T000");
  });
});

function resp429(headers: Record<string, string>): HttpResponseLike {
  return { status: 429, headers: new Headers(headers), json: async () => ({}) };
}

describe("parseDurationMs", () => {
  it.each([
    ["2s", 2000],
    ["1m30s", 90_000],
    ["250ms", 250],
    ["7m12.5s", 432_500],
    ["1h2m", 3_720_000],
    ["2", 2000],
    ["2.5", 2500],
    [" 3S ", 3000],
  ])("parses %s", (v, ms) => {
    expect(parseDurationMs(v)).toBe(ms);
  });
  it.each(["", "abc", "s", "1x", "-2s"])("rejects %j", (v) => {
    expect(parseDurationMs(v)).toBeNull();
  });
  it("rejects null/undefined", () => {
    expect(parseDurationMs(null)).toBeNull();
    expect(parseDurationMs(undefined)).toBeNull();
  });
});

describe("rateLimitHintMs", () => {
  it("prefers Retry-After seconds", () => {
    const h = new Headers({ "retry-after": "7", "x-ratelimit-reset-tokens": "1m" });
    expect(rateLimitHintMs(h)).toBe(7000);
  });
  it("accepts an HTTP-date Retry-After", () => {
    const h = new Headers({ "retry-after": new Date(10_000).toUTCString() });
    expect(rateLimitHintMs(h, () => 4_000)).toBe(6000);
  });
  it("uses the reset of the exhausted bucket", () => {
    const h = new Headers({
      "x-ratelimit-remaining-requests": "900",
      "x-ratelimit-reset-requests": "2m59.5s",
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-reset-tokens": "7.66s",
    });
    expect(rateLimitHintMs(h)).toBe(7660);
  });
  it("falls back to the smallest reset when no bucket reports exhaustion", () => {
    const h = new Headers({
      "x-ratelimit-remaining-requests": "5",
      "x-ratelimit-reset-requests": "30s",
      "x-ratelimit-remaining-tokens": "120",
      "x-ratelimit-reset-tokens": "1.5s",
    });
    expect(rateLimitHintMs(h)).toBe(1500);
  });
  it("returns null without headers", () => {
    expect(rateLimitHintMs(undefined)).toBeNull();
    expect(rateLimitHintMs(new Headers())).toBeNull();
  });
});

describe("requestWithRetry — 429 server hints", () => {
  it("sleeps for Retry-After instead of the backoff and reports it via onRetry", async () => {
    const responses = [resp429({ "retry-after": "5" }), resp429({ "retry-after": "1" }), resp(200)];
    const fetchImpl = vi.fn(async () => responses.shift() as HttpResponseLike);
    const sleeps: number[] = [];
    const events: RetryEvent[] = [];
    const r = await requestWithRetry(
      { method: "GET", url: "http://x", overallDeadlineMs: 600_000 },
      { fetchImpl, sleep: async (ms) => void sleeps.push(ms), onRetry: (e) => events.push(e) },
    );
    expect(r?.status).toBe(200);
    expect(sleeps).toEqual([5000, 1000]);
    expect(events.map((e) => [e.status, e.attempt, e.waitMs, e.hintMs])).toEqual([
      [429, 1, 5000, 5000],
      [429, 2, 1000, 1000],
    ]);
  });

  it("caps a hinted wait at retry429.maxWaitMs and adds the margin", async () => {
    const responses = [
      resp429({ "x-ratelimit-reset-tokens": "5m", "x-ratelimit-remaining-tokens": "0" }),
      resp429({ "retry-after": "2" }),
      resp(200),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() as HttpResponseLike);
    const sleeps: number[] = [];
    await requestWithRetry(
      {
        method: "GET",
        url: "http://x",
        overallDeadlineMs: 600_000,
        retry429: { maxWaitMs: 90_000, hintMarginMs: 250 },
      },
      { fetchImpl, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(sleeps).toEqual([90_000, 2250]);
  });

  it("returns the 429 immediately when the hint exceeds giveUpIfHintAboveMs", async () => {
    const fetchImpl = vi.fn(async () => resp429({ "retry-after": "3600" }));
    const sleeps: number[] = [];
    const r = await requestWithRetry(
      { method: "GET", url: "http://x", retry429: { giveUpIfHintAboveMs: 600_000 } },
      { fetchImpl, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(r?.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("honours retry429.maxRetries", async () => {
    const fetchImpl = vi.fn(async () => resp429({ "retry-after": "1" }));
    const r = await requestWithRetry(
      { method: "GET", url: "http://x", overallDeadlineMs: 600_000, retry429: { maxRetries: 6 } },
      { fetchImpl, sleep: async () => {} },
    );
    expect(r?.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });
});

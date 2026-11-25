/**
 * #570: opt-in short 429 backoff and a caller label for `requestWithRetry`.
 *
 * Semantic Scholar's keyed 429s are S2 shedding load, so the keyed S2
 * callers back off exponentially from 1 s capped at 8 s (S2's terms still
 * require exponential backoff, design 44 / 51 E1). The defaults (2 s
 * doubling, cap 30 s, 3 retries) are unchanged for every other caller.
 * No network, no real timers: fetch / sleep / clock are injected.
 */
import { describe, expect, it } from "vitest";
import {
  type HttpResponseLike,
  requestWithRetry,
  TimeoutError,
} from "../../../src/collect/http/requestWithRetry.js";

function resp(status: number, headers: Record<string, string> = {}): HttpResponseLike {
  return { status, headers: new Headers(headers), json: async () => ({}) };
}

function always(status: number, headers: Record<string, string> = {}) {
  let calls = 0;
  const fetchImpl = async (): Promise<HttpResponseLike> => {
    calls += 1;
    return resp(status, headers);
  };
  return { fetchImpl, calls: () => calls };
}

describe("requestWithRetry short 429 backoff (#570)", () => {
  it("(a) initialBackoffMs + maxBackoffMs give 1,2,4,8,8 s, shorter than the default", async () => {
    const { fetchImpl } = always(429);
    const sleeps: number[] = [];
    const r = await requestWithRetry(
      {
        method: "POST",
        url: "https://api.semanticscholar.org/graph/v1/paper/batch",
        overallDeadlineMs: 90_000,
        retry429: { maxRetries: 5, maxWaitMs: 20_000, initialBackoffMs: 1000, maxBackoffMs: 8000 },
      },
      { fetchImpl, sleep: async (ms) => void sleeps.push(ms), now: () => 0 },
    );
    expect(r?.status).toBe(429);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it("(a') maxWaitMs alone still caps the short backoff", async () => {
    const { fetchImpl } = always(429);
    const sleeps: number[] = [];
    await requestWithRetry(
      {
        method: "GET",
        url: "http://x",
        overallDeadlineMs: 90_000,
        retry429: { maxRetries: 5, maxWaitMs: 8000, initialBackoffMs: 1000 },
      },
      { fetchImpl, sleep: async (ms) => void sleeps.push(ms), now: () => 0 },
    );
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 8000]);
  });

  it("(b) a Retry-After hint is used as is, and a hint above giveUpIfHintAboveMs stops", async () => {
    const hinted = always(429, { "retry-after": "12" });
    const sleeps: number[] = [];
    await requestWithRetry(
      {
        method: "GET",
        url: "http://x",
        overallDeadlineMs: 90_000,
        retry429: {
          maxRetries: 2,
          maxWaitMs: 20_000,
          initialBackoffMs: 1000,
          maxBackoffMs: 8000,
          giveUpIfHintAboveMs: 60_000,
        },
      },
      { fetchImpl: hinted.fetchImpl, sleep: async (ms) => void sleeps.push(ms), now: () => 0 },
    );
    expect(sleeps).toEqual([12_000, 12_000]);

    const tooLong = always(429, { "retry-after": "120" });
    const sleeps2: number[] = [];
    const r = await requestWithRetry(
      {
        method: "GET",
        url: "http://x",
        retry429: { initialBackoffMs: 1000, maxBackoffMs: 8000, giveUpIfHintAboveMs: 60_000 },
      },
      { fetchImpl: tooLong.fetchImpl, sleep: async (ms) => void sleeps2.push(ms), now: () => 0 },
    );
    expect(r?.status).toBe(429);
    expect(tooLong.calls()).toBe(1);
    expect(sleeps2).toEqual([]);
  });

  it("(c) without the options the default stays 2,4,8 s with 3 retries", async () => {
    const { fetchImpl, calls } = always(429);
    const sleeps: number[] = [];
    const r = await requestWithRetry(
      { method: "GET", url: "http://x", overallDeadlineMs: 600_000 },
      { fetchImpl, sleep: async (ms) => void sleeps.push(ms), now: () => 0 },
    );
    expect(r?.status).toBe(429);
    expect(sleeps).toEqual([2000, 4000, 8000]);
    expect(calls()).toBe(4);
  });

  it("(g) 5xx keeps the fixed 3 s wait and 2 retries even with the short 429 options", async () => {
    const { fetchImpl, calls } = always(503);
    const sleeps: number[] = [];
    const r = await requestWithRetry(
      {
        method: "GET",
        url: "http://x",
        overallDeadlineMs: 90_000,
        retry429: { maxRetries: 4, initialBackoffMs: 1000, maxBackoffMs: 8000 },
      },
      { fetchImpl, sleep: async (ms) => void sleeps.push(ms), now: () => 0 },
    );
    expect(r?.status).toBe(503);
    expect(sleeps).toEqual([3000, 3000]);
    expect(calls()).toBe(3);
  });
});

describe("requestWithRetry label in every http: warning (#570)", () => {
  const SECRET = "fake-s2-key-value-570";
  const base = {
    url: "https://api.semanticscholar.org/graph/v1/paper/batch?token=zzz",
    headers: { "x-api-key": SECRET },
    label: "s2-citation-counts",
  } as const;

  async function warnings(
    fetchImpl: () => Promise<HttpResponseLike>,
    extra: { overallDeadlineMs?: number; now?: () => number } = {},
  ): Promise<string[]> {
    const out: string[] = [];
    await requestWithRetry(
      { method: "POST", ...base, overallDeadlineMs: extra.overallDeadlineMs ?? 90_000 },
      {
        fetchImpl,
        sleep: async () => {},
        now: extra.now ?? (() => 0),
        logger: { warn: (m) => out.push(m) },
      },
    );
    return out;
  }

  function checkAll(lines: string[]): void {
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.startsWith("http:")).toBe(true);
      expect(l).toContain("s2-citation-counts");
      expect(l).not.toContain(SECRET);
      expect(l).not.toContain("token=zzz");
      expect(l).toContain("https://api.semanticscholar.org");
    }
  }

  it("(d) 429, 5xx, timeout, request failure and deadline lines all carry the label", async () => {
    checkAll(await warnings(always(429).fetchImpl));
    checkAll(await warnings(always(502).fetchImpl));
    checkAll(
      await warnings(async () => {
        throw new TimeoutError();
      }),
    );
    checkAll(
      await warnings(async () => {
        throw new Error(`boom ${SECRET}`);
      }),
    );
    let t = 0;
    checkAll(
      await warnings(always(200).fetchImpl, {
        overallDeadlineMs: 10,
        now: () => {
          t += 100;
          return t;
        },
      }),
    );
  });

  it("(d') without a label the lines are unchanged", async () => {
    const out: string[] = [];
    await requestWithRetry(
      { method: "GET", url: "http://x", retry429: { maxRetries: 1 } },
      {
        fetchImpl: always(429).fetchImpl,
        sleep: async () => {},
        now: () => 0,
        logger: { warn: (m) => out.push(m) },
      },
    );
    expect(out).toEqual([
      "http: 429 throttled, sleeping 2.0s (retry 1): http://x",
      "http: 429 after 1 retries: http://x",
    ]);
  });
});

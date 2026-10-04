/**
 * M6 of the P4 review: the openreview/cvf CLI entry points passed
 * `init` straight to the global `fetch()`, which does not understand
 * `requestWithRetry`'s `timeoutMs` field — a stalled real request never
 * timed out. These tests exercise the adapter in isolation (a fake
 * `fetch` capturing what it was called with) rather than touching a real
 * socket.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  fetchImplWithTimeout,
  fetchTextWithTimeout,
} from "../../../src/conference/shared/networkTimeout.js";

describe("fetchImplWithTimeout (M6)", () => {
  it("passes an AbortSignal built from init.timeoutMs, not the raw timeoutMs field", async () => {
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      // The nonstandard `timeoutMs` property must not leak into what's
      // handed to the real `fetch` — only `signal` carries the timeout.
      expect(init).not.toHaveProperty("timeoutMs");
      return new Response("ok", { status: 200 });
    });
    const fetchImpl = fetchImplWithTimeout(fakeFetch as unknown as typeof fetch);
    const resp = await fetchImpl("https://example.com/notes", {
      method: "GET",
      timeoutMs: 5000,
    });
    expect(resp.status).toBe(200);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("forwards method/headers/body unchanged", async () => {
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "x-test": "1" });
      expect(init?.body).toBe('{"a":1}');
      return new Response("{}", { status: 200 });
    });
    const fetchImpl = fetchImplWithTimeout(fakeFetch as unknown as typeof fetch);
    await fetchImpl("https://example.com/x", {
      method: "POST",
      headers: { "x-test": "1" },
      body: '{"a":1}',
      timeoutMs: 1000,
    });
  });

  it("the built signal actually aborts with a TimeoutError reason once timeoutMs elapses", async () => {
    // Real timer, no mocking — proves AbortSignal.timeout(init.timeoutMs)
    // is really wired up, not just present and inert.
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      await sleep(30);
      if (signal.aborted) {
        const reason = signal.reason as Error;
        throw reason;
      }
      return new Response("too slow to notice", { status: 200 });
    });
    const fetchImpl = fetchImplWithTimeout(fakeFetch as unknown as typeof fetch);
    await expect(
      fetchImpl("https://example.com/notes", { method: "GET", timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("requestWithRetry retries once on the resulting TimeoutError then returns null", async () => {
    const { requestWithRetry } = await import("../../../src/collect/http/requestWithRetry.js");
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      await sleep(15);
      if (signal.aborted) throw signal.reason as Error;
      return new Response("ok", { status: 200 });
    });
    const resp = await requestWithRetry(
      {
        method: "GET",
        url: "https://example.com/notes",
        timeoutMs: 5,
        // Generous overall budget so both the first attempt and its one
        // retry fit — only each per-attempt AbortSignal (5ms) should fire.
        overallDeadlineMs: 1000,
      },
      {
        fetchImpl: fetchImplWithTimeout(fakeFetch as unknown as typeof fetch),
        sleep: async () => {},
      },
    );
    expect(resp).toBeNull();
    expect(fakeFetch).toHaveBeenCalledTimes(2); // original attempt + 1 retry
  });
});

describe("fetchTextWithTimeout (M6)", () => {
  it("passes an AbortSignal and returns the response's status/text", async () => {
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("<feed/>", { status: 200 });
    });
    const fetchText = fetchTextWithTimeout(30_000, fakeFetch as unknown as typeof fetch);
    const resp = await fetchText("https://export.arxiv.org/api/query?x=1");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("<feed/>");
  });
});

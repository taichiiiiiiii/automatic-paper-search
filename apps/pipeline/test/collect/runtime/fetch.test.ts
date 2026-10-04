/**
 * Tests for `collect/runtime/fetch.ts`'s real adapters: header
 * construction (default `User-Agent`, caller headers win on collision)
 * and that `init.timeoutMs` actually aborts the call via
 * `AbortSignal.timeout` — no real network; `fetch`/`setTimeout` are both
 * faked.
 */
import { afterEach, expect, it, vi } from "vitest";
import {
  createRealArxivFetchText,
  createRealFetchImpl,
  DEFAULT_USER_AGENT,
} from "../../../src/collect/runtime/fetch.js";

// `AbortSignal.timeout()` is implemented against the real platform timer,
// not the one `vi.useFakeTimers()` patches (`globalThis.setTimeout`), so
// the two abort tests below use small REAL timeouts instead of fake-timer
// advancement — confirmed empirically: `vi.advanceTimersByTimeAsync` does
// not make `AbortSignal.timeout` fire any sooner.
afterEach(() => {
  vi.restoreAllMocks();
});

it("createRealFetchImpl sends a default User-Agent and forwards method/body/status/json", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  const fetchImpl = createRealFetchImpl(fakeFetch as unknown as typeof fetch);
  const resp = await fetchImpl("https://api.example.com/x", {
    method: "GET",
    timeoutMs: 5000,
  });

  expect(resp.status).toBe(200);
  await expect(resp.json()).resolves.toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  const sentHeaders = calls[0]?.init.headers as Record<string, string>;
  expect(sentHeaders["User-Agent"]).toBe(DEFAULT_USER_AGENT);
});

it("createRealFetchImpl: caller-supplied headers win over the default (e.g. x-api-key, Authorization)", async () => {
  const calls: RequestInit[] = [];
  const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response("{}", { status: 200 });
  });

  const fetchImpl = createRealFetchImpl(fakeFetch as unknown as typeof fetch);
  await fetchImpl("https://api.example.com/x", {
    method: "GET",
    headers: { "User-Agent": "custom-ua", "x-api-key": "secret" },
    timeoutMs: 5000,
  });

  const sentHeaders = calls[0]?.headers as Record<string, string>;
  expect(sentHeaders["User-Agent"]).toBe("custom-ua");
  expect(sentHeaders["x-api-key"]).toBe("secret");
});

it("createRealFetchImpl: timeoutMs actually aborts the request (AbortSignal fires)", async () => {
  const fakeFetch = vi.fn((_url: string, init: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  });

  const fetchImpl = createRealFetchImpl(fakeFetch as unknown as typeof fetch);
  const pending = fetchImpl("https://api.example.com/slow", {
    method: "GET",
    timeoutMs: 20,
  });

  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

it("createRealArxivFetchText sends a default User-Agent, no caller headers to override (ArxivFetchText takes none), and returns text()", async () => {
  const calls: RequestInit[] = [];
  const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response("<feed>atom body</feed>", { status: 200 });
  });

  const fetchText = createRealArxivFetchText(5000, fakeFetch as unknown as typeof fetch);
  const resp = await fetchText("https://export.arxiv.org/api/query?x=1");

  expect(resp.status).toBe(200);
  await expect(resp.text()).resolves.toBe("<feed>atom body</feed>");
  const sentHeaders = calls[0]?.headers as Record<string, string>;
  expect(sentHeaders["User-Agent"]).toBe(DEFAULT_USER_AGENT);
});

it("createRealArxivFetchText: default timeout aborts a stalled request", async () => {
  const fakeFetch = vi.fn((_url: string, init: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  });

  const fetchText = createRealArxivFetchText(20, fakeFetch as unknown as typeof fetch);
  const pending = fetchText("https://export.arxiv.org/api/query?x=1");

  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

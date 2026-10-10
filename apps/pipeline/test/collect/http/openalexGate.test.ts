import { describe, expect, it } from "vitest";
import {
  classifyOpenAlexRequest,
  effectiveRemainingCredits,
  installOpenAlexGate,
  OpenAlexBudgetExhaustedError,
  OpenAlexGate,
  parseOpenAlexBudgetHeaders,
  resolveOpenAlexApiKey,
} from "../../../src/collect/http/openalexGate.js";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { requestWithRetry } from "../../../src/collect/http/requestWithRetry.js";

const KEY = "oa-test-key-123456";

function hdrs(values: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

/** Headers as OpenAlex sent them on 2026-10-10 (keyless, live probe). */
function budgetHeaders(remaining: number, extra: Record<string, string> = {}) {
  return hdrs({
    "x-ratelimit-limit": "1000",
    "x-ratelimit-limit-usd": "0.1",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-remaining-usd": String(remaining * 0.0001),
    "x-ratelimit-onetime-remaining": "0",
    "x-ratelimit-prepaid-remaining-usd": "0",
    "x-ratelimit-credits-used": "1",
    "x-ratelimit-reset": "41343",
    ...extra,
  });
}

function resp(status: number, body: unknown, headers = budgetHeaders(500)): HttpResponseLike {
  return { status, headers, json: async () => body };
}

interface Call {
  url: string;
  init: FetchInit;
}

function recorder(answer: (url: string, n: number) => HttpResponseLike) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: FetchInit) => {
    calls.push({ url, init });
    return answer(url, calls.length);
  };
  return { calls, fetchImpl };
}

const INIT: FetchInit = { method: "GET", headers: { "User-Agent": "t" }, timeoutMs: 1000 };
const LIST = "https://api.openalex.org/works?filter=openalex%3AW1%7CW2&per-page=2";
const SEARCH = "https://api.openalex.org/works?search=diffusion&per-page=25";
const SINGLE = "https://api.openalex.org/works/W123?select=id%2Creferenced_works";

describe("resolveOpenAlexApiKey", () => {
  it("prefers PAPERPILOT_OPENALEX_API_KEY, falls back to OPENALEX_API_KEY, ignores blanks", () => {
    expect(
      resolveOpenAlexApiKey({ PAPERPILOT_OPENALEX_API_KEY: " a ", OPENALEX_API_KEY: "b" }),
    ).toBe("a");
    expect(
      resolveOpenAlexApiKey({ PAPERPILOT_OPENALEX_API_KEY: "  ", OPENALEX_API_KEY: "b" }),
    ).toBe("b");
    expect(resolveOpenAlexApiKey({})).toBeNull();
  });
});

describe("classifyOpenAlexRequest", () => {
  it("prices requests the way OpenAlex bills them", () => {
    expect(classifyOpenAlexRequest(SEARCH)).toBe("search");
    expect(
      classifyOpenAlexRequest(
        "https://api.openalex.org/works?filter=title.search%3Afoo&per-page=5",
      ),
    ).toBe("search");
    expect(classifyOpenAlexRequest(LIST)).toBe("list");
    expect(classifyOpenAlexRequest("https://api.openalex.org/works?filter=cites%3AW1")).toBe(
      "list",
    );
    expect(classifyOpenAlexRequest(SINGLE)).toBe("singleton");
    expect(classifyOpenAlexRequest("https://api.openalex.org/rate-limit")).toBe("free");
  });
});

describe("parseOpenAlexBudgetHeaders", () => {
  it("reads the X-RateLimit-* headers (credits, USD, prepaid, reset)", () => {
    const snap = parseOpenAlexBudgetHeaders(budgetHeaders(535));
    expect(snap).toMatchObject({
      remainingCredits: 535,
      limitCredits: 1000,
      creditsUsed: 1,
      resetSeconds: 41343,
      prepaidRemainingUsd: 0,
    });
    expect(effectiveRemainingCredits(snap)).toBe(535);
  });

  it("falls back to the USD remainder and adds prepaid balance", () => {
    const snap = parseOpenAlexBudgetHeaders(
      hdrs({ "x-ratelimit-remaining-usd": "0.0005", "x-ratelimit-prepaid-remaining-usd": "0.001" }),
    );
    expect(effectiveRemainingCredits(snap)).toBe(5 + 10);
  });

  it("returns null when there are no budget headers", () => {
    expect(parseOpenAlexBudgetHeaders(hdrs({ "content-type": "application/json" }))).toBeNull();
    expect(parseOpenAlexBudgetHeaders(undefined)).toBeNull();
  });
});

describe("OpenAlexGate.wrap", () => {
  it("sends the key as a bearer header on OpenAlex requests only, never in the URL", async () => {
    const { calls, fetchImpl } = recorder(() => resp(200, { results: [] }));
    const gate = new OpenAlexGate({ apiKey: KEY });
    const f = gate.wrap(fetchImpl);
    await f(LIST, INIT);
    await f("https://api.semanticscholar.org/graph/v1/paper/x", INIT);
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: `Bearer ${KEY}`,
      "User-Agent": "t",
    });
    expect(calls[0]?.url).not.toContain(KEY);
    expect(calls[1]?.init.headers).toEqual({ "User-Agent": "t" });
    expect(gate.summary()).toContain("key=yes");
    expect(gate.summary()).not.toContain(KEY);
  });

  it("sends no Authorization header without a key", async () => {
    const { calls, fetchImpl } = recorder(() => resp(200, { results: [] }));
    const gate = new OpenAlexGate({});
    await gate.wrap(fetchImpl)(LIST, INIT);
    expect(calls[0]?.init.headers).toEqual({ "User-Agent": "t" });
    expect(gate.summary()).toContain("key=no");
  });

  it("opens the breaker when the headers show the budget spent; later list/search calls never leave", async () => {
    const warnings: string[] = [];
    const { calls, fetchImpl } = recorder(() => resp(200, { results: [] }, budgetHeaders(0)));
    const gate = new OpenAlexGate({ apiKey: KEY, logger: { warn: (m) => warnings.push(m) } });
    const f = gate.wrap(fetchImpl);
    await f(LIST, INIT);
    expect(gate.breaker).toBe("open");
    await expect(f(SEARCH, INIT)).rejects.toBeInstanceOf(OpenAlexBudgetExhaustedError);
    await expect(f(`${LIST}&page=2`, INIT)).rejects.toBeInstanceOf(OpenAlexBudgetExhaustedError);
    // Single-entity lookups are free and still go out.
    await f(SINGLE, INIT);
    expect(calls.map((c) => c.url)).toEqual([LIST, SINGLE]);
    expect(warnings.filter((w) => w.includes("daily budget exhausted"))).toHaveLength(1);
    expect(warnings.join("\n")).not.toContain(KEY);
    expect(gate.summary()).toMatch(
      /^openalex budget: remaining=0 .*calls=2, searches=0, lists=1, singletons=1, 429=0, blocked=2, .*key=yes, breaker=open$/,
    );
  });

  it("blocks only searches when fewer credits than one search remain", async () => {
    const { fetchImpl } = recorder(() => resp(200, { results: [] }, budgetHeaders(7)));
    const gate = new OpenAlexGate({});
    const f = gate.wrap(fetchImpl);
    await f(LIST, INIT);
    expect(gate.breaker).toBe("searches-blocked");
    await expect(f(SEARCH, INIT)).rejects.toBeInstanceOf(OpenAlexBudgetExhaustedError);
    await expect(f(`${LIST}&page=3`, INIT)).resolves.toMatchObject({ status: 200 });
  });

  it("trips on a daily-budget 429 and makes requestWithRetry give up without sleeping", async () => {
    const { calls, fetchImpl } = recorder(() =>
      resp(
        429,
        { error: "Rate limit exceeded", message: "Daily budget exhausted" },
        budgetHeaders(0),
      ),
    );
    const gate = new OpenAlexGate({ apiKey: KEY });
    const sleeps: number[] = [];
    const out = await requestWithRetry(
      { method: "GET", url: "https://api.openalex.org/works", params: { search: "x" } },
      { fetchImpl: gate.wrap(fetchImpl), sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(out).toBeNull();
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(gate.breaker).toBe("open");
    expect(gate.summary()).toContain("429=1");
  });

  it("recognises a budget 429 from its body even without headers", async () => {
    const { fetchImpl } = recorder(() =>
      resp(429, { message: "You have exceeded your daily budget of $0.10" }, hdrs({})),
    );
    const gate = new OpenAlexGate({});
    await expect(gate.wrap(fetchImpl)(LIST, INIT)).rejects.toBeInstanceOf(
      OpenAlexBudgetExhaustedError,
    );
    expect(gate.breaker).toBe("open");
  });

  it("leaves a per-second throttle 429 to the normal retry path (body still readable)", async () => {
    const { calls, fetchImpl } = recorder((_u, n) =>
      n === 1
        ? resp(
            429,
            { error: "Too many requests" },
            hdrs({ "retry-after": "1", "x-ratelimit-remaining": "900" }),
          )
        : resp(200, { results: [1] }),
    );
    const gate = new OpenAlexGate({});
    const out = await requestWithRetry(
      { method: "GET", url: LIST },
      { fetchImpl: gate.wrap(fetchImpl), sleep: async () => {} },
    );
    expect(out?.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(gate.breaker).toBe("closed");
  });

  it("serves an identical successful GET from the run memo (failures are never memoised)", async () => {
    const { calls, fetchImpl } = recorder((_u, n) =>
      n === 1 ? resp(503, {}) : resp(200, { results: [{ id: "W1" }] }),
    );
    const gate = new OpenAlexGate({});
    const f = gate.wrap(fetchImpl);
    expect((await f(LIST, INIT)).status).toBe(503);
    const a = await f(LIST, INIT);
    const bodyA = (await a.json()) as { results: unknown[] };
    bodyA.results.push("mutated");
    const b = await f(LIST, INIT);
    expect(await b.json()).toEqual({ results: [{ id: "W1" }] });
    expect(calls).toHaveLength(2);
    expect(gate.stats.memoHits).toBe(1);
  });
});

describe("installOpenAlexGate", () => {
  it("reads the key from env and prints one summary line on exit only when OpenAlex was used", async () => {
    const lines: string[] = [];
    let exitFn: (() => void) | null = null;
    const { calls, fetchImpl } = recorder(() => resp(200, { results: [] }));
    const installed = installOpenAlexGate(fetchImpl, {
      env: { OPENALEX_API_KEY: KEY },
      write: (l) => lines.push(l),
      onExit: (fn) => {
        exitFn = fn;
      },
    });
    expect(installed.gate.hasKey).toBe(true);
    await installed.fetchImpl(SEARCH, INIT);
    expect(calls[0]?.init.headers?.Authorization).toBe(`Bearer ${KEY}`);
    (exitFn as unknown as () => void)();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^openalex budget: remaining=500 .*calls=1, searches=1, .*key=yes/);
    expect(lines[0]).not.toContain(KEY);

    const quiet: string[] = [];
    let quietExit: (() => void) | null = null;
    installOpenAlexGate(fetchImpl, {
      env: {},
      write: (l) => quiet.push(l),
      onExit: (fn) => {
        quietExit = fn;
      },
    });
    (quietExit as unknown as () => void)();
    expect(quiet).toEqual([]);
  });
});

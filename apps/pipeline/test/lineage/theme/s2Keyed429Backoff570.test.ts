/**
 * #570: the keyed Semantic Scholar `/paper/batch` callers that go through
 * `requestWithRetry` (citation counts, abstract fallback) back off from a
 * 429 exponentially from 1 s capped at 8 s, the same constants as
 * `s2Citations.ts` (#571); without a key the old 2 s doubling stays. Every
 * retry of the abstract fallback waits for the shared S2 pacer. The
 * OpenAlex DOI lookup in `s2Expansion.ts` is not an S2 call and keeps its
 * budget. No network: fetch and sleep are injected.
 */
import { describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type { ThemeGraphNode } from "../../../src/lineage/shared/node.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import { supplementAbstracts } from "../../../src/lineage/theme/s2AbstractFallback.js";
import {
  applyS2CitationCounts,
  S2_COUNT_RETRY,
} from "../../../src/lineage/theme/s2CitationCounts.js";
import {
  S2_KEYED_429_BACKOFF_BASE_MS,
  S2_KEYED_429_BACKOFF_MAX_MS,
} from "../../../src/lineage/theme/s2Citations.js";
import { mapS2PapersToOpenalex } from "../../../src/lineage/theme/s2Expansion.js";

function node(id: string, arxiv: string): ThemeGraphNode {
  return {
    id,
    title: id,
    year: 2021,
    venue: "arXiv",
    venue_tier: "preprint",
    authors: [],
    kinds: [],
    citation_count: 1,
    github_stars: 0,
    tldr: "",
    arxiv_id: arxiv,
  };
}

/** A fake endpoint answering `statusFor(callIndex)`; records the call order. */
function scripted(statusFor: (call: number) => number, order?: string[]) {
  let calls = 0;
  const fetchImpl = async (_url: string, init?: FetchInit): Promise<HttpResponseLike> => {
    order?.push("fetch");
    const status = statusFor(calls);
    calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as { ids?: string[] };
    return {
      status,
      headers: new Headers(),
      json: async () =>
        (body.ids ?? []).map(() => ({ title: "T", abstract: "an abstract", citationCount: 5 })),
    } as HttpResponseLike;
  };
  return { fetchImpl: fetchImpl as never, calls: () => calls };
}

const KEY = "fake-s2-key-value-570";
const KEYED_FIRST_PASS = [1000, 2000, 4000, 8000];
const KEYLESS_FIRST_PASS = [2000, 4000, 8000, 16000];

describe("keyed S2 429 backoff on the requestWithRetry callers (#570)", () => {
  it("shares the #571 constants", () => {
    expect(S2_KEYED_429_BACKOFF_BASE_MS).toBe(1000);
    expect(S2_KEYED_429_BACKOFF_MAX_MS).toBe(8000);
  });

  it("(e1) citation counts: keyed first pass and retry back off 1,2,4,8 s then 1 s, labelled", async () => {
    const { fetchImpl } = scripted(() => 429);
    const sleeps: number[] = [];
    const warns: string[] = [];
    const stats = await applyS2CitationCounts([node("a", "2101.00001")], {
      cachePath: null,
      fetchImpl,
      apiKey: KEY,
      sleep: async (ms) => void sleeps.push(ms),
      retry: S2_COUNT_RETRY,
      logger: { warn: (m) => warns.push(m) },
    });
    expect(stats.failedChunks).toBe(1);
    // first pass (4 retries), the 30 s pre-retry wait, the retry's one 429 wait
    expect(sleeps).toEqual([...KEYED_FIRST_PASS, S2_COUNT_RETRY.waitMs, 1000]);
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
    const http = warns.filter((w) => w.startsWith("http:"));
    expect(http.length).toBeGreaterThan(0);
    for (const w of http) {
      expect(w).toContain("s2-citation-counts");
      expect(w).not.toContain(KEY);
    }
  });

  it("(e2) citation counts without a key keep 2,4,8,16 s and the 2 s retry wait", async () => {
    const { fetchImpl } = scripted(() => 429);
    const sleeps: number[] = [];
    await applyS2CitationCounts([node("a", "2101.00001")], {
      cachePath: null,
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
      retry: S2_COUNT_RETRY,
    });
    expect(sleeps).toEqual([...KEYLESS_FIRST_PASS, S2_COUNT_RETRY.waitMs, 2000]);
  });

  it("(e3) abstract fallback: keyed 1,2,4,8 s labelled, keyless 2,4,8,16 s", async () => {
    const keyed = scripted(() => 429);
    const sleeps: number[] = [];
    const warns: string[] = [];
    await supplementAbstracts(
      [{ title: "T", externalIds: { ArXiv: "2101.00002" } }],
      {
        fetchImpl: keyed.fetchImpl,
        apiKey: KEY,
        sleep: async (ms) => void sleeps.push(ms),
        logger: { warn: (m) => warns.push(m) },
      },
      new Set(),
      { asked: 0, filled: 0, titleMismatch: 0, notFound: 0, failedChunks: 0 },
    );
    expect(sleeps).toEqual(KEYED_FIRST_PASS);
    const http = warns.filter((w) => w.startsWith("http:"));
    expect(http.length).toBe(5);
    for (const w of http) {
      expect(w).toContain("s2-abstract-fallback");
      expect(w).not.toContain(KEY);
    }

    const keyless = scripted(() => 429);
    const sleeps2: number[] = [];
    await supplementAbstracts(
      [{ title: "T", externalIds: { ArXiv: "2101.00002" } }],
      { fetchImpl: keyless.fetchImpl, sleep: async (ms) => void sleeps2.push(ms) },
      new Set(),
      { asked: 0, filled: 0, titleMismatch: 0, notFound: 0, failedChunks: 0 },
    );
    expect(sleeps2).toEqual(KEYLESS_FIRST_PASS);
  });

  it("(f) abstract fallback: every retry waits for the shared pacer (pace,fetch,pace,fetch)", async () => {
    const order: string[] = [];
    const { fetchImpl } = scripted((i) => (i === 0 ? 429 : 200), order);
    const p = { title: "T", externalIds: { ArXiv: "2101.00003" } } as Record<string, unknown>;
    await supplementAbstracts(
      [p],
      {
        fetchImpl,
        apiKey: KEY,
        sleep: async () => {},
        pace: async () => void order.push("pace"),
      },
      new Set(),
      { asked: 0, filled: 0, titleMismatch: 0, notFound: 0, failedChunks: 0 },
    );
    expect(order).toEqual(["pace", "fetch", "pace", "fetch"]);
    expect(p._gate_abstract).toBe("an abstract");
  });

  it("(h) the OpenAlex DOI lookup in s2Expansion keeps its budget (2 retries, 2 s then 4 s)", async () => {
    const { fetchImpl, calls } = scripted(() => 429);
    const sleeps: number[] = [];
    const paper = {
      paperId: "s1",
      title: "T",
      externalIds: { DOI: "10.1/x" },
    } as unknown as ThemePaper;
    const got = await mapS2PapersToOpenalex([paper], {
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
      now: () => 0,
    });
    expect(got).toBeNull();
    expect(sleeps).toEqual([2000, 4000]);
    expect(calls()).toBe(3);
  });
});

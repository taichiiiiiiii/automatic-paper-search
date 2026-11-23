/**
 * #562: the `/paper/batch` citation-count fetch goes through the shared S2
 * pacer and retries a failed chunk once, after one bounded wait.
 *
 * Measured motivation (2026-11-23, Prompt Tuning upgrade): `/paper/batch`
 * answered 429 four times within 30 s, so the 43 new nodes kept their
 * OpenAlex counts and identities. No network: `fetchImpl` and `sleep` are
 * injected.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type { ThemeGraphNode } from "../../../src/lineage/shared/node.js";
import { s2CountRetryFromEnv } from "../../../src/lineage/theme/cli.js";
import {
  applyS2CitationCounts,
  S2_COUNT_RETRY,
} from "../../../src/lineage/theme/s2CitationCounts.js";
import { S2CitationSource } from "../../../src/lineage/theme/s2Citations.js";

function node(id: string, cites: number, ids: Partial<ThemeGraphNode> = {}): ThemeGraphNode {
  return {
    id,
    title: id,
    year: 2021,
    venue: "arXiv",
    venue_tier: "preprint",
    authors: [],
    kinds: [],
    citation_count: cites,
    github_stars: 0,
    tldr: "",
    ...ids,
  };
}

/** A fake S2 whose answer is decided per request by `statusFor(callIndex)`. */
function scriptedFetch(
  counts: Record<string, number>,
  statusFor: (call: number) => number,
): { fetchImpl: never; calls: { ids: string[]; status: number }[] } {
  const calls: { ids: string[]; status: number }[] = [];
  const fetchImpl = async (_url: string, init?: FetchInit): Promise<HttpResponseLike> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { ids: string[] };
    const status = statusFor(calls.length);
    calls.push({ ids: body.ids, status });
    return {
      status,
      headers: new Headers(),
      json: async () =>
        body.ids.map((i) => (counts[i] === undefined ? null : { citationCount: counts[i] })),
      text: async () => "",
    } as unknown as HttpResponseLike;
  };
  return { fetchImpl: fetchImpl as never, calls };
}

/** requestWithRetry: the first try plus `retry429.maxRetries` (4) retries. */
const FIRST_PASS_ATTEMPTS = 5;

describe("applyS2CitationCounts retry of a failed chunk (#562)", () => {
  it("(a) recovers a chunk that 429ed on every first-pass attempt", async () => {
    const nodes = [node("a", 10, { arxiv_id: "2101.00001" })];
    const { fetchImpl, calls } = scriptedFetch({ "ARXIV:2101.00001": 999 }, (i) =>
      i < FIRST_PASS_ATTEMPTS ? 429 : 200,
    );
    const infos: string[] = [];
    const stats = await applyS2CitationCounts(nodes, {
      cachePath: null,
      fetchImpl,
      sleep: async () => {},
      retry: S2_COUNT_RETRY,
      logger: { info: (m) => infos.push(m) },
    });
    expect(calls.length).toBe(FIRST_PASS_ATTEMPTS + 1);
    expect(stats).toMatchObject({
      failedChunks: 0,
      fetched: 1,
      raised: 1,
      retried: 1,
      recovered: 1,
    });
    expect(nodes[0]?.citation_count).toBe(999);
    expect(nodes[0]?.citation_count_source).toBe("semantic_scholar");
    expect(infos.join("\n")).toMatch(/retried=1 recovered=1/);
  });

  it("(b) keeps OpenAlex values and does not throw when the retry fails too", async () => {
    const nodes = [node("a", 10, { arxiv_id: "2101.00001" })];
    const { fetchImpl } = scriptedFetch({ "ARXIV:2101.00001": 999 }, () => 429);
    const warns: string[] = [];
    const stats = await applyS2CitationCounts(nodes, {
      cachePath: null,
      fetchImpl,
      sleep: async () => {},
      retry: S2_COUNT_RETRY,
      logger: { warn: (m) => warns.push(m) },
    });
    expect(stats).toMatchObject({
      failedChunks: 1,
      fetched: 0,
      raised: 0,
      retried: 1,
      recovered: 0,
    });
    expect(nodes[0]?.citation_count).toBe(10);
    expect(nodes[0]).not.toHaveProperty("citation_count_source");
    expect(warns.join("\n")).toMatch(/1 batch\(es\) failed/);
  });

  it("(c) sends every request (requestWithRetry's retries included) through the shared pacer", async () => {
    const nodes = Array.from({ length: 300 }, (_, i) =>
      node(`n${i}`, 1, { arxiv_id: `2101.${String(i).padStart(5, "0")}` }),
    );
    // chunk 1: 429 twice then 200 (3 requests); chunk 2: 200 (1 request)
    const { fetchImpl, calls } = scriptedFetch({}, (i) => (i < 2 ? 429 : 200));
    let paced = 0;
    const sleeps: number[] = [];
    const stats = await applyS2CitationCounts(nodes, {
      cachePath: null,
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pace: async () => {
        paced += 1;
      },
      retry: S2_COUNT_RETRY,
    });
    expect(calls.length).toBe(4);
    expect(paced).toBe(calls.length);
    expect(stats.failedChunks).toBe(0);
    // With a shared pacer the module adds no inter-chunk interval of its own
    // (only requestWithRetry's two 429 backoffs remain).
    expect(sleeps).toEqual([2000, 4000]);
  });

  it("(c) shares S2CitationSource's pacer: the batch waits out the interval of the previous S2 request", async () => {
    let clock = 0;
    const sourceSleeps: number[] = [];
    const src = new S2CitationSource(null, {
      fetchImpl: (async () => {
        throw new Error("not used");
      }) as never,
      sleep: async (ms) => {
        sourceSleeps.push(ms);
        clock += ms;
      },
      monotonicNow: () => clock,
      apiKey: null,
    });
    await src.pace(); // another S2 stage just sent a request
    const { fetchImpl, calls } = scriptedFetch({ "ARXIV:2101.00001": 5 }, () => 200);
    await applyS2CitationCounts([node("a", 1, { arxiv_id: "2101.00001" })], {
      cachePath: null,
      fetchImpl,
      sleep: async () => {},
      pace: () => src.pace(),
    });
    expect(calls.length).toBe(1);
    expect(sourceSleeps).toEqual([1100]);
  });

  it("(d) waits once before the retry, and the retry adds at most 60 s per build", async () => {
    // 600 ids = 3 chunks; every request fails, so all three are retried.
    const nodes = Array.from({ length: 600 }, (_, i) =>
      node(`n${i}`, 1, { arxiv_id: `2101.${String(i).padStart(5, "0")}` }),
    );
    const { fetchImpl } = scriptedFetch({}, () => 429);
    const sleeps: number[] = [];
    const stats = await applyS2CitationCounts(nodes, {
      cachePath: null,
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pace: async () => {},
      retry: S2_COUNT_RETRY,
    });
    expect(stats).toMatchObject({ failedChunks: 3, retried: 3, recovered: 0 });
    // The first pass (requestWithRetry's own 429 backoffs) never waits 30 s,
    // so the dedicated pre-retry wait is the one 30 s entry.
    const waits = sleeps.filter((ms) => ms === S2_COUNT_RETRY.waitMs);
    expect(waits).toHaveLength(1);
    const retryPhase = sleeps.slice(sleeps.indexOf(S2_COUNT_RETRY.waitMs));
    const retryTotal = retryPhase.reduce((a, b) => a + b, 0);
    expect(retryTotal).toBeGreaterThanOrEqual(S2_COUNT_RETRY.waitMs);
    expect(retryTotal).toBeLessThanOrEqual(60_000);
    expect(S2_COUNT_RETRY.budgetMs).toBeLessThanOrEqual(60_000);
  });

  it("(d) waits nothing when every id is answered from the cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s2counts562-"));
    try {
      const path = join(dir, "c.json");
      writeFileSync(
        path,
        JSON.stringify({
          schema_version: "s2-citation-counts-cache-v1",
          data: { "ARXIV:2101.00001": { n: 50, at: "2026-11-20T00:00:00Z", t: "a", a: [] } },
        }),
      );
      const { fetchImpl, calls } = scriptedFetch({}, () => 200);
      const sleeps: number[] = [];
      let paced = 0;
      const stats = await applyS2CitationCounts([node("a", 1, { arxiv_id: "2101.00001" })], {
        cachePath: path,
        fetchImpl,
        now: () => new Date("2026-11-23T00:00:00Z"),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        pace: async () => {
          paced += 1;
        },
        retry: S2_COUNT_RETRY,
      });
      expect(stats).toMatchObject({ fromCache: 1, fetched: 0, retried: 0 });
      expect(calls).toHaveLength(0);
      expect(paced).toBe(0);
      expect(sleeps).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(e) without a shared pacer keeps its own interval between chunks, and the library default never retries", async () => {
    const nodes = Array.from({ length: 300 }, (_, i) =>
      node(`n${i}`, 1, { arxiv_id: `2101.${String(i).padStart(5, "0")}` }),
    );
    const ok = scriptedFetch({}, () => 200);
    const sleeps: number[] = [];
    await applyS2CitationCounts(nodes, {
      cachePath: null,
      fetchImpl: ok.fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(ok.calls).toHaveLength(2);
    expect(sleeps).toEqual([1100]);

    const keyed: number[] = [];
    await applyS2CitationCounts(
      Array.from({ length: 300 }, (_, i) =>
        node(`k${i}`, 1, { arxiv_id: `2102.${String(i).padStart(5, "0")}` }),
      ),
      {
        cachePath: null,
        apiKey: "test-key",
        fetchImpl: scriptedFetch({}, () => 200).fetchImpl,
        sleep: async (ms) => {
          keyed.push(ms);
        },
      },
    );
    expect(keyed).toEqual([1250]);

    // No `retry` option = the pre-#562 behaviour: a failed chunk is not refetched.
    const bad = scriptedFetch({}, () => 500);
    const stats = await applyS2CitationCounts([node("a", 1, { arxiv_id: "2101.00001" })], {
      cachePath: null,
      fetchImpl: bad.fetchImpl,
      sleep: async () => {},
    });
    expect(stats).toMatchObject({ failedChunks: 1, retried: 0, recovered: 0 });
    expect(bad.calls).toHaveLength(3); // first try + requestWithRetry's two 5xx retries
  });

  it("(f) the theme CLI turns the retry on unless PAPERPILOT_S2_COUNT_RETRY=off", () => {
    expect(s2CountRetryFromEnv({})).toEqual(S2_COUNT_RETRY);
    expect(s2CountRetryFromEnv({ PAPERPILOT_S2_COUNT_RETRY: " OFF " })).toBeNull();
    expect(s2CountRetryFromEnv({ PAPERPILOT_S2_COUNT_RETRY: "on" })).toEqual(S2_COUNT_RETRY);
  });
});

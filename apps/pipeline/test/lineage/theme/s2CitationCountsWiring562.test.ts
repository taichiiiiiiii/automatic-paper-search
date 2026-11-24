/**
 * #562 follow-up: the wiring that makes the `/paper/batch` citation-count
 * fetch share the S2 pacer and retry a failed chunk — `build.ts` passes
 * `pace: () => s2Source.pace()` and `retry: deps.s2CitationCounts.retry`,
 * and the theme CLI's `defaultDeps` passes `s2CountRetryFromEnv(env)` — plus
 * the failure modes of the retry phase itself (5xx, timeout, budget).
 *
 * The module-level behaviour is in `s2CitationCountsRetry562.test.ts`; this
 * file pins that the build and the CLI actually hand those options over, so
 * an unrelated edit of `build.ts` / `cli.ts` cannot drop them silently.
 * No network: every `fetchImpl` and `sleep` is injected.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FetchInit,
  FetchLike,
  HttpResponseLike,
} from "../../../src/collect/http/requestWithRetry.js";
import type { ThemeGraphNode } from "../../../src/lineage/shared/node.js";
import { type BuildThemeLineageDeps, buildThemeLineage } from "../../../src/lineage/theme/build.js";
import { defaultDeps } from "../../../src/lineage/theme/cli.js";
import {
  applyS2CitationCounts,
  S2_COUNT_RETRY,
  type S2CountRetryOptions,
} from "../../../src/lineage/theme/s2CitationCounts.js";
import { S2CitationSource } from "../../../src/lineage/theme/s2Citations.js";

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, headers: new Headers(), json: async () => body } as HttpResponseLike;
}

/** requestWithRetry on the first pass: the first try + 4 retries of a 429. */
const FIRST_PASS_ATTEMPTS = 5;

/** A fake `/paper/batch`: `answer(call)` gives a status (or throws). */
function batchFetch(
  counts: Record<string, number>,
  answer: (call: number) => number,
  events: string[] = [],
): { fetchImpl: FetchLike; calls: number[] } {
  const calls: number[] = [];
  const fetchImpl = async (url: string, init?: FetchInit): Promise<HttpResponseLike> => {
    expect(url).toContain("/paper/batch");
    events.push("batch");
    const ids = (JSON.parse(String(init?.body ?? "{}")) as { ids: string[] }).ids;
    const status = answer(calls.length);
    calls.push(status);
    return jsonResp(
      status,
      ids.map((i) => (counts[i] === undefined ? null : { citationCount: counts[i] })),
    );
  };
  return { fetchImpl: fetchImpl as FetchLike, calls };
}

// ---------------------------------------------------------------------------
// build.ts wiring
// ---------------------------------------------------------------------------

const SEED_ARXIV = "2401.00001";
const SEED_KEY = `ARXIV:${SEED_ARXIV}`;
const S2_COUNT = 9_999;

function s2Paper(pid: string, title: string, year: number, cites: number, arxivId: string) {
  return {
    paperId: pid,
    title,
    year,
    venue: "NeurIPS",
    citationCount: cites,
    abstract: "a".repeat(80),
    authors: [],
    externalIds: { ArXiv: arxivId },
  };
}

let docsRoot: string;
beforeEach(() => {
  docsRoot = tmp("s2wiring-docs-");
});

/** The no-LLM build of `build.test.ts`, with S2 relations on (so build.ts
 * creates an `S2CitationSource`) and the citation counts fetched through
 * `countsFetch`. */
function wiredDeps(
  countsFetch: FetchLike,
  retry: S2CountRetryOptions | null | undefined,
  events: string[],
): BuildThemeLineageDeps {
  const seed = s2Paper("seedn", "Gate Theme Seed Paper", 2020, 100, SEED_ARXIV);
  const parent = s2Paper("parentn", "An Earlier Gate Theme Parent Paper", 2016, 60, "2016.00010");
  const cacheDir = tmp("s2wiring-cache-");
  return {
    fetchImpl: async (url) => {
      events.push("other");
      if (url.includes("/references")) {
        return jsonResp(200, { data: [{ citedPaper: parent, isInfluential: true, intents: [] }] });
      }
      if (url.includes("/citations")) return jsonResp(200, { data: [] });
      return jsonResp(200, { data: [seed], results: [] });
    },
    cacheDir,
    sleep: async () => {},
    docsRoot,
    identityAliasesPath: join(docsRoot, "identity-aliases-v1.json"),
    githubCachePath: join(cacheDir, "github_stars.json"),
    logger: {},
    buildProvider: () => {
      throw new Error("no LLM in this test");
    },
    s2Citations: { cachePath: null },
    s2CitationCounts: {
      cachePath: null,
      fetchImpl: countsFetch,
      ...(retry !== undefined ? { retry } : {}),
    },
  };
}

const OPTS = {
  theme: "Gate Theme",
  depth: 1,
  seedsCount: 3,
  width: 4,
  sinceYear: null,
  lineageLlm: "off" as const,
};

function seedCount(outPath: string): number {
  const payload = JSON.parse(readFileSync(outPath, "utf-8")) as { nodes: ThemeGraphNode[] };
  const seed = payload.nodes.find((n) => n.id === "seedn");
  expect(seed).toBeDefined();
  return seed?.citation_count as number;
}

/** Records every `S2CitationSource.pace()` call (any instance) in `events`. */
function spyPace(events: string[]) {
  const original = S2CitationSource.prototype.pace;
  return vi.spyOn(S2CitationSource.prototype, "pace").mockImplementation(function (
    this: S2CitationSource,
  ) {
    events.push("pace");
    return original.call(this);
  });
}

describe("buildThemeLineage wiring of the /paper/batch citation counts (#562)", () => {
  it("(a) every /paper/batch request waits for the shared S2CitationSource pacer", async () => {
    const events: string[] = [];
    const paceSpy = spyPace(events);
    // Two 429s then 200: three batch requests, each must be paced.
    const { fetchImpl, calls } = batchFetch(
      { [SEED_KEY]: S2_COUNT },
      (i) => (i < 2 ? 429 : 200),
      events,
    );
    const out = await buildThemeLineage(OPTS, wiredDeps(fetchImpl, null, events));
    expect(calls).toEqual([429, 429, 200]);
    expect(seedCount(out)).toBe(S2_COUNT);
    expect(paceSpy.mock.calls.length).toBeGreaterThanOrEqual(calls.length);
    // Each batch request is immediately preceded by a pace() call, i.e. it
    // went through the shared pacer and not the module's own interval.
    events.forEach((e, i) => {
      if (e === "batch") expect(events[i - 1]).toBe("pace");
    });
  });

  it("(b) deps.s2CitationCounts.retry refetches the chunk that failed the first pass", async () => {
    const events: string[] = [];
    const { fetchImpl, calls } = batchFetch({ [SEED_KEY]: S2_COUNT }, (i) =>
      i < FIRST_PASS_ATTEMPTS ? 429 : 200,
    );
    const out = await buildThemeLineage(OPTS, wiredDeps(fetchImpl, S2_COUNT_RETRY, events));
    expect(calls).toHaveLength(FIRST_PASS_ATTEMPTS + 1);
    expect(calls.at(-1)).toBe(200);
    expect(seedCount(out)).toBe(S2_COUNT);
  });

  it("(b) without deps.s2CitationCounts.retry (null or omitted) the failed chunk is not refetched", async () => {
    for (const retry of [null, undefined]) {
      const events: string[] = [];
      const { fetchImpl, calls } = batchFetch({ [SEED_KEY]: S2_COUNT }, (i) =>
        i < FIRST_PASS_ATTEMPTS ? 429 : 200,
      );
      const out = await buildThemeLineage(OPTS, wiredDeps(fetchImpl, retry, events));
      expect(calls).toHaveLength(FIRST_PASS_ATTEMPTS);
      expect(seedCount(out)).toBe(100); // the OpenAlex/search count stays
    }
  });
});

// ---------------------------------------------------------------------------
// cli.ts wiring
// ---------------------------------------------------------------------------

describe("theme CLI defaultDeps wiring of the count retry (#562)", () => {
  const ENV = "PAPERPILOT_S2_COUNT_RETRY";
  const COUNTS_ENV = "PAPERPILOT_S2_CITATION_COUNTS";
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { [ENV]: process.env[ENV], [COUNTS_ENV]: process.env[COUNTS_ENV] };
    delete process.env[COUNTS_ENV];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("(c) passes s2CountRetryFromEnv(process.env) as deps.s2CitationCounts.retry", () => {
    delete process.env[ENV];
    expect(defaultDeps(tmp("s2wiring-cli-")).s2CitationCounts?.retry).toEqual(S2_COUNT_RETRY);
    process.env[ENV] = "off";
    const off = defaultDeps(tmp("s2wiring-cli-")).s2CitationCounts;
    expect(off).not.toBeNull();
    expect(off?.retry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// failures inside the retry phase
// ---------------------------------------------------------------------------

function seedNode(): ThemeGraphNode {
  return {
    id: "a",
    title: "a",
    year: 2021,
    venue: "arXiv",
    venue_tier: "preprint",
    authors: [],
    kinds: [],
    citation_count: 10,
    github_stars: 0,
    tldr: "",
    arxiv_id: "2101.00001",
  };
}

/** Sleeps of the retry phase = every sleep after the first pass's
 * `firstPassSleeps` backoffs (requestWithRetry's 2, 4, 8, 16 s on 429). */
function retryPhase(sleeps: number[], firstPassSleeps: number): number[] {
  return sleeps.slice(firstPassSleeps);
}

describe("applyS2CitationCounts retry phase failures (#562)", () => {
  // The first pass: 5 attempts all 429 -> 4 backoff sleeps (2, 4, 8, 16 s).
  const FIRST_PASS_SLEEPS = FIRST_PASS_ATTEMPTS - 1;

  it("(d) a 5xx during the retry: no throw, the chunk stays failed, waiting within the budget", async () => {
    const n = seedNode();
    const { fetchImpl, calls } = batchFetch({ "ARXIV:2101.00001": 999 }, (i) =>
      i < FIRST_PASS_ATTEMPTS ? 429 : 503,
    );
    const sleeps: number[] = [];
    const stats = await applyS2CitationCounts([n], {
      cachePath: null,
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pace: async () => {},
      retry: S2_COUNT_RETRY,
    });
    expect(stats).toMatchObject({ failedChunks: 1, retried: 1, recovered: 0, fetched: 0 });
    // The retry was sent and answered 5xx (first try + requestWithRetry's 2 retries).
    expect(calls.slice(FIRST_PASS_ATTEMPTS)).toEqual([503, 503, 503]);
    const phase = retryPhase(sleeps, FIRST_PASS_SLEEPS);
    expect(phase[0]).toBe(S2_COUNT_RETRY.waitMs);
    expect(phase.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(S2_COUNT_RETRY.budgetMs);
    expect(n.citation_count).toBe(10);
  });

  it("(e) a timeout (abort) during the retry: no throw, the chunk stays failed, waiting within the budget", async () => {
    const n = seedNode();
    let call = 0;
    const retryCalls: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const i = call++;
      if (i < FIRST_PASS_ATTEMPTS) return jsonResp(429, null);
      retryCalls.push(String(init?.timeoutMs));
      throw new DOMException("The operation was aborted", "AbortError");
    };
    const sleeps: number[] = [];
    const stats = await applyS2CitationCounts([n], {
      cachePath: null,
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pace: async () => {},
      retry: S2_COUNT_RETRY,
    });
    expect(stats).toMatchObject({ failedChunks: 1, retried: 1, recovered: 0, fetched: 0 });
    expect(retryCalls).toHaveLength(2); // first try + requestWithRetry's one timeout retry
    const phase = retryPhase(sleeps, FIRST_PASS_SLEEPS);
    expect(phase).toEqual([S2_COUNT_RETRY.waitMs]);
    expect(phase.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(S2_COUNT_RETRY.budgetMs);
    expect(n.citation_count).toBe(10);
  });

  it("(f) a budget below waitMs clamps the wait, and too little left skips the refetch", async () => {
    const n = seedNode();
    const { fetchImpl, calls } = batchFetch({ "ARXIV:2101.00001": 999 }, () => 429);
    const sleeps: number[] = [];
    const stats = await applyS2CitationCounts([n], {
      cachePath: null,
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pace: async () => {},
      retry: { waitMs: 30_000, budgetMs: 4_000 },
    });
    // 4,000 ms waited (clamped), then 0 left < RETRY_MIN_REMAINING_MS (5 s).
    expect(retryPhase(sleeps, FIRST_PASS_SLEEPS)).toEqual([4_000]);
    expect(stats).toMatchObject({ failedChunks: 1, retried: 0, recovered: 0 });
    expect(calls).toHaveLength(FIRST_PASS_ATTEMPTS);
  });

  it("(f) budgetMs 0 never enters the retry phase: no extra wait, no extra request", async () => {
    const n = seedNode();
    const { fetchImpl, calls } = batchFetch({ "ARXIV:2101.00001": 999 }, () => 429);
    const sleeps: number[] = [];
    const stats = await applyS2CitationCounts([n], {
      cachePath: null,
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pace: async () => {},
      retry: { waitMs: 30_000, budgetMs: 0 },
    });
    expect(sleeps).toHaveLength(FIRST_PASS_SLEEPS);
    expect(retryPhase(sleeps, FIRST_PASS_SLEEPS)).toEqual([]);
    expect(stats).toMatchObject({ failedChunks: 1, retried: 0, recovered: 0 });
    expect(calls).toHaveLength(FIRST_PASS_ATTEMPTS);
  });
});

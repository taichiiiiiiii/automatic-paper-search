/**
 * R2-10: Semantic Scholar reference fetching for theme edges — id
 * resolution order, pagination, the persistent `s2_references.json` cache
 * (hits, TTL, merge-on-write, only looked-up pairs stored), pacing, 429
 * backoff honouring Retry-After, and failure handling. Fake fetch only.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import {
  findReference,
  lookupIdsOf,
  readS2ReferencesCache,
  S2_KEYED_INTERVAL_MS,
  S2_KEYLESS_INTERVAL_MS,
  S2_REFERENCES_SCHEMA,
  S2CitationSource,
} from "../../../src/lineage/theme/s2Citations.js";

interface Call {
  url: string;
  init: FetchInit;
}

function resp(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseLike {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
  };
}

const CITING = {
  paperId: "openalex:W2",
  title: "Graph Attention Networks",
  year: 2018,
  externalIds: { OpenAlex: "W2", ArXiv: "1710.10903", DOI: "10.1/gat" },
};
const CITED = {
  paperId: "openalex:W1",
  title: "Semi-Supervised Classification with Graph Convolutional Networks",
  year: 2017,
  externalIds: { OpenAlex: "W1", ArXiv: "1609.02907v4" },
};
const OTHER = {
  paperId: "openalex:W9",
  title: "Some Paper Nobody Cites Here",
  year: 2015,
  externalIds: { OpenAlex: "W9" },
};

const GCN_REF = {
  contexts: ["We build on the GCN layer [4]."],
  intents: ["methodology"],
  isInfluential: true,
  citedPaper: {
    paperId: "a".repeat(40),
    title: "Semi-Supervised Classification with Graph Convolutional Networks",
    externalIds: { ArXiv: "1609.02907" },
  },
};
const OTHER_REF = {
  contexts: [],
  intents: [],
  isInfluential: false,
  citedPaper: { paperId: "b".repeat(40), title: "Deep Residual Learning", externalIds: {} },
};

function harness(
  handler: (url: string, n: number) => HttpResponseLike,
  opts: { cachePath?: string | null; apiKey?: string | null; now?: Date } = {},
) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const source = new S2CitationSource(opts.cachePath ?? null, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, calls.length);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    monotonicNow: () => clock,
    now: () => opts.now ?? new Date("2026-10-10T00:00:00Z"),
    apiKey: opts.apiKey ?? null,
  });
  return { source, calls, sleeps };
}

describe("id resolution", () => {
  it("tries S2 id, ARXIV, DOI, MAG in order and strips arXiv versions", () => {
    expect(
      lookupIdsOf({
        paperId: "c".repeat(40),
        externalIds: { ArXiv: "2010.11929v2", DOI: "10.1/X", MAG: "42" },
      }),
    ).toEqual(["c".repeat(40), "ARXIV:2010.11929", "DOI:10.1/x", "MAG:42"]);
    // Graph nodes carry arxiv_id / doi / aliases instead of externalIds.
    expect(lookupIdsOf({ id: "openalex:W1", aliases: [["doi", "10.2/y"]] })).toEqual([
      "DOI:10.2/y",
    ]);
  });

  it("matches the cited paper by S2 id, DOI, arXiv id or normalised title", () => {
    expect(findReference([OTHER_REF, GCN_REF], CITED)).toBe(GCN_REF);
    expect(
      findReference([GCN_REF], {
        title: "semi-supervised classification with graph convolutional networks!",
      }),
    ).toBe(GCN_REF);
    expect(findReference([GCN_REF], OTHER)).toBeNull();
  });
});

describe("S2CitationSource.lookup", () => {
  it("fetches /references once per citing paper, with the expected fields", async () => {
    const h = harness(() => resp(200, { offset: 0, data: [OTHER_REF, GCN_REF] }));
    const a = await h.source.lookup(CITING, CITED);
    const b = await h.source.lookup(CITING, OTHER);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe(
      "https://api.semanticscholar.org/graph/v1/paper/ARXIV:1710.10903/references" +
        "?fields=contexts,intents,isInfluential,externalIds,title,year,abstract,venue,citationCount,authors&limit=1000&offset=0",
    );
    expect(h.calls[0]?.init.headers?.["x-api-key"]).toBeUndefined();
    expect(a).toEqual({
      kind: "pair",
      signals: {
        found: true,
        intents: ["methodology"],
        contexts: ["We build on the GCN layer [4]."],
        isInfluential: true,
      },
    });
    expect(b).toMatchObject({ kind: "pair", signals: { found: false } });
  });

  it("pages through `next` and sends the API key when set", async () => {
    const h = harness(
      (url) =>
        url.includes("offset=0")
          ? resp(200, { offset: 0, next: 1000, data: [OTHER_REF] })
          : resp(200, { offset: 1000, data: [GCN_REF] }),
      { apiKey: "k" },
    );
    const r = await h.source.lookup(CITING, CITED);
    expect(r).toMatchObject({ kind: "pair", signals: { found: true } });
    expect(h.calls.map((c) => c.url.split("offset=")[1])).toEqual(["0", "1000"]);
    expect(h.calls[0]?.init.headers?.["x-api-key"]).toBe("k");
    // Paced at the keyed interval between the two requests.
    expect(h.sleeps).toEqual([S2_KEYED_INTERVAL_MS]);
  });

  it("falls back from a 404 arXiv id to the DOI, then to an exact title match", async () => {
    const h = harness((url) => {
      if (url.includes("/paper/ARXIV:")) return resp(404, { error: "not found" });
      if (url.includes("/paper/DOI:")) return resp(404, { error: "not found" });
      if (url.includes("/search/match")) {
        return resp(200, {
          data: [{ paperId: "d".repeat(40), title: "Graph Attention Networks" }],
        });
      }
      return resp(200, { data: [GCN_REF] });
    });
    const r = await h.source.lookup(CITING, CITED);
    expect(r).toMatchObject({ kind: "pair", signals: { found: true } });
    expect(h.calls.map((c) => c.url.split("?")[0])).toEqual([
      "https://api.semanticscholar.org/graph/v1/paper/ARXIV:1710.10903/references",
      "https://api.semanticscholar.org/graph/v1/paper/DOI:10.1/gat/references",
      "https://api.semanticscholar.org/graph/v1/paper/search/match",
      `https://api.semanticscholar.org/graph/v1/paper/${"d".repeat(40)}/references`,
    ]);
    expect(h.sleeps.every((ms) => ms === S2_KEYLESS_INTERVAL_MS)).toBe(true);
  });

  it("reports no S2 data when the citing paper is unknown (and caches that)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s2c-"));
    const cachePath = join(dir, "s2_references.json");
    const h = harness(() => resp(404, null), { cachePath });
    expect(await h.source.lookup(CITING, CITED)).toEqual({
      kind: "no_s2_data",
      reason: "citing-not-in-s2",
    });
    h.source.flush();
    const again = harness(() => resp(500, null), { cachePath });
    expect(await again.source.lookup(CITING, CITED)).toMatchObject({ kind: "no_s2_data" });
    expect(again.calls).toHaveLength(0);
    // ... but only for 14 days.
    const later = harness(() => resp(200, { data: [GCN_REF] }), {
      cachePath,
      now: new Date("2026-10-30T00:00:00Z"),
    });
    expect(await later.source.lookup(CITING, CITED)).toMatchObject({ kind: "pair" });
  });

  it("backs off on 429 honouring Retry-After, then succeeds", async () => {
    const h = harness((_url, n) =>
      n === 1 ? resp(429, null, { "Retry-After": "7" }) : resp(200, { data: [GCN_REF] }),
    );
    const r = await h.source.lookup(CITING, CITED);
    expect(r).toMatchObject({ kind: "pair", signals: { found: true } });
    expect(h.source.stats.rateLimited).toBe(1);
    // 7 s from the header (above the 2 s first backoff), then pacing.
    expect(h.sleeps[0]).toBe(7000);
  });

  it("uses exponential backoff without a hint and gives up as a transient failure (never cached)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s2c-"));
    const cachePath = join(dir, "s2_references.json");
    const h = harness(() => resp(503, null), { cachePath });
    expect(await h.source.lookup(CITING, CITED)).toEqual({
      kind: "no_s2_data",
      reason: "fetch-failed",
    });
    expect(h.calls).toHaveLength(6);
    const backoffs = h.sleeps.filter((ms) => ms !== S2_KEYLESS_INTERVAL_MS);
    expect(backoffs.slice(0, 3)).toEqual([2000, 4000, 8000]);
    // A second pair of the same citing paper does not hammer S2 again.
    await h.source.lookup(CITING, OTHER);
    expect(h.calls).toHaveLength(6);
    h.source.flush();
    expect(existsSync(cachePath)).toBe(false);
  });
});

describe("persistent cache", () => {
  it("stores only looked-up pairs, compactly, and serves them without a request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s2c-"));
    const cachePath = join(dir, "s2_references.json");
    const longCtx = "x".repeat(900);
    const h = harness(
      () =>
        resp(200, {
          data: [{ ...GCN_REF, contexts: [longCtx, "b", "c", "d", "e"] }, OTHER_REF],
        }),
      { cachePath },
    );
    await h.source.lookup(CITING, CITED);
    expect(h.source.flush()).toBe(1);
    const file = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(file.schema_version).toBe(S2_REFERENCES_SCHEMA);
    const entry = file.entries["openalex:W2"];
    expect(entry.s2).toBe("ARXIV:1710.10903");
    expect(entry.fetched_at).toBe("2026-10-10T00:00:00Z");
    expect(Object.keys(entry.pairs)).toEqual(["openalex:W1"]);
    expect(entry.pairs["openalex:W1"].c).toHaveLength(4);
    expect(entry.pairs["openalex:W1"].c[0]).toHaveLength(400);

    const again = harness(() => resp(500, null), { cachePath });
    const hit = await again.source.lookup(CITING, CITED);
    expect(hit).toMatchObject({ kind: "pair", signals: { found: true, isInfluential: true } });
    expect(again.calls).toHaveLength(0);
    expect(again.source.stats.cacheHits).toBe(1);
  });

  it("refetches for a pair the entry does not hold and merges with the file on flush", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s2c-"));
    const cachePath = join(dir, "s2_references.json");
    const first = harness(() => resp(200, { data: [GCN_REF, OTHER_REF] }), { cachePath });
    await first.source.lookup(CITING, CITED);
    first.source.flush();
    const second = harness(() => resp(200, { data: [GCN_REF, OTHER_REF] }), { cachePath });
    const r = await second.source.lookup(CITING, OTHER);
    expect(second.calls).toHaveLength(1);
    expect(r).toMatchObject({ kind: "pair", signals: { found: false } });
    // Another run wrote a different citing paper meantime.
    const onDisk = JSON.parse(readFileSync(cachePath, "utf-8"));
    onDisk.entries["openalex:W7"] = {
      s2: "ARXIV:1",
      fetched_at: "2026-10-09T00:00:00Z",
      pairs: {},
    };
    writeFileSync(cachePath, JSON.stringify(onDisk));
    second.source.flush();
    const merged = readS2ReferencesCache(cachePath);
    expect(Object.keys(merged).sort()).toEqual(["openalex:W2", "openalex:W7"]);
    expect(Object.keys(merged["openalex:W2"]?.pairs ?? {}).sort()).toEqual([
      "openalex:W1",
      "openalex:W9",
    ]);
  });

  it("expires entries after 90 days and ignores a foreign schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s2c-"));
    const cachePath = join(dir, "s2_references.json");
    const first = harness(() => resp(200, { data: [GCN_REF] }), { cachePath });
    await first.source.lookup(CITING, CITED);
    first.source.flush();
    const late = harness(() => resp(200, { data: [GCN_REF] }), {
      cachePath,
      now: new Date("2027-01-09T00:00:00Z"),
    });
    await late.source.lookup(CITING, CITED);
    expect(late.calls).toHaveLength(1);
    writeFileSync(cachePath, JSON.stringify({ schema_version: "other", entries: { x: {} } }));
    expect(readS2ReferencesCache(cachePath)).toEqual({});
  });
});

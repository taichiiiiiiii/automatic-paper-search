/**
 * R2-14: Semantic Scholar fallback for theme expansion and seed search.
 *
 * FlashAttention's OpenAlex records have no `referenced_works`, so an
 * OpenAlex-only BFS never found its ancestors (4 nodes); a Vision
 * Transformer regen got 0 seeds when the OpenAlex search was throttled
 * (exit 4). These tests pin, with fake fetches only:
 *  - `S2CitationSource.referenceList` shares the lookup memo (one request);
 *  - `S2Expansion.expand`: OpenAlex first; < 3 references -> S2 list,
 *    mapped to OpenAlex ids by one DOI lookup, unmapped ones keep the S2
 *    id; a recovered OpenAlex failure is not reported to the ledger; the
 *    result is cached only when the id mapping answered;
 *  - citations fall back to S2 `/citations` when OpenAlex has none;
 *  - in the BFS the S2 candidates still pass the topic gate and width;
 *  - the OpenAlex seed search waits out a throttle honouring Retry-After,
 *    and falls back to S2 search (same filters) when it still fails.
 */
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { BuildCompleteness } from "../../../src/lineage/fetch-state/completeness.js";
import { fetchRelated } from "../../../src/lineage/shared/fetchRelated.js";
import { runBfsAndDescendants } from "../../../src/lineage/theme/bfs.js";
import { discoverSeedsOpenalexPrimary } from "../../../src/lineage/theme/discoverSeeds.js";
import { discoverSeedsViaOpenalex } from "../../../src/lineage/theme/openalexFetch.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import { S2CitationSource } from "../../../src/lineage/theme/s2Citations.js";
import { S2Expansion, s2EdgeToPaper } from "../../../src/lineage/theme/s2Expansion.js";
import { TopicScope } from "../../../src/lineage/theme/topicScope.js";

function resp(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseLike {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
  };
}

const sha = (c: string) => c.repeat(40);

/** FlashAttention as an OpenAlex seed with no referenced_works. */
const FA: ThemePaper = {
  paperId: "openalex:W4281758439",
  title: "FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness",
  year: 2022,
  venue: "arXiv",
  citationCount: 1500,
  abstract: "We propose FlashAttention, an IO-aware exact attention algorithm.",
  authors: [{ name: "Tri Dao" }],
  externalIds: { OpenAlex: "W4281758439", ArXiv: "2205.14135" },
};

function s2Ref(
  id: string,
  title: string,
  opts: { arxiv?: string; abstract?: string | null; cites?: number; infl?: boolean } = {},
) {
  return {
    contexts: [`we use ${title}`],
    intents: opts.infl ? ["methodology"] : [],
    isInfluential: opts.infl ?? false,
    citedPaper: {
      paperId: id,
      title,
      year: 2019,
      venue: "NeurIPS",
      citationCount: opts.cites ?? 100,
      abstract: opts.abstract === undefined ? `${title}. An attention method.` : opts.abstract,
      authors: [{ authorId: "1", name: "A. Author" }],
      externalIds: opts.arxiv ? { ArXiv: opts.arxiv } : {},
    },
  };
}

/** S2 references of FlashAttention: two on-topic attention papers (one
 * OpenAlex knows by its arXiv DOI), one off-topic paper. */
const FA_S2_REFS = [
  s2Ref(sha("a"), "Self-attention Does Not Need O(n^2) Memory", {
    arxiv: "2112.05682",
    abstract: "Memory-efficient exact attention, like flash attention, computed in chunks.",
    infl: true,
  }),
  s2Ref(sha("b"), "Online normalizer calculation for softmax", {
    abstract: "A softmax trick later used by flash attention kernels.",
    cites: 50,
  }),
  s2Ref(sha("c"), "ImageNet Large Scale Visual Recognition Challenge", {
    abstract: "A large image classification benchmark.",
    cites: 30000,
  }),
];

/** The OpenAlex Work for the arXiv DOI of the first reference. */
const OA_RABE = {
  id: "https://openalex.org/W4226000001",
  title: "Self-attention Does Not Need O(n^2) Memory",
  publication_year: 2021,
  doi: "https://doi.org/10.48550/arxiv.2112.05682",
  cited_by_count: 120,
  abstract_inverted_index: null,
  ids: { openalex: "https://openalex.org/W4226000001" },
};

interface Router {
  openalexRefs?: () => HttpResponseLike;
  openalexCites?: () => HttpResponseLike;
  openalexDoi?: (url: string) => HttpResponseLike;
  openalexSearch?: (n: number) => HttpResponseLike;
  s2Refs?: () => HttpResponseLike;
  s2Cites?: () => HttpResponseLike;
  s2Search?: (url: string) => HttpResponseLike;
}

function harness(router: Router) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  let searches = 0;
  const fetchImpl = async (url: string, _init: FetchInit): Promise<HttpResponseLike> => {
    calls.push(url);
    const u = decodeURIComponent(url);
    if (u.startsWith("https://api.openalex.org/works/")) {
      return router.openalexRefs?.() ?? resp(200, { id: "x", referenced_works: [] });
    }
    if (u.startsWith("https://api.openalex.org/works?")) {
      if (u.includes("filter=cites:"))
        return router.openalexCites?.() ?? resp(200, { results: [] });
      if (u.includes("filter=doi:")) return router.openalexDoi?.(u) ?? resp(200, { results: [] });
      if (u.includes("search=")) {
        searches += 1;
        return router.openalexSearch?.(searches) ?? resp(200, { results: [] });
      }
    }
    if (u.includes("api.semanticscholar.org/graph/v1/paper/search")) {
      return router.s2Search?.(u) ?? resp(200, { data: [] });
    }
    if (u.includes("/references?")) return router.s2Refs?.() ?? resp(200, { data: [] });
    if (u.includes("/citations?")) return router.s2Cites?.() ?? resp(200, { data: [] });
    throw new Error(`unexpected ${url}`);
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock += ms;
  };
  const now = () => clock;
  const source = new S2CitationSource(null, {
    fetchImpl,
    sleep,
    monotonicNow: now,
    now: () => new Date("2026-10-10T00:00:00Z"),
  });
  return { calls, sleeps, fetchImpl, sleep, now, source };
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "s2-expansion-"));
});

function netDeps(h: ReturnType<typeof harness>) {
  return {
    fetchImpl: h.fetchImpl,
    cacheDir,
    sleep: h.sleep,
    now: h.now,
    logger: { warn: () => {} },
  };
}

function expansionFor(h: ReturnType<typeof harness>, opts: { cache?: boolean } = {}) {
  return new S2Expansion({
    source: h.source,
    openalex: netDeps(h),
    cacheDir: opts.cache === false ? null : cacheDir,
  });
}

describe("S2CitationSource.referenceList", () => {
  it("returns the full list and shares it with lookup (one request)", async () => {
    const h = harness({ s2Refs: () => resp(200, { data: FA_S2_REFS }) });
    const list = await h.source.referenceList(FA as unknown as Record<string, unknown>);
    expect(list).toHaveLength(3);
    const pair = await h.source.lookup(FA as unknown as Record<string, unknown>, {
      paperId: sha("a"),
      title: "Self-attention Does Not Need O(n^2) Memory",
    });
    expect(pair.kind).toBe("pair");
    expect(h.calls.filter((u) => u.includes("/references"))).toHaveLength(1);
    expect(h.calls[0]).toContain("abstract,venue,citationCount,authors");
  });

  it("citationList fetches one page of /citations by the paper's S2 lookup id", async () => {
    const h = harness({ s2Cites: () => resp(200, { data: [] }) });
    expect(await h.source.citationList(FA as unknown as Record<string, unknown>)).toEqual([]);
    expect(h.calls[0]).toContain("/paper/ARXIV:2205.14135/citations?");
    expect(h.source.stats.citationListsFetched).toBe(1);
  });
});

describe("s2EdgeToPaper", () => {
  it("keeps DOI/arXiv/MAG only: an ACL id beside an arXiv id would be two canonical identities", () => {
    const p = s2EdgeToPaper(
      { isInfluential: true, intents: ["background"] },
      {
        paperId: sha("9"),
        title: "Efficient Content-Based Sparse Attention with Routing Transformers",
        externalIds: { ArXiv: "2003.05997", ACL: "2021.tacl-1.4", DBLP: "x", MAG: 2997517014 },
      },
    );
    expect(p?.externalIds).toEqual({ ArXiv: "2003.05997", MAG: "2997517014" });
    expect(p?._intents).toEqual(["background"]);
    expect(s2EdgeToPaper({}, { paperId: "not-an-s2-id", title: "x" })).toBeNull();
  });
});

describe("S2Expansion.expand (references)", () => {
  it("uses S2 when OpenAlex lists no references; maps to OpenAlex ids where it can", async () => {
    const h = harness({
      s2Refs: () => resp(200, { data: FA_S2_REFS }),
      openalexDoi: () => resp(200, { results: [OA_RABE] }),
    });
    const ledger = new BuildCompleteness();
    const exp = expansionFor(h);
    const got = await exp.expand(
      FA,
      "references",
      32,
      (l) => fetchRelated(FA.paperId, "references", 32, netDeps(h), l),
      ledger,
    );
    const ids = got.map((p) => p.paperId);
    // OpenAlex knows Rabe & Staats by its arXiv DOI; the others keep S2 ids.
    expect(ids).toContain("openalex:W4226000001");
    expect(ids).toContain(sha("b"));
    expect(ids).toContain(sha("c"));
    const rabe = got.find((p) => p.paperId === "openalex:W4226000001");
    // OpenAlex had no abstract: S2's fills the gap; S2 edge signals kept.
    expect(rabe?.abstract).toContain("flash attention");
    expect(rabe?._is_influential).toBe(true);
    expect(rabe?.externalIds.ArXiv).toBe("2112.05682");
    expect(exp.stats).toMatchObject({ s2: 1, openalex: 0, mappedToOpenalex: 1, keptS2Ids: 2 });
    expect(exp.summary()).toMatch(/^expansion sources: openalex=0 s2=1 /);
    // Asking again for the same node (topic-gate prefetch + BFS) counts once.
    await exp.expand(FA, "references", 32, async () => []);
    expect(exp.stats.s2).toBe(1);
    expect(ledger.expansionsAttempted).toBe(1);
    expect(ledger.expansionsFailed).toBe(0);
    // Cached: a second expansion asks nobody.
    const before = h.calls.length;
    const again = await expansionFor(h).related(FA, "references", 32);
    expect(again?.map((p) => p.paperId)).toEqual(ids);
    expect(h.calls.length).toBe(before);
  });

  it("keeps OpenAlex when it lists enough references (no S2 request)", async () => {
    const refs = ["W1", "W2", "W3"].map((w) => `https://openalex.org/${w}`);
    const works = ["W1", "W2", "W3"].map((w) => ({
      id: `https://openalex.org/${w}`,
      title: `Attention paper ${w}`,
      publication_year: 2020,
      cited_by_count: 10,
    }));
    const h = harness({
      openalexRefs: () => resp(200, { id: "x", referenced_works: refs }),
      openalexDoi: () => resp(500, {}),
    });
    // The batch fetch by id goes through the same `works?filter=` route.
    const fetchImpl = h.fetchImpl;
    const deps = {
      ...netDeps(h),
      fetchImpl: async (url: string, init: FetchInit) =>
        decodeURIComponent(url).includes("filter=openalex:")
          ? resp(200, { results: works })
          : fetchImpl(url, init),
    };
    const exp = expansionFor(h);
    const got = await exp.expand(FA, "references", 32, (l) =>
      fetchRelated(FA.paperId, "references", 32, deps, l),
    );
    expect(got).toHaveLength(3);
    expect(h.calls.some((u) => u.includes("semanticscholar"))).toBe(false);
    expect(exp.stats).toMatchObject({ openalex: 1, s2: 0 });
  });

  it("recovers a failed OpenAlex fetch without reporting it; a failed id mapping keeps S2 ids and is not cached", async () => {
    const h = harness({
      openalexRefs: () => resp(503, {}),
      openalexDoi: () => resp(500, {}),
      s2Refs: () => resp(200, { data: FA_S2_REFS }),
    });
    const ledger = new BuildCompleteness();
    const exp = expansionFor(h);
    const got = await exp.expand(
      FA,
      "references",
      32,
      (l) => fetchRelated(FA.paperId, "references", 32, netDeps(h), l),
      ledger,
    );
    expect(got.map((p) => p.paperId).sort()).toEqual([sha("a"), sha("b"), sha("c")]);
    expect(ledger.expansionsFailed).toBe(0);
    expect(exp.stats.mappingFailed).toBe(1);
    expect(readdirSync(cacheDir).some((f) => f.startsWith("s2expand_"))).toBe(false);
  });

  it("reports the OpenAlex failure when S2 cannot help either", async () => {
    const h = harness({
      openalexRefs: () => resp(503, {}),
      s2Refs: () => resp(404, {}),
    });
    const ledger = new BuildCompleteness();
    const exp = expansionFor(h, { cache: false });
    const got = await exp.expand(
      { ...FA, title: "" },
      "references",
      32,
      (l) => fetchRelated(FA.paperId, "references", 32, netDeps(h), l),
      ledger,
    );
    expect(got).toEqual([]);
    expect(ledger.expansionsFailed).toBe(1);
    expect(exp.stats.neither).toBe(1);
  });
});

describe("S2Expansion.expand (citations)", () => {
  it("falls back to S2 /citations when OpenAlex has no citing paper", async () => {
    const citing = (id: string, title: string, cites: number) => ({
      isInfluential: false,
      intents: [],
      contexts: [],
      citingPaper: {
        paperId: id,
        title,
        year: 2024,
        citationCount: cites,
        abstract: `${title} builds on flash attention.`,
        externalIds: {},
      },
    });
    const h = harness({
      s2Cites: () =>
        resp(200, {
          data: [
            citing(sha("d"), "FlashAttention-3", 300),
            citing(sha("e"), "Some small follow-up", 1),
          ],
        }),
    });
    const exp = expansionFor(h);
    const got = await exp.expand(FA, "citations", 1, (l) =>
      fetchRelated(FA.paperId, "citations", 1, netDeps(h), l),
    );
    // Ranked by citations, capped at the limit.
    expect(got.map((p) => p.paperId)).toEqual([sha("d")]);
    expect(exp.stats.s2).toBe(1);
  });
});

describe("runBfsAndDescendants with the S2 expansion fallback", () => {
  it("grows past the seed; S2 candidates still pass the topic gate and width", async () => {
    const h = harness({
      s2Refs: () => resp(200, { data: FA_S2_REFS }),
      openalexDoi: () => resp(200, { results: [OA_RABE] }),
    });
    const exp = expansionFor(h);
    const opts = {
      depth: 1,
      width: 1,
      maxSeedCite: 10 ** 9,
      provider: null,
      llmStrict: "off",
      currentYear: 2026,
      topicScope: TopicScope.forTheme("Flash Attention"),
    };
    const without = await runBfsAndDescendants([FA], opts, netDeps(h));
    expect([...without.nodes.keys()]).toEqual([FA.paperId]);

    const result = await runBfsAndDescendants([FA], { ...opts, s2Expansion: exp }, netDeps(h));
    const ids = [...result.nodes.keys()];
    // Width 1: only the best on-topic parent (influential Rabe & Staats);
    // the off-topic ImageNet paper never enters.
    expect(ids).toEqual([FA.paperId, "openalex:W4226000001"]);
    expect(result.edges.some((e) => e.src === "openalex:W4226000001" && e.dst === FA.paperId)).toBe(
      true,
    );
    expect(result.topicRejected).toBeGreaterThanOrEqual(1);
    expect(exp.stats.s2).toBeGreaterThanOrEqual(1);
  });
});

describe("OpenAlex seed search", () => {
  const work = (w: string, title: string) => ({
    id: `https://openalex.org/${w}`,
    title,
    publication_year: 2021,
    cited_by_count: 5000,
    abstract_inverted_index: { Vision: [0], Transformer: [1] },
  });

  it("waits out a throttle honouring Retry-After beyond the old 60 s budget", async () => {
    const h = harness({
      openalexSearch: (n) =>
        n <= 3
          ? resp(429, {}, { "Retry-After": "40" })
          : resp(200, { results: [work("W1", "Vision Transformer")] }),
    });
    const got = await discoverSeedsViaOpenalex(
      { query: "Vision Transformer", topN: 5, sinceYear: 2018 },
      netDeps(h),
    );
    expect(got).toHaveLength(1);
    expect(h.sleeps).toEqual([40_250, 40_250, 40_250]);
  });

  it("falls back to S2 search with the same filters when OpenAlex keeps failing", async () => {
    let s2Url = "";
    const h = harness({
      openalexSearch: () => resp(429, {}, { "Retry-After": "86400" }),
      s2Search: (u) => {
        s2Url = u;
        return resp(200, {
          data: [
            {
              paperId: sha("f"),
              title: "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
              year: 2020,
              venue: "ICLR",
              citationCount: 40000,
              abstract: "Vision Transformer (ViT) applies a pure transformer to image patches.",
              authors: [{ authorId: "1", name: "A. Dosovitskiy" }],
              externalIds: { ArXiv: "2010.11929" },
            },
          ],
        });
      },
      openalexDoi: () =>
        resp(200, {
          results: [
            {
              id: "https://openalex.org/W3094502228",
              title: "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
              publication_year: 2020,
              doi: "https://doi.org/10.48550/arxiv.2010.11929",
              cited_by_count: 30000,
            },
          ],
        }),
    });
    const failures: string[] = [];
    const seeds = await discoverSeedsOpenalexPrimary(
      { keywords: ["Vision Transformer"], topN: 5, sinceYear: 2018, theme: "Vision Transformer" },
      netDeps(h),
      { subjectFailed: (r) => failures.push(r) },
    );
    expect(seeds.map((s) => s.paperId)).toEqual(["openalex:W3094502228"]);
    expect(seeds[0]?.abstract).toContain("Vision Transformer");
    expect(failures).toEqual([]);
    expect(s2Url).toContain("fieldsOfStudy=Computer+Science");
    expect(s2Url).toContain("year=2018-");
    // The day-long Retry-After was not waited for.
    expect(h.sleeps.every((ms) => ms < 120_000)).toBe(true);
  });

  it("records the subject failure when S2 search fails too", async () => {
    const h = harness({
      openalexSearch: () => resp(500, {}),
      s2Search: () => resp(500, {}),
    });
    const failures: string[] = [];
    const seeds = await discoverSeedsOpenalexPrimary(
      { keywords: ["Vision Transformer"], topN: 5, sinceYear: 2018, theme: "Vision Transformer" },
      netDeps(h),
      { subjectFailed: (r) => failures.push(r) },
    );
    expect(seeds).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("openalex seed search");
    expect(existsSync(cacheDir)).toBe(true);
  });
});

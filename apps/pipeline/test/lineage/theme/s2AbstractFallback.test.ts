/**
 * #560: Semantic Scholar abstracts for candidates OpenAlex has none for.
 * Gate only: stored as `_gate_abstract`, never as `abstract`, and never
 * published. No network: a stubbed `fetchImpl` answers `/paper/batch`.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type { FetchRelatedDeps } from "../../../src/lineage/shared/fetchRelated.js";
import { runBfsAndDescendants } from "../../../src/lineage/theme/bfs.js";
import { toThemeNode } from "../../../src/lineage/theme/node.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import {
  type AbstractFallbackPaper,
  hasGateText,
  MAX_FAILED_CHUNKS,
  type S2AbstractStats,
  supplementAbstracts,
} from "../../../src/lineage/theme/s2AbstractFallback.js";
import { paperEmbeddingText } from "../../../src/lineage/theme/topicEmbedding.js";
import { TopicScope } from "../../../src/lineage/theme/topicScope.js";

type S2Item = { title: string; abstract: string | null } | null;

function stub(answers: Record<string, S2Item>, status = 200) {
  const calls: { ids: string[]; key: string | undefined }[] = [];
  const fetchImpl = async (_url: string, init?: FetchInit): Promise<HttpResponseLike> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { ids: string[] };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ ids: body.ids, key: headers["x-api-key"] });
    return {
      status,
      headers: new Headers(),
      json: async () => body.ids.map((i) => answers[i] ?? null),
      text: async () => "",
    } as unknown as HttpResponseLike;
  };
  return { fetchImpl: fetchImpl as never, calls };
}

const fresh = (): S2AbstractStats => ({
  asked: 0,
  filled: 0,
  titleMismatch: 0,
  notFound: 0,
  failedChunks: 0,
});

const paper = (
  title: string,
  ids: Record<string, string>,
  abstract?: string,
): AbstractFallbackPaper => ({
  title,
  externalIds: ids,
  ...(abstract ? { abstract } : {}),
});

describe("supplementAbstracts (#560)", () => {
  it("fills _gate_abstract (not abstract) from an S2 answer whose title matches", async () => {
    const p = paper("Prefix-Tuning: Optimizing Continuous Prompts for Generation", {
      ArXiv: "2101.00190v1",
    });
    const { fetchImpl, calls } = stub({
      "ARXIV:2101.00190": {
        title: "Prefix-Tuning: Optimizing Continuous Prompts for Generation",
        abstract: "Fine-tuning is the de facto way...",
      },
    });
    const stats = fresh();
    await supplementAbstracts([p], { fetchImpl, apiKey: "k" }, new Set(), stats);
    expect(p._gate_abstract).toBe("Fine-tuning is the de facto way...");
    expect(p.abstract).toBeUndefined();
    expect(hasGateText(p)).toBe(true);
    expect(calls[0]?.key).toBe("k");
    expect(stats).toMatchObject({ asked: 1, filled: 1, titleMismatch: 0 });
  });

  it("matches the title after normalisation, rejects a different paper", async () => {
    const same = paper("Self-RAG: Learning to Retrieve", { DOI: "10.1/x" });
    const other = paper("Totally Different Paper", { DOI: "10.1/y" });
    const { fetchImpl } = stub({
      "DOI:10.1/x": { title: "self rag  learning to retrieve", abstract: "A." },
      "DOI:10.1/y": { title: "Another Title", abstract: "B." },
    });
    const stats = fresh();
    await supplementAbstracts([same, other], { fetchImpl, apiKey: "k" }, new Set(), stats);
    expect(same._gate_abstract).toBe("A.");
    expect(other._gate_abstract).toBeUndefined();
    expect(stats.titleMismatch).toBe(1);
  });

  it("leaves papers that already have an abstract, or no S2 id, alone", async () => {
    const has = paper("Has abstract", { ArXiv: "1.1" }, "present");
    const noId = paper("No id", { OpenAlex: "W1" });
    const { fetchImpl, calls } = stub({});
    await supplementAbstracts([has, noId], { fetchImpl, apiKey: "k" }, new Set(), fresh());
    expect(calls).toHaveLength(0);
    expect(has._gate_abstract).toBeUndefined();
    expect(noId._gate_abstract).toBeUndefined();
  });

  it("a failed or throttled chunk changes nothing and is asked again next time", async () => {
    const p = paper("T", { ArXiv: "2.2" });
    const failing = stub({}, 500);
    const tried = new Set<string>();
    const stats = fresh();
    await supplementAbstracts(
      [p],
      { fetchImpl: failing.fetchImpl, apiKey: "k", sleep: async () => {} },
      tried,
      stats,
    );
    expect(p._gate_abstract).toBeUndefined();
    expect(stats.failedChunks).toBe(1);
    expect(tried.size).toBe(0);
    const ok = stub({ "ARXIV:2.2": { title: "T", abstract: "now" } });
    await supplementAbstracts([p], { fetchImpl: ok.fetchImpl, apiKey: "k" }, tried, stats);
    expect(p._gate_abstract).toBe("now");
  });

  it("stops asking after MAX_FAILED_CHUNKS failed chunks in one run", async () => {
    const failing = stub({}, 500);
    const tried = new Set<string>();
    const stats = fresh();
    for (let i = 0; i < 6; i++) {
      await supplementAbstracts(
        [paper(`T${i}`, { ArXiv: `9.${i}` })],
        { fetchImpl: failing.fetchImpl, apiKey: "k", sleep: async () => {} },
        tried,
        stats,
      );
    }
    expect(stats.failedChunks).toBe(MAX_FAILED_CHUNKS);
  });

  it("goes through the shared pacer before every request", async () => {
    const order: string[] = [];
    const { fetchImpl } = stub({ "ARXIV:4.4": { title: "T", abstract: "x" } });
    const wrapped = (async (u: string, i?: FetchInit) => {
      order.push("fetch");
      return (fetchImpl as unknown as (u: string, i?: FetchInit) => Promise<HttpResponseLike>)(
        u,
        i,
      );
    }) as never;
    await supplementAbstracts(
      [paper("T", { ArXiv: "4.4" })],
      { fetchImpl: wrapped, apiKey: "k", pace: async () => void order.push("pace") },
      new Set(),
      fresh(),
    );
    expect(order).toEqual(["pace", "fetch"]);
  });

  it("does not ask twice for the same id in one run", async () => {
    const a = paper("T", { ArXiv: "3.3" });
    const { fetchImpl, calls } = stub({ "ARXIV:3.3": { title: "T", abstract: null } });
    const tried = new Set<string>();
    await supplementAbstracts([a], { fetchImpl, apiKey: "k" }, tried, fresh());
    await supplementAbstracts(
      [paper("T", { ArXiv: "3.3" })],
      { fetchImpl, apiKey: "k" },
      tried,
      fresh(),
    );
    expect(calls).toHaveLength(1);
  });
});

describe("#560: the fallback text is for the gate only", () => {
  it("never reaches the published node (short_abstract / tldr / abstract)", () => {
    const p = {
      paperId: "openalex:W1",
      title: "Prefix-Tuning",
      year: 2021,
      venue: "arXiv",
      citationCount: 5,
      authors: [{ name: "A" }],
      externalIds: { OpenAlex: "W1" },
      _gate_abstract: "S2 SECRET ABSTRACT TEXT",
    } as unknown as ThemePaper;
    const node = toThemeNode(p, {});
    expect(JSON.stringify(node)).not.toContain("S2 SECRET");
    expect(node.short_abstract).toBeUndefined();
  });

  it("the topic scope and the embedding text do read it", () => {
    expect(
      paperEmbeddingText({ title: "Prefix-Tuning", _gate_abstract: "continuous prompts" }),
    ).toBe("Prefix-Tuning. continuous prompts");
    expect(paperEmbeddingText({ title: "X", abstract: "real", _gate_abstract: "s2" })).toBe(
      "X. real",
    );
    const scope = new TopicScope("prompt tuning", []);
    expect(
      scope.isOnTopic({ title: "Prefix-Tuning", _gate_abstract: "a study of prompt tuning" }),
    ).toBe(true);
    expect(scope.isOnTopic({ title: "Prefix-Tuning" })).toBe(false);
  });
});

describe("BFS uses the fallback for the abstract filter (#560)", () => {
  const mk = (
    pid: string,
    title: string,
    abstract: string | undefined,
    ids: Record<string, string>,
  ): ThemePaper =>
    ({
      paperId: pid,
      title,
      year: 2021,
      venue: "ACL",
      citationCount: 500,
      ...(abstract ? { abstract } : {}),
      authors: [],
      externalIds: ids,
    }) as unknown as ThemePaper;
  const seed = mk(
    "seed",
    "Prompt Tuning for Language Models",
    "We study prompt tuning of language models.",
    {},
  );
  const noAbs = mk("prefix", "Prefix-Tuning: Optimizing Continuous Prompts", undefined, {
    ArXiv: "2101.00190",
  });
  let cacheDirOf = "";
  const deps = (): FetchRelatedDeps => {
    cacheDirOf = mkdtempSync(join(tmpdir(), "bfs-s2abs-"));
    const fetchImpl = async (
      url: string,
    ): Promise<{ status: number; json: () => Promise<unknown> }> => {
      if (url.includes("/paper/seed/references"))
        return {
          status: 200,
          json: async () => ({
            data: [{ citedPaper: noAbs, isInfluential: true, intents: ["methodology"] }],
          }),
        };
      if (url.includes("/references") || url.includes("/citations"))
        return { status: 200, json: async () => ({ data: [] }) };
      throw new Error(`unexpected ${url}`);
    };
    return {
      fetchImpl: fetchImpl as never,
      cacheDir: cacheDirOf,
      sleep: async () => {},
      logger: { warn: () => {} },
    };
  };
  const opts = {
    depth: 1,
    width: 8,
    maxSeedCite: 10 ** 9,
    provider: null,
    llmStrict: "off",
    currentYear: 2026,
  };

  it("without the fallback a candidate with no abstract is dropped (as before)", async () => {
    const r = await runBfsAndDescendants([seed], opts, deps());
    expect([...r.nodes.keys()]).toEqual(["seed"]);
  });

  it("with the fallback it is admitted, and the node carries no S2 text", async () => {
    const abstractFallback = async (papers: ThemePaper[]): Promise<void> => {
      for (const p of papers)
        (p as AbstractFallbackPaper)._gate_abstract = "S2 ONLY TEXT about prompt tuning";
    };
    const r = await runBfsAndDescendants([seed], { ...opts, abstractFallback }, deps());
    expect([...r.nodes.keys()].sort()).toEqual(["prefix", "seed"]);
    expect(JSON.stringify([...r.nodes.values()])).not.toContain("S2 ONLY TEXT");
    // ...and no file the BFS wrote (fetch caches) holds the S2 text either.
    for (const f of readdirSync(cacheDirOf)) {
      expect(readFileSync(join(cacheDirOf, f), "utf-8")).not.toContain("S2 ONLY TEXT");
    }
  });
});

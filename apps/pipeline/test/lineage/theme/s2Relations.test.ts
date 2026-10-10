/**
 * R2-10 (design 41 D6): API-first edge classification — the rule result
 * is used without an LLM unless a cue phrase fired or S2 marks the
 * citation influential; the context LLM's answer is mapped onto the v1
 * enum; an unavailable LLM keeps the rule result; edges without S2 data
 * fall through to the existing path; provenance (`s2_context_rule`,
 * `relation-prompt-v4-context`) is accepted by the artifact contract and
 * counted as classified by the D3 gate. Fake fetch / fake LLM only.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type { LLMProvider } from "../../../src/collect/llm/provider.js";
import { validateLineageArtifact } from "../../../src/lineage/contract/v1.js";
import {
  buildContextPrompt,
  CONTEXT_PROMPT_VERSION,
  parseContextResponse,
} from "../../../src/lineage/llm/contextPrompt.js";
import { completeJsonAttributed, FallbackProvider } from "../../../src/lineage/llm/fallback.js";
import { runBfsAndDescendants } from "../../../src/lineage/theme/bfs.js";
import { ThemeCachedClassifyProvider } from "../../../src/lineage/theme/cachedClassifyProvider.js";
import { evidenceClassifiedRate } from "../../../src/lineage/theme/classificationGate.js";
import { makeEdge, PROMPT_VERSION } from "../../../src/lineage/theme/edges.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import { S2CitationSource } from "../../../src/lineage/theme/s2Citations.js";
import {
  deriveS2Relation,
  newS2RelationStats,
  QUOTE_MAX_CHARS,
  type S2RelationContext,
} from "../../../src/lineage/theme/s2Relations.js";

function resp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

function paper(id: string, title: string, year: number, arxiv?: string): ThemePaper {
  return {
    paperId: id,
    title,
    year,
    venue: "NeurIPS",
    citationCount: 100,
    abstract: "a".repeat(80),
    authors: [{ name: "Ada Lovelace" }, { name: "Alan Turing" }],
    externalIds: arxiv ? { ArXiv: arxiv } : {},
  };
}

const A = paper("openalex:WA", "Graph Convolutional Networks for Things", 2017);
const B = paper("openalex:WB", "Attention on Graphs for Other Things", 2019, "1900.00001");

function ref(
  contexts: string[],
  opts: { intents?: string[]; influential?: boolean; title?: string } = {},
) {
  return {
    contexts,
    intents: opts.intents ?? [],
    isInfluential: opts.influential ?? false,
    citedPaper: { paperId: "e".repeat(40), title: opts.title ?? A.title, externalIds: {} },
  };
}

function sourceWith(refs: unknown[] | null): S2CitationSource {
  return new S2CitationSource(null, {
    fetchImpl: async () => (refs === null ? resp(404, null) : resp(200, { data: refs })),
    sleep: async () => {},
  });
}

function fakeProvider(answer: string | null): LLMProvider & {
  completeJson: ReturnType<typeof vi.fn>;
  classifyRelation: ReturnType<typeof vi.fn>;
} {
  return {
    name: "groq",
    model: "m1",
    enabled: true,
    batchSize: 1,
    evaluateBatch: async () => [],
    chat: async () => null,
    classifyRelation: vi.fn(async () => null),
    completeJson: vi.fn(async () => answer),
  };
}

function ctx(source: S2CitationSource, provider: LLMProvider | null): S2RelationContext {
  return { source, provider, stats: newS2RelationStats() };
}

const BUILD_SENTENCE = "We build on the graph convolution of [3] for our attention layer.";

const ANSWER = (o: Record<string, unknown>) =>
  JSON.stringify({
    refers_to_cited: true,
    relation: "builds_on",
    contrast: false,
    confidence: 0.85,
    rationale: "B のグラフ注意層は A のグラフ畳み込みを土台に重み付けを学習する。",
    ...o,
  });

describe("deriveS2Relation routing", () => {
  it("background without a cue: rule result, no LLM call", async () => {
    const llm = fakeProvider(ANSWER({}));
    const c = ctx(
      sourceWith([ref(["Graph networks have become popular for relational data [3]."])]),
      llm,
    );
    const e = await deriveS2Relation(A, B, c);
    expect(e).toMatchObject({ relation: "baseline_only", provenance: "s2_context_rule" });
    expect(e?.rationale).toContain(
      '引用文: "Graph networks have become popular for relational data [3]."',
    );
    expect(llm.completeJson).not.toHaveBeenCalled();
    expect(c.stats).toMatchObject({ rule: 1, llmAsked: 0 });
  });

  it("a cue phrase goes to the context LLM, whose answer wins", async () => {
    const llm = fakeProvider(ANSWER({}));
    const c = ctx(
      sourceWith([ref(["We build on the graph convolution of [3] for our attention layer."])]),
      llm,
    );
    const onLlm = vi.fn();
    const e = await deriveS2Relation(A, B, c, onLlm);
    expect(llm.completeJson).toHaveBeenCalledTimes(1);
    const [system, user] = llm.completeJson.mock.calls[0] as [string, string];
    expect(system).toContain("refers_to_cited");
    expect(user).toContain("Title: Graph Convolutional Networks for Things");
    expect(user).toContain("Authors: Ada Lovelace, Alan Turing");
    expect(user).toContain("1. We build on the graph convolution of [3] for our attention layer.");
    expect(user).toContain("Short name: Graph Convolutional Networks fo…");
    expect(llm.classifyRelation).not.toHaveBeenCalled();
    expect(onLlm).toHaveBeenCalledWith(true);
    expect(e).toMatchObject({
      relation: "extends",
      provenance: "llm",
      promptVersion: CONTEXT_PROMPT_VERSION,
      producedBy: { provider: "groq", model: "groq:m1" },
    });
    expect(e?.rationale).toContain('引用文: "We build on');
  });

  it("the LLM saying the cue is about another work demotes it to baseline_only", async () => {
    const llm = fakeProvider(ANSWER({ refers_to_cited: false, relation: "builds_on" }));
    const c = ctx(
      sourceWith([ref(["We build on the graph convolution of [3] for our attention layer."])]),
      llm,
    );
    expect((await deriveS2Relation(A, B, c))?.relation).toBe("baseline_only");
  });

  it("R2-22: refers_to_cited=false cannot demote a build cue that names the cited paper in words", async () => {
    // DiffPool <- GraphSAGE: "We use the “mean” variant of GRAPHSAGE [16] …",
    // answered refers_to_cited=false by the context LLM.
    const llm = fakeProvider(ANSWER({ refers_to_cited: false, relation: "background" }));
    const c = ctx(
      sourceWith([
        ref([
          "We use the mean variant of GCN [3] and apply our pooling layer after every two layers.",
        ]),
      ]),
      llm,
    );
    const e = await deriveS2Relation(A, B, c);
    expect(e).toMatchObject({ relation: "extends", provenance: "s2_context_rule" });
    // A downgrade that reads the named sentence as use/comparison is accepted.
    const use = fakeProvider(ANSWER({ refers_to_cited: true, relation: "uses_resource" }));
    const c2 = ctx(
      sourceWith([
        ref([
          "We use the mean variant of GCN [3] and apply our pooling layer after every two layers.",
        ]),
      ]),
      use,
    );
    expect((await deriveS2Relation(A, B, c2))?.relation).toBe("baseline_only");
  });

  it("maps an LLM contrast about A to contrasts and a plain comparison to baseline_only", async () => {
    const contrast = fakeProvider(ANSWER({ relation: "compares_with", contrast: true }));
    const c1 = ctx(
      sourceWith([ref(["Unlike [3], we sample a fixed number of neighbours per node."])]),
      contrast,
    );
    expect((await deriveS2Relation(A, B, c1))?.relation).toBe("contrasts");
    const compare = fakeProvider(ANSWER({ relation: "compares_with", contrast: false }));
    const c2 = ctx(
      sourceWith([ref(["Our model clearly outperforms [3] on all three benchmarks."])]),
      compare,
    );
    expect((await deriveS2Relation(A, B, c2))?.relation).toBe("baseline_only");
  });

  it("R2-22: influential without a cue is not asked (the LLM cannot create a strong claim)", async () => {
    const llm = fakeProvider(ANSWER({ relation: "builds_on" }));
    const c = ctx(
      sourceWith([
        ref(["GCN [3] is a widely used spectral graph convolution model."], { influential: true }),
      ]),
      llm,
    );
    expect((await deriveS2Relation(A, B, c))?.relation).toBe("baseline_only");
    expect(llm.completeJson).not.toHaveBeenCalled();
    expect(c.stats.skipped.no_strong_claim).toBe(1);
  });

  it("an unavailable LLM keeps the rule result (contrasts only for a single-target cue)", async () => {
    const dead = fakeProvider(null);
    const single = ctx(
      sourceWith([ref(["Unlike [3], we sample a fixed number of neighbours per node."])]),
      dead,
    );
    const onLlm = vi.fn();
    const e1 = await deriveS2Relation(A, B, single, onLlm);
    expect(e1).toMatchObject({ relation: "contrasts", provenance: "s2_context_rule" });
    expect(onLlm).toHaveBeenCalledWith(false);
    const multi = ctx(
      sourceWith([ref(["Unlike [3, 5], we sample a fixed number of neighbours per node."])]),
      dead,
    );
    expect((await deriveS2Relation(A, B, multi))?.relation).toBe("baseline_only");
    const noLlm = ctx(
      sourceWith([ref(["We build on the graph convolution of [3] for our attention layer."])]),
      null,
    );
    expect(await deriveS2Relation(A, B, noLlm)).toMatchObject({
      relation: "extends",
      provenance: "s2_context_rule",
    });
  });

  it("cites_unspecified and unknown citing papers return null (caller's existing path)", async () => {
    const llm = fakeProvider(ANSWER({}));
    const noCtx = ctx(sourceWith([ref([])]), llm);
    expect(await deriveS2Relation(A, B, noCtx)).toBeNull();
    expect(noCtx.stats.unspecified).toBe(1);
    const unknown = ctx(sourceWith(null), llm);
    expect(await deriveS2Relation(A, B, unknown)).toBeNull();
    expect(unknown.stats.noS2Data).toBe(1);
    expect(llm.completeJson).not.toHaveBeenCalled();
  });

  it("surveys are background without asking the LLM", async () => {
    const llm = fakeProvider(ANSWER({}));
    const survey = { ...B, title: "A Survey of Graph Neural Networks" };
    const c = ctx(sourceWith([ref(["We build on [3]."], { influential: true })]), llm);
    expect((await deriveS2Relation(A, survey, c))?.relation).toBe("baseline_only");
    expect(llm.completeJson).not.toHaveBeenCalled();
  });

  it("truncates the quoted context sentence", async () => {
    const long = `Graph networks [3] ${"z".repeat(600)}.`;
    const e = await deriveS2Relation(A, B, ctx(sourceWith([ref([long])]), null));
    const quoted = /引用文: "(.*)"$/.exec(e?.rationale ?? "")?.[1] ?? "";
    expect(Array.from(quoted)).toHaveLength(QUOTE_MAX_CHARS);
    expect(quoted.endsWith("…")).toBe(true);
  });
});

describe("R2-16 quote and contrast rules", () => {
  const NO_QUOTE = "被引用論文を特定できる引用文はない";

  it("never quotes a bare marker list, a bibliography line or a short fragment", async () => {
    for (const junk of [
      "[19, 41].",
      "[17] Tri Dao, Daniel Y. Fu, Stefano Ermon, Atri Rudra. FlashAttention. In NeurIPS, 2022.",
      "See [3].",
    ]) {
      const e = await deriveS2Relation(A, B, ctx(sourceWith([ref([junk])]), null));
      expect(e).toMatchObject({ relation: "baseline_only", provenance: "s2_context_rule" });
      expect(e?.rationale).not.toContain("引用文:");
      expect(e?.rationale).toContain(NO_QUOTE);
    }
  });

  it("quotes the sentence that names the cited paper, not the first context", async () => {
    const swin = paper("openalex:WS", "Swin Transformer: Hierarchical Vision Transformer", 2021);
    const ir = paper(
      "openalex:WI",
      "SwinIR: Image Restoration Using Swin Transformer",
      2021,
      "2108.10257",
    );
    const e = await deriveS2Relation(
      swin,
      ir,
      ctx(
        sourceWith([
          ref(
            [
              "We show the effects of channel number and block number on model performance in Figs.",
              "Swin Transformer layer (STL) [56] is based on the standard multi-head self-attention.",
            ],
            { title: swin.title },
          ),
        ]),
        null,
      ),
    );
    expect(e?.rationale).toContain('引用文: "Swin Transformer layer (STL) [56]');
    expect(e?.rationale).toContain("「SwinIR」(2021) は 「Swin Transformer」(2021)");
  });

  it("drops the quote when no sentence identifies the cited paper", async () => {
    const e = await deriveS2Relation(
      A,
      B,
      ctx(
        sourceWith([
          ref([
            "Memory access overhead is a critical factor affecting model speed [15, 28, 31, 65].",
          ]),
        ]),
        null,
      ),
    );
    expect(e?.relation).toBe("baseline_only");
    expect(e?.rationale).toContain(NO_QUOTE);
  });

  it("an LLM contrast without a rule contrast cue on the cited paper is baseline_only", async () => {
    const contrast = fakeProvider(ANSWER({ relation: "compares_with", contrast: true }));
    const c = ctx(
      sourceWith([ref(["Our model clearly outperforms [3] on all three benchmarks."])]),
      contrast,
    );
    expect((await deriveS2Relation(A, B, c))?.relation).toBe("baseline_only");
  });

  it("names both papers by short title instead of A / B in context-LLM rationales", async () => {
    const llm = fakeProvider(ANSWER({}));
    const e = await deriveS2Relation(A, B, ctx(sourceWith([ref([BUILD_SENTENCE])]), llm));
    const head = (e?.rationale ?? "").split("引用文:")[0] as string;
    expect(head).toContain("「Graph Convolutional Networks fo…」");
    expect(head).not.toMatch(/(?<![\p{L}\p{N}_-])[AB](?![\p{L}\p{N}_-])/u);
  });
});

describe("context prompt answers", () => {
  it("parses, validates and forces background when the cue is about another work", () => {
    expect(parseContextResponse(`noise ${ANSWER({})} noise`)).toMatchObject({
      relation: "builds_on",
    });
    expect(parseContextResponse(ANSWER({ relation: "supersedes" }))).toBeNull();
    expect(parseContextResponse(ANSWER({ rationale: "短い" }))).toBeNull();
    expect(
      parseContextResponse(
        ANSWER({ refers_to_cited: false, relation: "compares_with", contrast: true }),
      ),
    ).toMatchObject({ relation: "background", contrast: false });
    expect(parseContextResponse(null)).toBeNull();
  });

  it("caps the sentences shown", () => {
    const [, user] = buildContextPrompt(A, B, ["1", "2", "3", "4", "5", "x".repeat(900)]);
    expect(user).toContain("4. 4");
    expect(user).not.toContain("5. 5");
  });

  it("completeJsonAttributed names the answering chain member", async () => {
    const dead = { ...fakeProvider(null), name: "groq" };
    const live = { ...fakeProvider("{}"), name: "gemini", model: "g" };
    const chain = new FallbackProvider([dead, live]);
    expect(await completeJsonAttributed(chain, "s", "u")).toEqual({
      text: "{}",
      producedBy: { provider: "gemini", model: "gemini:g" },
    });
    const throwing = {
      ...fakeProvider(null),
      completeJson: async () => {
        throw new Error("LLM-02");
      },
    };
    expect(await completeJsonAttributed(throwing, "s", "u")).toBeNull();
  });
});

describe("cached context answers (classifications.json v3)", () => {
  it("a second identical pair is answered from the cache with the original producer", async () => {
    const inner = fakeProvider(ANSWER({}));
    const persist = vi.fn(async () => {});
    const cached = new ThemeCachedClassifyProvider(
      inner,
      {},
      {
        producerName: "p",
        producerVersion: "1",
        promptVersion: "relation-prompt-v2",
        classificationSchemaVersion: "s",
      },
      {
        cachePath: "/nonexistent/dir/classifications.json",
        persist,
        now: () => new Date("2026-10-10T00:00:00Z"),
      },
    );
    const refs = [ref(["We build on the graph convolution of [3] for our attention layer."])];
    const e1 = await deriveS2Relation(A, B, ctx(sourceWith(refs), cached));
    const e2 = await deriveS2Relation(A, B, ctx(sourceWith(refs), cached));
    expect(inner.completeJson).toHaveBeenCalledTimes(1);
    expect(e2).toEqual(e1);
    expect(e2?.producedBy).toEqual({ provider: "groq", model: "groq:m1" });
  });
});

describe("provenance through the contract and the D3 gate", () => {
  it("s2_context_rule and context-LLM edges validate and count as classified", async () => {
    const ruleCls = await deriveS2Relation(A, B, ctx(sourceWith([ref(["See [3]."])]), null));
    const llmCls = await deriveS2Relation(
      A,
      B,
      ctx(
        sourceWith([ref(["We build on the graph convolution of [3] for our attention layer."])]),
        fakeProvider(ANSWER({})),
      ),
    );
    const C = paper("openalex:WC", "Third", 2020);
    const opts = (dst: ThemePaper) => ({
      srcId: A.paperId,
      dstId: dst.paperId,
      parent: A,
      child: dst,
      intentRecord: A,
      provider: null,
    });
    const e1 = makeEdge(ruleCls!, opts(B));
    const e2 = makeEdge(llmCls!, opts(C));
    expect(e1.provenance).toMatchObject({
      evidence: { source: "semantic_scholar", kind: "citation-context" },
      classification: { method: "s2_context_rule", provider: null, prompt_version: null },
    });
    expect(e2.provenance).toMatchObject({
      evidence: { source: "semantic_scholar", kind: "relation-input" },
      classification: { method: "llm", provider: "groq", prompt_version: CONTEXT_PROMPT_VERSION },
    });
    const node = (p: ThemePaper, focus = false) => ({
      id: p.paperId,
      title: p.title,
      is_focus: focus,
      ...(focus ? { seed_paper_id: "1".repeat(40) } : {}),
    });
    const artifact = {
      schema_version: "lineage-artifact-v1",
      root: A.paperId,
      nodes: [node(A, true), node(B), node(C)],
      edges: [e1, e2],
      clusters: [],
      meta: { kind: "theme", generator: "t", generated_at: "2026-10-10T00:00:00Z" },
    };
    expect(validateLineageArtifact(artifact, { kind: "theme" })).toEqual([]);
    const rate = evidenceClassifiedRate({ s2_context_rule: 7, llm: 1, citation_heuristic: 2 });
    expect(rate).toMatchObject({ classified: 8, guessed: 2, ratio: 0.8 });
    expect(rate.byMethod).toEqual({ s2_context_rule: 7, llm: 1 });
  });
});

describe("BFS wiring", () => {
  it("classifies BFS edges from S2 first, asks the LLM only for cue edges, and keeps the abstract path for pairs without S2 data", async () => {
    const seed = paper("seed1", "Seed Graph Model", 2023, "2301.00001");
    const parentEntry = (pid: string, title: string) => ({
      citedPaper: {
        paperId: pid,
        title,
        year: 2018,
        citationCount: 500,
        abstract: "a".repeat(80),
        authors: [],
        externalIds: {},
      },
      isInfluential: true,
      intents: [],
    });
    const fetchImpl = async (url: string, _init: FetchInit): Promise<HttpResponseLike> => {
      if (url.includes("/paper/seed1/references")) {
        return resp(200, {
          data: [
            parentEntry("p_bg", "Background Paper"),
            parentEntry("p_cue", "Cue Paper"),
            parentEntry("p_none", "Unlisted Paper"),
          ],
        });
      }
      if (url.includes("/paper/ARXIV:2301.00001/references")) {
        return resp(200, {
          data: [
            {
              contexts: ["Graphs are common [1]."],
              intents: [],
              isInfluential: false,
              citedPaper: { title: "Background Paper" },
            },
            {
              contexts: ["We build on the message passing scheme of [2] in our encoder."],
              intents: [],
              isInfluential: false,
              citedPaper: { title: "Cue Paper" },
            },
          ],
        });
      }
      return resp(200, { data: [] });
    };
    const deps = {
      fetchImpl,
      cacheDir: mkdtempSync(join(tmpdir(), "bfs-s2-")),
      sleep: async () => {},
      logger: { warn: () => {} },
    };
    const llm = fakeProvider(ANSWER({}));
    llm.classifyRelation.mockResolvedValue({
      relation: "successor",
      confidence: 0.8,
      rationale: "B は A の Unlisted な仕組みを発展させた後継研究である。",
    });
    const s2 = ctx(new S2CitationSource(null, { fetchImpl, sleep: async () => {} }), llm);
    const res = await runBfsAndDescendants(
      [seed],
      {
        depth: 1,
        width: 5,
        maxSeedCite: 10_000,
        provider: llm,
        llmStrict: "ambiguous",
        currentYear: 2026,
        s2Relations: s2,
      },
      deps,
    );
    const byParent = Object.fromEntries(res.edges.map((e) => [e.src, e]));
    expect(byParent.p_bg?.provenance).toMatchObject({
      classification: { method: "s2_context_rule" },
    });
    expect(byParent.p_bg?.relation).toBe("baseline_only");
    expect(byParent.p_cue?.provenance).toMatchObject({
      classification: { method: "llm", prompt_version: CONTEXT_PROMPT_VERSION },
    });
    expect(byParent.p_none?.provenance).toMatchObject({
      classification: { method: "llm", prompt_version: PROMPT_VERSION },
    });
    expect(llm.completeJson).toHaveBeenCalledTimes(1);
    expect(llm.classifyRelation).toHaveBeenCalledTimes(1);
    expect(res.llmCalls).toBe(2);
    expect(s2.stats).toMatchObject({ rule: 1, llmAsked: 1, llmAnswered: 1, unspecified: 1 });
  });
});

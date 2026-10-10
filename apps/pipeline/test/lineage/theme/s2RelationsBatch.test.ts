/**
 * R2-20 (Groq token budget): confident-rule skips, batched context
 * prompts with single-call fallback, per-pair cache entries under the
 * semantic key, and the deferred-edge replacement in the BFS graph.
 * Fake fetch / fake LLM only.
 */
import { describe, expect, it, vi } from "vitest";
import type { HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type { CompletionOptions, LLMProvider } from "../../../src/collect/llm/provider.js";
import type { ClassificationCache } from "../../../src/lineage/classify/cache.js";
import {
  buildContextBatchPrompt,
  buildContextPrompt,
  CONTEXT_BATCH_SYSTEM_PROMPT,
  CONTEXT_SYSTEM_PROMPT,
  contextPromptInputs,
  parseContextBatchResponse,
} from "../../../src/lineage/llm/contextPrompt.js";
import { applyDeferredS2Relations } from "../../../src/lineage/theme/bfs.js";
import { ThemeCachedClassifyProvider } from "../../../src/lineage/theme/cachedClassifyProvider.js";
import { makeEdge, type ThemeEdge } from "../../../src/lineage/theme/edges.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import { S2CitationSource } from "../../../src/lineage/theme/s2Citations.js";
import {
  contextLlmSummary,
  deriveS2Relation,
  newS2RelationStats,
  resolvePendingContext,
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
const child = (n: number) =>
  paper(`openalex:WB${n}`, `Attention on Graphs Variant ${n}`, 2019, `1900.0000${n}`);

function ref(contexts: string[], opts: { influential?: boolean; intents?: string[] } = {}) {
  return {
    contexts,
    intents: opts.intents ?? [],
    isInfluential: opts.influential ?? false,
    citedPaper: { paperId: "e".repeat(40), title: A.title, externalIds: {} },
  };
}

function sourceWith(refs: unknown[]): S2CitationSource {
  return new S2CitationSource(null, {
    fetchImpl: async () => resp(200, { data: refs }),
    sleep: async () => {},
  });
}

const BUILD = "We build on the graph convolution of [3] for our attention layer.";

const answerObj = (o: Record<string, unknown> = {}) => ({
  refers_to_cited: true,
  relation: "builds_on",
  contrast: false,
  confidence: 0.85,
  rationale: "B のグラフ注意層は A のグラフ畳み込みを土台に重み付けを学習する。",
  ...o,
});

type Fake = LLMProvider & { completeJson: ReturnType<typeof vi.fn> };

/** Answers a batch prompt with `batchAnswer(ids)` and a single prompt with one answer. */
function fakeProvider(batchAnswer: (ids: string[]) => string | null): Fake {
  return {
    name: "groq",
    model: "m1",
    enabled: true,
    batchSize: 1,
    evaluateBatch: async () => [],
    chat: async () => null,
    classifyRelation: async () => null,
    completeJson: vi.fn(async (system: string, user: string, _opts?: CompletionOptions) => {
      if (system === CONTEXT_BATCH_SYSTEM_PROMPT) {
        const ids = [...user.matchAll(/=== PAIR (p\d+) ===/g)].map((m) => m[1] as string);
        return batchAnswer(ids);
      }
      return JSON.stringify(answerObj());
    }),
  };
}

function ctx(
  source: S2CitationSource,
  provider: LLMProvider | null,
  batchSize = 6,
): S2RelationContext {
  return { source, provider, stats: newS2RelationStats(), batchSize };
}

describe("contextLlmSkipReason (via deriveS2Relation)", () => {
  it("negative cue (protocol / ablation sentence) keeps the rule result without asking", async () => {
    const llm = fakeProvider(() => null);
    const c = ctx(
      sourceWith([ref(["We follow the evaluation protocol of [3] on all datasets."])]),
      llm,
      1,
    );
    const e = await deriveS2Relation(A, child(1), c);
    expect(e?.provenance).toBe("s2_context_rule");
    expect(llm.completeJson).not.toHaveBeenCalled();
    expect(c.stats.skipped).toEqual({ negative_cue: 1 });
    expect(c.stats.llmAsked).toBe(0);
  });

  it("influential-only pair whose sentences all cite >= 3 works without naming A is skipped", async () => {
    const llm = fakeProvider(() => null);
    const c = ctx(
      sourceWith([
        ref(["Graph models have been widely studied [3, 7, 12]."], {
          influential: true,
        }),
      ]),
      llm,
      1,
    );
    const e = await deriveS2Relation(A, child(1), c);
    expect(e?.relation).toBe("baseline_only");
    expect(llm.completeJson).not.toHaveBeenCalled();
    expect(c.stats.skipped).toEqual({ multi_citation: 1 });
  });

  it("a build cue on a sentence about A is still asked", async () => {
    const llm = fakeProvider(() => null);
    const c = ctx(sourceWith([ref([BUILD])]), llm, 1);
    const e = await deriveS2Relation(A, child(1), c);
    expect(llm.completeJson).toHaveBeenCalledTimes(1);
    expect(e?.provenance).toBe("llm");
    expect(c.stats.singleCalls).toBe(1);
  });
});

describe("batched context prompt", () => {
  it("parses {answers:[{id,…}]} per id; drops invalid / duplicated ids; null for the wrong shape", () => {
    const text = JSON.stringify({
      answers: [
        { id: "p1", ...answerObj() },
        { id: "p2", ...answerObj({ relation: "nonsense" }) },
        { id: "p3", ...answerObj() },
        { id: "p3", ...answerObj() },
        { id: "p9", ...answerObj() },
      ],
    });
    const m = parseContextBatchResponse(text, ["p1", "p2", "p3"]);
    expect([...(m?.keys() ?? [])]).toEqual(["p1"]);
    expect(parseContextBatchResponse(JSON.stringify(answerObj()), ["p1"])).toBeNull();
    expect(parseContextBatchResponse("not json", ["p1"])).toBeNull();
    expect(parseContextBatchResponse(null, ["p1"])).toBeNull();
  });

  it("the batch prompt shares the single prompt's instructions and lists every pair", () => {
    const inp = contextPromptInputs(A, child(1), [BUILD]);
    const [system, user] = buildContextBatchPrompt([
      { id: "p1", inputs: inp },
      { id: "p2", inputs: inp },
    ]);
    const shared = CONTEXT_SYSTEM_PROMPT.slice(CONTEXT_SYSTEM_PROMPT.indexOf("A sentence often"));
    expect(system.endsWith(shared)).toBe(true);
    expect(user).toContain("=== PAIR p1 ===");
    expect(user).toContain("=== PAIR p2 ===");
    expect(user).toContain(`1. ${BUILD}`);
    // The single prompt's user block is the pair block of the batch.
    const [, single] = buildContextPrompt(A, child(1), [BUILD]);
    expect(user).toContain(single.slice(0, single.indexOf("\nIs the cue")));
  });

  it("defers uncached pairs and asks up to batchSize per request", async () => {
    const llm = fakeProvider((ids) =>
      JSON.stringify({ answers: ids.map((id) => ({ id, ...answerObj() })) }),
    );
    const c = ctx(sourceWith([ref([BUILD])]), llm, 3);
    const rules = [];
    for (let n = 1; n <= 7; n++) rules.push(await deriveS2Relation(A, child(n), c));
    // Rule edges stand until resolution; nothing asked yet.
    expect(rules.every((e) => e?.provenance === "s2_context_rule")).toBe(true);
    expect(llm.completeJson).not.toHaveBeenCalled();
    const out = await resolvePendingContext(c, () => true);
    expect(out).toHaveLength(7);
    expect(out.every((r) => r.edge.provenance === "llm" && r.edge.relation === "extends")).toBe(
      true,
    );
    // 7 pairs at 3 per request: 3 + 3 batched, the last one alone (single).
    expect(c.stats).toMatchObject({ batchCalls: 2, batchPairs: 6, singleCalls: 1 });
    const opts = llm.completeJson.mock.calls.map((x) => x[2] as CompletionOptions);
    expect(opts[0]).toEqual({ kind: "context-batch", answers: 3 });
    expect(opts[2]).toEqual({ kind: "context", answers: 1 });
    expect(contextLlmSummary(c.stats)).toContain("calls saved: by batching=4");
  });

  it("a malformed batch answer falls back to single requests; a missing id too", async () => {
    let call = 0;
    const llm = fakeProvider((ids) => {
      call += 1;
      if (call === 1) return '{"answers": "oops"}';
      // second batch: only the first id answered
      return JSON.stringify({ answers: [{ id: ids[0], ...answerObj() }] });
    });
    const c = ctx(sourceWith([ref([BUILD])]), llm, 2);
    for (let n = 1; n <= 4; n++) await deriveS2Relation(A, child(n), c);
    const out = await resolvePendingContext(c, () => true);
    expect(out.every((r) => r.edge.provenance === "llm")).toBe(true);
    expect(c.stats).toMatchObject({ batchCalls: 2, batchFallbacks: 3, singleCalls: 3 });
  });

  it("caches every batched pair under its own key; a rerun asks nothing", async () => {
    const cache: ClassificationCache = {};
    const identity = {
      producerName: "p",
      producerVersion: "1",
      promptVersion: "relation-prompt-v4",
      classificationSchemaVersion: "relation-classification-v1",
    };
    const llm = fakeProvider((ids) =>
      JSON.stringify({ answers: ids.map((id) => ({ id, ...answerObj() })) }),
    );
    const wrapped = new ThemeCachedClassifyProvider(llm, cache, identity, { cachePath: null });
    const c1 = ctx(sourceWith([ref([BUILD])]), wrapped, 6);
    for (let n = 1; n <= 4; n++) await deriveS2Relation(A, child(n), c1);
    await resolvePendingContext(c1, () => true);
    expect(llm.completeJson).toHaveBeenCalledTimes(1);
    expect(Object.keys(cache).filter((k) => k.startsWith("v4:"))).toHaveLength(4);
    // Second run: answered from the cache inline, nothing deferred.
    const c2 = ctx(sourceWith([ref([BUILD])]), wrapped, 6);
    const edges = [];
    for (let n = 1; n <= 4; n++) edges.push(await deriveS2Relation(A, child(n), c2));
    expect(edges.every((e) => e?.provenance === "llm")).toBe(true);
    expect(c2.pending ?? []).toHaveLength(0);
    expect(c2.stats.cached).toBe(4);
    expect(llm.completeJson).toHaveBeenCalledTimes(1);
    // ... and inline (batchSize 1) mode reads the same entries.
    const c3 = ctx(sourceWith([ref([BUILD])]), wrapped, 1);
    await deriveS2Relation(A, child(1), c3);
    expect(c3.stats.cached).toBe(1);
    expect(llm.completeJson).toHaveBeenCalledTimes(1);
  });

  it("identical pairs share one answer; pairs whose edge is gone are not asked", async () => {
    const llm = fakeProvider((ids) =>
      JSON.stringify({ answers: ids.map((id) => ({ id, ...answerObj() })) }),
    );
    const c = ctx(sourceWith([ref([BUILD])]), llm, 6);
    await deriveS2Relation(A, child(1), c);
    await deriveS2Relation(A, child(1), c); // same pair again (another BFS pass)
    await deriveS2Relation(A, child(2), c);
    const out = await resolvePendingContext(c, (p) => p.dstId !== child(2).paperId);
    expect(out).toHaveLength(2);
    expect(c.stats).toMatchObject({ deduped: 1, deferredUnused: 1, singleCalls: 1 });
    expect(llm.completeJson).toHaveBeenCalledTimes(1);
  });

  it("applyDeferredS2Relations replaces the provisional rule edge in the graph", async () => {
    const llm = fakeProvider((ids) =>
      JSON.stringify({ answers: ids.map((id) => ({ id, ...answerObj() })) }),
    );
    const c = ctx(sourceWith([ref([BUILD])]), llm, 6);
    const edges: ThemeEdge[] = [];
    for (let n = 1; n <= 2; n++) {
      const b = child(n);
      const rule = await deriveS2Relation(A, b, c);
      if (rule === null) throw new Error("no rule edge");
      edges.push(
        makeEdge(rule, {
          srcId: A.paperId,
          dstId: b.paperId,
          parent: A,
          child: b,
          intentRecord: A,
          provider: llm,
        }),
      );
    }
    expect(edges.every((e) => (e.provenance as any).classification.method === "s2_context_rule"));
    const changed = await applyDeferredS2Relations(edges, c, llm);
    expect(changed).toBe(2);
    for (const e of edges) {
      expect(e.relation).toBe("extends");
      const prov = e.provenance as { classification: Record<string, unknown> };
      expect(prov.classification.method).toBe("llm");
      expect(prov.classification.prompt_version).toBe("relation-prompt-v4-context");
    }
  });
});

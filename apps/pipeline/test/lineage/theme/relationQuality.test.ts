/**
 * R2-2d (design doc 40): relation quality and topical precision of theme
 * lineages — case-sensitive acronym terms, descendant / support / dataset
 * admission, same-title node identity, the survey/dataset `contrasts`
 * guard, the relation-prompt-v2 rules and the extended offline eval.
 * Fixtures mirror the CI regenerations that showed the problems
 * (flash-attention, mixture-of-experts, vision-transformer, GNN).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type {
  ClassifyPaperLike,
  LLMProvider,
  PaperEvaluation,
  RelationClassification,
} from "../../../src/collect/llm/provider.js";
import type { DerivedEdge } from "../../../src/lineage/classify/classify.js";
import { CLASSIFY_SYSTEM_PROMPT } from "../../../src/lineage/llm/base.js";
import type { FetchRelatedDeps } from "../../../src/lineage/shared/fetchRelated.js";
import type { ThemeGraphNode } from "../../../src/lineage/shared/node.js";
import { confirmSupportAdmissions, runBfsAndDescendants } from "../../../src/lineage/theme/bfs.js";
import {
  mergeDuplicateTitleNodes,
  TitleIdentity,
  titleIdentityKey,
} from "../../../src/lineage/theme/dedup.js";
import type { ThemeEdge } from "../../../src/lineage/theme/edges.js";
import { evaluateArtifact, formatReport } from "../../../src/lineage/theme/evalTopicDriftCli.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import {
  GUARDED_RELATION_MAX_CONFIDENCE,
  guardRelation,
  isSurveyLike,
} from "../../../src/lineage/theme/relationGuard.js";
import { looksLikeDataset, TopicScope, themeTerms } from "../../../src/lineage/theme/topicScope.js";

const MOE = "Mixture of Experts";
const moe = () => new TopicScope(MOE, []);
const gnn = (options = {}) => new TopicScope("Graph Neural Network", [], options);

function paper(
  pid: string,
  title: string,
  opts: { year?: number; cites?: number; abstract?: string } = {},
): ThemePaper {
  return {
    paperId: pid,
    title,
    year: opts.year ?? 2020,
    venue: "NeurIPS",
    citationCount: opts.cites ?? 100,
    abstract: opts.abstract ?? `${"Unrelated filler text. ".repeat(4)}`,
    authors: [],
    externalIds: {},
  };
}

// ---- theme terms ----

describe("acronym terms are case-sensitive", () => {
  it("builds MoE / GNN initialisms in their written case and never 'expert' alone", () => {
    const terms = themeTerms(MOE);
    expect(terms).toEqual(expect.arrayContaining(["mixture of experts", "MoE", "MoEs"]));
    for (const t of ["moe", "MOE", "expert", "experts"]) expect(terms).not.toContain(t);
    expect(themeTerms("Graph Neural Network")).toContain("GNN");
  });

  it("matches MoE as a word or a CamelCase suffix, not lower/upper-case or inside a word", () => {
    const s = moe();
    expect(s.isOnTopic({ title: "Region-Aware MoE Network for Image Fusion" })).toBe(true);
    expect(s.isOnTopic({ title: "FasterMoE" })).toBe(true);
    expect(s.isOnTopic({ title: "x", abstract: "Sparse MoEs scale well." })).toBe(true);
    expect(s.isOnTopic({ title: "Domain experts label the data" })).toBe(false);
    expect(s.isOnTopic({ title: "x", abstract: "Funded by the MOE of China." })).toBe(false);
    expect(s.isOnTopic({ title: "x", abstract: "moe is not the acronym" })).toBe(false);
    expect(s.isOnTopic({ title: "MoEfication of dense layers" })).toBe(false);
    expect(gnn().isOnTopic({ title: "GNNExplainer" })).toBe(false);
  });

  it("keeps the subject/component split with the new matcher", () => {
    const s = gnn();
    expect(s.role({ title: "Learning Feature Matching With GNNs" })).toBe("component");
    expect(s.role({ title: "Pre-training GNNs at Scale" })).toBe("subject");
    expect(
      s.role({ title: "EEG-Based Emotion Recognition Using Regularized Graph Neural Networks" }),
    ).toBe("component");
  });
});

// ---- admission ----

describe("descendant and dataset admission", () => {
  it("admits a citing paper only when its title is about the theme", () => {
    const s = moe();
    expect(s.admitsDescendant({ title: "Region-Aware MoE Network" })).toBe("topic");
    // Theme only in the abstract / as a tool: provisional (needs non-seed support).
    expect(
      s.admitsDescendant({
        title: "Channel Estimation for Pinching-Antenna Systems (PASS)",
        abstract: "We use a mixture of experts (MoE) estimator.",
      }),
    ).toBe("provisional");
    expect(gnn().admitsDescendant({ title: "Feature Matching With Graph Neural Networks" })).toBe(
      "provisional",
    );
    // No theme term: rejected; the foundational allowlist does not apply.
    expect(s.admitsDescendant({ title: "Point Transformer V3" })).toBeNull();
    expect(
      gnn().admitsDescendant({ title: "Deep Residual Learning for Image Recognition: A Survey" }),
    ).toBeNull();
    expect(gnn({ gate: false }).admitsDescendant({ title: "anything" })).toBe("topic");
  });

  it("never admits a dataset/benchmark paper by support", () => {
    const pets = {
      title: "Cats and dogs",
      abstract: "To this end we introduce a new annotated dataset of pets covering 37 breeds.",
    };
    expect(looksLikeDataset(pets)).toBe(true);
    expect(looksLikeDataset({ title: "The Open Graph Benchmark" })).toBe(true);
    expect(
      looksLikeDataset({ title: "Non-local Neural Networks", abstract: "We propose a block." }),
    ).toBe(false);
    expect(gnn().admits(pets, 9)).toBeNull();
    expect(gnn().admits({ title: "Non-local Neural Networks" }, 2)).toBe("support");
  });
});

// ---- BFS integration ----

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "rq-bfs-"));
});

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

function bfsDeps(
  refs: Record<string, ThemePaper[]>,
  cites: Record<string, ThemePaper[]> = {},
): FetchRelatedDeps {
  const fetchImpl = async (url: string, _init: FetchInit): Promise<HttpResponseLike> => {
    for (const [id, list] of Object.entries(refs)) {
      if (url.includes(`/paper/${id}/references`)) {
        return jsonResp(200, {
          data: list.map((p) => ({ citedPaper: p, isInfluential: true, intents: ["methodology"] })),
        });
      }
    }
    for (const [id, list] of Object.entries(cites)) {
      if (url.includes(`/paper/${id}/citations`)) {
        return jsonResp(200, {
          data: list.map((p) => ({
            citingPaper: p,
            isInfluential: true,
            intents: ["methodology"],
          })),
        });
      }
    }
    if (url.includes("/references") || url.includes("/citations"))
      return jsonResp(200, { data: [] });
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, cacheDir, sleep: async () => {}, logger: { warn: () => {} } };
}

const OPTS = { depth: 1, width: 8, maxSeedCite: 10 ** 9, provider: null, llmStrict: "off" };

describe("runBfsAndDescendants (R2-2d)", () => {
  it("descendants need a theme title or confirmed support: users of the theme stay out", async () => {
    const seed = paper("fa1", "FlashAttention: Fast and Memory-Efficient Exact Attention", {
      year: 2022,
    });
    const scope = new TopicScope("Flash Attention", ["FlashAttention IO-Awareness"]);
    const ptv3 = paper("ptv3", "Point Transformer V3: Simpler, Faster, Stronger", { year: 2024 });
    const gaze = paper("gaze", "MambaGaze-Stereo: Depth Estimation via Selective Attention", {
      year: 2025,
      abstract: "We accelerate the decoder with FlashAttention kernels and efficient attention.",
    });
    const fa2 = paper("fa2", "FlashAttention-2: Faster Attention with Better Parallelism", {
      year: 2023,
    });
    const result = await runBfsAndDescendants(
      [seed],
      { ...OPTS, currentYear: 2026, topicScope: scope },
      bfsDeps({}, { fa1: [ptv3, gaze, fa2] }),
    );
    // PTv3 (no theme term) is rejected; MambaGaze (FlashAttention only in
    // its abstract) is provisional and dies without non-seed support.
    expect([...result.nodes.keys()].sort()).toEqual(["fa1", "fa2", "gaze"]);
    expect(result.topicRejected).toBe(1);
    expect(result.provisional).toEqual(new Set(["gaze"]));
    const nodes = new Map(result.nodes);
    const confirmed = confirmSupportAdmissions(nodes, result.edges, {
      seedIds: new Set(result.seedIds),
      provisional: result.provisional,
      onTopicIds: result.onTopicIds,
      minSupport: 2,
    });
    expect(confirmed.dropped).toEqual(["gaze"]);
    expect([...nodes.keys()].sort()).toEqual(["fa1", "fa2"]);
    expect(confirmed.edges.map((e) => `${e.src}>${e.dst}`)).toEqual(["fa1>fa2"]);
  });

  it("folds a second ID of the same work (arXiv vs venue version) into the existing node", async () => {
    const vit = paper(
      "vitArxiv",
      "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
      { year: 2020, cites: 9000 },
    );
    const vitIclr = { ...vit, paperId: "vitIclr", year: 2021, cites: 3000 };
    const cvt = paper("cvt", "CvT: Introducing Convolutions to Vision Transformers", {
      year: 2021,
    });
    const scope = new TopicScope("Vision Transformer", ["ViT image patches"]);
    const result = await runBfsAndDescendants(
      [vit, cvt],
      { ...OPTS, currentYear: 2026, topicScope: scope },
      bfsDeps({ cvt: [vitIclr as ThemePaper] }),
    );
    expect(result.nodes.has("vitIclr")).toBe(false);
    expect(result.titleMerged).toBe(1);
    expect(result.edges.map((e) => `${e.src}>${e.dst}`)).toEqual(["vitArxiv>cvt"]);
  });

  it("support admissions are provisional and are dropped without non-seed support", async () => {
    const seedA = paper("seedA", "Graph Neural Networks for Molecules", { year: 2021 });
    const seedB = paper("seedB", "Scalable Graph Neural Network Training", { year: 2021 });
    const glorot = paper("glorot", "Understanding the difficulty of training deep networks", {
      year: 2010,
    });
    const result = await runBfsAndDescendants(
      [seedA, seedB],
      { ...OPTS, currentYear: 2026, topicScope: gnn() },
      bfsDeps({ seedA: [glorot], seedB: [glorot] }),
    );
    expect(result.provisional).toEqual(new Set(["glorot"]));
    const nodes = new Map(result.nodes);
    const confirmed = confirmSupportAdmissions(nodes, result.edges, {
      seedIds: new Set(result.seedIds),
      provisional: result.provisional,
      onTopicIds: result.onTopicIds,
      minSupport: 2,
    });
    expect(confirmed.dropped).toEqual(["glorot"]);
    expect(nodes.has("glorot")).toBe(false);
    expect(confirmed.edges).toHaveLength(0);
  });
});

describe("confirmSupportAdmissions", () => {
  const node = (id: string) => ({ id, title: id }) as unknown as ThemeGraphNode;
  const edge = (src: string, dst: string) => ({ src, dst }) as unknown as ThemeEdge;
  it("keeps a node cited by >= minSupport on-topic non-seed nodes", () => {
    const nodes = new Map(["s", "a", "b", "x", "sup"].map((id) => [id, node(id)]));
    const edges = [edge("x", "s"), edge("x", "a"), edge("x", "b"), edge("x", "sup")];
    const opts = {
      seedIds: new Set(["s"]),
      provisional: new Set(["x", "sup"]),
      onTopicIds: new Set(["s", "a", "b"]),
      minSupport: 2,
    };
    const r = confirmSupportAdmissions(nodes, edges, opts);
    // x: a + b (s is a seed, sup is support-admitted) -> kept; sup: none -> dropped.
    expect(r.dropped).toEqual(["sup"]);
    expect(r.edges).toHaveLength(3);
    expect(nodes.has("x")).toBe(true);
  });
});

// ---- same-title identity ----

describe("title identity", () => {
  it("ignores generic short titles and respects the preprint year window", () => {
    expect(titleIdentityKey("Cats and dogs")).toBeNull();
    const t = new TitleIdentity();
    t.register("a", { title: "An Image is Worth 16x16 Words", year: 2020 });
    expect(t.resolve({ paperId: "b", title: "An image is worth 16x16 words.", year: 2021 })).toBe(
      "a",
    );
    expect(t.resolve({ paperId: "c", title: "An Image is Worth 16x16 Words", year: 2026 })).toBe(
      null,
    );
    expect(t.resolve({ paperId: "a", title: "An Image is Worth 16x16 Words", year: 2020 })).toBe(
      null,
    );
  });

  it("merges artifact duplicates onto the focus node and dedupes the remapped edges", () => {
    const title = "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale";
    const nodes = [
      { id: "iclr", title, year: 2021 },
      { id: "arxiv", title, year: 2020, is_focus: true },
      { id: "pets", title: "Cats and dogs", year: 2012 },
      { id: "cvt", title: "CvT", year: 2021 },
    ];
    const edges = [
      { src: "pets", dst: "arxiv", rel: "contrasts" },
      { src: "pets", dst: "iclr", rel: "extends" },
      { src: "iclr", dst: "cvt", rel: "extends" },
      { src: "arxiv", dst: "iclr", rel: "successor" },
    ];
    const r = mergeDuplicateTitleNodes(nodes, edges);
    expect(r.merged).toEqual([{ survivor: "arxiv", dropped: "iclr", title }]);
    expect(r.nodes.map((n) => n.id)).toEqual(["arxiv", "pets", "cvt"]);
    expect(r.edges.map((e) => `${e.src}>${e.dst}:${e.rel}`)).toEqual([
      "pets>arxiv:contrasts",
      "arxiv>cvt:extends",
    ]);
  });
});

// ---- relation guard ----

const contrasts: DerivedEdge = {
  relation: "contrasts",
  confidence: 0.85,
  rationale: "B のサーベイは A のグラフ信号処理とは根本的に異なるアプローチである。",
  provenance: "llm",
};

describe("relation guard", () => {
  it("detects survey/review titles by whole word", () => {
    expect(isSurveyLike({ title: "A Comprehensive Survey on Graph Neural Networks" })).toBe(true);
    expect(isSurveyLike({ title: "Graph convolutional networks: a comprehensive review" })).toBe(
      true,
    );
    expect(isSurveyLike({ title: "Towards Incremental Learning in LLMs: A Critical Review" })).toBe(
      true,
    );
    expect(isSurveyLike({ title: "Reviewer Assignment with GNNs" })).toBe(false);
  });

  it("rewrites contrasts with a survey or dataset endpoint to baseline_only", () => {
    const sp = { title: "The emerging field of signal processing on graphs" };
    const survey = { title: "A Comprehensive Survey on Graph Neural Networks" };
    const g = guardRelation(contrasts, sp, survey);
    expect(g.relation).toBe("baseline_only");
    expect(g.confidence).toBe(GUARDED_RELATION_MAX_CONFIDENCE);
    expect(g.provenance).toBe("llm");
    expect(g.rationale).toContain("サーベイ/レビュー");
    expect(g.rationale).toContain("グラフ信号処理");
    expect([...g.rationale].length).toBeLessThanOrEqual(200);
    const pets = { title: "Cats and dogs", abstract: "We introduce a new annotated dataset." };
    expect(guardRelation(contrasts, pets, { title: "CvT" }).relation).toBe("baseline_only");
  });

  it("leaves method-vs-method contrasts and every other relation alone", () => {
    const resnet = { title: "Deep Residual Learning for Image Recognition" };
    const vit = { title: "An Image is Worth 16x16 Words" };
    expect(guardRelation(contrasts, resnet, vit)).toBe(contrasts);
    const ext = { ...contrasts, relation: "extends" as const };
    expect(guardRelation(ext, resnet, { title: "A Survey of X" })).toBe(ext);
  });

  it("applies to LLM edges built by the BFS", async () => {
    class Fixed implements LLMProvider {
      readonly name = "groq";
      enabled = true;
      batchSize = 1;
      async evaluateBatch(): Promise<(PaperEvaluation | null)[]> {
        return [];
      }
      async chat(): Promise<string | null> {
        return null;
      }
      async completeJson(): Promise<string | null> {
        return null;
      }
      async classifyRelation(
        _a: ClassifyPaperLike,
        _b: ClassifyPaperLike,
      ): Promise<RelationClassification | null> {
        return { relation: "contrasts", confidence: 0.85, rationale: contrasts.rationale };
      }
    }
    const survey = paper("survey", "A Comprehensive Survey on Graph Neural Networks", {
      year: 2020,
    });
    const gsp = paper("gsp", "Discrete Signal Processing on Graphs", {
      year: 2013,
      abstract: "graph signal processing; a graph neural network precursor",
    });
    const result = await runBfsAndDescendants(
      [survey],
      {
        ...OPTS,
        provider: new Fixed(),
        llmStrict: "all",
        currentYear: 2026,
        topicScope: gnn(),
      },
      bfsDeps({ survey: [gsp] }),
    );
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.relation).toBe("baseline_only");
    expect(result.edges[0]!.rel).toBe("baseline_only");
  });
});

// ---- prompt ----

describe("relation-prompt-v2 contrasts rules", () => {
  it("restricts contrasts to competing methods for the same task, with survey/dataset rules", () => {
    expect(CLASSIFY_SYSTEM_PROMPT).toContain("同じタスクに競合する手法を提案");
    expect(CLASSIFY_SYSTEM_PROMPT).toContain("サーベイ/レビューなら baseline_only か extends");
    expect(CLASSIFY_SYSTEM_PROMPT).toContain("データセット");
    expect(CLASSIFY_SYSTEM_PROMPT).toContain("迷ったら contrasts を選ばない");
    // A positive and a negative few-shot example for the confusable pair.
    expect(CLASSIFY_SYSTEM_PROMPT).toMatch(/- contrasts: "B \(ViT\)/);
    expect(CLASSIFY_SYSTEM_PROMPT).toMatch(/- baseline_only: "B \(GNN サーベイ\)/);
  });
});

// ---- offline eval ----

describe("offline eval: merge + gate + guard with relation histograms", () => {
  it("reports merged duplicates, dropped users of the theme and guarded contrasts", () => {
    const title = "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale";
    const artifact = {
      root: "arxiv",
      meta: { theme: "Vision Transformer" },
      nodes: [
        { id: "arxiv", title, year: 2020, is_focus: true },
        { id: "iclr", title, year: 2021 },
        {
          id: "cvt",
          title: "CvT: Introducing Convolutions to Vision Transformers",
          is_focus: true,
        },
        { id: "survey", title: "Transformers in Vision: A Survey", year: 2022 },
        {
          id: "pets",
          title: "Cats and dogs",
          tldr: "we introduce a new annotated dataset of pets",
        },
      ],
      edges: [
        { src: "arxiv", dst: "cvt", rel: "extends", relation: "extends" },
        { src: "iclr", dst: "cvt", rel: "extends", relation: "extends" },
        { src: "arxiv", dst: "survey", rel: "contrasts", relation: "contrasts" },
        { src: "cvt", dst: "survey", rel: "contrasts", relation: "contrasts" },
        { src: "pets", dst: "arxiv", rel: "contrasts", relation: "contrasts" },
        { src: "pets", dst: "cvt", rel: "contrasts", relation: "contrasts" },
      ],
    };
    const dir = mkdtempSync(join(tmpdir(), "rq-eval-"));
    const path = join(dir, "lineage.json");
    writeFileSync(path, JSON.stringify(artifact));
    const r = evaluateArtifact(path);
    expect(r.merged.map((m) => m.dropped)).toEqual(["iclr"]);
    expect(r.kept.map((k) => k.id).sort()).toEqual(["arxiv", "cvt", "survey"]);
    expect(r.dropped.find((d) => d.id === "pets")?.rule).toBe("support(dataset)");
    expect(r.relationsBefore).toEqual({ contrasts: 4, extends: 2 });
    expect(r.relationsAfter).toEqual({ baseline_only: 2, extends: 1 });
    expect(r.contrastsGuarded).toHaveLength(2);
    expect(formatReport(r)).toContain("relations after:  baseline_only=2 extends=1");
  });
});

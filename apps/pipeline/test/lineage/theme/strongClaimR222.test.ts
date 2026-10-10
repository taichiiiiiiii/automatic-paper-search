/**
 * R2-22: strong-claim precision (design 41 D5). A published extends /
 * successor / supersedes / contrasts needs a quoted citing sentence that
 * names the cited paper and carries a build / contrast cue; the LLM may
 * confirm or downgrade such a rule claim, never create one. Sentences are
 * the real Semantic Scholar contexts of the published lineages.
 */
import { describe, expect, it } from "vitest";
import {
  classifyApiRelationV3,
  classifyS2Pair,
  type PairSignals,
} from "../../../src/lineage/classify/apiRelations.js";
import { titleizeRationale } from "../../../src/lineage/classify/citedTarget.js";
import type { DerivedEdge } from "../../../src/lineage/classify/classify.js";
import { CONTEXT_PROMPT_VERSION } from "../../../src/lineage/llm/contextPrompt.js";
import { suspectMergedRecords } from "../../../src/lineage/theme/nodeIdentityGuard.js";
import { guardRelation, hasQuotedBuildEvidence } from "../../../src/lineage/theme/relationGuard.js";
import {
  contextLlmSkipReason,
  contradictsRelation,
  mergeContextAnswer,
} from "../../../src/lineage/theme/s2Relations.js";

function sig(cited: Record<string, unknown>, contexts: string[], extra: Partial<PairSignals> = {}) {
  return {
    found: true,
    intents: ["methodology", "background"],
    isInfluential: true,
    contexts,
    cited,
    ...extra,
  } as PairSignals;
}

const sparseTransformer = {
  title: "Generating Long Sequences with Sparse Transformers",
  authors: ["Rewon Child", "Scott Gray"],
  year: 2019,
};
const longformer = {
  title: "Longformer: The Long-Document Transformer",
  authors: ["Iz Beltagy", "Matthew E. Peters"],
  year: 2020,
};
const smyrf = {
  title: "SMYRF: Efficient Attention using Asymmetric Clustering",
  authors: ["Giannis Daras"],
  year: 2020,
};
const vit = {
  title: "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
  authors: ["Alexey Dosovitskiy"],
  year: 2020,
};
const fa2 = {
  title: "FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning",
  authors: ["Tri Dao"],
  year: 2023,
};
const gshard = {
  title: "GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding",
  authors: ["Dmitry Lepikhin"],
  year: 2021,
};
const base = {
  title: "BASE Layers: Simplifying Training of Large, Sparse Models",
  authors: ["Mike Lewis"],
  year: 2021,
};
const sage = {
  title: "Inductive Representation Learning on Large Graphs",
  authors: ["William L. Hamilton", "Zhitao Ying", "Jure Leskovec"],
  year: 2017,
};
const swin = {
  title: "Swin Transformer: Hierarchical Vision Transformer using Shifted Windows",
  authors: ["Ze Liu"],
  year: 2021,
};

describe("rule set v3: the weak intent rule never builds_on", () => {
  it("Performer / FlashAttention related-work and limitation sentences are background", () => {
    // Published as extends via methodology intent + influential + named.
    for (const [cited, ctx] of [
      [
        sparseTransformer,
        ", 2018) or incorporate structural priors on attention such as sparsity (Child et al., 2019), pooling-based compression (Rae et al.",
      ],
      [
        longformer,
        ", 2020), where locality sensitive hashing is used to group together tokens of similar embeddings), sliding windows (Beltagy et al., 2020), or truncated targeting (Chelba et al.",
      ],
      [longformer, "Longformer and BigBird do not support sequence lengths longer than 8092."],
      [smyrf, "Linformer Attention [88], Smyrf [20], and LongShortFormer (LSFormer) [98]."],
    ] as const) {
      const r = classifyS2Pair(sig(cited, [ctx]));
      expect(r.relation, ctx).not.toBe("builds_on");
    }
  });
});

describe("rule set v3: R2-22 negative cues and target checks", () => {
  it("copying a model size 'as in Child et al.' is a protocol, not builds_on (Longformer)", () => {
    const r = classifyApiRelationV3(
      sig(sparseTransformer, [
        "We use two different model sizes, a small (12 layers, 512 hidden size) model as in Dai et al. (2019), and a large (30 layers, 512 hidden size) model as in Child et al. (2019).",
      ]),
    );
    expect(r.rule).toBe("phrase_protocol");
    expect(r.relation).not.toBe("builds_on");
  });

  it("taking architecture and hyperparameters 'directly from [10]' is a protocol (Hash Layers)", () => {
    const r = classifyApiRelationV3(
      sig(base, [
        "We use the architecture, data (RoBERTa+cc100en), and hyperparameters directly from [10], using either a single sparse routing layer.",
        "Another such approach for Transformers, where the routing is learned via solving a linear assignment problem, is studied in [10].",
      ]),
    );
    expect(r.relation).not.toBe("builds_on");
  });

  it("subsampling 'following Hamilton et al.' is a protocol (VR-GCN)", () => {
    const r = classifyApiRelationV3(
      sig(sage, [
        "The cost is not larger than O(VD), if we subsample the graph such that the max degree is D, following Hamilton et al. (2017a).",
      ]),
    );
    expect(r.relation).not.toBe("builds_on");
  });

  it("a build cue on a sentence that lumps the cited marker with others is not builds_on (MoCo v3)", () => {
    const r = classifyApiRelationV3(
      sig(vit, [
        "This investigation is a straightforward extension given the recent progress on Vision Transformers (ViT) [15].",
        "Unlike prior works [8, 15] that train self-supervised Transformers with masked auto-encoding, we study the frameworks that are based on Siamese networks, including MoCo [19] and others [9, 17, 7].",
      ]),
    );
    expect(r.relation).not.toBe("builds_on");
  });

  it("the version family's name singles a grouped marker out (FlashAttention-2 -> Blackwell)", () => {
    const r = classifyApiRelationV3(
      sig(fa2, [
        "Skipping fully masked blocks is standard in causal attention [2].",
        "Later FlashAttention kernels sought to keep arithmetic units busy within each tile: FlashAttention-2 improved work partitioning [2], FlashAttention-3 overlapped matrix multiplication and softmax on Hopper [3].",
        "We follow the FlashAttention algorithms in using e P for unnormalized shifted exponentials, m for the row shift, and L for log-sum-exp [2, 3, 4].",
      ]),
    );
    expect(r).toMatchObject({ relation: "builds_on", rule: "phrase_build" });
  });

  it("'Following [39], we place the MoEs on every other layer' is builds_on (V-MoE <- GShard)", () => {
    const r = classifyApiRelationV3(
      sig(gshard, [
        "Following [39], we place the MoEs on every other layer (we refer to these as V-MoE Every-2).",
        "This follows a similar design pattern as the M4 machine translation model [39].",
      ]),
    );
    expect(r).toMatchObject({ relation: "builds_on", rule: "phrase_build" });
    // …but "Following [1], we report top-1 accuracy" is a protocol.
    const p = classifyApiRelationV3(
      sig(gshard, ["Following [39], we report the top-1 accuracy on the validation set."]),
    );
    expect(p.relation).not.toBe("builds_on");
  });

  it("'Motivated by the Swin Transformer's [19] success, we propose Swin-Unet' is builds_on", () => {
    const r = classifyApiRelationV3(
      sig(swin, [
        "Motivated by the Swin Transformer’s [19] success, we propose Swin-Unet to leverage the power of Transformer for 2D medical image segmentation in this work.",
      ]),
    );
    expect(r).toMatchObject({ relation: "builds_on", rule: "phrase_build" });
  });
});

describe("context LLM: confirm or downgrade, never create (mergeContextAnswer)", () => {
  const named = { namedInWords: true };
  const unnamed = { namedInWords: false };
  it("cannot create a strong claim the rule has no cue for", () => {
    expect(mergeContextAnswer("baseline_only", "extends", { refers_to_cited: true }, named)).toBe(
      "rule_with_hint",
    );
    expect(mergeContextAnswer("contrasts", "extends", { refers_to_cited: true }, named)).toBe(
      "baseline_with_hint",
    );
  });
  it("confirms the rule's strong relation", () => {
    expect(mergeContextAnswer("extends", "extends", { refers_to_cited: true }, named)).toBe("llm");
    expect(mergeContextAnswer("contrasts", "contrasts", { refers_to_cited: true }, named)).toBe(
      "llm",
    );
  });
  it("downgrades when it reads the sentence as about the cited paper, or the name is only a marker", () => {
    expect(mergeContextAnswer("extends", "baseline_only", { refers_to_cited: true }, named)).toBe(
      "llm",
    );
    expect(
      mergeContextAnswer("extends", "baseline_only", { refers_to_cited: false }, unnamed),
    ).toBe("llm");
  });
  it("ignores 'not about the cited paper' when the sentence names it in words (DiffPool <- GraphSAGE)", () => {
    expect(mergeContextAnswer("extends", "baseline_only", { refers_to_cited: false }, named)).toBe(
      "rule",
    );
  });
  it("is not asked when the rule result is not strong (no_strong_claim)", () => {
    const r = classifyS2Pair(
      sig(sage, [
        "Then, we trained a GraphSAGE classifier and obtained the predictions on testing samples.",
      ]),
    );
    expect(contextLlmSkipReason(r, sig(sage, r.evidence ? [r.evidence] : []))).toBe(
      "no_strong_claim",
    );
  });
  it("flags an LLM rationale that argues against its own relation", () => {
    expect(
      contradictsRelation(
        "「Learning Factored…」はMoEのアイデアを拡張し、「Outrageously…」は位置ごとに異なるゲーティングを導入して対照的にする。",
        "extends",
      ),
    ).toBe(true);
    expect(contradictsRelation("スパースMoEのアイデアを採用している。", "extends")).toBe(false);
  });
});

describe("relation guard: unbacked build claims (R2-22)", () => {
  const p = { title: "Deep Mixture of Experts via Shallow Embedding" };
  const c = { title: "Speechmoe2: Mixture-of-Experts Model with Improved Routing" };
  const abstractLlm: DerivedEdge = {
    relation: "extends",
    confidence: 0.85,
    rationale: "SpeechMoE2 は DeepMoE を拡張",
    provenance: "llm",
  };
  it("an abstract-only LLM extends/successor becomes baseline_only, keeping the LLM label as a hint", () => {
    for (const relation of ["extends", "successor", "supersedes", "ablation"] as const) {
      const g = guardRelation({ ...abstractLlm, relation }, p, c);
      expect(g.relation).toBe("baseline_only");
      expect(g.confidence).toBeLessThanOrEqual(0.6);
      expect(g.rationale).toContain(`引用文の裏付けがないため ${relation} を baseline_only に補正`);
      expect(g.rationale).toContain("元の判定: SpeechMoE2 は DeepMoE を拡張");
      expect(g.provenance).toBe("llm");
    }
    expect(guardRelation({ ...abstractLlm, provenance: "intent_map" }, p, c).relation).toBe(
      "baseline_only",
    );
  });
  it("quote-backed sources pass", () => {
    for (const e of [
      { ...abstractLlm, provenance: "s2_context_rule" },
      { ...abstractLlm, promptVersion: CONTEXT_PROMPT_VERSION },
      { ...abstractLlm, relation: "supersedes" as const, provenance: "title_version" },
      { ...abstractLlm, provenance: "foundational_allowlist" },
    ]) {
      expect(hasQuotedBuildEvidence(e)).toBe(true);
      expect(guardRelation(e, p, c)).toBe(e);
    }
  });
});

describe("titleizeRationale: A/B touching Japanese text (R2-22)", () => {
  it("replaces 'Bは' / 'のAを' with the short names", () => {
    const a = { title: "Learning Factored Representations in a Deep Mixture of Experts" };
    const b = {
      title: "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer",
    };
    const out = titleizeRationale(
      "AはMoEのアイデアを拡張し、Bは位置ごとに異なるゲーティングを導入する。BはAを使う。",
      a,
      b,
    );
    expect(out).not.toMatch(/(^|[^A-Za-z])[AB](?![A-Za-z])/);
    expect(out).toContain("、「Outrageously Large Neural Netwo…」は位置ごと");
    expect(out).toContain(
      "「Outrageously Large Neural Netwo…」は「Learning Factored Representatio…」を使う",
    );
  });
  it("leaves Latin words, model sizes and titles alone", () => {
    const a = { title: "A" };
    const b = { title: "B" };
    for (const s of ["ViT-Bは大きい", "MoE-Aを使う", "A ConvNet for the 2020s を参照", "GPT-4は"]) {
      expect(titleizeRationale(s, a, b)).toBe(s);
    }
  });
});

describe("node identity guard: mis-merged records (R2-22)", () => {
  const chebRecord = {
    id: "openalex:W2964321699",
    title: "Advances In Deep Learning On Graphs (Gsp'18 Workshop)",
    year: 2016,
    venue: "Figshare",
    citation_count: 4973,
    aliases: [["doi", "10.5281/zenodo.1286817"]],
  };
  it("drops the GSP'18 workshop slide record carrying ChebNet's citations", () => {
    const s = suspectMergedRecords([chebRecord], { currentYear: 2026 });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: chebRecord.id, action: "dropped" });
    expect(s[0]?.reasons).toEqual(
      expect.arrayContaining(["event_title", "repository_record", "citations>=500"]),
    );
  });
  it("only flags a young paper with an implausible citation count", () => {
    const road = {
      id: "openalex:W4322614756",
      title: "Identifying Resilient Communities in Road Networks: A Path-Based Embedding",
      year: 2025,
      venue: "Leibniz international proceedings in informatics",
      citation_count: 1570,
      aliases: [["doi", "10.4230/lipics.giscience.2025.9"]],
    };
    expect(suspectMergedRecords([road], { currentYear: 2026 })).toEqual([
      expect.objectContaining({ id: road.id, action: "flagged" }),
    ]);
  });
  it("leaves real papers alone, including highly cited ones and low-cited workshop papers", () => {
    const papers = [
      {
        id: "gcn",
        title: "Semi-Supervised Classification with Graph Convolutional Networks",
        year: 2016,
        citation_count: 7929,
      },
      { id: "vit", title: "An Image is Worth 16x16 Words", year: 2020, citation_count: 21502 },
      { id: "ws", title: "Graph Pooling (ICML Workshop)", year: 2019, citation_count: 40 },
      { id: "fresh", title: "VFA: Relieving Vector Operations", year: 2026, citation_count: 0 },
    ];
    expect(suspectMergedRecords(papers, { currentYear: 2026 })).toEqual([]);
  });
  it("drops on an OpenAlex/S2 count disagreement, but never drops a focus node", () => {
    const n = { id: "x", title: "Some Method", year: 2018, citation_count: 4000 };
    expect(
      suspectMergedRecords([n], { currentYear: 2026, s2CitationCounts: new Map([["x", 120]]) }),
    ).toEqual([expect.objectContaining({ action: "dropped" })]);
    expect(
      suspectMergedRecords([chebRecord], { currentYear: 2026, focusIds: new Set([chebRecord.id]) }),
    ).toEqual([expect.objectContaining({ action: "flagged" })]);
  });
});

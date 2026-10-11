/**
 * R2-30 (design 42): weak-entry corroboration. A node the topic gate let in
 * on a theme-term match with an embedding z below `zHi` must be backed by
 * more than the single citation that brought it in. Cases are the
 * off-topic nodes found in the 2026-10-11 published themes (DeepSeek-V3.2
 * in Flash Attention, a radar ViT model, a continual-learning channel gate
 * in MoE) next to the on-topic nodes the rule must keep.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThemeGraphNode } from "../../../src/lineage/shared/node.js";
import {
  confirmWeakAdmissions,
  type NodeAdmission,
  runBfsAndDescendants,
} from "../../../src/lineage/theme/bfs.js";
import type { ThemeEdge } from "../../../src/lineage/theme/edges.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import type { TopicEmbedder } from "../../../src/lineage/theme/topicEmbedding.js";
import { TopicScope } from "../../../src/lineage/theme/topicScope.js";

const FA = new TopicScope("Flash Attention", ["FlashAttention"], {}, ["efficient attention"]);
const MOE = new TopicScope("Mixture of Experts", [], {}, ["conditional computation"]);
const VIT = new TopicScope("Vision Transformer", []);

function node(id: string, title: string, abstract = ""): ThemeGraphNode {
  return { id, title, short_abstract: abstract } as unknown as ThemeGraphNode;
}

function edge(
  src: string,
  dst: string,
  relation = "baseline_only",
  method = "s2_context_rule",
): ThemeEdge {
  return {
    src,
    dst,
    rel: relation,
    relation,
    conf: 0.6,
    confidence: 0.6,
    rationale: "",
    provenance: { classification: { method } },
  };
}

function adm(
  z: number | null,
  path: NodeAdmission["path"] = "reference",
  why = "topic",
): NodeAdmission {
  return { path, why, z, anchor: "seed" };
}

function run(
  scope: TopicScope,
  nodes: ThemeGraphNode[],
  edges: ThemeEdge[],
  seeds: string[],
  admissions: Record<string, NodeAdmission>,
) {
  const map = new Map(nodes.map((n) => [n.id, n]));
  const out = confirmWeakAdmissions(map, edges, {
    seedIds: new Set(seeds),
    admissions: new Map(Object.entries(admissions)),
    scope,
  });
  return { ...out, kept: [...map.keys()].sort() };
}

describe("confirmWeakAdmissions (R2-30)", () => {
  it("drops a general paper a seed cites once for a side remark (DeepSeek-V3.2 in FA)", () => {
    const r = run(
      FA,
      [
        node("vfa", "VFA: Relieving Vector Operations in Flash Attention"),
        node("fa2", "FlashAttention-2: Faster Attention with Better Parallelism"),
        node(
          "ds",
          "DeepSeek-V3.2: Pushing the Frontier of Open Large Language Models",
          "We introduce DeepSeek-V3.2, an open model. It adds DSA, an efficient attention mechanism.",
        ),
        node("perf", "Rethinking Attention with Performers", "an efficient attention method"),
      ],
      [edge("ds", "vfa"), edge("fa2", "vfa"), edge("perf", "fa2"), edge("perf", "vfa")],
      ["vfa", "fa2"],
      { ds: adm(0.64), perf: adm(1.51) },
    );
    expect(r.dropped).toEqual([{ id: "ds", rule: "uncorroborated", z: 0.64 }]);
    expect(r.kept).toEqual(["fa2", "perf", "vfa"]);
    expect(r.edges.map((e) => `${e.src}>${e.dst}`)).toEqual(["fa2>vfa", "perf>fa2", "perf>vfa"]);
  });

  it("does not count two seed links as corroboration (channel gate citing two MoE seeds)", () => {
    const r = run(
      MOE,
      [
        node(
          "bengio",
          "Estimating or Propagating Gradients Through Stochastic Neurons for Conditional Computation",
        ),
        node("ec", "Mixture-of-Experts with Expert Choice Routing"),
        node(
          "ccgn",
          "Conditional Channel Gated Networks for Task-Aware Continual Learning",
          "Networks forget old tasks. We tackle this with conditional computation.",
        ),
      ],
      [edge("bengio", "ccgn", "baseline_only", "api_citation"), edge("ccgn", "ec")],
      ["bengio", "ec"],
      { ccgn: adm(0.72) },
    );
    expect(r.dropped.map((d) => d.id)).toEqual(["ccgn"]);
  });

  it("drops a theme-titled paper that cites one seed once, keeps one with two links", () => {
    const r = run(
      VIT,
      [
        node("vit", "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale"),
        node("deit", "Training data-efficient image transformers"),
        node(
          "radar",
          "A lightweight hybrid vision transformer network for radar-based human activity recognition",
        ),
        node("vita", "ViTA: A Vision Transformer Inference Accelerator for Edge Applications"),
      ],
      [
        edge("vit", "radar", "baseline_only", "api_citation"),
        edge("vit", "vita"),
        edge("deit", "vita"),
      ],
      ["vit", "deit"],
      { radar: adm(0.22, "citing"), vita: adm(0.98, "citing") },
    );
    expect(r.dropped).toEqual([{ id: "radar", rule: "single-link", z: 0.22 }]);
    expect(r.kept).toEqual(["deit", "vit", "vita"]);
  });

  it("treats an abstract about the theme like a theme title (two links suffice)", () => {
    const r = run(
      MOE,
      [
        node(
          "som",
          "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer",
        ),
        node("st", "Switch Transformers: Scaling to Trillion Parameter Models"),
        node(
          "vmoe",
          "Mobile V-MoEs: Scaling Down Vision Transformers via Sparse Mixture-of-Experts",
          "Sparse Mixture-of-Experts models scale well. We shrink MoE models for phones.",
        ),
      ],
      [edge("vmoe", "som"), edge("vmoe", "st")],
      ["som", "st"],
      { vmoe: adm(0.89) },
    );
    expect(r.dropped).toEqual([]);
    // The admission-time verdict (full abstract) wins over the node's text.
    const r2 = run(
      MOE,
      [
        node(
          "som",
          "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer",
        ),
        node("st", "Switch Transformers: Scaling to Trillion Parameter Models"),
        node(
          "vmoe",
          "Mobile V-MoEs: Scaling Down Vision Transformers via Sparse Mixture-of-Experts",
        ),
      ],
      [edge("vmoe", "som"), edge("vmoe", "st")],
      ["som", "st"],
      { vmoe: { ...adm(0.89), aboutTheme: false } },
    );
    expect(r2.dropped).toEqual([{ id: "vmoe", rule: "uncorroborated", z: 0.89 }]);
  });

  it("keeps weak nodes admitted with z >= zHi, support admissions and seeds", () => {
    const r = run(
      MOE,
      [
        node(
          "som",
          "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer",
        ),
        node("gate", "Expert Gate: Lifelong Learning with a Network of Experts"),
        node("sup", "Some paper"),
      ],
      [edge("gate", "som"), edge("sup", "som")],
      ["som"],
      { gate: adm(1.27, "reference", "embedding"), sup: adm(0.1, "support", "support") },
    );
    expect(r.dropped).toEqual([]);
    expect(r.kept).toEqual(["gate", "som", "sup"]);
  });

  it("a quoted lineage cue keeps a single-link weak node; a citation-only strong label does not", () => {
    const nodes = () => [
      node("fa", "FlashAttention: Fast and Memory-Efficient Exact Attention"),
      node("x", "Kernel paper", "We study kernels. One is an efficient attention kernel."),
    ];
    const cue = run(FA, nodes(), [edge("fa", "x", "extends", "s2_context_rule")], ["fa"], {
      x: adm(0.3, "citing"),
    });
    expect(cue.dropped).toEqual([]);
    for (const method of ["api_citation", "foundational_allowlist", "citation_heuristic"]) {
      const weakCue = run(FA, nodes(), [edge("fa", "x", "extends", method)], ["fa"], {
        x: adm(0.3, "citing"),
      });
      expect(weakCue.dropped.map((d) => d.id)).toEqual(["x"]);
    }
  });

  it("corroboration spreads through corroborated weak nodes, not through seeds", () => {
    // ARMA graph filtering (abstract-only, z 0.03) is cited by CayleyNets
    // (abstract-only to the term list, z 0.84), which is linked to a
    // strongly on-topic non-seed node.
    const gnn = new TopicScope("Graph Neural Network", [], {}, ["graph signal processing"]);
    const r = run(
      gnn,
      [
        node("arma", "Graph Neural Networks with Convolutional ARMA Filters"),
        node(
          "armaf",
          "Autoregressive Moving Average Graph Filtering",
          "We design filters. They suit graph signal processing.",
        ),
        node(
          "cayley",
          "CayleyNets: Graph Convolutional Neural Networks With Complex Rational Spectral Filters",
          "We propose spectral filters. They come from graph signal processing.",
        ),
        node(
          "cheb",
          "Convolutional Neural Networks on Graphs with Fast Localized Spectral Filtering",
        ),
      ],
      [
        edge("armaf", "arma"),
        edge("armaf", "cayley"),
        edge("cheb", "cayley"),
        edge("cayley", "arma"),
      ],
      ["arma"],
      { armaf: adm(0.03), cayley: adm(0.84), cheb: adm(1.4, "reference", "embedding") },
    );
    expect(r.dropped).toEqual([]);
    // Without the strong non-seed node the chain has nothing to hang on.
    const r2 = run(
      gnn,
      [
        node("arma", "Graph Neural Networks with Convolutional ARMA Filters"),
        node(
          "armaf",
          "Autoregressive Moving Average Graph Filtering",
          "We design filters. They suit graph signal processing.",
        ),
        node(
          "cayley",
          "CayleyNets: Graph Convolutional Neural Networks With Complex Rational Spectral Filters",
          "We propose spectral filters. They come from graph signal processing.",
        ),
      ],
      [edge("armaf", "arma"), edge("armaf", "cayley"), edge("cayley", "arma")],
      ["arma"],
      { armaf: adm(0.03), cayley: adm(0.84) },
    );
    expect(r2.dropped.map((d) => d.id).sort()).toEqual(["armaf", "cayley"]);
  });

  it("lets a passing theme-titled node vouch for an abstract-only one, never weak for weak", () => {
    const r = run(
      VIT,
      [
        node("vit", "An Image is Worth 16x16 Words"),
        node("deit", "Training data-efficient image transformers"),
        node("y", "Unrelated model", "We study crops. The model uses a vision transformer."),
        node("z", "A Lightweight Vision Transformer Network"),
      ],
      [
        edge("vit", "y"),
        edge("y", "z"),
        edge("vit", "z", "baseline_only", "api_citation"),
        edge("deit", "z"),
      ],
      ["vit", "deit"],
      { y: adm(0.2), z: adm(0.3, "citing") },
    );
    // z (title about the theme) has two links besides y, so it passes and
    // vouches for y, whose only other link is a seed.
    expect(r.dropped).toEqual([]);
    const r2 = run(
      VIT,
      [
        node("vit", "An Image is Worth 16x16 Words"),
        node("y", "Unrelated model", "We study crops. The model uses a vision transformer."),
        node("z", "A Lightweight Vision Transformer Network"),
        node("w", "Another model", "We study soil. It has a vision transformer backbone."),
      ],
      [edge("vit", "y"), edge("y", "z"), edge("vit", "w"), edge("w", "z")],
      ["vit"],
      { y: adm(0.2), z: adm(0.3, "citing"), w: adm(0.1) },
    );
    // z's two links are both abstract-only weak nodes, which cannot vouch
    // for it, so z fails (single-link); then y and w have no lender (seeds
    // never lend). Weak nodes cannot hold each other up.
    expect(r2.dropped.map((d) => d.id).sort()).toEqual(["w", "y", "z"]);
  });
});

// ---- the BFS records how each node entered ----

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function paper(pid: string, title: string, year: number, abstract: string): ThemePaper {
  return {
    paperId: pid,
    title,
    year,
    venue: "NeurIPS",
    citationCount: 10,
    abstract,
    authors: [],
    externalIds: {},
  } as ThemePaper;
}

describe("runBfsAndDescendants admissions (R2-30)", () => {
  it("records path, verdict, z and anchor for every admitted node", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "r230-"));
    dirs.push(cacheDir);
    const seed = paper(
      "s:fa",
      "FlashAttention: Fast and Memory-Efficient Exact Attention",
      2022,
      "FlashAttention is IO-aware exact attention.",
    );
    const ref = paper(
      "s:ref",
      "Rethinking Attention with Performers",
      2020,
      "Efficient attention via random features. ".repeat(3),
    );
    const cit = paper(
      "s:cit",
      "FlashAttention on new GPUs",
      2024,
      "We port FlashAttention to new GPUs. ".repeat(3),
    );
    const resnet = paper(
      "s:res",
      "Deep Residual Learning for Image Recognition",
      2016,
      "We train very deep networks. ".repeat(3),
    );
    const related: Record<string, Record<string, ThemePaper[]>> = {
      references: { "s:fa": [ref, resnet] },
      citations: { "s:fa": [cit] },
    };
    const deps = {
      cacheDir,
      sleep: async () => {},
      fetchImpl: async () => {
        throw new Error("no network");
      },
      logger: { warn: () => {} },
    };
    // Attention papers point one way, everything else the other: the
    // attention candidates get z > 0, ResNet z < 0 (and no theme term).
    const embedder: TopicEmbedder = {
      model: "fake",
      revision: "r",
      queryPrefix: "",
      embed: async (texts: readonly string[]) =>
        texts.map((t) => (/attention/i.test(t) ? [1, 0] : [0, 1])),
    };
    const expansion = {
      expand: async (p: ThemePaper, kind: "references" | "citations") =>
        (related[kind]![p.paperId] ?? []).map((x) => ({ ...x })),
      summary: () => "",
    };
    const result = await runBfsAndDescendants(
      [seed],
      {
        depth: 1,
        width: 8,
        maxSeedCite: 10 ** 9,
        provider: null,
        llmStrict: "off",
        currentYear: 2026,
        topicScope: FA,
        topicEmbedder: embedder,
        s2Expansion: expansion as never,
      },
      deps as never,
    );
    expect(result.nodes.has("s:ref") && result.nodes.has("s:cit")).toBe(true);
    const ref1 = result.admissions.get("s:ref")!;
    const cit1 = result.admissions.get("s:cit")!;
    expect([ref1.path, ref1.anchor]).toEqual(["reference", "s:fa"]);
    expect([cit1.path, cit1.anchor]).toEqual(["citing", "s:fa"]);
    expect(typeof ref1.z).toBe("number");
    expect(ref1.why).toMatch(/topic|embedding/);
    expect(result.admissions.has("s:fa")).toBe(false);
    expect(result.nodes.has("s:res")).toBe(false);
    expect(result.admissions.has("s:res")).toBe(false);
  });
});

/**
 * R2-23: quote-backed recall of strong claims (design 41 D5) without losing
 * precision. Sentences are real Semantic Scholar contexts / OpenAlex
 * abstracts of the four theme lineages (refetched 2026-10-11).
 *  - the cited paper's marker as the one marker every context shares
 *    (V-MoE: "[54] … [39]", "[54, 39, 22]" -> 54);
 *  - attribution: a build / contrast cue counts only when the cited paper's
 *    name or marker sits in the cue's own clause;
 *  - "our modified ViT", the citing method's own name as a contrast
 *    subject, "While X …, our …";
 *  - abstract evidence ("we propose … SwinIR … based on the Swin
 *    Transformer");
 *  - precision guards surfaced by keeping 12 contexts per pair instead of 4:
 *    copied setups, recipes, measurement / analysis procedures, shared
 *    marker groups, "us-ing", "a strong baseline model".
 */
import { describe, expect, it } from "vitest";
import {
  abstractSentences,
  classifyApiRelationV3,
  classifyS2Pair,
  type PairSignals,
  v1RelationFor,
} from "../../../src/lineage/classify/apiRelations.js";
import {
  citedIdentity,
  citingSelfNames,
  commonMarker,
  cueTargetsCited,
  inferCitedMarker,
  ownVariantOf,
} from "../../../src/lineage/classify/citedTarget.js";

const shazeer = {
  title: "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer",
  authors: ["Noam Shazeer", "Azalia Mirhoseini"],
  year: 2017,
};
const vit = {
  title: "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
  authors: ["Alexey Dosovitskiy", "Lucas Beyer"],
  year: 2020,
};
const swin = {
  title: "Swin Transformer: Hierarchical Vision Transformer using Shifted Windows",
  authors: ["Ze Liu", "Yutong Lin"],
  year: 2021,
};
const eigen = {
  title: "Learning Factored Representations in a Deep Mixture of Experts",
  authors: ["David Eigen", "Marc'Aurelio Ranzato", "Ilya Sutskever"],
  year: 2013,
};
const chebnet = {
  title: "Convolutional Neural Networks on Graphs with Fast Localized Spectral Filtering",
  authors: ["Michaël Defferrard", "Xavier Bresson", "Pierre Vandergheynst"],
  year: 2016,
};

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
const mapped = (s: PairSignals) => {
  const r = classifyS2Pair(s);
  return v1RelationFor(r.relation, { contrast: r.contrast, targetsCited: r.singleTarget });
};

const VMOE = [
  "The difference between previous formulations [54] is that we apply TOPk after the softmax over experts weights [39], instead of before.",
  "This is essentially the same approach as followed by [54, 39, 22].",
  "Our approach is inspired by [54] who proposed a top-k gating in LSTMs, with auxiliary losses ensuring the expert balance [26].",
  "Given the TOP-i position, the default—or vanilla—routing, as used in [54, 39, 22], assigns tokens to experts as follows.",
];

describe("R2-23 marker inference and cue attribution", () => {
  it("takes the one marker every context shares", () => {
    expect(commonMarker(VMOE)).toBe(54);
    expect(inferCitedMarker(VMOE, shazeer)).toBe(54);
    expect(commonMarker(["a [3, 7] b.", "c [3, 7] d."])).toBeNull();
    expect(commonMarker(["only one [3] context."])).toBeNull();
  });

  it("V-MoE <- Shazeer: 'inspired by [54] who …' is a build claim on the cited marker", () => {
    const r = classifyApiRelationV3(
      sig(shazeer, VMOE, { citingTitle: "Scaling Vision with Sparse Mixture of Experts" }),
    );
    expect(r.relation).toBe("builds_on");
    expect(r.evidence).toContain("inspired by [54]");
  });

  it("a cue governing another work of the sentence is not attributed", () => {
    const id = { aliases: ["moco"], marker: 15, surname: null };
    const s =
      "prior works [8, 15] that train self-supervised Transformers with masked auto-encoding, we study the frameworks that are based on Siamese networks, including MoCo [19] and others [9, 17, 7].";
    expect(cueTargetsCited(s, { ...id, aliases: [] }, [/\bbased\s+on\b/i])).toBe(false);
    expect(cueTargetsCited(s, { ...id, marker: 19 }, [/\bbased\s+on\b/i])).toBe(true);
    // ChebNet named, but "based on" governs the Graclus method [16].
    const cheb =
      "LeNet used 2 × 2 max-pooling; in ChebNet and MoNet we used three convolutional layers, interleaved with pooling layers based on the Graclus method [16] to coarsen the graph by a factor of four.";
    const chebCtx = [
      "ChebNet [8] approximates spectral filters with Chebyshev polynomials of the Laplacian.",
      "We compare against the spectral ChebNet [8] on MNIST.",
      cheb,
    ];
    expect(
      mapped(
        sig(chebnet, chebCtx, {
          citingTitle: "Geometric Deep Learning on Graphs and Manifolds Using Mixture Model CNNs",
        }),
      ),
    ).toBe("baseline_only");
  });

  it("a contrast through a marker group shared with other works is not targeted", () => {
    const resnet = {
      title: "Deep Residual Learning for Image Recognition",
      authors: ["Kaiming He"],
      year: 2016,
    };
    const ctx = [
      "Unlike CNN backbone networks [53, 21], which use different convolutional strides to obtain multi-scale feature maps, our PVT uses a progressive shrinking strategy to control the scale of feature maps by patch embedding layers.",
      "ResNet [21] is a widely used backbone for dense prediction.",
    ];
    expect(
      mapped(sig(resnet, ctx, { citingTitle: "Pyramid Vision Transformer: A Versatile Backbone" })),
    ).toBe("baseline_only");
  });
});

describe("R2-23 new cues", () => {
  it("'our modified ViT' names the cited model as the citing paper's variant", () => {
    const ctx = [
      "Vision Transformers (ViT) [15] are a recent family of models.",
      "ViT-BN is our modified ViT that has BatchNorm, and “/7” denotes a patch size of 7×7 (otherwise following [15]).",
    ];
    expect(ownVariantOf(ctx[1] as string, citedIdentity(vit, ctx))).toBe(true);
    expect(
      mapped(
        sig(vit, ctx, {
          citingTitle: "An Empirical Study of Training Self-Supervised Vision Transformers",
        }),
      ),
    ).toBe("extends");
  });

  it("the citing method's own name is a first-person subject for contrasts (Swin <- ViT)", () => {
    const ctx = [
      "Transformer based vision backbones Most related to our work is the Vision Transformer (ViT) [19] and its follow-ups [57, 66, 15, 25, 60].",
      "These merits make Swin Transformer suitable as a general-purpose backbone for various vision tasks, in contrast to previous Transformer based architectures [19] which produce feature maps of a single resolution and have quadratic complexity.",
    ];
    const title = "Swin Transformer: Hierarchical Vision Transformer using Shifted Windows";
    expect(citingSelfNames(title, citedIdentity(vit, ctx))).toEqual(["swin transformer"]);
    expect(mapped(sig(vit, ctx, { citingTitle: title }))).toBe("contrasts");
  });

  it("but not for build cues: the own name is often their object", () => {
    const regnet = {
      title: "Designing Network Design Spaces",
      authors: ["Ilija Radosavovic"],
      year: 2020,
    };
    const ctx = [
      "Noting that while RegNet [44] are obtained via a thorough architecture search, the Swin Transformer is manually adapted from a standard Transformer and has potential for further improvement.",
    ];
    const title = "Swin Transformer: Hierarchical Vision Transformer using Shifted Windows";
    expect(mapped(sig(regnet, ctx, { citingTitle: title }))).toBe("baseline_only");
  });

  it("'While Eigen et al. (2013) uses …, our …' is a targeted contrast", () => {
    const ctx = [
      "While Eigen et al. (2013) uses two stacked MoEs allowing for two sets of gating decisions, our convolutional application of the MoE allows for different gating decisions at each position in the text.",
    ];
    expect(mapped(sig(eigen, ctx, { citingTitle: shazeer.title }))).toBe("contrasts");
  });
});

describe("R2-23 abstract evidence", () => {
  const swinirAbstract =
    "Image restoration is a long-standing low-level vision problem. While state-of-the-art image restoration methods are based on convolutional neural networks, few attempts have been made with Transformers which show impressive performance on high-level vision tasks. In this paper, we propose a strong baseline model SwinIR for image restoration based on the Swin Transformer. SwinIR consists of three parts.";
  const swinirCtx = [
    "A concurrent work [82] proposed a U-shaped architecture based on the Swin Transformer [56].",
    "Swin Transformer layer (STL) [56] is based on the standard multi-head selfattention of the original Transformer layer [76].",
  ];

  it("splits an abstract into sentences", () => {
    expect(abstractSentences(swinirAbstract)).toHaveLength(4);
    expect(abstractSentences(null)).toEqual([]);
  });

  it("SwinIR <- Swin: a build cue naming the cited paper in the citing abstract", () => {
    const s = sig(swin, swinirCtx, {
      citingTitle: "SwinIR: Image Restoration Using Swin Transformer",
      citingAbstract: swinirAbstract,
    });
    const r = classifyS2Pair(s);
    expect(r.rule).toBe("abstract_build");
    expect(r.fromAbstract).toBe(true);
    expect(r.evidence).toContain("based on the Swin Transformer");
    expect(mapped(s)).toBe("extends");
    // Without the abstract the contexts carry no build claim.
    expect(mapped({ ...s, citingAbstract: null })).toBe("baseline_only");
  });

  it("the cited paper must be the cue's object, within its phrase", () => {
    const pvt2 = {
      title: "PVT v2: Improved baselines with Pyramid Vision Transformer",
      authors: ["Wenhai Wang"],
      year: 2022,
    };
    const abs =
      "Unlike the recently-proposed Vision Transformer (ViT) that was designed for image classification specifically, we introduce the Pyramid Vision Transformer (PVT), which overcomes the difficulties of porting Transformer to various dense prediction tasks.";
    expect(
      mapped(
        sig(pvt2, ["PVT v2 [70] improves PVT."], {
          citingTitle: "Pyramid Vision Transformer: A Versatile Backbone",
          citingAbstract: abs,
        }),
      ),
    ).toBe("baseline_only");
    expect(
      mapped(
        sig(vit, ["ViT [13] splits images into patches."], {
          citingTitle: "Pyramid Vision Transformer: A Versatile Backbone",
          citingAbstract: abs,
        }),
      ),
    ).toBe("contrasts");
    const bronstein = {
      title: "Geometric Deep Learning: Going beyond Euclidean data",
      authors: ["Michael M. Bronstein"],
      year: 2017,
    };
    const pyg =
      "We introduce PyTorch Geometric, a library for deep learning on irregularly structured input data such as graphs, point clouds and manifolds, built upon PyTorch.";
    expect(
      mapped(
        sig(bronstein, ["Geometric deep learning (Bronstein et al., 2017) is a growing field."], {
          citingTitle: "Fast Graph Representation Learning with PyTorch Geometric",
          citingAbstract: pyg,
        }),
      ),
    ).toBe("baseline_only");
  });
});

describe("R2-23 precision guards (12 contexts per pair surface more setup sentences)", () => {
  const gcn = {
    title: "Semi-Supervised Classification with Graph Convolutional Networks",
    authors: ["Thomas Kipf", "Max Welling"],
    year: 2016,
  };
  it.each([
    [
      "copied architecture",
      gcn,
      "Citeseer, Cora, PubMed and NELL: We use the same architecture as Kipf & Welling (2017): two graph convolution layers with one linear layer per graph convolution layer.",
    ],
    [
      "per-dataset setup line",
      {
        title: "Representation Learning on Graphs: Methods and Applications",
        authors: ["William L. Hamilton"],
        year: 2017,
      },
      "• PPI and Reddit: We use the mean pooling architecture proposed by Hamilton et al. (2017a).",
    ],
    [
      "training recipe",
      {
        title: "Accurate, Large Minibatch SGD: Training ImageNet in 1 Hour",
        authors: ["Priya Goyal"],
        year: 2017,
      },
      "We adopt learning rate warmup [16] for 40 epochs (as per “warmup of 10k steps”, Table 4 in [15]).",
    ],
    [
      "analysis procedure",
      { title: "Language Models are Few-Shot Learners", authors: ["Tom B. Brown"], year: 2020 },
      "Because of this, we follow Brown et al. (2020) and include all adjectives and adverbs, and to make our analysis transparent and reproducible, we omit any manual labeling steps.",
    ],
    [
      "hyphenated 'us-ing'",
      { title: "Delving Deep into Rectifiers", authors: ["Kaiming He"], year: 2015 },
      "An interesting line of work builds upon the Reversible ResNets ideas proposing better reversible CNN models us-ing ODE characterizations [6].",
    ],
  ])("%s is not a build claim", (_name, cited, sentence) => {
    expect(mapped(sig(cited as Record<string, unknown>, [sentence as string]))).toBe(
      "baseline_only",
    );
  });
});

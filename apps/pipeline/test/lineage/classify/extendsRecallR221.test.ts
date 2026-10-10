/**
 * R2-21: recall gaps of rule set v3 found in the graph-neural-network
 * lineage (lineage_relation_share 0.063). Sentences are the real Semantic
 * Scholar contexts of that lineage (data/state/lineage-cache).
 *  - cited papers named only by their authors / method name: "Kipf and
 *    Welling [21]", "GraphSAGE (Hamilton, Ying, and Leskovec 2017)",
 *    "GAT (Veliˇckovi´c et al. 2018)" (PDF-extraction accents);
 *  - "as particular instances of our approach" (MoNet generalising GCN)
 *    and "we use the “mean” variant of GRAPHSAGE [16]" as build cues;
 *  - precision guards: lettered-year / two-year author citations are
 *    ambiguous, and "our work is a particular instance of MoNet" (the
 *    reverse direction) is not builds_on.
 */
import { describe, expect, it } from "vitest";
import {
  classifyApiRelationV3,
  classifyS2Pair,
  type PairSignals,
  v1RelationFor,
} from "../../../src/lineage/classify/apiRelations.js";
import {
  citedAliases,
  citedIdentity,
  contextMethodNames,
  foldText,
  sentenceTarget,
} from "../../../src/lineage/classify/citedTarget.js";

const gcn = {
  title: "Semi-Supervised Classification with Graph Convolutional Networks",
  authors: ["Thomas Kipf", "Max Welling"],
  year: 2016,
};
const vgae = { title: "Variational Graph Auto-Encoders", authors: ["Thomas Kipf", "Max Welling"] };
const sage = {
  title: "Inductive Representation Learning on Large Graphs",
  authors: ["William L. Hamilton", "Zhitao Ying", "Jure Leskovec"],
  year: 2017,
};
const gat = {
  title: "Graph Attention Networks",
  authors: ["Petar Veličković", "Guillem Cucurull", "Arantxa Casanova"],
  year: 2017,
};
const monet = {
  title: "Geometric Deep Learning on Graphs and Manifolds Using Mixture Model CNNs",
  authors: ["Federico Monti", "Davide Boscaini"],
  year: 2017,
};

function sig(cited: Record<string, unknown>, contexts: string[], extra: Partial<PairSignals> = {}) {
  return {
    found: true,
    intents: ["methodology", "background"],
    isInfluential: false,
    contexts,
    cited,
    ...extra,
  } as PairSignals;
}

function v1(s: PairSignals): string | null {
  const r = classifyS2Pair(s);
  return v1RelationFor(r.relation, { contrast: r.contrast, targetsCited: r.singleTarget });
}

describe("author-list aliases and accent folding", () => {
  it("adds 'X and Y' / 'X, Y, and Z' forms and parses 'Last, First' names", () => {
    expect(citedAliases(gcn)).toEqual(
      expect.arrayContaining(["kipf et al", "kipf and welling", "kipf & welling"]),
    );
    expect(citedAliases(sage)).toEqual(
      expect.arrayContaining(["hamilton et al", "hamilton, ying, and leskovec"]),
    );
    expect(citedAliases({ title: "X", authors: ["Hamilton, William L."] })).toContain(
      "hamilton et al",
    );
  });

  it("matches names whose accents PDF extraction split off", () => {
    expect(foldText("Veliˇckovi´c")).toBe("Velickovic");
    const id = citedIdentity(gat, []);
    expect(
      sentenceTarget(
        "Vertex classification is usually conducted to verify GNN architectures (Veliˇckovi´c et al. 2018; Hamilton, Ying, and Leskovec 2017).",
        id,
      ),
    ).toBe("named");
  });

  it("an author citation with a lettered or a second year is ambiguous", () => {
    const id = citedIdentity(sage, []);
    // SIGN -> GraphSAGE: "2017b" is Hamilton et al.'s review, not GraphSAGE.
    expect(
      sentenceTarget(
        "We refer the reader to recent review papers Bronstein et al. (2017); Hamilton et al. (2017b); Battaglia et al. (2018); Zhang et al. (2018) for an overview.",
        id,
      ),
    ).toBe("multi");
    const idGcn = citedIdentity(gcn, []);
    expect(
      sentenceTarget(
        "GCNs have been applied to node classification (Kipf & Welling, 2017), link prediction (Kipf & Welling, 2016; Berg et al., 2017) and knowledge graphs (Schlichtkrull et al., 2017).",
        idGcn,
      ),
    ).toBe("multi");
    expect(
      sentenceTarget(
        "GCN (Kipf and Welling 2017) simplifies ChebNet to a more simple form.",
        idGcn,
      ),
    ).toBe("named");
  });

  it("a single author-year citation of somebody else is not the cited paper", () => {
    const arma = {
      title: "Graph Neural Networks with Convolutional ARMA Filters",
      authors: ["Filippo Maria Bianchi"],
    };
    const id = citedIdentity(arma, []);
    // SIGN -> ARMA: a truncated context S2 attached to the wrong reference.
    expect(
      sentenceTarget(
        "We refer the reader to recent review papers Bronstein et al. (2017); Hamilton et al.",
        id,
      ),
    ).toBe("other");
    expect(
      sentenceTarget("Previous work (Bianchi et al., 2019) stacks ARMA layers on graphs.", id),
    ).toBe("named");
    const isufi = citedIdentity({ title: "X", authors: ["Elvin Isufi"] }, []);
    const s = "Their filters behave like rational ones (Isufi et al., 2016).";
    expect(sentenceTarget(s, isufi)).toBe("named");
    // No author metadata: the single citation still counts as the cited one.
    expect(sentenceTarget(s, citedIdentity({ title: "X" }, []))).toBe("single");
  });
});

describe("method names from the pair's own contexts", () => {
  it("takes the name written right before the cited paper's citation", () => {
    expect(
      contextMethodNames(
        ["GraphSAGE (Hamilton, Ying, and Leskovec 2017) samples a fixed number of neighbors."],
        sage,
        null,
      ),
    ).toEqual(["graphsage"]);
    expect(
      contextMethodNames(
        [
          "We use the “mean” variant of GRAPHSAGE [16] and apply a DIFFPOOL layer after every two GRAPHSAGE layers.",
        ],
        sage,
        16,
      ),
    ).toEqual(["graphsage"]);
    expect(
      contextMethodNames(
        ["We demonstrate this model using a graph convolutional network (GCN) [4] encoder."],
        gcn,
        4,
      ),
    ).toEqual(["gcn"]);
    // GCNs -> gcn; the name before ANOTHER paper's citation is not taken.
    expect(
      contextMethodNames(
        ["Figure 1: accuracy of GCNs (Kipf and Welling 2017) and GAT (Velickovic et al. 2018)."],
        gcn,
        null,
      ),
    ).toEqual(["gcn"]);
    // Generic family acronyms and lettered years never give a name.
    expect(contextMethodNames(["GNN (Kipf and Welling 2017) is popular."], gcn, null)).toEqual([]);
    expect(
      contextMethodNames(["GraphSAGE (Hamilton et al., 2017b) is a review."], sage, null),
    ).toEqual([]);
  });

  it("a derived name makes the pair's other sentences name the cited paper", () => {
    const ctxs = [
      "We use the “mean” variant of GRAPHSAGE [16] and apply a DIFFPOOL layer after every two GRAPHSAGE layers in our architecture.",
      "Our DIFFPOOL approach improves upon the base GRAPHSAGE architecture by an average of 6.27%.",
      "In recent years there has been a surge of interest in GNNs [16, 21, 36].",
    ];
    const id = citedIdentity(sage, ctxs);
    expect(id.marker).toBe(16);
    expect(id.aliases).toContain("graphsage");
    expect(sentenceTarget(ctxs[1] as string, id)).toBe("named");
  });
});

describe("generalisation and variant build cues", () => {
  it("MoNet: earlier models as 'particular instances of our approach' -> extends", () => {
    const ctxs = [
      "Kipf and Welling [21] further simplified this approach using simple filters operating on 1-hop neighborhoods of the graph.",
      "We followed verbatim the experimental settings presented in [44, 21].",
      "Such a construction allows to formulate previously proposed Geodesic CNN (GCNN) [26] and Anisotropic CNN (ACNN) [7] on manifolds or GCN [21] and DCNN [3] on graphs as particular instances of our approach.",
    ];
    const r = classifyApiRelationV3(sig(gcn, ctxs, { isInfluential: true }));
    expect(r.relation).toBe("builds_on");
    expect(r.evidence).toContain("particular instances of our approach");
    expect(v1(sig(gcn, ctxs, { isInfluential: true }))).toBe("extends");
  });

  it("GAT: 'our work … a particular instance of MoNet' is NOT builds_on (reverse direction)", () => {
    const ctxs = [
      "It is worth noting that, as Kipf & Welling (2017) and Atwood & Towsley (2016), our work can also be reformulated as a particular instance of MoNet (Monti et al., 2016).",
      "Monti et al. (2016) presented mixture model CNNs (MoNet), a spatial approach which provides a unified generalization of CNN architectures to graphs.",
    ];
    expect(classifyApiRelationV3(sig(monet, ctxs)).relation).not.toBe("builds_on");
  });

  it("'we use the “mean” variant of GraphSAGE [16]' is builds_on", () => {
    const r = classifyApiRelationV3(
      sig(sage, [
        "We use the “mean” variant of GRAPHSAGE [16] and apply a DIFFPOOL layer after every two GRAPHSAGE layers in our architecture.",
      ]),
    );
    expect(r.relation).toBe("builds_on");
    expect(r.rule).toBe("phrase_build");
  });

  it("does not turn background / protocol / comparison mentions into builds_on", () => {
    // GCN -> HAN, GraphSAGE -> GAT, VGAE -> VR-GCN (real contexts).
    expect(
      v1(
        sig(gcn, [
          "[18] proposes a spectral approach, named Graph Convolutional Network, which designs a graph convolutional network via a localized first-order approximation of spectral graph convolutions.",
          "• GCN [18]: It is a semi-supervised graph convolutional network that designed for the homogeneous graphs.",
        ]),
      ),
    ).toBe("baseline_only");
    expect(
      v1(
        sig(sage, [
          "Inductive learning For the inductive learning task, we compare against the four different supervised GraphSAGE inductive methods presented in Hamilton et al. (2017).",
          "More recently, Hamilton et al. (2017) introduced GraphSAGE, a method for computing node representations in an inductive manner.",
        ]),
      ),
    ).toBe("baseline_only");
    expect(
      v1(
        sig(vgae, [
          "Generalization of GCN to other tasks can be found in Kipf & Welling (2016); Berg et al. (2017); Schlichtkrull et al. (2017) and Hamilton et al. (2017b).",
          "GCNs have been applied to node classification (Kipf & Welling, 2017), link prediction (Kipf & Welling, 2016; Berg et al., 2017), outperforming multi-layer perceptron (MLP) models.",
        ]),
      ),
    ).toBe("baseline_only");
  });
});

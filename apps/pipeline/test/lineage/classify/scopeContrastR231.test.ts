/**
 * R2-31 (design 41): build-on beats a scope contrast. "While X …, our
 * <application / version> of …" states a difference of scope inside the
 * approach the citing paper builds on (Shazeer et al. <- Eigen et al.,
 * second review R2-29: extends, not contrasts). An explicit contrast
 * (unlike / in contrast to / differ from), a replacement (instead of /
 * rather than / replace) or a comparison claim keeps the contrast.
 */
import { describe, expect, it } from "vitest";
import {
  classifyS2Pair,
  type PairSignals,
  v1RelationFor,
} from "../../../src/lineage/classify/apiRelations.js";

const eigen = {
  title: "Learning Factored Representations in a Deep Mixture of Experts",
  authors: ["David Eigen", "Marc'Aurelio Ranzato", "Ilya Sutskever"],
  year: 2013,
};
const shazeer = "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer";
const SCOPE =
  "While Eigen et al. (2013) uses two stacked MoEs allowing for two sets of gating decisions, our convolutional application of the MoE allows for different gating decisions at each position in the text.";

function rel(contexts: string[], extra: Partial<PairSignals> = {}) {
  const r = classifyS2Pair({
    found: true,
    intents: ["methodology", "background"],
    contexts,
    isInfluential: true,
    cited: eigen,
    citingTitle: shazeer,
    ...extra,
  });
  return {
    r,
    v1: v1RelationFor(r.relation, { contrast: r.contrast, targetsCited: r.singleTarget }),
  };
}

describe("R2-31: build-on beats a scope contrast", () => {
  it("Shazeer <- Eigen (the published S2 contexts): extends, quoting the scope sentence", () => {
    const { r, v1 } = rel([
      "Eigen et al. (2013) introduce the idea of using multiple MoEs with their own gating networks as parts of a deep model.",
      SCOPE,
      "Eigen et al. (2013) describe the same phenomenon, and use a hard constraint at the beginning of training to avoid this local minimum.",
    ]);
    expect(v1).toBe("extends");
    expect(r.rule).toBe("phrase_build");
    expect(r.evidence).toBe(SCOPE);
    expect(r.contrast).toBe(false);
  });

  it("an explicit contrast in another sentence about the cited paper dominates", () => {
    const { v1 } = rel([
      SCOPE,
      "Unlike Eigen et al. (2013), we do not stack the MoEs at all and route each token once.",
    ]);
    expect(v1).toBe("contrasts");
  });

  it("a comparison claim in another sentence keeps the scope sentence a contrast", () => {
    const { v1 } = rel([SCOPE, "Our model outperforms Eigen et al. (2013) on every benchmark."]);
    expect(v1).toBe("contrasts");
  });

  it("a replacement cue in the scope sentence keeps the contrast", () => {
    const { v1 } = rel([
      "While Eigen et al. (2013) uses two stacked MoEs, our application of the MoE uses a single sparse layer instead of stacked gates.",
    ]);
    expect(v1).toBe("contrasts");
  });

  it("a concessive 'While X …, we found …' (MAE <- BERT, gold contrasts) is unchanged", () => {
    const { v1 } = rel(
      [
        "While in BERT the decoder can be trivial (an MLP) [14], we found that for images, the decoder design plays a key role in determining the semantic level of the learned latent representations.",
      ],
      {
        cited: {
          title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
          authors: ["Jacob Devlin"],
          year: 2019,
        },
        citingTitle: "Masked Autoencoders Are Scalable Vision Learners",
      },
    );
    expect(v1).toBe("contrasts");
  });

  it("'whereas' with an explicit 'differ from' stays a contrast", () => {
    const { v1 } = rel([
      "Whereas Eigen et al. (2013) stack two MoEs, our use of the MoE differs from theirs in the gating.",
    ]);
    expect(v1).toBe("contrasts");
  });
});

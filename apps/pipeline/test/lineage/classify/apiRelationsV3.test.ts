/**
 * R2-16: rule set v3 (production S2 rules) on the sentence shapes the
 * second review flagged (ERROR_PATTERNS 2/3/7). Sentences are the real
 * Semantic Scholar contexts of the published vision-transformer lineage.
 */
import { describe, expect, it } from "vitest";
import {
  classifyApiRelationV3,
  classifyS2Pair,
  type PairSignals,
  v1RelationFor,
} from "../../../src/lineage/classify/apiRelations.js";

const swin = { title: "Swin Transformer: Hierarchical Vision Transformer using Shifted Windows" };
const pvt = { title: "Pyramid Vision Transformer: A Versatile Backbone for Dense Prediction" };
const vivit = { title: "ViViT: A Video Vision Transformer" };
const segmenter = { title: "Segmenter: Transformer for Semantic Segmentation" };
const cswin = { title: "CSWin Transformer: A General Vision Transformer Backbone" };

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

function v1(s: PairSignals): string | null {
  const r = classifyS2Pair(s);
  return v1RelationFor(r.relation, { contrast: r.contrast, targetsCited: r.singleTarget });
}

describe("negative cues: protocol / fair comparison / comparison / ablation", () => {
  it("an experimental protocol is never builds_on", () => {
    // PVT -> CSWin
    expect(
      v1(
        sig(pvt, [
          "For fair comparison, we follow previous works [30, 47] and train Semantic FPN 80k iterations with batch size as 16.",
          "We compare CSWin Transformer with various backbones: ResNet [22], and Transformer backbones PVT [58], Twins [11], and Swin [38].",
        ]),
      ),
    ).toBe("baseline_only");
    // ViViT -> Video Swin
    expect(
      v1(
        sig(vivit, [
          "For inference, we follow [1] by using 4 × 3 views, where a video is uniformly sampled in the temporal dimension as 4 clips.",
        ]),
      ),
    ).toBe("baseline_only");
    const r = classifyApiRelationV3(
      sig({ title: "X" }, [
        "Following [5], we use the same training setting as in their paper for all runs.",
      ]),
    );
    expect(r.relation).not.toBe("builds_on");
    expect(r.rule).toBe("phrase_protocol");
  });

  it("a fair-comparison sentence with a schedule is a comparison (PVT -> DAT)", () => {
    const r = classifyApiRelationV3(
      sig(pvt, [
        "To make a fair comparison to PVT [36] and Swin Transformer [26], we follow the learning rate schedules and training epochs.",
      ]),
    );
    expect(r).toMatchObject({ relation: "compares_with", rule: "phrase_protocol" });
  });

  it("outperform / surpass naming the cited paper beats the methodology intent (PVT -> CvT)", () => {
    const r = classifyApiRelationV3(
      sig(pvt, [
        "With fewer paramerters, CvT-13 achieves a 81.6% ImageNet Top-1 accuracy, outperforming PVT-Small [34], T2T-ViT t -14 [41], TNT-S [14] by 1.7%, 0.8%, 0.2% respectively.",
      ]),
    );
    expect(r).toMatchObject({ relation: "compares_with", rule: "phrase_compare" });
  });

  it("an ablation mention is not builds_on (CSWin -> DAT)", () => {
    const r = classifyApiRelationV3(
      sig(cswin, [
        "We also try other types of position embeddings, including a fixed learnable position bias and a depthwise convolution in [11].",
      ]),
    );
    expect(r).toMatchObject({ relation: "compares_with", rule: "phrase_ablation" });
  });
});

describe("target matching", () => {
  it("a sentence citing >= 3 works without naming the cited one is background", () => {
    // Segmenter -> CSWin: "Built upon the success of ViT … [8,8,10,13,…]"
    const r = classifyApiRelationV3(
      sig(
        segmenter,
        [
          "Built upon the success of ViT, many efforts have been devoted to designing better Transformer based architectures for various vision tasks [4, 46], [8, 10, 13, 14, 17, 24].",
        ],
        { isInfluential: false, intents: ["methodology"] },
      ),
    );
    expect(r.relation).toBe("background");
  });

  it("a build cue needs the citing paper as subject", () => {
    for (const s of [
      "Recently, inspired by successful ViT [66], transformer variants emerge explosively.",
      "Concurrent work extends this work to video classification [2, 6] and semantic segmentation [35, 67].",
      "A concurrent work [82] proposed a U-shaped architecture based on the Swin Transformer [56].",
    ]) {
      expect(
        classifyApiRelationV3(sig(swin, [s], { intents: [], isInfluential: false })).relation,
      ).not.toBe("builds_on");
    }
  });

  it("a named cited paper in a multi-citation sentence still counts", () => {
    const r = classifyApiRelationV3(
      sig(swin, ["Our backbone is built upon Swin Transformer [28], ViT [8] and DeiT [30]."], {
        intents: [],
      }),
    );
    expect(r).toMatchObject({ relation: "builds_on", rule: "phrase_build" });
  });

  it("the weak methodology+influential rule is background, never builds_on (R2-22)", () => {
    const multiOnly = sig({ title: "PVT v2: Improved baselines with pyramid vision transformer" }, [
      "Recent works [6, 11, 35, 39] have proved that adopting convolution layers in the Vision Transformer architecture can further improve model performances.",
    ]);
    expect(classifyApiRelationV3(multiOnly).relation).toBe("background");
    const named = sig(swin, [
      "Swin Transformer layer (STL) [56] is based on the standard multi-head self-attention of the original Transformer layer.",
    ]);
    // R2-22: intent + influential + a named sentence without a build cue
    // is not an inheritance claim (design 41 D5).
    expect(classifyApiRelationV3(named)).toMatchObject({
      relation: "background",
      rule: "intent_methodology_influential",
    });
  });
});

describe("adaptation cues outrank the S2 intents (Swin -> Video Swin)", () => {
  it("'our architecture is adapted from Swin Transformer [28]' is builds_on", () => {
    const r = classifyApiRelationV3(
      sig(
        swin,
        [
          "Swin Transformer [28] further introduces the inductive biases of locality, hierarchy and translation invariance.",
          "As our architecture is adapted from Swin Transformer [28], our model can be initialized by its strong pre-trained model on a large-scale dataset.",
        ],
        { intents: ["background"], isInfluential: false },
      ),
    );
    expect(r).toMatchObject({ relation: "builds_on", rule: "phrase_build" });
    expect(r.evidence).toMatch(/^As our architecture is adapted from Swin Transformer/);
  });
});

describe("contrasts only from a contrast cue that targets the cited paper", () => {
  it("named or single-target contrast cue -> contrasts; otherwise baseline_only", () => {
    expect(
      v1(
        sig(
          swin,
          [
            "Unlike Swin Transformer [28] and PVT [36], we use deformable attention in every stage.",
          ],
          {
            intents: [],
          },
        ),
      ),
    ).toBe("contrasts");
    expect(
      v1(
        sig({ title: "X" }, ["Unlike [3, 5], we sample a fixed number of neighbours per node."], {
          intents: [],
        }),
      ),
    ).toBe("baseline_only");
    // Contrast cue without the citing paper as subject.
    expect(
      v1(
        sig(
          swin,
          [
            "This strategy is fundamentally different from existing self-attention mechanisms [18, 30, 45, 56].",
          ],
          {
            intents: [],
            isInfluential: false,
          },
        ),
      ),
    ).toBe("baseline_only");
  });

  it("no contexts gives no contrast at all (left to the caller)", () => {
    expect(classifyS2Pair(sig(swin, [], { intents: [] })).relation).toBe("cites_unspecified");
  });
});

describe("evidence is the triggering sentence, or a sentence about the cited paper", () => {
  it("quotes nothing when only junk contexts exist", () => {
    const r = classifyS2Pair(
      sig({ title: "X" }, ["[19, 41]."], { intents: [], isInfluential: false }),
    );
    expect(r).toMatchObject({ relation: "background", evidence: null, quotable: false });
  });
});

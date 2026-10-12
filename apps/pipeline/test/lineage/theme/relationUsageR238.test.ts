/**
 * R2-38 (design 41): `extends` precision on the hand-labelled evaluation
 * set of every strong edge of the published ICML 2025 conference lineage
 * and the 5 theme lineages (`fixtures/relation-usage-eval-r238.json`).
 * A citation that only USES a benchmark / dataset / task / metric /
 * framework / tool / protocol is not a build-on; the rule set must say so
 * (rule `phrase_usage`, baseline_only) without losing an audited extends.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyS2Pair,
  type PairSignals,
  usageReason,
  v1RelationFor,
} from "../../../src/lineage/classify/apiRelations.js";
import { isSurveyLike } from "../../../src/lineage/shared/surveyLike.js";
import { citingAbstractOf } from "../../../src/lineage/theme/s2Relations.js";

const here = dirname(fileURLToPath(import.meta.url));

interface EvalItem {
  collection: string;
  src: string;
  dst: string;
  cited: { title: string; year: number | null; authors: unknown };
  citing: { title: string; year: number | null };
  citing_abstract: string | null;
  method: string;
  evidence_source: string;
  published_relation: string;
  s2: { intents: string[] | null; is_influential: boolean | null; contexts: string[] | null };
  arxiv_html_contexts?: string[];
  label: "genuine" | "genuine_contrast" | "usage" | "other";
  usage_kind: string | null;
  gold_relation: string;
  also_acceptable: string[];
  borderline: boolean;
  audited_verdict: string | null;
  note: string;
}

const fixture = JSON.parse(
  readFileSync(join(here, "fixtures/relation-usage-eval-r238.json"), "utf8"),
) as { items: EvalItem[] };
const items = fixture.items;
const STRONG = new Set(["extends", "supersedes", "contrasts", "successor"]);

/** The relation the current rules give the pair, the way production reads
 * it: title versions / the allowlist are not rule-classified; arXiv HTML
 * contexts only ever add a strong cue-backed claim (R2-28); S2 contexts
 * plus the citing abstract otherwise. */
function predict(item: EvalItem): string {
  if (item.method !== "s2_context_rule") return item.published_relation;
  const html = item.evidence_source === "arxiv_html";
  const child = { title: item.citing.title, short_abstract: item.citing_abstract ?? undefined };
  const signals: PairSignals = {
    found: true,
    intents: item.s2.intents ?? [],
    contexts: html ? (item.arxiv_html_contexts ?? []) : (item.s2.contexts ?? []),
    isInfluential: item.s2.is_influential,
    citingTitle: item.citing.title,
    citingSurvey: isSurveyLike(child),
    cited: { title: item.cited.title, year: item.cited.year, authors: item.cited.authors } as never,
    citingAbstract: html ? null : citingAbstractOf(child),
  };
  const r = classifyS2Pair(signals);
  const mapped =
    v1RelationFor(r.relation, { contrast: r.contrast, targetsCited: r.singleTarget }) ??
    "baseline_only";
  if (html && !(STRONG.has(mapped) && r.cue && r.quotable && !r.fromAbstract))
    return "baseline_only";
  return mapped;
}

function score(pred: (i: EvalItem) => string, subset: readonly EvalItem[] = items) {
  const scoped = subset.filter((i) => i.method === "s2_context_rule");
  const predicted = scoped.filter((i) => pred(i) === "extends");
  const tp = predicted.filter((i) => i.label === "genuine").length;
  const genuine = scoped.filter((i) => i.label === "genuine").length;
  return {
    predicted: predicted.length,
    tp,
    precision: predicted.length === 0 ? 1 : tp / predicted.length,
    recall: genuine === 0 ? 1 : tp / genuine,
  };
}

describe("R2-38 usage vs extends evaluation set", () => {
  it("covers ICML 2025 and all 5 themes with real sentences", () => {
    const by = new Set(items.map((i) => i.collection));
    expect([...by].sort()).toEqual([
      "flash-attention",
      "graph-neural-network",
      "icml-2025",
      "low-rank-adaptation",
      "mixture-of-experts",
      "vision-transformer",
    ]);
    expect(
      items.filter((i) => i.collection === "icml-2025" && i.published_relation === "extends"),
    ).toHaveLength(17);
    for (const i of items) {
      if (i.method !== "s2_context_rule") continue;
      const ctx = i.evidence_source === "arxiv_html" ? i.arxiv_html_contexts : i.s2.contexts;
      expect(ctx?.length ?? 0, `${i.citing.title} <- ${i.cited.title}`).toBeGreaterThan(0);
    }
  });

  it("published (pre-R2-38) extends precision on ICML 2025 is low", () => {
    const icml = items.filter((i) => i.collection === "icml-2025");
    const before = score((i) => i.published_relation, icml);
    expect(before).toMatchObject({ predicted: 17, tp: 3 });
  });

  it("reaches extends precision >= 0.9 overall and on ICML 2025", () => {
    const all = score(predict);
    expect(all.precision).toBeGreaterThanOrEqual(0.9);
    const icml = score(
      predict,
      items.filter((i) => i.collection === "icml-2025"),
    );
    expect(icml.precision).toBeGreaterThanOrEqual(0.9);
    expect(icml.tp).toBe(3); // Hi Robot -> MemER, π0 -> Hi Robot, ReAct -> REMem
  });

  it("keeps every audited strong edge", () => {
    const audited = items.filter((i) => i.audited_verdict !== null);
    expect(audited.length).toBe(28);
    for (const i of audited) {
      expect(predict(i), `${i.collection}: ${i.citing.title} <- ${i.cited.title}`).toBe(
        i.published_relation,
      );
    }
  });

  it("never labels a usage citation extends", () => {
    const usage = items.filter((i) => i.method === "s2_context_rule" && i.label === "usage");
    expect(usage.length).toBe(13);
    for (const i of usage) {
      expect(
        [i.gold_relation, ...i.also_acceptable],
        `${i.citing.title} <- ${i.cited.title}`,
      ).toContain(predict(i));
    }
  });
});

describe("usageReason (R2-38) on real sentences of the evaluation set", () => {
  const none = { citedResource: false, citingEvaluation: false, intentsWithoutMethod: false };
  it.each([
    [
      "Second, we adopt V-IRL (Yang et al., 2024a), a real-world navigation task that focuses on the model’s spatial reasoning capabilities .",
      "resource_apposition",
    ],
    [
      "To address this gap, we adopt Embench [54], a benchmark designed for evaluating multimodal agents in dynamic, interactive environments.",
      "resource_apposition",
    ],
    [
      "We adopt the F1 calculation from HippoRAG 2 (Guti´errez et al., 2025), BLEU-1 implementation from HuggingFace Evaluate (HuggingFace, 2025).",
      "resource_object",
    ],
    ["For the agent, we adopt the most popular framework, ReAct [29].", "stock_tool"],
    [
      "…should be discriminative enough for a model to identify their correctness directly from the latent thoughts. pothesis, we follow the widely-used probing technique (Liu et al., 2019; Hewitt & Manning, 2019), and train a lightweight sequence classifier to predict the correctness of latent thoughts.",
      "resource_object",
    ],
    [
      "Specifically, we adopt a 2-layer Transformer (Vaswani et al., 2017) with Sinusoidal positional encoding to encode the sequence of latent thoughts.",
      "stock_tool",
    ],
    [
      "5-Math [Yang et al., 2024], we adopt the pairwise ranking loss [Ouyang et al., 2022] to optimize the ORM.",
      "component",
    ],
    [
      "Based on such annotations, we find inter-annotator agreement to be Fleiss’ κ = 0.912, suggesting excellent agreement among annotators.",
      "measurement",
    ],
    [
      "While we can vary α to get different formulations of matrix entropy, we follow the approach of Skean et al. (2025) and choose α → 1 , which is equivalent to the standard von Neumann entropy.",
      "setting",
    ],
    [
      "We follow the official code and configuration of QLoRA (Dettmers et al., 2024), IR-QLoRA (Qin et al., 2024), QA-LoRA (Xu et al., 2023b), PEQA (Kim et al., 2024), and GPTQ (Achiam et al., 2023).",
      "resource_object",
    ],
    [
      "Given the target modal features z^img or z^pcl , we construct image-text conversation pairs in an instruction-following format based on previous works (Zhang et al., 2023; Yin et al., 2023; Peng et al., 2023), as shown in Figure 4.",
      "resource_object",
    ],
  ])("demotes a weak adoption cue: %s", (sentence, reason) => {
    expect(usageReason(sentence, false, none)).toBe(reason);
  });

  it("demotes a strong cue whose own object / subject is a resource", () => {
    expect(
      usageReason(
        "This output structure is inspired by the Embench[54] prompting format, where the model is encouraged to first observe the image, then reflect and reason, and finally produce a coherent multi-step action plan.",
        true,
        none,
      ),
    ).toBe("resource_object");
    expect(
      usageReason(
        "Due to computational constraints, we limited these extended experiments to three methods: LoRA[4], LoRA+[36], and LoRA-GA .",
        true,
        none,
      ),
    ).toBe("resource_object");
  });

  it("uses the paper types and S2 intents only for weak cues", () => {
    const s = "To address the problem, we adopt X [3] in our pipeline.";
    expect(usageReason(s, false, { ...none, citedResource: true })).toBe("cited_resource");
    expect(usageReason(s, false, { ...none, citingEvaluation: true })).toBe("citing_evaluation");
    expect(usageReason(s, false, { ...none, intentsWithoutMethod: true })).toBe(
      "intent_not_methodology",
    );
    expect(
      usageReason(s, true, {
        citedResource: true,
        citingEvaluation: true,
        intentsWithoutMethod: true,
      }),
    ).toBeNull();
    expect(usageReason(s, false, none)).toBeNull();
  });

  it.each([
    "Our method builds on the common hierarchical VLA paradigm, as in Shi et al. (2025), and extends it with the ability to tackle long-horizon tasks that require memory.",
    "As our architecture is adapted from Swin Transformer [28], our model can be initialized by its strong pre-trained model on a large-scale dataset.",
    "Our approach is inspired by [54] who proposed a top-k gating in LSTMs, with auxiliary losses ensuring the expert balance [26].",
    "For the encoder, we build upon the vision transformer ViT [19] and consider ”Tiny”, ”Small”, ”Base” and ”Large” models described in Table 1.",
  ])("keeps a strong methodological cue: %s", (sentence) => {
    expect(usageReason(sentence, true, none)).toBeNull();
  });

  it.each([
    "We use the “mean” variant of GRAPHSAGE [16] and apply a DIFFPOOL layer after every two GRAPHSAGE layers in our architecture.",
    "Following [39], we place the MoEs on every other layer (we refer to these as V-MoE Every-2).",
    "For image classification, we follow ViT [13] and DeiT [63] to append a learnable classification token to the input of the last stage, and then employ a fully connected (FC) layer to conduct classification on top of the token.",
    "We follow the FlashAttention algorithms in using e P for unnormalized shifted exponentials, m for the row shift, ℓ for their row sum, and L for log-sum-exp [2, 3, 4].",
    "We adopt a ReAct-style agent (Yao et al., 2023a; Gu et al., 2024) equipped with three categories of carefully curated tools to access the hybrid graph: 1) retrieval tools, 2) graph exploration tools, and 3) the flow control tool.",
  ])("keeps a weak cue that adopts a method: %s", (sentence) => {
    expect(usageReason(sentence, false, none)).toBeNull();
  });
});

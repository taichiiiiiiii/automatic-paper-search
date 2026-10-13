/**
 * R2-39 (design 41): cue → target attribution of the LLM-free relation
 * rules, judged on every `extends` edge of the published NeurIPS 2025
 * conference lineage (`fixtures/relation-cue-target-eval-r239.json`) next
 * to the R2-38 set. A build-on cue counts for the cited paper only when it
 * governs the cited paper's citation (not another work's in the same
 * sentence, not a Section / Table of the citing paper, not a third-party
 * subject), and using a released model / training data / template /
 * setting / stock algorithm is not inheritance.
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
import {
  citedAliases,
  citedIdentity,
  cueGovernor,
  cueTargetsCited,
} from "../../../src/lineage/classify/citedTarget.js";
import { isBogusPaperRecord, isGenericTitle } from "../../../src/lineage/shared/bogusRecord.js";
import { isSurveyLike } from "../../../src/lineage/shared/surveyLike.js";
import { citingAbstractOf } from "../../../src/lineage/theme/s2Relations.js";

const here = dirname(fileURLToPath(import.meta.url));

interface EvalItem {
  collection: string;
  cited: { title: string; year: number | null; authors: unknown; venue?: string };
  citing: { title: string; year: number | null };
  citing_abstract: string | null;
  method: string;
  evidence_source: string;
  published_relation: string;
  s2: { intents: string[] | null; is_influential: boolean | null; contexts: string[] | null };
  arxiv_html_contexts?: string[];
  label: string;
  usage_kind: string | null;
  gold_relation: string;
  also_acceptable: string[];
  audited_verdict: string | null;
  genuine_evidence?: string[] | null;
}

const load = (f: string) =>
  (JSON.parse(readFileSync(join(here, "fixtures", f), "utf8")) as { items: EvalItem[] }).items;
const r239 = load("relation-cue-target-eval-r239.json");
const r238 = load("relation-usage-eval-r238.json");
const STRONG = new Set(["extends", "supersedes", "contrasts", "successor"]);

const contextsOf = (i: EvalItem) =>
  (i.evidence_source === "arxiv_html" ? i.arxiv_html_contexts : i.s2.contexts) ?? [];

/** As in `relationUsageR238.test.ts`: the relation production derives. */
function predict(item: EvalItem): { relation: string; evidence: string | null } {
  if (item.method !== "s2_context_rule")
    return { relation: item.published_relation, evidence: null };
  const html = item.evidence_source === "arxiv_html";
  const child = { title: item.citing.title, short_abstract: item.citing_abstract ?? undefined };
  const signals: PairSignals = {
    found: true,
    intents: item.s2.intents ?? [],
    contexts: contextsOf(item),
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
    return { relation: "baseline_only", evidence: null };
  return { relation: mapped, evidence: r.evidence };
}

/** Bogus cited records never become nodes (edition builder, R2-39). */
const kept = (i: EvalItem) => !isBogusPaperRecord(i.cited as Record<string, unknown>);

function score(items: readonly EvalItem[], strict = false) {
  const scoped = items.filter((i) => i.method === "s2_context_rule" && kept(i));
  const preds = scoped.map((i) => ({ i, p: predict(i) }));
  const ext = preds.filter((x) => x.p.relation === "extends");
  const tp = ext.filter(
    (x) =>
      x.i.label === "genuine" &&
      (!strict ||
        !Array.isArray(x.i.genuine_evidence) ||
        x.i.genuine_evidence.some((g) => (x.p.evidence ?? "").includes(g))),
  ).length;
  const genuine = scoped.filter((i) => i.label === "genuine").length;
  return {
    predicted: ext.length,
    tp,
    precision: ext.length === 0 ? 1 : tp / ext.length,
    recall: genuine === 0 ? 1 : tp / genuine,
  };
}

describe("R2-39 NeurIPS 2025 extends evaluation set", () => {
  it("labels all 44 published extends with their real sentences", () => {
    expect(r239).toHaveLength(44);
    expect(r239.every((i) => i.collection === "neurips-2025")).toBe(true);
    expect(r239.every((i) => i.published_relation === "extends")).toBe(true);
    const by: Record<string, number> = {};
    for (const i of r239) by[i.label] = (by[i.label] ?? 0) + 1;
    expect(by).toEqual({
      genuine: 12,
      usage: 15,
      misattributed: 8,
      self_ref: 6,
      third_party: 1,
      other: 2,
    });
    for (const i of r239) expect(contextsOf(i).length, i.citing.title).toBeGreaterThan(0);
  });

  it("published precision was 12/44", () => {
    const g = r239.filter((i) => i.label === "genuine").length;
    expect(g / r239.length).toBeCloseTo(12 / 44, 5);
  });

  it("drops the two edges of the bogus 'Open Source' node", () => {
    const bogus = r239.filter((i) => !kept(i));
    expect(bogus.map((i) => i.cited.title)).toEqual(["Open Source", "Open Source"]);
    expect(bogus.every((i) => i.usage_kind === "bogus_node")).toBe(true);
  });

  it("reaches extends precision >= 0.9 on NeurIPS 2025, also with the evidence sentence checked", () => {
    const s = score(r239);
    expect(s.precision).toBeGreaterThanOrEqual(0.9);
    expect(s.tp).toBeGreaterThanOrEqual(10);
    const strict = score(r239, true);
    expect(strict.precision).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps precision >= 0.9 on the union with the R2-38 set", () => {
    expect(score([...r238, ...r239]).precision).toBeGreaterThanOrEqual(0.9);
    expect(score(r238).precision).toBeGreaterThanOrEqual(0.9);
  });

  it("never gives extends to a misattributed, self-referencing or third-party cue", () => {
    const wrong = r239.filter((i) =>
      ["misattributed", "self_ref", "third_party"].includes(i.label),
    );
    expect(wrong).toHaveLength(15);
    for (const i of wrong) {
      expect(predict(i).relation, `${i.cited.title} -> ${i.citing.title}`).not.toBe("extends");
    }
  });

  it("never gives extends to a usage citation unless also acceptable", () => {
    const usage = r239.filter((i) => i.label === "usage");
    for (const i of usage) {
      expect(
        [i.gold_relation, ...i.also_acceptable],
        `${i.cited.title} -> ${i.citing.title}`,
      ).toContain(predict(i).relation);
    }
  });

  it("quotes the sentence that states the build-on (MiMo <- GRPO)", () => {
    const mimo = r239.find((i) => i.citing.title.startsWith("MiMo")) as EvalItem;
    const p = predict(mimo);
    expect(p.relation).toBe("extends");
    expect(p.evidence).toContain("modified version of Group Relative Policy Optimization");
  });
});

/** Identity of the cited paper of a fixture item (as production builds it). */
function idOf(citing: string, cited: string) {
  const i = r239.find((x) => x.citing.title.startsWith(citing) && x.cited.title.startsWith(cited));
  if (!i) throw new Error(`no item ${cited} -> ${citing}`);
  return citedIdentity(i.cited as never, contextsOf(i));
}

const cue = (sentence: string, re: RegExp) => {
  const m = re.exec(sentence);
  if (!m) throw new Error(`no cue ${re} in ${sentence}`);
  return [m.index, m[0]] as const;
};

describe("cueGovernor (R2-39) on real NeurIPS 2025 sentences", () => {
  it("another work comes first in the cue's object", () => {
    const s =
      "We adopt the zero residual-block initialization [13], which adaLN-zero [35] also follows.";
    const [at, c] = cue(s, /We adopt/);
    expect(cueGovernor(s, at, c, idOf("Improved Mean Flows", "Scalable Diffusion"))).toBe("other");
    const s2 =
      "We adopt the PPO [4] as the core RL algorithm, diverging from the GRPO used in DeepSeek-R1-Zero [2].";
    const [at2, c2] = cue(s2, /We adopt/);
    expect(cueGovernor(s2, at2, c2, idOf("Open-Reasoner-Zero", "DeepSeek-R1: Incentivizing"))).toBe(
      "other",
    );
    expect(cueGovernor(s2, at2, c2, idOf("Open-Reasoner-Zero", "Proximal Policy"))).toBe("cited");
  });

  it("the owner a 'proposed by / released by / introduced in' phrase names governs", () => {
    const s =
      "We adopt enhancements of GRPO [16] proposed by DAPO [4], decoupling clipping hyperparameters with ϵ low = 0 .";
    const [at, c] = cue(s, /We adopt/);
    expect(cueGovernor(s, at, c, idOf("ProRL", "DeepSeekMath"))).toBe("other");
    const s2 =
      "We adopt RLVR-trained models released by SimpleRLZoo (Zeng et al., 2025), which train zero-RL models using GRPO on GSM8K and the MATH training set, with correctness reward only, excluding any format-based reward.";
    const [at2, c2] = cue(s2, /We adopt/);
    expect(cueGovernor(s2, at2, c2, idOf("Does Reinforcement", "DeepSeekMath"))).toBe("other");
    const s3 =
      "Semi-Autoregressive Sampling for Text Generation For text generation, we adopt the semi-autoregressive denoising strategy introduced in LLaDA [22], which integrates autoregressive decoding with diffusion-based denoising.";
    const [at3, c3] = cue(s3, /we adopt/);
    expect(cueGovernor(s3, at3, c3, idOf("MMaDA", "Large Language Diffusion"))).toBe("cited");
  });

  it("a section / table reference or an anaphor is the citing paper itself", () => {
    const s =
      "In this section, building on the observations of entropy patterns in CoTs discussed in Section 3, we further investigate how these patterns evolve throughout RLVR training.";
    const [at, c] = cue(s, /building on/);
    expect(cueGovernor(s, at, c, idOf("Beyond the 80/20", "DAPO"))).toBe("self");
    const s2 =
      "Our work builds on this line of research by leveraging entropy as a mechanism to extract meaningful signals from zero-variance prompts, addressing this limitation directly.";
    const [at2, c2] = cue(s2, /builds on/);
    expect(cueGovernor(s2, at2, c2, idOf("No Prompt Left Behind", "Understanding R1"))).toBe(
      "self",
    );
    const s3 =
      "Based on the setup in Section 4.3, we investigate the effect of the training steps on the asymptotic performance of the model.";
    expect(cueTargetsCited(s3, idOf("Does Reinforcement", "DAPO"), [/\bbased\s+on\b/i])).toBe(
      false,
    );
  });

  it("a third-party subject of 'extend' is not the citing paper's claim", () => {
    const s =
      "Flow Matching methods [28, 1, 30] extend this framework by modeling the velocity fields that define flow paths between distributions.";
    const [at, c] = cue(s, /extend/);
    expect(cueGovernor(s, at, c, idOf("Mean Flows", "Flow Straight"))).toBe("other");
  });

  it("the destination of an extension is not built on", () => {
    const s =
      "Using the log-probability estimators proposed in Section 3.1, we extend GRPO to masked dLLMs. Note that our estimation technique is broadly applicable and can readily extend to other policy gradient methods such as PPO [37] or REINFORCE [44].";
    const id = idOf("d1:", "Proximal Policy");
    expect(cueTargetsCited(s, id, [/\bextend(s|ed|ing)?\b/i])).toBe(false);
  });

  it("an object without any citation over 12 words is not about the later name", () => {
    const s =
      "On-Policy RL with Extended Generation Budget Our prior empirical investigations indicated that a vanilla implementation of GRPO was markedly prone to premature performance saturation.";
    const [at, c] = cue(s, /Extended/);
    expect(cueGovernor(s, at, c, idOf("MiMo", "DeepSeekMath"))).toBe("distant");
  });

  it("keeps a build-on that names the cited paper in its object", () => {
    const s =
      "Our pMF is built on top of Flow Matching (Lipman et al., 2023; Liu et al., 2023; Albergo & Vanden-Eijnden, 2023), MeanFlow (Geng et al., 2025a;b), and JiT (Li & He, 2025).";
    const [at, c] = cue(s, /built on top of/);
    expect(cueGovernor(s, at, c, idOf("One-step Latent-free", "Flow Straight"))).toBe("cited");
    expect(cueGovernor(s, at, c, idOf("One-step Latent-free", "Flow Matching for"))).toBe("cited");
  });
});

describe("usageReason (R2-39) on real NeurIPS 2025 sentences", () => {
  const none = { citedResource: false, citingEvaluation: false, intentsWithoutMethod: false };
  it.each([
    [
      "Our analyses are based on the DeepSeek R1-Distill Qwen-14B model (48 layers) [8].",
      "resource_object",
    ],
    [
      "To ensure a fair evaluation, we use the publicly released model from (Hu et al., 2025b).",
      "released_model",
    ],
    [
      "For training and evaluation of DAPO (Yu et al., 2025), we reuse their training data ( https:// huggingface.co/datasets/BytedTsinghua-SIA/DAPO-Math-17k ) and processed version of AIME 2024 ( https://huggingface.co/datasets/BytedTsinghua-SIA/ AIME-2024 ).",
      "resource_object",
    ],
    [
      "For reliable answer extraction, we adopt the “ < think >< /think >< answer >< /answer > ” template of R1 (Liu et al., 2025b) during training and use the striped content inside answer tags as the generated answer.",
      "resource_object",
    ],
    [
      "The detailed implementation of DiT-B/2 is provided in Table 3, where we adopt the DiT-B/2-non-cfg setting.",
      "resource_object",
    ],
    [
      "We adopt GRPO [Shao et al., 2024] as the RL algorithm, and full implementation details are in Appendix C.",
      "stock_role",
    ],
    [
      "We adopt the PPO [4] as the core RL algorithm, diverging from the GRPO used in DeepSeek-R1-Zero [2].",
      "stock_role",
    ],
    ["Following DAPO [19], we adopt a clip-higher strategy with 𝜀 high = 0.28.", "setting_value"],
    [
      "(17) to class-unconditional inputs, we drop the class condition with 10% probability, following [18].",
      "setting_value",
    ],
    [
      "Inspired by DeepSeek-R1-Zero [2], we design our prompt template to elicit the model to utilize inference computation, gradually mastering the reasoning ability, as shown in the Appendix.",
      "main_clause_usage",
    ],
    [
      "Building on the advancements of the GRPO [7] algo-rithm and prior explorations of multi-modal reasoning training [2, 25], we adhere to the standard GRPO framework to train our model.",
      "main_clause_usage",
    ],
  ])("demotes: %s", (sentence, reason) => {
    expect(usageReason(sentence, false, none)).toBe(reason);
  });

  it.each([
    'For the 32B variant, we introduce an additional "annealing" training stage inspired by analogous practices in large language model pre-training [26].',
    "The optimization objective is defined as follows: (2) Inspired by DAPO Yu et al. [2025b], in all experiments of this work, we omit the KL term during optimization, while incorporating the clip-higher , token-level loss and dynamic sampling strategies to enhance the training efficiency of RLVR.",
  ])(
    "demotes a strong cue whose object / main clause is a practice or the experiments: %s",
    (s) => {
      expect(usageReason(s, true, none)).not.toBeNull();
    },
  );

  it.each([
    "We present the first adaptation of the MeanFlow (Geng et al. 2025) paradigm to robot learning, termed MP1.",
    "Second , we extend the GRPO [28] paradigm to enhance spatial reasoning by designing task-specific verifiable rewards for various QA formats (e.g., multiple choice, numerical).",
    "While a common practice involves the use of Stochastic Differential Equations (SDEs), we adopt Coefficients-Preserving Sampling (CPS) [40] as a more refined alternative to maintain the integrity of the probability path.",
    "Semi-Autoregressive Sampling for Text Generation For text generation, we adopt the semi-autoregressive denoising strategy introduced in LLaDA [22], which integrates autoregressive decoding with diffusion-based denoising.",
  ])("keeps a genuine build-on: %s", (s) => {
    expect(usageReason(s, /extend|adaptation/.test(s), none)).toBeNull();
  });
});

describe("generic names (R2-39)", () => {
  it("a field-word title stem or first word is no alias", () => {
    expect(citedAliases({ title: "Reinforcement Learning: A Survey" } as never)).not.toContain(
      "reinforcement learning",
    );
    expect(
      citedAliases({
        title: "Flow Straight and Fast: Learning to Generate and Transfer Data with Rectified Flow",
      } as never),
    ).not.toContain("flow");
    expect(
      citedAliases({ title: "Swin Transformer: Hierarchical Vision Transformer" } as never),
    ).toContain("swin");
  });
});

describe("isBogusPaperRecord (R2-39)", () => {
  it("drops a generic-title record with a weak record", () => {
    expect(
      isBogusPaperRecord({
        title: "Open Source",
        year: 2019,
        authors: ["M. Watson"],
        venue: "Definitions",
      }),
    ).toBe(true);
    expect(isBogusPaperRecord({ title: "", year: 2020, authors: ["A", "B"] })).toBe(true);
    expect(isBogusPaperRecord({ title: "Introduction", year: null, authors: [] })).toBe(true);
  });

  it("keeps real papers, short or without metadata", () => {
    expect(
      isBogusPaperRecord({
        title: "Deep learning",
        year: 2015,
        authors: ["Yann LeCun", "Yoshua Bengio", "Geoffrey Hinton"],
        venue: "Nature",
      }),
    ).toBe(false);
    expect(
      isBogusPaperRecord({
        title: "The Claude 3 Model Family: Opus, Sonnet, Haiku",
        year: null,
        authors: [],
      }),
    ).toBe(false);
    expect(isBogusPaperRecord({ title: "GPT-4 Technical Report", year: 2023, authors: [] })).toBe(
      false,
    );
    expect(isBogusPaperRecord({ title: "BLEU", year: 2001, authors: ["K. Papineni"] })).toBe(false);
    expect(isGenericTitle("Graph Attention Networks")).toBe(false);
    expect(isGenericTitle("Open Source")).toBe(true);
  });
});

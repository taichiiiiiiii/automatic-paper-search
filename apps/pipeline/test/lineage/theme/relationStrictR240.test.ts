/**
 * R2-40 (design 41 D-R2-40): a rule-based `extends` needs a STRONG cue that
 * governs the cited paper (build on / upon, extend X, variant / version /
 * adaptation of X, adapted from X, generalise X, improve upon X …). Weak
 * adoption cues (adopt / use / employ / leverage, follow(ing), based on,
 * inspired by, motivated by) never build on. Judged on every rule-decided
 * strong edge of the published CVPR 2025 and ICLR 2025 conference lineages
 * (`fixtures/relation-strict-eval-r240.json`) together with the R2-38
 * (ICML 2025 + 5 themes) and R2-39 (NeurIPS 2025) sets.
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
import { citedIdentity, cueGovernor } from "../../../src/lineage/classify/citedTarget.js";
import { isBogusPaperRecord } from "../../../src/lineage/shared/bogusRecord.js";
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
const r240 = load("relation-strict-eval-r240.json");
const r239 = load("relation-cue-target-eval-r239.json");
const r238 = load("relation-usage-eval-r238.json");
const all = [...r238, ...r239, ...r240];
const STRONG = new Set(["extends", "supersedes", "contrasts", "successor"]);
const AUDITED = [
  "flash-attention",
  "graph-neural-network",
  "mixture-of-experts",
  "vision-transformer",
];

const contextsOf = (i: EvalItem) =>
  (i.evidence_source === "arxiv_html" ? i.arxiv_html_contexts : i.s2.contexts) ?? [];

function signalsOf(item: EvalItem, contexts?: string[]): PairSignals {
  const html = item.evidence_source === "arxiv_html";
  const child = { title: item.citing.title, short_abstract: item.citing_abstract ?? undefined };
  return {
    found: true,
    intents: item.s2.intents ?? [],
    contexts: contexts ?? contextsOf(item),
    isInfluential: item.s2.is_influential,
    citingTitle: item.citing.title,
    citingSurvey: isSurveyLike(child),
    cited: { title: item.cited.title, year: item.cited.year, authors: item.cited.authors } as never,
    citingAbstract: html || contexts !== undefined ? null : citingAbstractOf(child),
  };
}

/** As in `relationUsageR238.test.ts`: the relation production derives. */
function predict(item: EvalItem): { relation: string; evidence: string | null } {
  if (item.method !== "s2_context_rule")
    return { relation: item.published_relation, evidence: null };
  const r = classifyS2Pair(signalsOf(item));
  const mapped =
    v1RelationFor(r.relation, { contrast: r.contrast, targetsCited: r.singleTarget }) ??
    "baseline_only";
  if (
    item.evidence_source === "arxiv_html" &&
    !(STRONG.has(mapped) && r.cue && r.quotable && !r.fromAbstract)
  )
    return { relation: "baseline_only", evidence: null };
  return { relation: mapped, evidence: r.evidence };
}

const kept = (i: EvalItem) => !isBogusPaperRecord(i.cited as Record<string, unknown>);
const scoped = (items: readonly EvalItem[]) =>
  items.filter((i) => i.method === "s2_context_rule" && kept(i));

function extendsScore(items: readonly EvalItem[], strict = false) {
  const preds = scoped(items).map((i) => ({ i, p: predict(i) }));
  const ext = preds.filter((x) => x.p.relation === "extends");
  const tp = ext.filter(
    (x) =>
      x.i.label === "genuine" &&
      (!strict ||
        !Array.isArray(x.i.genuine_evidence) ||
        x.i.genuine_evidence.some((g) => (x.p.evidence ?? "").includes(g))),
  ).length;
  return { predicted: ext.length, tp, precision: ext.length === 0 ? 1 : tp / ext.length };
}

function contrastsScore(items: readonly EvalItem[]) {
  const preds = scoped(items).map((i) => ({ i, p: predict(i) }));
  const con = preds.filter((x) => x.p.relation === "contrasts");
  const tp = con.filter(
    (x) => x.i.label === "genuine_contrast" || x.i.also_acceptable.includes("contrasts"),
  ).length;
  return { predicted: con.length, tp, precision: con.length === 0 ? 1 : tp / con.length };
}

const of = (c: string) => all.filter((i) => i.collection === c);

/** The fixture item whose contexts contain `sentence` (as a substring). */
function itemWith(sentence: string): EvalItem {
  const i = all.find((x) => contextsOf(x).some((c) => c.includes(sentence)));
  if (!i) throw new Error(`no fixture context contains: ${sentence}`);
  return i;
}

/** Classify the pair of `sentence`'s item with that sentence as its only context. */
function classifyAlone(sentence: string) {
  const item = itemWith(sentence);
  const full = contextsOf(item).find((c) => c.includes(sentence)) as string;
  return classifyS2Pair(signalsOf(item, [full]));
}

describe("R2-40 CVPR 2025 / ICLR 2025 strong-relation evaluation set", () => {
  it("labels every rule-decided strong edge of both lineages with real sentences", () => {
    expect(r240).toHaveLength(56);
    const by: Record<string, number> = {};
    for (const i of r240) {
      const k = `${i.collection} ${i.published_relation} ${i.label}`;
      by[k] = (by[k] ?? 0) + 1;
    }
    expect(by).toEqual({
      "cvpr-2025 extends genuine": 9,
      "cvpr-2025 extends usage": 20,
      "cvpr-2025 extends misattributed": 3,
      "cvpr-2025 contrasts genuine_contrast": 2,
      "iclr-2025 extends genuine": 3,
      "iclr-2025 extends usage": 13,
      "iclr-2025 extends other": 2,
      "iclr-2025 contrasts genuine_contrast": 3,
      "iclr-2025 contrasts other": 1,
    });
    for (const i of r240) {
      expect(contextsOf(i).length, i.citing.title).toBeGreaterThan(0);
      for (const g of i.genuine_evidence ?? []) {
        expect(
          contextsOf(i).some((c) => c.includes(g)),
          `${i.citing.title}: ${g}`,
        ).toBe(true);
      }
    }
  });

  it("published extends precision was 9/32 (CVPR) and 3/18 (ICLR)", () => {
    for (const [c, tp, n] of [
      ["cvpr-2025", 9, 32],
      ["iclr-2025", 3, 18],
    ] as const) {
      const ext = of(c).filter((i) => i.published_relation === "extends");
      expect(ext).toHaveLength(n);
      expect(ext.filter((i) => i.label === "genuine")).toHaveLength(tp);
    }
  });
});

describe("R2-40 precision on every collection", () => {
  it.each([
    ["cvpr-2025", 6],
    ["iclr-2025", 1],
    ["neurips-2025", 5],
    ["icml-2025", 2],
    ["audited themes", 8],
    ["low-rank-adaptation", 1],
  ] as const)("extends precision >= 0.9 on %s (at least %i correct)", (c, minTp) => {
    const items =
      c === "audited themes" ? all.filter((i) => AUDITED.includes(i.collection)) : of(c);
    const s = extendsScore(items);
    expect(s.precision).toBeGreaterThanOrEqual(0.9);
    expect(s.tp).toBeGreaterThanOrEqual(minTp);
    expect(extendsScore(items, true).precision).toBeGreaterThanOrEqual(0.9);
  });

  it("extends precision >= 0.9 on the union of the three sets", () => {
    expect(extendsScore(all).precision).toBeGreaterThanOrEqual(0.9);
    expect(extendsScore(all).tp).toBeGreaterThanOrEqual(20);
  });

  it.each(["cvpr-2025", "iclr-2025", "neurips-2025", "icml-2025"])(
    "contrasts precision >= 0.9 on %s",
    (c) => {
      expect(contrastsScore(of(c)).precision).toBeGreaterThanOrEqual(0.9);
    },
  );

  it("contrasts precision >= 0.9 on the union (LoRA's DyLoRA counting remark stays the one miss)", () => {
    const s = contrastsScore(all);
    expect(s.precision).toBeGreaterThanOrEqual(0.9);
    expect(s.predicted - s.tp).toBeLessThanOrEqual(1);
  });

  it("never gives extends to a usage, misattributed or other citation", () => {
    for (const i of scoped(all)) {
      if (!["usage", "misattributed", "self_ref", "third_party", "other"].includes(i.label))
        continue;
      expect(predict(i).relation, `${i.cited.title} -> ${i.citing.title}`).not.toBe("extends");
    }
  });

  it("CVPR / ICLR keep the contrasts the rules gave", () => {
    for (const i of r240.filter((x) => x.published_relation === "contrasts")) {
      expect(predict(i).relation, i.citing.title).toBe("contrasts");
    }
  });
});

describe("weak adoption cues never build on (real sentences)", () => {
  it.each([
    // R2-38 set (themes / ICML 2025)
    "Our approach is inspired by [54] who proposed a top-k gating in LSTMs",
    "Following [39], we place the MoEs on every other layer",
    "For image classification, we follow ViT [13] and DeiT [63] to append a learnable classification token",
    "We follow the FlashAttention algorithms in using e P for unnormalized shifted exponentials",
    "We adopt a ReAct-style agent (Yao et al., 2023a; Gu et al., 2024)",
    // R2-39 set (NeurIPS 2025)
    "We adopt GRPO [Shao et al., 2024] as the RL algorithm",
    "we adopt the semi-autoregressive denoising strategy introduced in LLaDA [22]",
    "Inspired by DeepSeek-R1-Zero [2], we design our prompt template",
    // R2-40 set (CVPR / ICLR 2025)
    "Inspired by GAN Loss [7], we employ an adaptive weighting mechanism.",
    "we adopt 3D Gaussian Splatting [25] for 3D reconstruction on curated videos.",
    "Following MASt3R [40], we apply a conﬁdence-aware regression loss",
    "we modify the Rotary Positional Embedding (RoPE) [59] to accommodate this integration.",
    "We adopt Depth Anything v3 (DAv3) [58], a feed-forward 3D foundation model",
    "we adapt IC-Light [57] into a zero-shot video diffusion model.",
    "Following DUSt3R [10], we apply a confidence-aware regression loss",
    "Specifically, we adopt CLIP ViT-L/14 [49] as our vision encoder",
  ])("%s", (sentence) => {
    const r = classifyAlone(sentence);
    expect(r.relation).not.toBe("builds_on");
  });

  it("a first-person weak cue on the cited paper is recorded as usage", () => {
    expect(classifyAlone("we adopt 3D Gaussian Splatting [25] for 3D reconstruction").rule).toBe(
      "phrase_usage",
    );
    expect(
      classifyAlone("we adapt IC-Light [57] into a zero-shot video diffusion model.").rule,
    ).toBe("phrase_usage");
  });
});

describe("strong cues that govern the cited paper still build on", () => {
  it.each([
    "Building upon VGGT [78]’s strong visual geometry reasoning capability",
    "Building on the success of VGGT [50], we propose a token-cached causal architecture",
    "Concretely, we build upon GEN3C (Ren et al., 2025)",
    "our work builds upon the powerful yet computationally intensive Foundation-Stereo [68].",
    "We extend visual instruction tuning (Liu et al., 2023) with a simple and efficient approach",
    "Specifically, we propose a new network architecture built upon the diffusion transformer (Peebles & Xie, 2023).",
    "We present the first adaptation of the MeanFlow (Geng et al. 2025) paradigm to robot learning",
  ])("%s", (sentence) => {
    const r = classifyAlone(sentence);
    expect(r.relation).toBe("builds_on");
    expect(r.rule).toBe("phrase_build");
  });
});

/** Identity of the cited paper of a fixture item (as production builds it). */
function idOf(citing: string, cited: string) {
  const i = all.find((x) => x.citing.title.startsWith(citing) && x.cited.title.startsWith(cited));
  if (!i) throw new Error(`no item ${cited} -> ${citing}`);
  return citedIdentity(i.cited as never, contextsOf(i));
}

const cue = (sentence: string, re: RegExp) => {
  const m = re.exec(sentence);
  if (!m) throw new Error(`no cue ${re} in ${sentence}`);
  return [m.index, m[0]] as const;
};

describe("cueGovernor (R2-40) on real CVPR 2025 sentences", () => {
  it("a participle that describes another work is not the citing paper's build-on", () => {
    const s =
      "For evaluation, we crop perspective videos from ground-truth panoramas and assess the model’s generation performance; (3) GenEx [33], a panoramic video generation model built upon stable video diffusion [5].";
    const [at, c] = cue(s, /built upon/);
    expect(cueGovernor(s, at, c, idOf("Matrix-3D", "Stable Video Diffusion"))).toBe("other");
  });

  it("a relative clause about other works is third party", () => {
    const s =
      "We also evaluate against Point3R [95] and StreamVGGT [106], which extend CUT3R and VGGT [87], respectively, to longer sequences by fine-tuning with explicit pointmap memory or KV-cache–based state representations.";
    const [at, c] = cue(s, /extend/);
    expect(cueGovernor(s, at, c, idOf("TTT3R", "VGGT"))).toBe("other");
  });

  it("what follows 'extend … with' is an instrument, unless the cited paper came first", () => {
    const s =
      "We extend the patch-level pathway with multi-modal DiT (MM-DiT) blocks [9] that fuse text and image semantics while leaving the pixel-level pathway unchanged.";
    const [at, c] = cue(s, /extend/);
    expect(cueGovernor(s, at, c, idOf("PixelDiT", "Scaling Rectified Flow"))).toBe("other");
    const s2 =
      "We extend visual instruction tuning (Liu et al., 2023) with a simple and efficient approach to train InstructVLA.";
    const [at2, c2] = cue(s2, /extend/);
    expect(cueGovernor(s2, at2, c2, idOf("InstructVLA", "Visual Instruction Tuning"))).toBe(
      "cited",
    );
  });

  it("a variant named in an apposition belongs to the work before it", () => {
    const s =
      "We use LightningDiT (Yao et al., 2025), a variant of DiT (Peebles & Xie, 2023), as our model backbone.";
    const [at, c] = cue(s, /variant of/);
    expect(
      cueGovernor(
        s,
        at,
        c,
        idOf("Diffusion Transformers with Representation", "Scalable Diffusion"),
      ),
    ).toBe("other");
  });
});

describe("usageReason (R2-40) for strong cues", () => {
  const none = { citedResource: false };
  it.each([
    [
      "Our visual generation architecture builds upon a pre-trained LLM model [53].",
      "released_model",
    ],
    [
      "For the monocular branch, we use the ViT-large version of DepthAnythingV2 [38] and freeze its parameters.",
      "released_model",
    ],
    [
      "We build on recent studies (Darcet et al., 2023; Kang et al., 2025a) which identify ”sink tokens”.",
      "finding",
    ],
  ])("%s -> %s", (sentence, reason) => {
    expect(usageReason(sentence, none)).toBe(reason);
  });

  it("a dataset paper is not built on, even under a strong cue", () => {
    const i = itemWith("build upon the well-established feature backbones studied on ImageNet");
    expect(predict(i).relation).toBe("baseline_only");
  });

  it("'generalization' alone and 'modification of <gerund>' are no build cues", () => {
    const hamster = r240.find((x) => x.citing.title.startsWith("PEEK")) as EvalItem;
    expect(predict(hamster).relation).toBe("contrasts");
    const dpt = itemWith("with the key modification of adopting a DPT head [37]");
    expect(predict(dpt).relation).toBe("baseline_only");
  });
});

describe("concessive while-contrasts (R2-40)", () => {
  it("need the cited paper inside the while-clause", () => {
    const mix = r239.find((x) => x.citing.title.startsWith("MixGRPO")) as EvalItem;
    expect(contextsOf(mix).some((c) => c.startsWith("While a common practice"))).toBe(true);
    expect(["extends", "contrasts"]).not.toContain(predict(mix).relation);
    const peek = r240.find((x) => x.citing.title.startsWith("PEEK")) as EvalItem;
    const p = predict(peek);
    expect(p.relation).toBe("contrasts");
    expect(p.evidence).toContain("While prior works predict paths");
  });
});

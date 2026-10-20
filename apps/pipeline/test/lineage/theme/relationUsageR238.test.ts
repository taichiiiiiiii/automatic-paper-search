/**
 * R2-38 (design 41): `extends` precision on the hand-labelled evaluation
 * set of every strong edge of the published ICML 2025 conference lineage
 * and the 5 theme lineages (`fixtures/relation-usage-eval-r238.json`).
 * A citation that only USES a benchmark / dataset / task / metric /
 * framework / tool / protocol is not a build-on; the rule set must say so
 * (rule `phrase_usage`, baseline_only). Since R2-40 only strong cues build
 * on, so the audited extends stated with a weak cue (follow / adopt /
 * inspired by …) are listed explicitly (their published files are not
 * regenerated).
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
    // Hi Robot -> MemER, π0 -> Hi Robot. R2-40: ReAct -> REMem (“we adopt a
    // ReAct-style agent”) is a weak cue and no longer extends.
    expect(icml.tp).toBe(2);
  });

  it("R2-40: changes an audited strong edge only where its sentence has a weak cue", () => {
    const audited = items.filter((i) => i.audited_verdict !== null);
    expect(audited.length).toBe(28);
    const changed = audited
      .filter((i) => predict(i) !== i.published_relation)
      .map(
        (i) => `${i.collection}: ${i.cited.title.slice(0, 24)} -> ${i.citing.title.slice(0, 24)}`,
      )
      .sort();
    // follow / inspired by / adopt / based on / motivated by: the published
    // files are not regenerated (design 41 R2-40); a future rebuild drops these.
    expect(changed).toEqual(
      [
        "flash-attention: FlashAttention-2: Faster -> Efficient FlashAttention",
        "mixture-of-experts: GShard: Scaling Giant Mo -> Scaling Vision with Spar",
        "mixture-of-experts: GShard: Scaling Giant Mo -> Switch Transformers: Sca",
        "mixture-of-experts: Outrageously Large Neura -> Mixture-of-Experts with ",
        "mixture-of-experts: Outrageously Large Neura -> Scaling Vision with Spar",
        "vision-transformer: An Image is Worth 16x16  -> Pyramid Vision Transform",
        "vision-transformer: An Image is Worth 16x16  -> Reversible Vision Transf",
        "vision-transformer: An Image is Worth 16x16  -> TransUNet: Transformers ",
        "vision-transformer: An Image is Worth 16x16  -> ViViT: A Video Vision Tr",
        "vision-transformer: Swin Transformer: Hierar -> Swin-Unet: Unet-Like Pur",
        "vision-transformer: Swin Transformer: Hierar -> SwinIR: Image Restoratio",
      ].sort(),
    );
    for (const i of audited) {
      if (predict(i) !== i.published_relation) expect(predict(i)).toBe("baseline_only");
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

describe("usageReason (R2-38) on real sentences with a strong cue", () => {
  const none = { citedResource: false };
  it("demotes a strong cue whose own object / subject is a resource", () => {
    expect(
      usageReason(
        "Due to computational constraints, we limited these extended experiments to three methods: LoRA[4], LoRA+[36], and LoRA-GA .",
        none,
      ),
    ).toBe("resource_object");
    expect(
      usageReason(
        "Based on such annotations, we find inter-annotator agreement to be Fleiss’ κ = 0.912, suggesting excellent agreement among annotators.",
        none,
      ),
    ).toBe("measurement");
  });

  it("R2-40: uses the cited paper's type also for a strong cue", () => {
    const s = "To address the problem, we build on X [3] in our pipeline.";
    expect(usageReason(s, { citedResource: true })).toBe("cited_resource");
    expect(usageReason(s, none)).toBeNull();
  });

  it.each([
    "Our method builds on the common hierarchical VLA paradigm, as in Shi et al. (2025), and extends it with the ability to tackle long-horizon tasks that require memory.",
    "As our architecture is adapted from Swin Transformer [28], our model can be initialized by its strong pre-trained model on a large-scale dataset.",
    "For the encoder, we build upon the vision transformer ViT [19] and consider ”Tiny”, ”Small”, ”Base” and ”Large” models described in Table 1.",
    "We use the “mean” variant of GRAPHSAGE [16] and apply a DIFFPOOL layer after every two GRAPHSAGE layers in our architecture.",
  ])("keeps a strong methodological cue: %s", (sentence) => {
    expect(usageReason(sentence, none)).toBeNull();
  });
});

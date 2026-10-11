/**
 * R2-24 (design 41): strong-claim precision/recall WITHOUT any LLM on the
 * R2-22 / R2-23 labelled sets, next to the replay with the cached
 * citation-context LLM answers (`relationPrecisionR222/R223.test.ts`).
 *
 * The context LLM could only confirm or downgrade a rule claim (R2-22).
 * Without it the rule result stands, so the question is which downgrades
 * mattered. On these sets: one — Hash Layers <- BASE Layers ("we adopt the
 * BASE Layer setup [10] and code base"), now a protocol rule (taking
 * another work's setup / code base is use, not a build). VR-GCN <-
 * GraphSAGE was already a protocol sentence under the R2-23 rules. The
 * one remaining difference is Shazeer <- Eigen: the rule's named "While
 * Eigen et al. … , our …" contrast stands (gold: a strong relation, kind
 * extends — the cached LLM's extends disagreed with the rule, which made
 * the edge baseline_only in LLM mode).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyS2Pair } from "../../../src/lineage/classify/apiRelations.js";
import type { DerivedEdge } from "../../../src/lineage/classify/classify.js";
import { CONTEXT_PROMPT_VERSION } from "../../../src/lineage/llm/contextPrompt.js";
import { guardRelation } from "../../../src/lineage/theme/relationGuard.js";
import { deriveS2Relation, newS2RelationStats } from "../../../src/lineage/theme/s2Relations.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) =>
  JSON.parse(
    readFileSync(join(here, `../../fixtures/lineage-eval/relation-precision-${n}.json`), "utf8"),
  );

interface Item {
  src: string;
  dst: string;
  cited: Record<string, unknown>;
  citing: Record<string, unknown>;
  published?: {
    relation: string;
    method: string;
    prompt_version: string | null;
    confidence: number;
    rationale: string;
  };
  s2: {
    found: boolean;
    intents: string[];
    contexts: string[];
    isInfluential: boolean | null;
  } | null;
  context_llm_answer?: Record<string, unknown> | null;
  gold: { strong: boolean | null; relation: string };
}

const STRONG = new Set(["extends", "successor", "supersedes", "contrasts", "ablation"]);
const key = (it: Item) => `${it.src}->${it.dst}`;

/** Replay one labelled edge; `llm` = with the cached context-LLM answer. */
async function replay(it: Item, llm: boolean): Promise<DerivedEdge> {
  type Paper = Parameters<typeof guardRelation>[1] & Record<string, unknown>;
  const parent = { ...it.cited, paperId: it.src } as Paper;
  const child = { ...it.citing, paperId: it.dst } as Paper;
  const pub: DerivedEdge | null = it.published
    ? {
        relation: it.published.relation as DerivedEdge["relation"],
        confidence: it.published.confidence,
        rationale: it.published.rationale,
        provenance: it.published.method,
        ...(it.published.method === "llm" && it.published.prompt_version === CONTEXT_PROMPT_VERSION
          ? { promptVersion: CONTEXT_PROMPT_VERSION }
          : {}),
      }
    : null;
  const m = it.published?.method;
  if (pub && (m === "title_version" || m === "foundational_allowlist")) {
    return guardRelation(pub, parent, child);
  }
  if (it.s2 !== null) {
    const answer = it.context_llm_answer ?? null;
    const provider = llm
      ? {
          name: "fixture",
          enabled: true,
          model: "fixture",
          completeJson: async () => (answer === null ? null : JSON.stringify(answer)),
        }
      : null;
    const signals = it.s2;
    const ctx = {
      source: { lookup: async () => ({ kind: "pair" as const, signals }) },
      provider,
      stats: newS2RelationStats(),
      batchSize: 1,
    };
    const edge = await deriveS2Relation(parent, child, ctx as never);
    if (edge !== null) return guardRelation(edge, parent, child);
  }
  // No S2 rule edge: an abstract-LLM published label is not reproducible
  // without the LLM; the no-LLM path gives at most a citation-only edge.
  if (pub && !(llm === false && pub.provenance === "llm")) return guardRelation(pub, parent, child);
  return { relation: "baseline_only", confidence: 0.5, rationale: "", provenance: "api_citation" };
}

async function score(items: Item[], llm: boolean) {
  const rows: { it: Item; e: DerivedEdge }[] = [];
  for (const it of items) rows.push({ it, e: await replay(it, llm) });
  const strong = rows.filter((r) => STRONG.has(r.e.relation) && r.it.gold.strong !== null);
  return {
    rows,
    predicted: strong.length,
    correct: strong.filter((r) => r.it.gold.strong === true).length,
    exactKind: strong.filter(
      (r) => r.it.gold.strong === true && r.e.relation === r.it.gold.relation,
    ).length,
    goldStrong: rows.filter((r) => r.it.gold.strong === true).length,
    falsePositives: strong.filter((r) => r.it.gold.strong !== true).map((r) => key(r.it)),
  };
}

const SHAZEER_EIGEN = "openalex:W1593114658->openalex:W2581624817";

describe("R2-24: strong claims without any LLM (labelled sets)", () => {
  it("R2-22 set: precision 1.0 in both modes; no LLM recalls 22/31 (LLM 21/31)", async () => {
    const items = fixture("r222").edges as Item[];
    const withLlm = await score(items, true);
    const noLlm = await score(items, false);
    expect(withLlm.falsePositives).toEqual([]);
    expect(noLlm.falsePositives).toEqual([]);
    expect([withLlm.correct, noLlm.correct, noLlm.goldStrong]).toEqual([21, 22, 31]);
  });

  it("R2-23 set: precision 1.0 in both modes; no LLM recalls 26/32 (LLM 25/32)", async () => {
    const items = fixture("r223").edges as Item[];
    const withLlm = await score(items, true);
    const noLlm = await score(items, false);
    expect(withLlm.falsePositives).toEqual([]);
    expect(noLlm.falsePositives).toEqual([]);
    expect([withLlm.correct, noLlm.correct, noLlm.goldStrong]).toEqual([25, 26, 32]);
    // The only difference: Shazeer <- Eigen, a strong claim either way in
    // the gold labels, read as the rule's named contrast (gold kind: extends).
    const diff = noLlm.rows
      .filter((r, i) => r.e.relation !== withLlm.rows[i]?.e.relation)
      .map((r) => `${key(r.it)}:${r.e.relation}`);
    expect(diff).toEqual([`${SHAZEER_EIGEN}:contrasts`]);
    expect(noLlm.exactKind).toBe(withLlm.exactKind);
  });

  it("R2-23 rule cases: identical in both modes (7/7, the known MAE false positive)", async () => {
    const items = fixture("r223").rule_cases as Item[];
    const withLlm = await score(items, true);
    const noLlm = await score(items, false);
    expect([noLlm.correct, noLlm.goldStrong, noLlm.falsePositives.length]).toEqual([7, 7, 1]);
    expect(noLlm.rows.map((r) => r.e.relation)).toEqual(withLlm.rows.map((r) => r.e.relation));
  });

  it("the second review's false claims stay baseline_only without the LLM", async () => {
    const items = (fixture("r223").edges as Item[]).filter((i) => i.gold.strong === false);
    expect((await score(items, false)).predicted).toBe(0);
  });
});

describe("R2-24 rule: adopting another work's setup / code base is use, not a build", () => {
  const cited = { title: "BASE Layers: Simplifying Training of Large, Sparse Models", year: 2021 };
  const ctx = (s: string) => ({
    found: true,
    intents: ["methodology"],
    contexts: [s],
    isInfluential: true,
    cited,
    citingTitle: "Hash Layers For Large Sparse Models",
  });
  it("Hash Layers <- BASE Layers (the context-LLM downgrade R2-22 relied on)", () => {
    const r = classifyS2Pair(
      ctx(
        "28B parameters, to test our methods at scale on larger sparse models, we adopt the BASE Layer setup [10] and code base2 instead where we compare 4.",
      ),
    );
    expect(r.relation).not.toBe("builds_on");
    expect(r.rule).toBe("phrase_protocol");
  });
  it("a genuine build cue still reads as builds_on", () => {
    const r = classifyS2Pair(
      ctx("We build on BASE Layers [10] and replace its assignment with hashing."),
    );
    expect(r.relation).toBe("builds_on");
  });
});

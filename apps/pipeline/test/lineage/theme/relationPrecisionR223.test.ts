/**
 * R2-23: quote-backed recall of strong claims at R2-22 precision (design 41
 * D5) on `test/fixtures/lineage-eval/relation-precision-r223.json`:
 *  - `edges`: the R2-22 labelled edges with Semantic Scholar signals at the
 *    R2-23 cap (<= 12 contexts per pair, refetched) and full citing
 *    abstracts, re-judged where the newly visible sentences back a claim,
 *    plus Switch -> Expert Choice;
 *  - `rule_cases`: hand-judged pairs from the refetched reference lists
 *    where the R2-23 rules change a strong claim (selected from that diff,
 *    so they over-represent hard cases).
 * Replayed through the production path offline, like the R2-22 test.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DerivedEdge } from "../../../src/lineage/classify/classify.js";
import { CONTEXT_PROMPT_VERSION } from "../../../src/lineage/llm/contextPrompt.js";
import { guardRelation } from "../../../src/lineage/theme/relationGuard.js";
import { deriveS2Relation, newS2RelationStats } from "../../../src/lineage/theme/s2Relations.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "../../fixtures/lineage-eval/relation-precision-r223.json");

interface Item {
  theme: string;
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
  gold: {
    strong: boolean | null;
    relation: string;
    quote_backed: boolean;
    quote: string | null;
    note: string;
  };
}

const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as { edges: Item[]; rule_cases: Item[] };
const STRONG = new Set(["extends", "successor", "supersedes", "contrasts", "ablation"]);
const key = (it: Item) => `${it.src}->${it.dst}`;

async function replay(it: Item): Promise<DerivedEdge> {
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
    const provider = {
      name: "fixture",
      enabled: true,
      model: "fixture",
      completeJson: async () => (answer === null ? null : JSON.stringify(answer)),
    };
    const signals = it.s2;
    const ctx = {
      source: { lookup: async () => ({ kind: "pair" as const, signals }) },
      provider: provider as never,
      stats: newS2RelationStats(),
      batchSize: 1,
    };
    const edge = await deriveS2Relation(parent, child, ctx as never);
    if (edge !== null) return guardRelation(edge, parent, child);
  }
  if (pub) return guardRelation(pub, parent, child);
  return {
    relation: "baseline_only",
    confidence: 0,
    rationale: "",
    provenance: "none",
  } as DerivedEdge;
}

async function run(items: Item[]) {
  const rows: { it: Item; e: DerivedEdge; strong: boolean }[] = [];
  for (const it of items) {
    const e = await replay(it);
    rows.push({ it, e, strong: STRONG.has(e.relation) });
  }
  const judged = rows.filter((r) => r.strong && r.it.gold.strong !== null);
  return {
    rows,
    predicted: judged.length,
    correct: judged.filter((r) => r.it.gold.strong === true).length,
    goldStrong: rows.filter((r) => r.it.gold.strong === true).length,
    falsePositives: judged.filter((r) => r.it.gold.strong !== true).map((r) => key(r.it)),
    misses: rows.filter((r) => !r.strong && r.it.gold.strong === true).map((r) => key(r.it)),
  };
}

describe("R2-23 strong-claim recall on the refreshed labelled set", () => {
  it("fixture shape: R2-22 edges + 1 new edge, rule cases, quotes for every quote-backed label", () => {
    expect(fx.edges.length).toBe(59);
    expect(fx.rule_cases.length).toBeGreaterThanOrEqual(15);
    for (const it of [...fx.edges, ...fx.rule_cases]) {
      if (it.gold.quote_backed && it.published?.method !== "title_version") {
        expect(it.gold.quote, key(it)).toBeTruthy();
      }
      if (it.s2) expect(it.s2.contexts.length, key(it)).toBeLessThanOrEqual(12);
    }
  });

  it("published edges: precision stays 1.0, recall 25/32 (R2-22 rules on the same signals: 23/32)", async () => {
    const p = await run(fx.edges);
    expect(p.falsePositives).toEqual([]);
    expect(p.correct).toBe(25);
    expect(p.goldStrong).toBe(32);
    // Every strong claim is backed by a quote, the titles or the allowlist.
    for (const r of p.rows.filter((x) => x.strong)) {
      const m = r.e.provenance;
      expect(
        r.it.gold.quote_backed || m === "title_version" || m === "foundational_allowlist",
        key(r.it),
      ).toBe(true);
    }
    // The remaining misses have no usable sentence (no context, publisher-
    // elided references, multi-paper marker groups) — except Shazeer <-
    // Eigen, whose rule contrast is vetoed by the cached LLM's extends.
    expect(p.misses.sort()).toEqual(
      [
        "openalex:W4281758439->openalex:W4388327470", // FlashDecoding++ <- FlashAttention
        "openalex:W1593114658->openalex:W2581624817", // Shazeer <- Eigen (rule/LLM disagree)
        "openalex:W1593114658->openalex:W2809290718", // MMoE <- Eigen (elided references)
        "openalex:W2581624817->openalex:W2809290718", // MMoE <- Shazeer (elided references)
        "openalex:W2809290718->openalex:W4390873360", // AdaMV-MoE <- MMoE (elided references)
        "openalex:W3122317902->openalex:W3119866685", // Switch <- GShard (no contexts)
        "openalex:W4226079124->openalex:W4390873360", // AdaMV-MoE <- Expert Choice
      ].sort(),
    );
  });

  it("the false claims of the second review stay baseline_only", async () => {
    const p = await run(fx.edges.filter((i) => i.gold.strong === false));
    expect(p.predicted).toBe(0);
  });

  it("rule cases: 7/7 hand-judged positives, one known false positive", async () => {
    const p = await run(fx.rule_cases);
    expect(p.misses).toEqual([]);
    expect(p.correct).toBe(7);
    // "Following [15], we adopt an extra BatchNorm layer" (MAE): an
    // implementation detail the build cue cannot tell from a design
    // adoption ("Following [39], we place the MoEs on every other layer").
    expect(p.falsePositives).toHaveLength(1);
    expect(p.falsePositives[0]).toBe(
      "s2:fc1b1c9364c58ec406f494dd944b609a6a038ba6->openalex:W4226002507",
    );
  });
});

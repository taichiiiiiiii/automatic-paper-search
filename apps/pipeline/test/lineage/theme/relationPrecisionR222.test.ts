/**
 * R2-22: strong-claim precision on the labelled set built from the
 * published lineages (`test/fixtures/lineage-eval/relation-precision-r222.json`,
 * 58 edges: every published extends/successor/supersedes/contrasts edge of
 * the four themes with the R2-8 audit-draft and R2-21 hand-check verdicts,
 * plus hard rule cases). Each edge is replayed through the PRODUCTION path
 * offline — the title-version / allowlist edges as published, Semantic
 * Scholar pairs through `deriveS2Relation` with the stored S2 signals and
 * the stored (cached) citation-context LLM answer, everything else through
 * `guardRelation` on its published classification — and the published
 * strong claims must be right and quote-backed (design 41 D5).
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
const FIXTURE = join(here, "../../fixtures/lineage-eval/relation-precision-r222.json");

interface Item {
  theme: string;
  src: string;
  dst: string;
  cited: Record<string, unknown>;
  citing: Record<string, unknown>;
  published: {
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
  context_llm_answer: Record<string, unknown> | null;
  gold: {
    strong: boolean | null;
    relation: string;
    quote_backed: boolean;
    quote: string | null;
    note: string;
  };
}

const items = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { edges: Item[] }).edges;
const STRONG = new Set(["extends", "successor", "supersedes", "contrasts", "ablation"]);

function publishedDerived(it: Item): DerivedEdge {
  return {
    relation: it.published.relation as DerivedEdge["relation"],
    confidence: it.published.confidence,
    rationale: it.published.rationale,
    provenance: it.published.method,
    ...(it.published.method === "llm" && it.published.prompt_version === CONTEXT_PROMPT_VERSION
      ? { promptVersion: CONTEXT_PROMPT_VERSION }
      : {}),
  };
}

/** The production decision for one fixture edge, offline. */
async function replay(it: Item): Promise<DerivedEdge> {
  type Paper = Parameters<typeof guardRelation>[1] & Record<string, unknown>;
  const parent = { ...it.cited, paperId: it.src } as Paper;
  const child = { ...it.citing, paperId: it.dst } as Paper;
  // Decided before the S2 path in `bfs.ts::classifyPair` / the BFS.
  if (it.published.method === "title_version" || it.published.method === "foundational_allowlist") {
    return guardRelation(publishedDerived(it), parent, child);
  }
  if (it.s2 !== null) {
    const answer = it.context_llm_answer;
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
  return guardRelation(publishedDerived(it), parent, child);
}

function precision(rows: { predicted: string; it: Item }[]) {
  const judged = rows.filter((r) => STRONG.has(r.predicted) && r.it.gold.strong !== null);
  const correct = judged.filter((r) => r.it.gold.strong === true).length;
  const goldStrong = rows.filter((r) => r.it.gold.strong === true).length;
  return { predicted: judged.length, correct, goldStrong };
}

describe("R2-22 strong-claim precision on the labelled set", () => {
  it("fixture shape: ~60 labelled edges over the four themes, quotes kept", () => {
    expect(items.length).toBeGreaterThanOrEqual(55);
    expect(new Set(items.map((i) => i.theme)).size).toBe(4);
    for (const it of items) {
      if (it.gold.quote_backed && it.published.method !== "title_version") {
        expect(it.gold.quote, `${it.src}->${it.dst}`).toBeTruthy();
      }
    }
  });

  it("published (before): many strong claims are wrong", () => {
    const p = precision(items.map((it) => ({ predicted: it.published.relation, it })));
    // 29 of 48 judged published strong claims are right.
    expect(p.correct).toBe(29);
    expect(p.predicted).toBe(48);
  });

  it("after R2-22: every published strong claim is right, and backed by a quote, the titles or the allowlist", async () => {
    const rows: { predicted: string; method: string; it: Item }[] = [];
    for (const it of items) {
      const e = await replay(it);
      rows.push({ predicted: e.relation, method: e.provenance, it });
    }
    const p = precision(rows);
    expect(p.correct).toBe(p.predicted);
    expect(p.predicted).toBe(19);
    for (const r of rows.filter((x) => STRONG.has(x.predicted))) {
      const ok =
        r.it.gold.quote_backed ||
        r.method === "foundational_allowlist" ||
        r.method === "title_version";
      expect(ok, `${r.it.src}->${r.it.dst} (${r.method})`).toBe(true);
    }
    // Every quote-backed correct claim survives (recall on what D5 allows).
    for (const it of items.filter((i) => i.gold.strong === true && i.gold.quote_backed)) {
      const row = rows.find((r) => r.it === it);
      expect(STRONG.has(row?.predicted ?? ""), `${it.src}->${it.dst}`).toBe(true);
    }
  });

  it("the named false claims of the second review are baseline_only", async () => {
    const wrong = items.filter((i) => i.gold.strong === false);
    expect(wrong.length).toBeGreaterThanOrEqual(25);
    for (const it of wrong) {
      const e = await replay(it);
      expect(e.relation, `${it.theme}: ${it.cited.title} -> ${it.citing.title}`).toBe(
        "baseline_only",
      );
    }
  });
});

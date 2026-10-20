/**
 * R2-28: strong claims from arXiv HTML citation contexts on the labelled
 * set (`test/fixtures/lineage-eval/relation-precision-r228.json`): every
 * R2-23 labelled pair whose S2 contexts are empty / missing and whose
 * citing paper's arXiv HTML had sentences for the cited paper, with the
 * recorded sentences. Replayed through the production path
 * (`deriveS2Relation` + `guardRelation`, no LLM) with an arXiv HTML source
 * that answers from the fixture.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DerivedEdge } from "../../../src/lineage/classify/classify.js";
import { guardRelation } from "../../../src/lineage/theme/relationGuard.js";
import { deriveS2Relation, newS2RelationStats } from "../../../src/lineage/theme/s2Relations.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "../../fixtures/lineage-eval/relation-precision-r228.json");

interface Item {
  src: string;
  dst: string;
  cited: Record<string, unknown>;
  citing: Record<string, unknown>;
  published?: { relation: string; method: string; confidence: number; rationale: string };
  s2: {
    found: boolean;
    intents: string[];
    contexts: string[];
    isInfluential: boolean | null;
  } | null;
  gold: { strong: boolean | null; relation: string };
  arxiv_html: { id: string; version: string | null; bib: string; contexts: string[] };
}

const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as { items: Item[] };
const STRONG = new Set(["extends", "successor", "supersedes", "contrasts", "ablation"]);
const key = (it: Item) => `${it.cited.title as string} <- ${it.citing.title as string}`;

async function replay(it: Item, withHtml: boolean): Promise<DerivedEdge | null> {
  const parent = { ...it.cited, paperId: it.src } as Record<string, unknown>;
  const child = { ...it.citing, paperId: it.dst } as Record<string, unknown>;
  const ctx = {
    source: {
      lookup: async () =>
        it.s2 === null
          ? { kind: "no_s2_data", reason: "citing-not-in-s2" }
          : { kind: "pair", signals: it.s2 },
      arxivIdOf: async () => it.arxiv_html.id,
    },
    provider: null,
    stats: newS2RelationStats(),
    arxivHtml: withHtml
      ? {
          contexts: async () => ({ kind: "contexts", ...it.arxiv_html, arxiv: it.arxiv_html.id }),
          stats: { strongEdges: 0 },
        }
      : null,
  };
  const edge = await deriveS2Relation(parent as never, child as never, ctx as never);
  if (edge !== null) return guardRelation(edge, parent as never, child as never);
  // bfs.classifyPair falls through to the allowlist / api_citation path.
  return it.published
    ? guardRelation(
        {
          relation: it.published.relation as DerivedEdge["relation"],
          confidence: it.published.confidence,
          rationale: it.published.rationale,
          provenance: it.published.method as DerivedEdge["provenance"],
        },
        parent as never,
        child as never,
      )
    : null;
}

describe("R2-28 arXiv HTML contexts on the labelled set", () => {
  it("fixture: only pairs S2 had no usable sentence for, recorded sentences within the cap", () => {
    expect(fx.items.length).toBe(10);
    for (const it of fx.items) {
      expect(it.s2 === null || !it.s2.found || it.s2.contexts.length === 0, key(it)).toBe(true);
      expect(it.arxiv_html.contexts.length).toBeGreaterThan(0);
      expect(it.arxiv_html.contexts.length).toBeLessThanOrEqual(12);
      for (const c of it.arxiv_html.contexts) expect(Array.from(c).length).toBeLessThanOrEqual(400);
    }
  });

  it("every strong claim from HTML is labelled correct; precision kept (R2-40: Segmenter only)", async () => {
    const fromHtml: string[] = [];
    let strongBefore = 0;
    let strongAfter = 0;
    for (const it of fx.items) {
      const before = await replay(it, false);
      const after = await replay(it, true);
      if (before && STRONG.has(before.relation)) strongBefore += 1;
      if (after && STRONG.has(after.relation)) {
        strongAfter += 1;
        expect(it.gold.strong, key(it)).not.toBe(false);
      }
      if (after?.evidence?.source === "arxiv_html") {
        fromHtml.push(key(it));
        expect(STRONG.has(after.relation)).toBe(true);
        expect(after.rationale).toMatch(
          /（arXiv HTML（arXiv:\d{4}\.\d{4,5}v\d+）の本文の引用文から規則で判定）。引用文: "/,
        );
        expect(it.gold.strong, key(it)).toBe(true);
      }
    }
    // R2-40: the HTML sentences of PVT (“we follow ViT [13] and DeiT”),
    // RevViT (“Following ViT [15]”) and Switch <- GShard (“…, which we also
    // follow”) are weak cues; the two ViT pairs stay allowlist edges and
    // Switch <- GShard gets no strong claim. Segmenter's strong cue remains.
    expect(fromHtml.map((k) => k.split(" <- ")[1]?.slice(0, 20)).sort()).toEqual([
      "Segmenter: Transform",
    ]);
    expect(strongAfter - strongBefore).toBe(0);
  });

  it("a comparison sentence naming the cited paper is not a build cue (ARMA <- CayleyNets)", async () => {
    const arma = fx.items.find((it) => (it.cited.title as string).startsWith("CayleyNets"));
    expect(arma?.arxiv_html.contexts.join(" ")).toMatch(/comparing the proposed ARMA layer with/);
    const e = await replay(arma as Item, true);
    expect(e === null || !STRONG.has(e.relation)).toBe(true);
  });
});

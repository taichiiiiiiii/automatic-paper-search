/**
 * #455: gold set of the strong relations (extends / contrasts) published on
 * 2026-11-01, each read by hand against its quoted sentence (93 edges: 72
 * correct, 5 wrong, 7 unclear, 9 from the foundation-paper rule, which has no
 * sentence). The sentence is replayed through the *current* rules:
 *  - a wrong edge must not replay as a strong relation;
 *  - of the replayed strong relations, at least 90% must be correct (the
 *    unclear ones count against it) — the precision target of the loop;
 *  - a correct edge may only fall out of the strong set if it is listed in
 *    `REPLAY_GAPS` (the replay has no intents / abstracts, so a few published
 *    edges rest on signals it cannot see).
 * New wrong edges found by the improvement loop are added to the JSON file.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyS2Pair, v1RelationFor } from "../../../src/lineage/classify/apiRelations.js";
import { isSurveyLike } from "../../../src/lineage/shared/surveyLike.js";

interface GoldEdge {
  id: number;
  theme: string;
  published: "extends" | "contrasts";
  cited: { title: string; year: number | null; authors: string[] };
  citing: string;
  sentence: string | null;
  label: "correct" | "wrong" | "unclear" | "rule_based";
  note: string;
}

const GOLD = JSON.parse(
  readFileSync(new URL("./fixtures/strong-edge-gold-v1.json", import.meta.url), "utf8"),
) as { edges: GoldEdge[] };

/** Correct edges whose published relation rests on signals the replay lacks. */
const REPLAY_GAPS = new Set<number>([
  25, 26, 45, 61, 62, 64, 69, 70, 72, 73, 75, 82, 85, 86, 90, 93,
]);
/** Wrong edges the rules cannot tell apart yet (documented gaps). */
const KNOWN_WRONG_GAPS = new Set<number>([
  16, // “an extension of GRPO (Qi et al., 2025)”: needs a name→paper alias table
]);

function replay(e: GoldEdge): string {
  const r = classifyS2Pair({
    found: true,
    intents: [],
    contexts: [e.sentence as string],
    isInfluential: false,
    citingTitle: e.citing,
    citingSurvey: isSurveyLike({ title: e.citing }),
    cited: { title: e.cited.title, year: e.cited.year, authors: e.cited.authors } as never,
    citingAbstract: null,
  });
  return (
    v1RelationFor(r.relation, { contrast: r.contrast, targetsCited: r.singleTarget }) ??
    "baseline_only"
  );
}

const withSentence = GOLD.edges.filter((e) => e.sentence);
const replayed = withSentence.map((e) => ({ e, now: replay(e) }));

describe("strong-edge gold set (#455)", () => {
  it("has the expected shape", () => {
    expect(GOLD.edges.length).toBe(93);
    // Without a quoted sentence the edge rests on the foundation-paper rule or an abstract.
    expect(
      GOLD.edges
        .filter((e) => !e.sentence)
        .every((e) => e.label === "rule_based" || e.label === "correct"),
    ).toBe(true);
  });

  it("no edge read as wrong replays as a strong relation", () => {
    const bad = replayed.filter(
      ({ e, now }) => e.label === "wrong" && now !== "baseline_only" && !KNOWN_WRONG_GAPS.has(e.id),
    );
    expect(bad.map(({ e }) => `${e.id} ${e.citing}: ${e.note}`)).toEqual([]);
  });

  it("correct edges stay strong (except listed replay gaps)", () => {
    const lost = replayed.filter(
      ({ e, now }) => e.label === "correct" && now === "baseline_only" && !REPLAY_GAPS.has(e.id),
    );
    expect(lost.map(({ e }) => `${e.id} ${e.citing}`)).toEqual([]);
  });

  it("precision of the replayed strong relations is at least 0.9", () => {
    const strong = replayed.filter(({ now }) => now !== "baseline_only");
    const correct = strong.filter(({ e }) => e.label === "correct").length;
    const precision = correct / strong.length;
    console.info(
      `strong-edge gold: ${correct}/${strong.length} correct (precision ${precision.toFixed(3)})`,
    );
    expect(precision).toBeGreaterThanOrEqual(0.9);
  });
});

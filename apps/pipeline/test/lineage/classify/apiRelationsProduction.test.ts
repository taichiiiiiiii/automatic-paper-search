/**
 * R2-10 (design 41 D6): rule set v2 in production — routing facts
 * (`classifyS2Pair`), the citation-target counter and the mapping onto the
 * v1 relation enum, replayed over the R2-9 hand-checked fixture.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ApiRelation,
  CUE_RULES,
  citationTargetCount,
  classifyS2Pair,
  type PairSignals,
  v1RelationFor,
} from "../../../src/lineage/classify/apiRelations.js";
import * as evalModule from "../../../src/lineage/eval/apiRelations.js";

const base: PairSignals = { found: true, intents: [], contexts: [], isInfluential: false };

describe("citationTargetCount", () => {
  it("counts numeric, range, author-year and narrative citations", () => {
    expect(citationTargetCount("Unlike [5], we use no convolutions.")).toBe(1);
    expect(citationTargetCount("Prior work [3, 7, 12] studies this.")).toBe(3);
    expect(citationTargetCount("Several methods [3]-[5], [9] exist.")).toBe(4);
    expect(citationTargetCount("Methods [3-5] exist.")).toBe(3);
    expect(citationTargetCount("as in (Smith et al., 2020; Lee and Kim, 2021).")).toBe(2);
    expect(citationTargetCount("Unlike Kipf and Welling (2017), we sample neighbours.")).toBe(1);
    expect(citationTargetCount("Unlike GraphSAGE, we sample neighbours.")).toBe(0);
    // Bracketed text that is not a citation list is ignored.
    expect(citationTargetCount("a vector [x, y] of features [4]")).toBe(1);
  });
});

describe("classifyS2Pair", () => {
  it("is v2 plus cue / influential / single-target facts", () => {
    const r = classifyS2Pair({
      ...base,
      isInfluential: true,
      contexts: ["Unlike [5], we use no convolutions."],
    });
    expect(r).toMatchObject({
      relation: "compares_with",
      rule: "phrase_contrast",
      contrast: true,
      cue: true,
      influential: true,
      singleTarget: true,
    });
    const multi = classifyS2Pair({ ...base, contexts: ["Unlike [3, 5], we use no convolutions."] });
    expect(multi.singleTarget).toBe(false);
    const bg = classifyS2Pair({ ...base, contexts: ["GNNs are popular [2]."] });
    expect(bg).toMatchObject({ relation: "background", cue: false, influential: false });
    expect(classifyS2Pair({ ...base, found: false }).relation).toBe("cites_unspecified");
  });

  it("treats phrase rules and table rows as cues, intents and defaults as not", () => {
    expect([...CUE_RULES].sort()).toEqual(
      ["phrase_build", "phrase_compare", "phrase_contrast", "phrase_resource", "table_row"].sort(),
    );
    expect(classifyS2Pair({ ...base, intents: ["result"], contexts: ["x [1]."] }).cue).toBe(false);
  });

  it("is re-exported unchanged by the evaluation module", () => {
    expect(evalModule.classifyApiRelationV2).toBeTypeOf("function");
    expect(evalModule.classifyS2Pair).toBe(classifyS2Pair);
  });
});

describe("v1RelationFor (design 43 §9 案 A)", () => {
  it("maps builds_on to extends and background/resource to baseline_only", () => {
    const o = { contrast: false, targetsCited: true };
    expect(v1RelationFor("builds_on", o)).toBe("extends");
    expect(v1RelationFor("uses_resource", o)).toBe("baseline_only");
    expect(v1RelationFor("background", o)).toBe("baseline_only");
  });

  it("gives contrasts only for a contrast cue that targets the cited paper", () => {
    expect(v1RelationFor("compares_with", { contrast: true, targetsCited: true })).toBe(
      "contrasts",
    );
    expect(v1RelationFor("compares_with", { contrast: true, targetsCited: false })).toBe(
      "baseline_only",
    );
    expect(v1RelationFor("compares_with", { contrast: false, targetsCited: true })).toBe(
      "baseline_only",
    );
  });

  it("leaves cites_unspecified to the caller's heuristic", () => {
    expect(v1RelationFor("cites_unspecified", { contrast: false, targetsCited: false })).toBeNull();
  });

  it("over the hand-checked fixture, never emits contrasts from a multi-citation sentence", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, "../../fixtures/lineage-eval/api-relations-handcheck.json"),
        "utf-8",
      ),
    ) as { edges: { signals: PairSignals; gold: string }[] };
    const counts: Record<string, number> = {};
    for (const e of fixture.edges) {
      const r = classifyS2Pair(e.signals);
      const mapped = v1RelationFor(r.relation as ApiRelation, {
        contrast: r.contrast,
        targetsCited: r.singleTarget,
      });
      counts[String(mapped)] = (counts[String(mapped)] ?? 0) + 1;
      if (mapped === "contrasts") expect(citationTargetCount(r.evidence ?? "")).toBe(1);
      // Every inheriting rule result is extends, and nothing else is.
      expect(mapped === "extends").toBe(r.relation === "builds_on");
    }
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(fixture.edges.length);
  });
});

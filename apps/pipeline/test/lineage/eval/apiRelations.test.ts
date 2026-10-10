import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyApiRelation,
  classifyApiRelationV2,
  coarse,
  llmToSimplified,
  type PairSignals,
} from "../../../src/lineage/eval/apiRelations.js";

const base: PairSignals = { found: true, intents: [], contexts: [], isInfluential: false };

describe("classifyApiRelation", () => {
  it("returns cites_unspecified when S2 has no record of the pair", () => {
    expect(classifyApiRelation({ ...base, found: false }).relation).toBe("cites_unspecified");
    expect(classifyApiRelation(base).rule).toBe("s2_no_context");
  });

  it("prefers build phrases over comparison phrases in the same contexts", () => {
    const r = classifyApiRelation({
      ...base,
      contexts: [
        "We compare with GCN [3].",
        "Our model builds on the spectral convolution of [3].",
      ],
    });
    expect(r.relation).toBe("builds_on");
    expect(r.rule).toBe("phrase_build");
    expect(r.evidence).toContain("builds on");
  });

  it("maps contrast and comparison cues to compares_with", () => {
    expect(
      classifyApiRelation({ ...base, contexts: ["Unlike [5], we use no convolutions."] }),
    ).toMatchObject({ relation: "compares_with", rule: "phrase_contrast", contrast: true });
    expect(
      classifyApiRelation({ ...base, contexts: ["Our method outperforms GraphSAGE [12]."] }).rule,
    ).toBe("phrase_compare");
  });

  it("detects resource use only with both a resource noun and a usage verb", () => {
    expect(
      classifyApiRelation({ ...base, contexts: ["We train on the ImageNet dataset [7]."] })
        .relation,
    ).toBe("uses_resource");
    expect(classifyApiRelation({ ...base, contexts: ["ImageNet dataset [7]."] }).relation).toBe(
      "background",
    );
  });

  it("v2: surveys are background; comparison phrases need a first-person subject", () => {
    expect(
      classifyApiRelationV2({
        ...base,
        citingTitle: "Deep Learning on Graphs: A Survey",
        contexts: ["Our model builds on [3]."],
      }).rule,
    ).toBe("citing_survey");
    expect(
      classifyApiRelationV2({ ...base, contexts: ["X outperforms prior work [4, 5, 6]."] })
        .relation,
    ).toBe("background");
    expect(
      classifyApiRelationV2({ ...base, contexts: ["Our method outperforms GraphSAGE [12]."] }).rule,
    ).toBe("phrase_compare");
    expect(
      classifyApiRelationV2({
        ...base,
        intents: ["methodology"],
        isInfluential: false,
        contexts: ["[3]"],
      }).relation,
    ).toBe("background");
    expect(
      classifyApiRelationV2({
        ...base,
        intents: ["methodology"],
        isInfluential: true,
        contexts: ["[3]"],
      }).rule,
    ).toBe("intent_methodology_influential");
  });

  it("falls back to intents, then isInfluential, then shared authors", () => {
    expect(classifyApiRelation({ ...base, intents: ["methodology"] }).rule).toBe(
      "intent_methodology",
    );
    expect(classifyApiRelation({ ...base, intents: ["result"] }).relation).toBe("compares_with");
    expect(
      classifyApiRelation({ ...base, intents: ["background"], isInfluential: true }).rule,
    ).toBe("influential");
    expect(classifyApiRelation({ ...base, sharedAuthors: true }).rule).toBe("shared_authors");
    expect(classifyApiRelation({ ...base, intents: ["background"] }).relation).toBe("background");
  });
});

describe("llmToSimplified / coarse", () => {
  it("projects the LLM enum onto inherit / not-inherit", () => {
    for (const r of ["supersedes", "successor", "extends", "ablation"]) {
      expect(coarse(llmToSimplified(r))).toBe("inherit");
    }
    expect(coarse(llmToSimplified("baseline_only"))).toBe("not_inherit");
    expect(coarse(llmToSimplified("contrasts"))).toBe("not_inherit");
    expect(coarse(llmToSimplified("unrelated"))).toBe("unknown");
  });
});

describe("hand-check fixture", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(__dirname, "../../fixtures/lineage-eval/api-relations-handcheck.json"),
      "utf-8",
    ),
  ) as {
    edges: {
      signals: PairSignals;
      api: { relation: string; rule: string };
      apiV1: { relation: string; rule: string };
      gold: string;
    }[];
  };

  it("re-derives every recorded API classification from its recorded signals", () => {
    expect(fixture.edges.length).toBeGreaterThanOrEqual(40);
    for (const e of fixture.edges) {
      const v2 = classifyApiRelationV2(e.signals);
      expect({ relation: v2.relation, rule: v2.rule }).toEqual(e.api);
      const v1 = classifyApiRelation(e.signals);
      expect({ relation: v1.relation, rule: v1.rule }).toEqual(e.apiV1);
    }
  });

  it("keeps the documented hold-out precision (v2 >= v1)", () => {
    const hold = (
      fixture.edges as {
        split?: string;
        gold: string;
        api: { relation: string };
        apiV1: { relation: string };
      }[]
    ).filter((e) => e.split === "holdout");
    const v2 = hold.filter((e) => e.api.relation === e.gold).length;
    const v1 = hold.filter((e) => e.apiV1.relation === e.gold).length;
    expect(hold.length).toBe(30);
    expect(v2).toBeGreaterThanOrEqual(v1);
  });
});

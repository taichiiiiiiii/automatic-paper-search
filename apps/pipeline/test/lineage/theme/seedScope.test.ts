// R2-66 (#473): the majority subfield of the keyword seeds scopes the
// canonical-seed step so a survey from the other sense of a field name
// ("State Space Models" in statistics) cannot drag its field in.
import { describe, expect, it } from "vitest";
import { inSeedScope, seedScopeOf } from "../../../src/lineage/theme/discoverSeeds.js";
import { workToPaperDict } from "../../../src/lineage/theme/openalexWork.js";

const ai = { subfield: "Artificial Intelligence" };
const stats = { subfield: "Statistics and Probability" };
const unknown = {};

describe("seedScopeOf", () => {
  it("takes the majority subfield once 3 seeds are known", () => {
    const scope = seedScopeOf([ai, ai, { subfield: "Computer Vision" }, stats, unknown]);
    expect(scope.subfield).toBe("Artificial Intelligence");
    expect(scope.known).toBe(4);
    expect(scope.total).toBe(5);
  });
  it("does not scope with fewer than 3 known seeds (old cache, S2-only records)", () => {
    const scope = seedScopeOf([ai, ai, unknown, unknown]);
    expect(scope.subfield).toBeNull();
    expect(inSeedScope(scope, stats)).toBe(true);
  });
  it("breaks a tie by name so the result is deterministic", () => {
    expect(seedScopeOf([ai, stats, ai, stats]).subfield).toBe("Artificial Intelligence");
  });
});

describe("inSeedScope", () => {
  const scope = seedScopeOf([ai, ai, ai]);
  it("excludes the other subfield, keeps the majority one", () => {
    expect(inSeedScope(scope, stats)).toBe(false);
    expect(inSeedScope(scope, ai)).toBe(true);
  });
  it("never excludes a paper whose subfield is unknown", () => {
    expect(inSeedScope(scope, unknown)).toBe(true);
  });
});

describe("workToPaperDict subfield", () => {
  const base = { id: "https://openalex.org/W1", title: "T", publication_year: 2020 };
  it("reads primary_topic.subfield.display_name", () => {
    const p = workToPaperDict({
      ...base,
      primary_topic: { display_name: "x", subfield: { display_name: " Artificial Intelligence " } },
    });
    expect(p?.subfield).toBe("Artificial Intelligence");
  });
  it("omits the key when OpenAlex gave no topic", () => {
    expect("subfield" in (workToPaperDict(base) ?? {})).toBe(false);
  });
});

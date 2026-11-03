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

describe("fetchSubfieldsByIds (R2-66 backfill)", () => {
  it("maps ids to subfields and leaves a failed chunk unknown", async () => {
    const { fetchSubfieldsByIds } = await import("../../../src/lineage/theme/openalexFetch.js");
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return {
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          results: [
            {
              id: "https://openalex.org/W1",
              primary_topic: { subfield: { display_name: "Statistics and Probability" } },
            },
            { id: "https://openalex.org/W2", primary_topic: null },
          ],
        }),
      };
    };
    const deps = {
      fetchImpl,
      sleep: async () => {},
      now: () => 0,
      logger: { warn() {}, info() {} },
    };
    const out = await fetchSubfieldsByIds(["W1", "W2", "openalex:W1"], deps as never);
    expect(out.get("W1")).toBe("Statistics and Probability");
    expect(out.has("W2")).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("select=id%2Cprimary_topic");
    const dead = async () => {
      throw new TypeError("fetch failed");
    };
    const none = await fetchSubfieldsByIds(["W3"], { ...deps, fetchImpl: dead } as never);
    expect(none.size).toBe(0);
  });
});

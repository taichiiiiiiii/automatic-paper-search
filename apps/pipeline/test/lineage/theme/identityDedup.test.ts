/**
 * Vitest port of the strong-alias identity + dedup tests from
 * `paperpilot/tests/test_build_theme_lineage_p2t.py` and the title/year +
 * DOI dedup tests from `paperpilot/tests/test_build_theme_lineage.py`
 * (safety contract LIN-25).
 */
import { describe, expect, it } from "vitest";
import { makePaperId } from "../../../src/catalog/identity.js";
import {
  dedupByTitleYear,
  dedupNodesByStrongAlias,
  normalizeDedupTitle,
  remapEdgeEndpoints,
} from "../../../src/lineage/theme/dedup.js";
import {
  candidateRank,
  type IdentityAliasIndex,
  resolveAndDedupSeeds,
  resolveSeedPaperId,
} from "../../../src/lineage/theme/identity.js";
import { type ThemeGraphNode, toThemeNode } from "../../../src/lineage/theme/node.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";

function mkS2Paper(
  pid: string,
  opts: { title?: string; year?: number; cites?: number; abstract?: string } = {},
): ThemePaper {
  const { title = "Some paper", year = 2020, cites = 100, abstract = "stub abstract" } = opts;
  return {
    paperId: pid,
    title,
    year,
    venue: "NeurIPS",
    citationCount: cites,
    abstract,
    authors: [{ name: "A. Author" }],
    externalIds: {},
  };
}

function paper(
  graphId: string,
  arxivId: string | null,
  opts: { title?: string; year?: number; citations?: number } = {},
): ThemePaper {
  const { title = "A paper", year = 2024, citations = 10 } = opts;
  return {
    paperId: graphId,
    title,
    year,
    venue: "arXiv",
    citationCount: citations,
    abstract: "A sufficiently specific abstract for deterministic tests.",
    authors: [],
    externalIds: arxivId === null ? {} : { ArXiv: arxivId },
  };
}

const EMPTY_INDEX: IdentityAliasIndex = new Map();

describe("resolveSeedPaperId / resolveAndDedupSeeds (LIN-25)", () => {
  it("rejects two canonical aliases that disagree (conflicting canonical seed IDs)", () => {
    const conflicting = paper("s", "2401.00001");
    conflicting.externalIds.OpenReview = "forum-two";
    expect(() => resolveSeedPaperId(conflicting, EMPTY_INDEX)).toThrow(
      /conflicting canonical seed IDs/,
    );

    const mismatched = paper("s", "2401.00001");
    mismatched.arxiv_id = "2401.00002";
    expect(() => resolveSeedPaperId(mismatched, EMPTY_INDEX)).toThrow(
      /conflicting canonical seed IDs/,
    );
  });

  it("dedups by exact alias with a deterministic (higher-cite) survivor, order-independent", () => {
    const low = paper("z-low", "2401.00001", { citations: 10 });
    const high = paper("a-high", "2401.00001", { citations: 100 });
    const [survivorsA, idsA] = resolveAndDedupSeeds([low, high], EMPTY_INDEX);
    const [survivorsB, idsB] = resolveAndDedupSeeds([high, low], EMPTY_INDEX);
    expect(survivorsA.map((r) => r.paperId)).toEqual(["a-high"]);
    expect(survivorsA).toEqual(survivorsB);
    expect([...idsA.entries()]).toEqual([...idsB.entries()]);
    expect(idsA.get("a-high")).toBe(makePaperId("arxiv", "2401.00001"));
  });

  it("does not merge same title/year with distinct strong aliases", () => {
    const first = paper("a", "2401.00001", { title: "Same title", year: 2024 });
    const second = paper("b", "2401.00002", { title: "Same title", year: 2024 });
    const [survivors, seedIds] = resolveAndDedupSeeds([second, first], EMPTY_INDEX);
    expect(survivors.map((r) => r.paperId)).toEqual(["a", "b"]);
    expect(new Set(seedIds.values()).size).toBe(2);
  });
});

describe("dedupNodesByStrongAlias (LIN-25)", () => {
  it("rejects a shared DOI with distinct strong aliases (conflicting seed IDs on exact alias)", () => {
    const focus = paper("focus-low", "2401.00001", { citations: 10 });
    focus.externalIds.DOI = "10.1000/shared";
    const other = paper("other-high", "2401.00002", { citations: 100 });
    other.externalIds.DOI = "10.1000/shared";
    const nodes = new Map<string, ThemeGraphNode>([
      ["focus-low", toThemeNode(focus, { focus: true })],
      ["other-high", toThemeNode(other)],
    ]);
    const seedByGraphId = new Map([["focus-low", makePaperId("arxiv", "2401.00001")]]);
    expect(() => dedupNodesByStrongAlias(nodes, seedByGraphId, EMPTY_INDEX)).toThrow(
      /conflicting seed IDs on exact alias/,
    );
  });

  it("keeps the isolated exact-identity survivor deterministically (citation-desc)", () => {
    const low = paper("z-low", "2401.00001", { citations: 10 });
    const high = paper("a-high", "2401.00001", { citations: 100 });
    const nodes = new Map<string, ThemeGraphNode>([
      ["z-low", toThemeNode(low, { focus: true })],
      ["a-high", toThemeNode(high)],
    ]);
    const canonical = makePaperId("arxiv", "2401.00001");
    const seedByGraphId = new Map([["z-low", canonical]]);
    const [survivors, remap, seeds] = dedupNodesByStrongAlias(nodes, seedByGraphId, EMPTY_INDEX);
    expect([...survivors.keys()]).toEqual(["a-high"]);
    expect([...remap.entries()]).toEqual([["z-low", "a-high"]]);
    expect([...seeds.entries()]).toEqual([["a-high", canonical]]);
  });
});

describe("candidateRank", () => {
  it("ranks by -citationCount then graph id ascending", () => {
    expect(candidateRank({ paperId: "b", citationCount: 5 })).toEqual([-5, "b"]);
    expect(candidateRank({ id: "a", citation_count: 10 })).toEqual([-10, "a"]);
    expect(candidateRank({})).toEqual([0, ""]);
  });
});

describe("remapEdgeEndpoints (P2T endpoint-bound provenance)", () => {
  it("rejects a remap that would change a surviving edge's endpoints (not just drop a self-loop)", () => {
    const remap = new Map([["dup_lo", "dup_hi"]]);
    const edges = [
      { src: "dup_lo", dst: "dup_hi", rel: "extends" },
      { src: "other", dst: "dup_lo", rel: "extends" },
      { src: "other", dst: "dup_hi", rel: "extends" },
    ];
    expect(() => remapEdgeEndpoints(edges, remap)).toThrow(/endpoint-bound provenance/);
  });

  it("passes edges through unchanged when the remap is empty", () => {
    const edges = [{ src: "a", dst: "b" }];
    expect(remapEdgeEndpoints(edges, new Map())).toBe(edges);
  });
});

describe("normalizeDedupTitle", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeDedupTitle("FlashAttention: Fast,  Memory-Efficient!")).toBe(
      "flashattention fast memory efficient",
    );
  });
});

describe("dedupByTitleYear (#298)", () => {
  it("collapses distinct ids with the same normalised title+year, keeping the higher-cite record", () => {
    const papers = [
      {
        ...mkS2Paper("openalex:W4281758439", {
          title: "FlashAttention: Fast and Memory-Efficient Exact Attention",
          year: 2022,
          cites: 4_000,
        }),
        externalIds: { DOI: "10.48550/arxiv.2205.14135" },
      },
      {
        ...mkS2Paper("openalex:W7133227460", {
          title: "FlashAttention:  Fast and Memory-Efficient  Exact Attention!",
          year: 2022,
          cites: 9_500,
        }),
        externalIds: { DOI: "10.52202/068431-1189" },
      },
    ];
    const [deduped, remap] = dedupByTitleYear(papers);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.paperId).toBe("openalex:W7133227460");
    expect(remap.get("openalex:W4281758439")).toBe("openalex:W7133227460");
  });

  it("keeps distinct papers (different title, or same title different year)", () => {
    const papers = [
      mkS2Paper("a", { title: "Attention Is All You Need", year: 2017, cites: 80_000 }),
      mkS2Paper("b", { title: "FlashAttention", year: 2022, cites: 5_000 }),
      mkS2Paper("c", { title: "Attention Is All You Need", year: 2023, cites: 10 }),
    ];
    const [deduped, remap] = dedupByTitleYear(papers);
    expect(new Set(deduped.map((p) => p.paperId))).toEqual(new Set(["a", "b", "c"]));
    expect(remap.size).toBe(0);
  });

  it("collapses same title within the year window but not far outside it", () => {
    const papers = [
      mkS2Paper("vit2020", { title: "An Image is Worth 16x16 Words", year: 2020, cites: 21585 }),
      mkS2Paper("vit2021", { title: "An Image is Worth 16x16 Words", year: 2021, cites: 557 }),
      mkS2Paper("old", { title: "An Image is Worth 16x16 Words", year: 2003, cites: 3 }),
    ];
    const [deduped, remap] = dedupByTitleYear(papers);
    const ids = new Set(deduped.map((p) => p.paperId));
    expect(ids.has("vit2020")).toBe(true);
    expect(ids.has("vit2021")).toBe(false);
    expect(ids.has("old")).toBe(true);
    expect(remap.get("vit2021")).toBe("vit2020");
  });

  it("uses DOI as a secondary key, folding case variance", () => {
    const papers = [
      {
        ...mkS2Paper("dup_lo", { title: "Some Paper", year: 2021, cites: 10 }),
        externalIds: { DOI: "10.48550/ARXIV.2106.12345" },
      },
      {
        ...mkS2Paper("dup_hi", { title: "Some Paper (v2)", year: 2021, cites: 99 }),
        externalIds: { DOI: "10.48550/arxiv.2106.12345" },
      },
    ];
    const [deduped, remap] = dedupByTitleYear(papers);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.paperId).toBe("dup_hi");
    expect(remap.get("dup_lo")).toBe("dup_hi");
  });

  it("passes a keyless paper (no title, no DOI) through untouched", () => {
    const papers = [
      { paperId: "k1", title: "", year: null } as unknown as ThemePaper,
      { paperId: "k2", title: "", year: null } as unknown as ThemePaper,
    ];
    const [deduped, remap] = dedupByTitleYear(papers);
    expect(new Set(deduped.map((p) => p.paperId))).toEqual(new Set(["k1", "k2"]));
    expect(remap.size).toBe(0);
  });
});

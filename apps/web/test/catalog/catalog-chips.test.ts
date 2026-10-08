import { describe, expect, it } from "vitest";
import { buildTagChipGroups, buildTypeChips } from "../../lib/catalog-chips";
import type { CatalogPaper } from "../../lib/catalog-core";

function paper(tags: string[], type: "Oral" | "Poster" = "Poster"): CatalogPaper {
  return { paper_id: "0".repeat(40), title: "t", authors: [], tags, abstract: "", type };
}

describe("buildTagChipGroups", () => {
  it("keeps only the top 18 tags, by descending count", () => {
    // tag0 has 20 occurrences, tag1 has 19, ... tag19 has 1.
    const papers: CatalogPaper[] = [];
    for (let i = 0; i < 20; i++) {
      for (let n = 0; n < 20 - i; n++) papers.push(paper([`tag${i}`]));
    }
    const groups = buildTagChipGroups(papers, new Set());
    expect(groups.head.length + groups.tail.length).toBe(18);
    expect(groups.head).toHaveLength(8);
    expect(groups.tail).toHaveLength(10);
    // tag0 has the most occurrences (20), so it must lead the head.
    expect(groups.head[0]?.tag).toBe("tag0");
  });

  it("forces tailActiveByDefault when a restored filter tag lives in the tail", () => {
    const papers: CatalogPaper[] = [];
    for (let i = 0; i < 12; i++) {
      for (let n = 0; n < 12 - i; n++) papers.push(paper([`tag${i}`]));
    }
    const withoutActive = buildTagChipGroups(papers, new Set());
    expect(withoutActive.tailActiveByDefault).toBe(false);
    const tailTag = withoutActive.tail[0]?.tag;
    expect(tailTag).toBeDefined();
    const withActive = buildTagChipGroups(papers, new Set([tailTag as string]));
    expect(withActive.tailActiveByDefault).toBe(true);
  });
});

describe("buildTypeChips", () => {
  it("always includes All, plus any type present in the loaded rows", () => {
    const chips = buildTypeChips([paper([], "Oral"), paper([], "Poster"), paper([], "Poster")]);
    expect(chips).toEqual([
      { value: "all", label: "all", count: 3 },
      { value: "Oral", label: "Oral", count: 1 },
      { value: "Poster", label: "Poster", count: 2 },
    ]);
  });

  it("omits Oral when no loaded row is Oral", () => {
    const chips = buildTypeChips([paper([], "Poster")]);
    expect(chips.map((c) => c.value)).toEqual(["all", "Poster"]);
  });
});

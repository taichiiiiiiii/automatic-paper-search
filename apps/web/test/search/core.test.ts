import { describe, expect, it } from "vitest";
import {
  blockFile,
  paginate,
  rankResults,
  type SearchRow,
  validateIdBlock,
  validateIndex,
} from "../../lib/search-core";

// Case-for-case port of
// paperpilot/tests/viewer/test_search_v2.mjs (docs/assets/search.js's
// own contract test for `window.PaperPilotSearchCore`).

function row(
  title: string,
  ref: number,
  opts: {
    authors?: string[];
    tags?: string[];
    year?: number | null;
    type?: "Oral" | "Poster";
  } = {},
): SearchRow {
  const { authors = [], tags = [], year = 2026, type = "Poster" } = opts;
  return [title, "iclr-2026", ref, authors, tags, year, type];
}

describe("validateIndex", () => {
  it("accepts a well-formed index", () => {
    const valid = [
      row("Exact Paper", 0, { year: 2022 }),
      row("An Exact Paper Survey", 1, { year: 2026 }),
      row("Unrelated", 2, { authors: ["Exact Paper Group"], year: 2025 }),
      row("Also Unrelated", 3, { tags: ["exact paper"], year: 2024 }),
    ];
    expect(validateIndex(valid)).toBe(valid);
  });

  it("rejects the whole index when one row's paper_ref is wrong (fail-closed, SCR-05)", () => {
    expect(() => validateIndex([row("Wrong ref", 8)])).toThrow(/paper_ref/);
  });
});

describe("rankResults", () => {
  const valid = [
    row("Exact Paper", 0, { year: 2022 }),
    row("An Exact Paper Survey", 1, { year: 2026 }),
    row("Unrelated", 2, { authors: ["Exact Paper Group"], year: 2025 }),
    row("Also Unrelated", 3, { tags: ["exact paper"], year: 2024 }),
  ];

  it("ranks exact-title > title > author > tag", () => {
    const ranked = rankResults(valid, " exact   paper ");
    expect(ranked.map((hit) => hit.matchKind)).toEqual(["exact-title", "title", "author", "tag"]);
    expect(ranked.map((hit) => hit.row[2])).toEqual([0, 1, 2, 3]);
  });

  const faceted: SearchRow[] = [
    ["alpha older oral", "eccv-2024", 0, [], ["Vision"], 2024, "Oral"],
    ["alpha current poster", "iclr-2026", 1, [], ["Vision"], 2026, "Poster"],
    ["alpha current oral", "iclr-2026", 2, [], ["Vision"], 2026, "Oral"],
  ];

  it("applies conference/year/type as predicates before (unchanged) ranking", () => {
    const hits = rankResults(faceted, "alpha", {
      conference: "iclr-2026",
      year: 2026,
      type: "Oral",
    });
    expect(hits.map((hit) => hit.row[2])).toEqual([2]);
  });

  it("empty facets preserve the original ranking and tie order", () => {
    const hits = rankResults(faceted, "alpha", { conference: "", year: null, type: "" });
    expect(hits.map((hit) => hit.row[2])).toEqual([1, 2, 0]);
  });

  it("ties use year descending, then original ordinal", () => {
    const ties = rankResults(
      [
        row("alpha old", 0, { year: 2023 }),
        row("alpha newest first", 1, { year: 2026 }),
        row("alpha newest second", 2, { year: 2026 }),
        row("alpha unknown", 3, { year: null }),
      ],
      "alpha",
    );
    expect(ties.map((hit) => hit.row[2])).toEqual([1, 2, 0, 3]);
  });
});

describe("paginate", () => {
  it("slices into fixed-size pages", () => {
    const many = Array.from({ length: 41 }, (_, ref) => row(`paper ${ref}`, ref));
    const manyHits = rankResults(many, "paper");
    expect(paginate(manyHits, 1, 20).items).toHaveLength(20);
    expect(paginate(manyHits, 2, 20).items[0]?.row[2]).toBe(20);
    expect(paginate(manyHits, 3, 20).items[0]?.row[2]).toBe(40);
  });
});

describe("blockFile / validateIdBlock", () => {
  it("addresses blocks by paper_ref", () => {
    expect(blockFile(0)).toBe("search-paper-ids-v1/0000.json");
    expect(blockFile(511)).toBe("search-paper-ids-v1/0001.json");
  });

  it("fails closed when a block is fetched for the wrong ordinal (SCR-05)", () => {
    expect(() =>
      validateIdBlock(
        {
          schema_version: "search-paper-ids-v1",
          block: 1,
          start: 256,
          paper_ids: ["0".repeat(40)],
        },
        0,
        257,
      ),
    ).toThrow(/block/);
  });
});

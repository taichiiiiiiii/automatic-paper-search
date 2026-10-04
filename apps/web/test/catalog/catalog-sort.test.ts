/**
 * Ported from paperpilot/tests/viewer/test_catalog_viewer_medium.mjs §1
 * (the "新着順" sort and its availability fallback).
 */
import { describe, expect, it } from "vitest";
import type { CatalogPaper } from "../../lib/catalog-core";
import { getSorted, hasActiveFilters, newestAvailability } from "../../lib/catalog-sort";

function row(key: string, arxivId: string | undefined): CatalogPaper {
  const paper: CatalogPaper = {
    paper_id: key.repeat(40),
    title: `row ${key}`,
    authors: [],
    tags: [],
    abstract: "preview",
    type: "Poster",
  };
  if (arxivId !== undefined) paper.arxiv_id = arxivId;
  return paper;
}

describe("getSorted newest", () => {
  it("dated rows come first in descending order; undated rows keep collection order", () => {
    const mixed = [
      row("1", "2506.00101"),
      row("2", ""),
      row("3", "2505.99999"),
      row("4", undefined),
      row("5", "2506.00102"),
    ];
    expect(getSorted(mixed, "newest").map((p) => p.title)).toEqual([
      "row 5",
      "row 1",
      "row 3",
      "row 2",
      "row 4",
    ]);
  });

  it("an all-undated catalog keeps collection order even if newest is selected", () => {
    const undated = [row("a", ""), row("b", undefined), row("c", "")];
    expect(getSorted(undated, "newest").map((p) => p.title)).toEqual(["row a", "row b", "row c"]);
  });
});

describe("newestAvailability", () => {
  it("is unusable when no loaded row has an arXiv id", () => {
    const undated = [row("a", ""), row("b", undefined), row("c", "")];
    const availability = newestAvailability(undated);
    expect(availability.usable).toBe(false);
    expect(availability.label).toBe("新着順（arXiv ID がない学会では使えません）");
  });

  it("is usable when at least one loaded row has an arXiv id", () => {
    const mixed = [row("a", ""), row("b", undefined), row("d", "2506.00001")];
    const availability = newestAvailability(mixed);
    expect(availability.usable).toBe(true);
    expect(availability.label).toBe("新着順");
  });
});

describe("hasActiveFilters", () => {
  it("is false for the default filter state", () => {
    expect(hasActiveFilters({ search: "", type: "all", activeTags: new Set() })).toBe(false);
  });
  it("is true when search, type or tags are set", () => {
    expect(hasActiveFilters({ search: "vision", type: "all", activeTags: new Set() })).toBe(true);
    expect(hasActiveFilters({ search: "", type: "Oral", activeTags: new Set() })).toBe(true);
    expect(hasActiveFilters({ search: "", type: "all", activeTags: new Set(["3D"]) })).toBe(true);
  });
});

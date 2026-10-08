import { describe, expect, it } from "vitest";
import {
  filtersFromUrl,
  pageFromUrl,
  rankResults,
  type SearchRow,
  searchUrl,
  urlHasDuplicateSearchState,
} from "../../lib/search-core";

// Pure-function port of
// paperpilot/tests/viewer/test_search_facets_state.mjs, which drove
// docs/assets/search.js end-to-end through a hand-rolled DOM/fetch
// harness. components/search/search-area.tsx wires these same pure
// helpers to React state instead of DOM nodes, so this test exercises
// the state machine at the (DOM-free) function boundary.

const rows: SearchRow[] = [
  ["alpha old oral", "eccv-2024", 0, [], ["Vision"], 2024, "Oral"],
  ["alpha new poster", "iclr-2026", 1, [], ["Vision"], 2026, "Poster"],
  ["alpha new oral", "iclr-2026", 2, [], ["Vision"], 2026, "Oral"],
];

function paramsFor(search: string): URLSearchParams {
  return new URL(`https://example.test/${search}`).searchParams;
}

describe("filtersFromUrl", () => {
  it("parses a valid deep link into conference/year/type", () => {
    const params = paramsFor("?q=alpha&conference=iclr-2026&year=2026&type=Oral&page=1");
    const filters = filtersFromUrl(params, rows);
    expect(filters).toEqual({ conference: "iclr-2026", year: 2026, type: "Oral", invalid: false });
    expect(rankResults(rows, "alpha", filters).map((hit) => hit.row[2])).toEqual([2]);
  });

  it("a duplicate filter key is invalid, not first-match (SCR-07)", () => {
    const params = paramsFor("?q=alpha&conference=iclr-2026&conference=eccv-2024&page=1");
    const filters = filtersFromUrl(params, rows);
    expect(filters.invalid).toBe(true);
    // The caller (search-area.tsx's runQuery) treats an invalid filter
    // set as zero results, never silently picking one duplicate value.
    expect(filters.invalid ? [] : rankResults(rows, "alpha", filters)).toEqual([]);
  });

  it("a filter value absent from the corpus is dropped, not passed through", () => {
    const params = paramsFor("?conference=nope-2099");
    const filters = filtersFromUrl(params, rows);
    expect(filters).toEqual({ conference: "", year: null, type: "", invalid: true });
  });

  it("resetting (no filter params) clears every field", () => {
    const filters = filtersFromUrl(paramsFor(""), rows);
    expect(filters).toEqual({ conference: "", year: null, type: "", invalid: false });
    expect(rankResults(rows, "alpha", filters).map((hit) => hit.row[2])).toEqual([1, 2, 0]);
  });
});

describe("pageFromUrl / urlHasDuplicateSearchState", () => {
  it("has no page by default", () => {
    expect(pageFromUrl(paramsFor("?q=a"))).toBeNull();
  });

  it("clamps a malformed page to 1", () => {
    expect(pageFromUrl(paramsFor("?page=not-a-number"))).toBe(1);
    expect(pageFromUrl(paramsFor("?page=0"))).toBe(1);
  });

  it("flags duplicate q/page/filter keys as invalid url state", () => {
    expect(urlHasDuplicateSearchState(paramsFor("?q=a&q=b"))).toBe(true);
    expect(urlHasDuplicateSearchState(paramsFor("?page=2"))).toBe(false);
    expect(urlHasDuplicateSearchState(paramsFor("?page=-1"))).toBe(true);
  });
});

describe("searchUrl", () => {
  it("round-trips query/page/filters into the URL, dropping empty fields, leaving unrelated params alone", () => {
    const href = searchUrl("https://example.test/?stale=1", "alpha", 2, {
      conference: "iclr-2026",
      year: 2026,
      type: "",
      invalid: false,
    });
    const url = new URL(href, "https://example.test/");
    expect(url.searchParams.get("q")).toBe("alpha");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("conference")).toBe("iclr-2026");
    expect(url.searchParams.get("year")).toBe("2026");
    expect(url.searchParams.has("type")).toBe(false);
    // searchUrl only ever touches q/conference/year/type/page -- an
    // unrelated param is neither a signal it reads nor one it owns.
    expect(url.searchParams.get("stale")).toBe("1");
  });

  it("omits page entirely when page is null (combobox mode)", () => {
    const href = searchUrl("https://example.test/?page=5", "alpha", null, {
      conference: "",
      year: null,
      type: "",
      invalid: false,
    });
    expect(new URL(href, "https://example.test/").searchParams.has("page")).toBe(false);
  });
});

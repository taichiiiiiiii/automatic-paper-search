/**
 * Port of the `first_unusable`/`gh_repo_slug`/`gh_search_item_ok` cases of
 * `paperpilot/tests/test_payload_elements.py` (the rest of that module —
 * `s2_paper_id`/`s2_paper_shape`/`openalex_work_shape`/`openalex_short_id`/
 * `s2_relation_entry_ok`/`s2_cached_neighbour_ok` — backs the P4d lineage
 * builders and is out of this task's scope; see `signals/payload.ts`'s
 * module doc).
 */
import { describe, expect, it } from "vitest";
import { firstUnusable, ghRepoSlug, ghSearchItemOk } from "../../../src/collect/signals/payload.js";

it("test_first_unusable_returns_the_index_and_the_offending_element", () => {
  expect(firstUnusable([1, 2, 3], (x) => x < 5)).toBeNull();
  expect(firstUnusable([1, 9, 3], (x) => x < 5)).toEqual([1, 9]);
});

it("test_first_unusable_treats_a_throwing_predicate_as_a_failed_check", () => {
  expect(
    firstUnusable(["ok", null], (s) => {
      if (s === null) throw new Error("boom");
      return s.startsWith("o");
    }),
  ).toEqual([1, null]);
});

it("test_first_unusable_allows_a_none_hole_only_when_asked", () => {
  const entries: (Record<string, unknown> | null)[] = [{ paperId: "P1" }, null];
  const pred = (e: Record<string, unknown> | null) => e !== null && Boolean(e.paperId);
  expect(firstUnusable(entries, pred, { allowNone: true })).toBeNull();
  expect(firstUnusable(entries, pred)).toEqual([1, null]);
});

describe("test_gh_repo_slug", () => {
  it.each([
    ["owner/repo", ["owner", "repo"]],
    ["owner/with spaces", null],
    ["owner/$evil", null],
    ["owner/..", null],
    [".owner/repo", null],
    ["noslash", null],
    [7, null],
  ])("%j -> %j", (value, expected) => {
    expect(ghRepoSlug(value)).toEqual(expected);
  });
});

it("test_gh_repo_slug_rejects_a_trailing_newline", () => {
  expect(ghRepoSlug("owner/repo\n")).toBeNull();
  expect(ghRepoSlug("owner\n/repo")).toBeNull();
});

describe("test_gh_search_item_ok", () => {
  it.each([
    [{ full_name: "o/r", name: "r", description: null }, true],
    [{ full_name: "o/r", name: "r", description: "d" }, true],
    [{ full_name: "o/r", name: 1, description: null }, false],
    [{ full_name: "o/r", name: "r", description: { m: 1 } }, false],
    [{ full_name: "o/r", description: null }, false],
    [{ full_name: "o/../r", name: "r", description: null }, false],
    [null, false],
  ])("%j -> %j", (item, ok) => {
    expect(ghSearchItemOk(item)).toBe(ok);
  });
});

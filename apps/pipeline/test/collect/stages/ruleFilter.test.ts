/**
 * Port of `paperpilot/tests/test_stage_rule_filter.py`.
 */
import { expect, it } from "vitest";
import { createPaper } from "../../../src/collect/model/paper.js";
import { ruleFilter } from "../../../src/collect/stages/ruleFilter.js";

function mk(opts: {
  title?: string;
  categories?: string[];
  pub?: string;
  comment?: string | null;
  suffix?: string;
}) {
  const {
    title = "Title",
    categories = ["cs.LG"],
    pub = "2026-04-10",
    comment = null,
    suffix = "1",
  } = opts;
  return createPaper({
    title,
    authors: ["A"],
    abstract: "abs",
    url: `http://x/${suffix}`,
    publishedDate: pub,
    source: "arxiv",
    arxivId: `2604.000${suffix}`,
    categories,
    comment,
  });
}

it("test_category_filter_keeps_matching", () => {
  const papers = [
    mk({ categories: ["cs.LG"], suffix: "1" }),
    mk({ categories: ["math.ST"], suffix: "2" }),
  ];
  const kept = ruleFilter(papers, { excludeWords: [], categories: ["cs.LG"] });
  expect(kept.length).toBe(1);
  expect(kept[0]?.categories).toEqual(["cs.LG"]);
});

it("test_empty_categories_allows_all", () => {
  const papers = [
    mk({ categories: ["cs.LG"], suffix: "1" }),
    mk({ categories: ["math.ST"], suffix: "2" }),
  ];
  const kept = ruleFilter(papers, { excludeWords: [], categories: [] });
  expect(kept.length).toBe(2);
});

it("test_paper_without_categories_passes_category_filter", () => {
  const papers = [mk({ categories: ["cs.LG"], suffix: "1" }), mk({ categories: [], suffix: "2" })];
  const kept = ruleFilter(papers, { excludeWords: [], categories: ["cs.LG"] });
  expect(kept.length).toBe(2);
  expect(kept.some((p) => p.categories.length === 0)).toBe(true);
});

it("test_date_filter", () => {
  const old = mk({ pub: "2026-03-11", suffix: "1" });
  const fresh = mk({ pub: "2026-04-07", suffix: "2" });
  const kept = ruleFilter([old, fresh], {
    excludeWords: [],
    categories: [],
    sinceDate: "2026-04-03",
  });
  expect(kept).toEqual([fresh]);
});

it("test_exclude_words_scan_title_abstract_comment", () => {
  const pSurvey = mk({ title: "A Comprehensive Survey of LLMs", suffix: "1" });
  const pOk = mk({ title: "Novel Method", suffix: "2" });
  const pWs = mk({ title: "Good", comment: "Workshop paper", suffix: "3" });
  const kept = ruleFilter([pSurvey, pOk, pWs], {
    excludeWords: ["survey", "workshop"],
    categories: [],
  });
  expect(kept).toEqual([pOk]);
});

it("test_seen_ids_drops_known", () => {
  const papers = [mk({ suffix: "1" }), mk({ suffix: "2" })];
  const seen = { [`arxiv:${papers[0]?.arxivId}`]: new Date().toISOString() };
  const kept = ruleFilter(papers, { excludeWords: [], categories: [], seenIds: seen });
  expect(kept).toEqual([papers[1]]);
});

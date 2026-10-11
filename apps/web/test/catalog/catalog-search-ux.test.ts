/**
 * Design doc 53 「学会の論文一覧」: search / filter behaviour changed by
 * the UX audit -- multi-word AND search, the has-abstract filter, the
 * Japanese-query hint, multi-term highlighting and the result-count line.
 */
import { describe, expect, it } from "vitest";
import type { CatalogPaper } from "../../lib/catalog-core";
import {
  getFiltered,
  getSorted,
  hasActiveFilters,
  hasJapaneseText,
  paperHasAbstract,
  searchTerms,
  termVariants,
  titleSortKey,
} from "../../lib/catalog-sort";
import { resultSummary } from "../../lib/catalog-status";
import { buildAbstractDek, highlightSegments } from "../../lib/catalog-text";

function row(key: string, title: string, abstract: string, authors: string[] = []): CatalogPaper {
  return {
    paper_id: key.repeat(40),
    title,
    authors,
    tags: [],
    abstract,
    type: "Poster",
  };
}

const ROWS = [
  row("a", "Diffusion Models for Video Generation", "We generate videos."),
  row("b", "Video Transformers", "A diffusion-free approach."),
  row("c", "Graph Neural Networks", "", ["Taro Yamada"]),
  row("d", "Retrieval at scale", "   "),
];

const NO_FILTER = { type: "all" as const, activeTags: new Set<string>() };

describe("searchTerms", () => {
  it("splits on ASCII and full-width spaces and lowercases", () => {
    expect(searchTerms("  Video\u3000Diffusion  ")).toEqual(["video", "diffusion"]);
    expect(searchTerms("")).toEqual([]);
  });
});

describe("getFiltered multi-word search", () => {
  it("matches rows containing every term, in any order (was: exact phrase only)", () => {
    const ids = (q: string) =>
      getFiltered(ROWS, { ...NO_FILTER, search: q }).map((p) => p.paper_id[0]);
    expect(ids("video diffusion")).toEqual(["a", "b"]);
    expect(ids("diffusion video generation")).toEqual(["a"]);
    // A single term behaves exactly like the old substring match.
    expect(ids("transformer")).toEqual(["b"]);
    expect(ids("yamada")).toEqual(["c"]);
  });

  it("caches the haystack per row without going stale across queries", () => {
    expect(getFiltered(ROWS, { ...NO_FILTER, search: "graph" })).toHaveLength(1);
    expect(getFiltered(ROWS, { ...NO_FILTER, search: "generation" })).toHaveLength(1);
  });

  it("NFKC-normalises full-width Latin typed with a Japanese IME", () => {
    const ids = (q: string) =>
      getFiltered(ROWS, { ...NO_FILTER, search: q }).map((p) => p.paper_id[0]);
    expect(ids("ｄｉｆｆｕｓｉｏｎ")).toEqual(["a", "b"]);
    expect(ids("ＶＩＤＥＯ\u3000ｇｅｎｅｒａｔｉｏｎ")).toEqual(["a"]);
    const segments = highlightSegments("Diffusion Models", "ｄｉｆｆｕｓｉｏｎ");
    expect(segments.filter((s) => s.mark).map((s) => s.text)).toEqual(["Diffusion"]);
  });

  it("folds hyphens and simple plurals in the query", () => {
    const ids = (q: string) =>
      getFiltered(ROWS, { ...NO_FILTER, search: q }).map((p) => p.paper_id[0]);
    // "diffusion-free" in b's abstract is found by "diffusion free".
    expect(ids("diffusion free")).toEqual(["b"]);
    // ...and "Diffusion Models" in a's title by "diffusion-models".
    expect(ids("diffusion-models")).toEqual(["a"]);
    // A plural query finds the singular ("Video" in a and b).
    expect(ids("videos")).toEqual(["a", "b"]);
    // Short words and "-ss" endings are not folded.
    expect(termVariants("loss")).toEqual(["loss"]);
    expect(termVariants("gans")).toEqual(["gans"]);
    expect(termVariants("transformers")).toEqual(["transformers", "transformer"]);
  });
});

describe("has-abstract filter", () => {
  it("treats empty and whitespace-only abstracts as missing", () => {
    expect(ROWS.map(paperHasAbstract)).toEqual([true, true, false, false]);
  });

  it("drops rows without an abstract only when enabled", () => {
    expect(getFiltered(ROWS, { ...NO_FILTER, search: "", hasAbstract: true })).toHaveLength(2);
    expect(getFiltered(ROWS, { ...NO_FILTER, search: "" })).toHaveLength(4);
  });

  it("counts as an active filter (so フィルタ解除 appears)", () => {
    expect(hasActiveFilters({ ...NO_FILTER, search: "", hasAbstract: true })).toBe(true);
  });
});

describe("title sort", () => {
  it("ignores leading LaTeX and punctuation", () => {
    expect(titleSortKey("$\\texttt{Multi}^2$: Hierarchical")).toBe("Multi}^2$: Hierarchical");
    expect(titleSortKey('"Do Diffusion Models Dream"')).toBe('Do Diffusion Models Dream"');
    const rows = [
      row("a", "$\\mathcal{O}$ bounds", "x"),
      row("b", "Attention", "x"),
      row("c", '"Zebra"', "x"),
    ];
    expect(getSorted(rows, "title").map((p) => p.paper_id[0])).toEqual(["b", "a", "c"]);
  });
});

describe("hasJapaneseText", () => {
  it("detects kana and kanji, not Latin text", () => {
    expect(hasJapaneseText("拡散モデル")).toBe(true);
    expect(hasJapaneseText("ﾃｽﾄ")).toBe(true);
    expect(hasJapaneseText("diffusion")).toBe(false);
  });
});

describe("multi-term highlighting", () => {
  it("marks every term, preferring the longer overlapping one", () => {
    const segments = highlightSegments("Video diffusion transformer", "trans video transformer");
    expect(segments.filter((s) => s.mark).map((s) => s.text)).toEqual(["Video", "transformer"]);
  });

  it("anchors the preview window at the first match of ANY term", () => {
    const abstract = `${"filler ".repeat(30)}diffusion appears late`;
    const dek = buildAbstractDek(abstract, "zzz diffusion", { isFull: false, isSelected: false });
    expect(dek.leadEllipsis).toBe(true);
    expect(dek.segments.some((s) => s.mark && s.text === "diffusion")).toBe(true);
  });
});

describe("resultSummary", () => {
  it("uses one wording: matched, total, and how many are rendered", () => {
    expect(resultSummary({ matched: 6552, shown: 30, total: 6552 })).toBe(
      "全 6,552 件 · 先頭 30 件を表示中",
    );
    expect(resultSummary({ matched: 548, shown: 30, total: 6552 })).toBe(
      "548 件が該当（全 6,552 件） · 先頭 30 件を表示中",
    );
    expect(resultSummary({ matched: 12, shown: 12, total: 6552 })).toBe(
      "12 件が該当（全 6,552 件）",
    );
    expect(resultSummary({ matched: 0, shown: 0, total: 6552 })).toBe("0 件が該当（全 6,552 件）");
  });
});

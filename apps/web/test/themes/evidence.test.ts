// R2 UX P0-2: pure helpers behind the theme evidence panel / relation list.
import { describe, expect, it } from "vitest";
import {
  clipQuote,
  MAX_QUOTE_CHARS,
  METHOD_LABEL_FALLBACK,
  methodLabelJa,
  paperLink,
  parseEdgeEvidence,
  semanticScholarUrl,
} from "../../lib/lineage/evidence";
import { RELATION_LABEL_JA } from "../../lib/lineage/relations";

const S2_RATIONALE =
  '「PVT v2: Improved baselines with pyramid vision tr…」(2022) は 「Tokens-to-Token ViT: Training Vision Transformers…」(2021) を背景・関連研究として引用している（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "T2T ViT [37] con-catenates tokens within an overlapping sliding window into one token progressively."';

describe("parseEdgeEvidence", () => {
  it("splits the quoted citation sentence off the rationale", () => {
    const { summary, quote } = parseEdgeEvidence(S2_RATIONALE);
    expect(quote).toBe(
      "T2T ViT [37] con-catenates tokens within an overlapping sliding window into one token progressively.",
    );
    expect(summary).toContain("背景・関連研究として引用している");
    expect(summary).not.toContain("引用文:");
  });

  it("accepts curly quotes / full-width colon and returns null quote when absent", () => {
    expect(parseEdgeEvidence("理由。引用文：“We build on X.”").quote).toBe("We build on X.");
    const plain = parseEdgeEvidence("命名パターンから置き換え (supersedes) と推定される。");
    expect(plain.quote).toBeNull();
    expect(plain.summary).toBe("命名パターンから置き換え (supersedes) と推定される。");
    expect(parseEdgeEvidence(undefined)).toEqual({ summary: "", quote: null });
  });

  it("limits a quote to one sentence of ~300 chars (S2 attribution rules)", () => {
    const long = `理由。引用文: "${"word ".repeat(200)}"`;
    const { quote } = parseEdgeEvidence(long);
    expect(quote).not.toBeNull();
    expect((quote as string).length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(quote?.endsWith("…")).toBe(true);
    expect(clipQuote("  a   b ")).toBe("a b");
  });
});

describe("methodLabelJa", () => {
  it("labels every classification method in Japanese", () => {
    expect(methodLabelJa("s2_context_rule")).toBe("Semantic Scholar の引用文");
    expect(methodLabelJa("llm")).toBe("LLM");
    expect(methodLabelJa("title_version")).toBe("題名の版");
    expect(methodLabelJa("foundational_allowlist")).toBe("基礎文献リスト");
    expect(methodLabelJa("citation_heuristic")).toBe("引用と年からの推測");
    expect(methodLabelJa("year_cite")).toBe("引用と年からの推測");
  });
  it("never leaks an unknown raw key", () => {
    expect(methodLabelJa("mystery_rule")).toBe(METHOD_LABEL_FALLBACK);
    expect(methodLabelJa(null)).toBe(METHOD_LABEL_FALLBACK);
  });
});

describe("paper links", () => {
  it("prefers arXiv and links S2 via the arXiv resolver", () => {
    const node = { id: "openalex:W1", title: "ViT", arxiv_id: "2010.11929v2" };
    expect(paperLink(node)).toEqual({ url: "https://arxiv.org/abs/2010.11929v2", label: "arXiv" });
    expect(semanticScholarUrl(node)).toBe("https://www.semanticscholar.org/arxiv/2010.11929");
  });
  it("falls back to an S2 title search (never paper/<openalex id>)", () => {
    const node = { id: "openalex:W2", title: "Graph Attention Networks" };
    expect(paperLink(node).label).toBe("Semantic Scholar");
    expect(semanticScholarUrl(node)).toBe(
      "https://www.semanticscholar.org/search?q=Graph%20Attention%20Networks",
    );
  });
});

describe("relation labels (R2 UX P1-6)", () => {
  it("labels baseline_only as 参照（背景）, not 比較", () => {
    expect(RELATION_LABEL_JA.baseline_only).toBe("参照（背景）");
    expect(Object.values(RELATION_LABEL_JA)).not.toContain("比較");
  });
});

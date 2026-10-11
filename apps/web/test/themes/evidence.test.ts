// R2 UX P0-2: pure helpers behind the theme evidence panel / relation list.
import { describe, expect, it } from "vitest";
import {
  ARXIV_HTML_METHOD_LABEL,
  abstractExcerptSourceLabel,
  arxivHtmlSourceOf,
  clipQuote,
  edgeMethodLabelJa,
  endsMidSentence,
  MAX_QUOTE_CHARS,
  METHOD_LABEL_FALLBACK,
  methodLabelJa,
  paperLink,
  parseEdgeEvidence,
  quoteAuthorCredit,
  semanticScholarUrl,
  startsMidSentence,
} from "../../lib/lineage/evidence";
import { RELATION_LABEL_JA } from "../../lib/lineage/relations";

const S2_RATIONALE =
  '「PVT v2: Improved baselines with pyramid vision tr…」(2022) は 「Tokens-to-Token ViT: Training Vision Transformers…」(2021) を背景・関連研究として引用している（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "T2T ViT [37] con-catenates tokens within an overlapping sliding window into one token progressively."';

describe("parseEdgeEvidence", () => {
  it("R2-28: labels a quote taken from the citing paper's arXiv HTML", () => {
    const r =
      '「Switch Transformers」(2021) は 「GShard」(2020) を土台にしている（arXiv HTML（arXiv:2101.03961v3）の本文の引用文から規則で判定）。引用文: "Lepikhin et al. (2020) adapts a Mixture-of-Expert model … which we also follow."';
    const ev = parseEdgeEvidence(r);
    expect(ev.quoteSource).toBe("arxiv-html");
    expect(ev.quote).toContain("which we also follow");
    expect(arxivHtmlSourceOf(r)).toEqual({ id: "2101.03961", version: "v3" });
    expect(edgeMethodLabelJa("s2_context_rule", r)).toBe(ARXIV_HTML_METHOD_LABEL);
    expect(edgeMethodLabelJa("s2_context_rule", S2_RATIONALE)).toBe("Semantic Scholar の引用文");
    expect(arxivHtmlSourceOf(S2_RATIONALE)).toBeNull();
  });

  it("R2-23: tells a citation-context quote from a citing-abstract quote (要旨)", () => {
    expect(parseEdgeEvidence(S2_RATIONALE).quoteSource).toBe("citation-context");
    const abs = parseEdgeEvidence(
      '「SwinIR」(2021) は 「Swin Transformer」(2021) を土台にしている（引用元の論文の要旨から規則で判定）。要旨: "In this paper, we propose a strong baseline model SwinIR for image restoration based on the Swin Transformer."',
    );
    expect(abs.quoteSource).toBe("abstract");
    expect(abs.quote).toContain("based on the Swin Transformer");
    expect(abs.summary).not.toContain("要旨:");
  });

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
    expect(clipQuote("  A   b. ")).toBe("A b.");
  });
});

describe("R2-26: quotation marks of omission and author credit (design 51 §3.3)", () => {
  it("prefixes … when a quote starts mid-word / mid-sentence", () => {
    expect(clipQuote("istance and angular distance are used as in [3].")).toBe(
      "… istance and angular distance are used as in [3].",
    );
    expect(clipQuote(", which we follow [4].")).toBe("… , which we follow [4].");
    expect(clipQuote("We build on X.")).toBe("We build on X.");
    expect(clipQuote("[12] proposed the layer we use.")).toBe("[12] proposed the layer we use.");
    expect(startsMidSentence("… already marked")).toBe(false);
  });

  it("appends … when a quote stops mid-sentence", () => {
    expect(clipQuote("We follow the sparse attention of")).toBe(
      "We follow the sparse attention of…",
    );
    expect(endsMidSentence("Ends here.")).toBe(false);
    expect(endsMidSentence('He said "done."')).toBe(false);
    expect(endsMidSentence("as shown in prior work [12].")).toBe(false);
    expect(clipQuote("both ends cut")).toBe("… both ends cut…");
  });

  it("keeps a clipped mid-sentence quote within the length cap", () => {
    const q = clipQuote("word ".repeat(200));
    expect(q.startsWith("… ")).toBe(true);
    expect(q.endsWith("…")).toBe(true);
    expect(q.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
  });

  it("credits the quoted paper's authors", () => {
    expect(
      quoteAuthorCredit({ id: "x", authors: ["Iz Beltagy", "Matthew E. Peters", "Arman Cohan"] }),
    ).toBe("Beltagy et al.");
    expect(quoteAuthorCredit({ id: "x", authors: ["Ashish Vaswani", "Noam Shazeer"] })).toBe(
      "Vaswani & Shazeer",
    );
    expect(quoteAuthorCredit({ id: "x", authors: ["Ada Lovelace"] })).toBe("Lovelace");
    expect(quoteAuthorCredit({ id: "x" })).toBe("");
    expect(quoteAuthorCredit(undefined)).toBe("");
  });

  it("labels where a node's abstract excerpt was read from", () => {
    expect(abstractExcerptSourceLabel("openalex:W1")).toContain("OpenAlex");
    expect(abstractExcerptSourceLabel("s2:abc")).toBe("Semantic Scholar ");
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
    // R2-24: no-LLM mode, the citation read from a reference list.
    expect(methodLabelJa("api_citation")).toBe("参考文献リスト（引用の事実のみ）");
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

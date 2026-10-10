/**
 * R2-16: which citation-context sentences are about the cited paper, which
 * may be quoted, and title-based rationales (second review patterns 3/4,
 * UX P1-4/P1-5).
 */
import { describe, expect, it } from "vitest";
import {
  citedAliases,
  citedIdentity,
  inferCitedMarker,
  isBibliographyLine,
  isUsableContext,
  numericMarkers,
  pickQuote,
  sentenceTarget,
  shortPaperName,
  titleizeRationale,
} from "../../../src/lineage/classify/citedTarget.js";

const swin = {
  title: "Swin Transformer: Hierarchical Vision Transformer using Shifted Windows",
  authors: ["Ze Liu", "Yutong Lin"],
  year: 2021,
};
const pvt = {
  title: "Pyramid Vision Transformer: A Versatile Backbone for Dense Prediction",
  authors: ["Wenhai Wang"],
  year: 2021,
};
const fa = {
  title: "FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness",
  authors: [{ name: "Tri Dao" }, { name: "Daniel Y. Fu" }],
  year: 2022,
};

describe("isUsableContext / isBibliographyLine", () => {
  it("drops bare marker lists, bibliography lines and short fragments", () => {
    expect(isUsableContext("[19, 41].")).toBe(false);
    expect(isUsableContext("See [3].")).toBe(false);
    expect(isUsableContext("PVT-Small [34][arxiv 2021] 25 224(2) 3.")).toBe(false);
    const bib =
      "[17] Tri Dao, Daniel Y. Fu, Stefano Ermon, Atri Rudra, and Christopher Ré. FlashAttention: Fast and memory-efficient exact attention. In NeurIPS, 2022.";
    expect(isBibliographyLine(bib)).toBe(true);
    expect(isUsableContext(bib)).toBe(false);
    expect(
      isUsableContext("Swin Transformer [28] further introduces the inductive biases of locality."),
    ).toBe(true);
    // A sentence that merely starts with a marker is not a bibliography line.
    expect(
      isBibliographyLine("[5] proposed to reorder the attention computation with tiling."),
    ).toBe(false);
  });
});

describe("cited identity", () => {
  it("derives aliases from the title stem, its acronym and the first author", () => {
    expect(citedAliases(swin)).toEqual(
      expect.arrayContaining(["swin transformer", "swin", "liu et al"]),
    );
    expect(citedAliases(pvt)).toEqual(
      expect.arrayContaining(["pyramid vision transformer", "pvt"]),
    );
    expect(citedAliases({ title: "PVT v2: Improved baselines" })).toEqual(
      expect.arrayContaining(["pvt v2", "pvtv2"]),
    );
    // Generic first words are not aliases.
    expect(citedAliases({ title: "Video Swin Transformer" })).not.toContain("video");
  });

  it("infers the cited marker from a bibliography line, an alias, or single citations", () => {
    expect(
      inferCitedMarker(
        ["[17] Tri Dao, Daniel Y. Fu, Stefano Ermon. FlashAttention. In NeurIPS, 2022."],
        fa,
      ),
    ).toBe(17);
    expect(
      inferCitedMarker(
        [
          "Typical encodings include RPE [30, 35] and CPE [9].",
          "As our architecture is adapted from Swin Transformer [28], we initialise from it.",
          "Similar to image recognition [28], this 3D shifted window design adds connections.",
        ],
        swin,
      ),
    ).toBe(28);
    expect(
      inferCitedMarker(["Prior work [7] does X.", "It [7] also does Y."], { title: "X" }),
    ).toBe(7);
    expect(numericMarkers("see [3, 7-9] and [12]")).toEqual([3, 7, 8, 9, 12]);
  });

  it("classifies how a sentence refers to the cited paper", () => {
    const ctxs = ["Our method outperforms Swin Transformer [26], PVT [36] and DeiT [33]."];
    const idPvt = citedIdentity(pvt, ctxs);
    expect(idPvt.marker).toBe(36);
    expect(sentenceTarget(ctxs[0] as string, idPvt)).toBe("named");
    // Markers present, none of them the cited one.
    expect(sentenceTarget("For fair comparison, we follow [30, 47] and train FPN.", idPvt)).toBe(
      "other",
    );
    const anon = citedIdentity({ title: "Something" }, []);
    expect(sentenceTarget("Unlike [5], we use no convolutions.", anon)).toBe("single");
    expect(sentenceTarget("Unlike [3, 5], we use no convolutions.", anon)).toBe("pair");
    expect(sentenceTarget("Many works [3, 5, 8, 9] use attention.", anon)).toBe("multi");
    expect(sentenceTarget("Graph networks are popular for relational data.", anon)).toBe(
      "unmarked",
    );
  });
});

describe("pickQuote", () => {
  it("prefers the sentence whose subject is the cited paper and never quotes junk", () => {
    const ctxs = [
      "[19, 41].",
      "We show the effects of channel number and block number on model performance in Figs.",
      "A concurrent work [82] proposed a U-shaped architecture based on the Swin Transformer [56].",
      "Swin Transformer layer (STL) [56] is based on the standard multi-head self-attention.",
    ];
    expect(pickQuote(ctxs, citedIdentity(swin, ctxs))).toMatch(/^Swin Transformer layer \(STL\)/);
  });

  it("returns null when no usable sentence identifies the cited paper", () => {
    const ctxs = [
      "[19, 41].",
      "Memory access overhead is a critical factor affecting model speed [15, 28, 31, 65].",
    ];
    expect(pickQuote(ctxs, citedIdentity(fa, ctxs))).toBeNull();
  });
});

describe("short names and titleized rationales", () => {
  it("uses the title stem, else a trimmed title", () => {
    expect(shortPaperName(swin)).toBe("Swin Transformer");
    expect(
      shortPaperName({ title: "Graph neural networks for materials science and chemistry" }),
    ).toBe("Graph neural networks for mater…");
    expect(shortPaperName({})).toBe("引用元の論文");
  });

  it("replaces bare A / B with the papers' short names", () => {
    const a = { title: "FlashAttention: Fast and Memory-Efficient Exact Attention" };
    const b = { title: "FlashAttention-2: Faster Attention with Better Parallelism" };
    expect(titleizeRationale("B は A と同じ exact attention のまま A を置き換える。", a, b)).toBe(
      "「FlashAttention-2」 は 「FlashAttention」 と同じ exact attention のまま 「FlashAttention」 を置き換える。",
    );
    expect(titleizeRationale("B (FlashAttention-2) は論文 A を改良する。", a, b)).toBe(
      "「FlashAttention-2」 は「FlashAttention」 を改良する。",
    );
    // Titles, model sizes and English articles are left alone.
    const t = "『A ConvNet for the 2020s』は ViT-B と Swin-B を比較する。";
    expect(titleizeRationale(t, a, b)).toBe(t);
  });
});

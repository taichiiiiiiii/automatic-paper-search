/**
 * Vitest port of the off-topic/seed-filter tests in
 * `paperpilot/tests/test_build_theme_lineage.py` (LIN-29..32). Reads the
 * real `paperpilot/data/{lineage_denylist,theme_aliases,theme_blacklist}.json`
 * files (same files the Python code reads), so these tests double as a
 * drift check against the live curated lists.
 */
import { describe, expect, it } from "vitest";
import {
  aliasesFor,
  filterDenylistedSeeds,
  filterOffTopicRefs,
  filterThemeBlacklist,
  filterTopicRelevantSeeds,
  isImplementationFoundation,
  isTopicRelevant,
  minTokenDistance,
  normalizeRelevanceText,
} from "../../../src/lineage/theme/seedFilters.js";

describe("normalizeRelevanceText", () => {
  it("lowercases, replaces hyphens with spaces, collapses whitespace", () => {
    expect(normalizeRelevanceText("Self-Supervised   Learning")).toBe("self supervised learning");
  });
});

describe("minTokenDistance", () => {
  it("finds the minimum distance between stem-matched tokens", () => {
    expect(minTokenDistance("real world weight cross entropy modeling", "world", "model")).toBe(4);
    expect(minTokenDistance("ddpm diffusion model", "world", "model")).toBeNull();
  });
});

describe("isTopicRelevant / filterTopicRelevantSeeds (LIN-30)", () => {
  it("skips the gate entirely for short/single-word themes", () => {
    expect(isTopicRelevant({ title: "totally unrelated", abstract: "" }, "RAG")).toBe(true);
  });

  it("two-word theme requires both words present AND in-title within the distance bound", () => {
    // LPIPS regression (#209, real Python fixture): both words present in
    // the abstract, never as a verbatim phrase, and absent from the title.
    const lpips = {
      title: "The Unreasonable Effectiveness of Deep Features as a Perceptual Metric",
      abstract:
        "we apply supervised, self-supervised, and even unsupervised deep features to evaluate perceptual similarity.",
    };
    expect(isTopicRelevant(lpips, "Self-Supervised Learning")).toBe(false);

    const onTopic = {
      title: "Self-Supervised Learning of Visual Features",
      abstract: "we propose a method",
    };
    expect(isTopicRelevant(onTopic, "self-supervised learning")).toBe(true);
  });

  it("hyphen/space normalisation: both spellings of the theme match", () => {
    const hyphen = {
      title: "Self-Supervised Learning of Visual Features",
      abstract: "we study self-supervised learning ...",
    };
    const space = {
      title: "A Survey of Self Supervised Learning",
      abstract: "self supervised learning has matured ...",
    };
    expect(isTopicRelevant(hyphen, "Self-Supervised Learning")).toBe(true);
    expect(isTopicRelevant(space, "Self-Supervised Learning")).toBe(true);
  });

  it("verbatim phrase match short-circuits to true even for a 2-word theme", () => {
    const paper = { title: "On Self Supervised Learning", abstract: "" };
    expect(isTopicRelevant(paper, "self-supervised learning")).toBe(true);
  });

  it("3+ word theme requires ceil(N/2) distinct words anywhere in title+abstract", () => {
    const paper = {
      title: "Graph Neural Networks for Node Classification",
      abstract: "we study graphs",
    };
    // "graph neural network classification" -> 4 words, threshold = 2.
    expect(isTopicRelevant(paper, "graph neural network classification")).toBe(true);
    const offTopic = { title: "Unrelated Topic Entirely", abstract: "nothing relevant here" };
    expect(isTopicRelevant(offTopic, "graph neural network classification")).toBe(false);
  });

  it("filterTopicRelevantSeeds drops the off-topic seed (LPIPS) and keeps the on-topic one (SimCLR)", () => {
    const seeds = [
      {
        paperId: "lpips",
        title: "The Unreasonable Effectiveness of Deep Features as a Perceptual Metric",
        abstract:
          "we apply supervised, self-supervised, and even unsupervised deep features to evaluate perceptual similarity.",
      },
      {
        paperId: "simclr",
        title: "A Simple Framework for Contrastive Learning of Visual Representations",
        abstract:
          "We present SimCLR, a simple framework for contrastive self-supervised learning of visual representations.",
      },
    ];
    const kept = filterTopicRelevantSeeds(seeds, "Self-Supervised Learning");
    expect(kept.map((s) => s.paperId)).toEqual(["simclr"]);
  });

  it("handles an empty seed list", () => {
    expect(filterTopicRelevantSeeds([], "anything")).toEqual([]);
  });
});

describe("isImplementationFoundation / filterDenylistedSeeds (LIN-29)", () => {
  it("drops known library papers by paperId from the real denylist file", () => {
    // From paperpilot/data/lineage_denylist.json's paper_ids list.
    expect(
      isImplementationFoundation({ paperId: "a6cb366736791bcccc5c8639de5a8f9636bf87e8" }),
    ).toBe(true);
  });

  it("drops known library papers by title regex (Adam, TensorFlow, ...)", () => {
    expect(
      isImplementationFoundation({
        paperId: "unrelated-id",
        title: "Adam: A Method for Stochastic Optimization",
      }),
    ).toBe(true);
    expect(
      isImplementationFoundation({ paperId: "unrelated-id-2", title: "TensorFlow: a system" }),
    ).toBe(true);
  });

  it("keeps a topic-specific library (PyTorch Geometric) that the title pattern does not catch", () => {
    expect(
      isImplementationFoundation({
        paperId: "63a513832f56addb67be81a2fa399b233f3030fc",
        title: "Fast Graph Representation Learning with PyTorch Geometric",
      }),
    ).toBe(false);
  });

  it("keeps a genuinely unrelated paper", () => {
    expect(isImplementationFoundation({ paperId: "zzz", title: "Some Research Paper" })).toBe(
      false,
    );
  });

  it("filterDenylistedSeeds drops the matched seed only", () => {
    const seeds = [
      { paperId: "a6cb366736791bcccc5c8639de5a8f9636bf87e8", title: "Adam" },
      { paperId: "keep-me", title: "Some Research Paper" },
    ];
    expect(filterDenylistedSeeds(seeds).map((s) => s.paperId)).toEqual(["keep-me"]);
  });
});

describe("filterOffTopicRefs (LIN-32)", () => {
  it("drops a high-cite paper with no methodology intent", () => {
    const refs = [{ paperId: "foundational", citationCount: 100_000, title: "Foundational" }];
    const kept = filterOffTopicRefs(refs, { maxSeedCite: 1000 });
    expect(kept).toEqual([]);
  });

  it("keeps a high-cite paper that does carry a methodology intent", () => {
    const refs = [
      {
        paperId: "foundational",
        citationCount: 100_000,
        title: "Foundational",
        _intents: ["methodology"],
      },
    ];
    const kept = filterOffTopicRefs(refs, { maxSeedCite: 1000 });
    expect(kept.map((r) => r.paperId)).toEqual(["foundational"]);
  });

  it("the denylist check is unconditional, even with a methodology intent", () => {
    const refs = [
      {
        paperId: "a6cb366736791bcccc5c8639de5a8f9636bf87e8",
        citationCount: 5,
        title: "Adam",
        _intents: ["methodology"],
      },
    ];
    expect(filterOffTopicRefs(refs, { maxSeedCite: 1000 })).toEqual([]);
  });

  it("uses the tighter 2x multiplier (not 3x)", () => {
    // maxSeedCite=100 -> ceiling=200. A ref at 250 cites with no
    // methodology intent must be dropped (would have survived a 3x=300 ceiling).
    const refs = [{ paperId: "borderline", citationCount: 250, title: "Borderline" }];
    expect(filterOffTopicRefs(refs, { maxSeedCite: 100 })).toEqual([]);
    const underCeiling = [{ paperId: "under", citationCount: 150, title: "Under" }];
    expect(filterOffTopicRefs(underCeiling, { maxSeedCite: 100 }).map((r) => r.paperId)).toEqual([
      "under",
    ]);
  });

  it("passes everything through when maxSeedCite is 0", () => {
    const refs = [{ paperId: "x", citationCount: 999_999, title: "X" }];
    expect(filterOffTopicRefs(refs, { maxSeedCite: 0 }).map((r) => r.paperId)).toEqual(["x"]);
  });
});

describe("aliasesFor (LIN-26, real theme_aliases.json)", () => {
  it("returns the known alias for a known theme, case-insensitively", () => {
    expect(aliasesFor("speculative decoding")).toContain("speculative sampling");
    expect(aliasesFor("Speculative Decoding")).toContain("speculative sampling");
    expect(aliasesFor("  MOE  ")).toEqual(expect.arrayContaining(["mixture-of-experts"]));
  });

  it("returns an empty array for an unknown theme", () => {
    expect(aliasesFor("totally-unknown-theme-xyz")).toEqual([]);
  });
});

describe("filterThemeBlacklist (LIN-31, real theme_blacklist.json)", () => {
  it("vetoes a lip-to-speech paper for the flash-attention theme", () => {
    const seeds = [
      { paperId: "a", title: "Lip-to-Speech Synthesis", abstract: "" },
      { paperId: "b", title: "FlashAttention: Fast Attention", abstract: "" },
    ];
    const kept = filterThemeBlacklist(seeds, "flash-attention");
    expect(kept.map((s) => s.paperId)).toEqual(["b"]);
  });

  it("is a no-op for a theme with no blacklist entry", () => {
    const seeds = [{ paperId: "a", title: "Anything", abstract: "" }];
    expect(filterThemeBlacklist(seeds, "totally-unknown-theme-xyz")).toEqual(seeds);
  });
});

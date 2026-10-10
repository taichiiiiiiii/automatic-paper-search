/**
 * R2-17: application-title topic gate (ERROR_PATTERNS 11) and node
 * metadata sanity (ERROR_PATTERNS 13).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ThemeGraphNode } from "../../../src/lineage/shared/node.js";
import { enrichGithubStars, ownerMatchesAuthors } from "../../../src/lineage/theme/github.js";
import { abstractContradictsTitle } from "../../../src/lineage/theme/openalexWork.js";
import { TopicScope } from "../../../src/lineage/theme/topicScope.js";

describe("application titles use the theme as a tool (ERROR_PATTERNS 11)", () => {
  const vit = TopicScope.forTheme("Vision Transformer");
  const gnn = TopicScope.forTheme("Graph Neural Network");
  const moe = TopicScope.forTheme("Mixture of Experts");

  it("'<theme> drives/for/in/based <task>' is a component; theme after the connector stays subject", () => {
    expect(
      vit.role({
        title:
          "SwinNet: Swin Transformer drives edge-aware RGB-D and RGB-T salient object detection",
      }),
    ).toBe("component");
    expect(gnn.role({ title: "Graph Neural Networks for Social Recommendation" })).toBe(
      "component",
    );
    expect(
      gnn.role({ title: "E-GraphSAGE: A Graph Neural Network based Intrusion Detection System" }),
    ).toBe("component");
    expect(moe.role({ title: "StableMoE: Stable Routing Strategy for Mixture of Experts" })).toBe(
      "subject",
    );
    expect(gnn.role({ title: "Heterogeneous Graph Neural Network" })).toBe("subject");
    expect(gnn.role({ title: "Graph Neural Networks with Heterophily" })).toBe("subject");
    // A survey of an application area is still a survey of the theme.
    expect(gnn.role({ title: "Graph Neural Networks in Recommender Systems: A Survey" })).toBe(
      "subject",
    );
    // The rest of the clause names the theme again.
    expect(
      gnn.role({ title: "Graph Neural Networks for Pre-training Graph Neural Networks" }),
    ).toBe("subject");
  });

  it("abstractIsAboutTheme: a theme term in the first sentence or two mentions", () => {
    expect(
      gnn.abstractIsAboutTheme({ abstract: "Graph neural networks are popular. We study X." }),
    ).toBe(true);
    expect(
      gnn.abstractIsAboutTheme({
        abstract: "We study recommendation. A GNN encodes users. The GNN is trained jointly.",
      }),
    ).toBe(true);
    expect(
      gnn.abstractIsAboutTheme({
        abstract: "We study RGB-D segmentation. Our backbone is a graph neural network.",
      }),
    ).toBe(false);
    expect(gnn.abstractIsAboutTheme({})).toBe(false);
  });

  it("a component-title reference needs an abstract about the theme, else z >= zHi + 0.25", () => {
    const app = {
      title: "3D Graph Neural Networks for RGBD Semantic Segmentation",
      abstract: "RGBD semantic segmentation needs 3D reasoning. We build a k-NN graph on points.",
    };
    expect(gnn.admits(app, 0, 0.9)).toBeNull();
    expect(gnn.admits(app, 0, 1.3)).toBe("embedding");
    expect(
      gnn.admits({ ...app, abstract: "Graph neural networks segment RGBD images." }, 0, 0.9),
    ).toBe("topic");
    // A reference without the theme in its title keeps the doc-42 rule.
    expect(
      gnn.admits({ title: "DeepWalk", abstract: "Latent representations of vertices." }, 0, 1.1),
    ).toBe("embedding");
    // The option switches the rule off.
    const off = TopicScope.forTheme("Graph Neural Network", { requireAbstractSubject: false });
    expect(off.admits(app, 0, 0.9)).toBe("topic");
  });

  it("a citing paper without a theme title needs an abstract about the theme (EfficientViT shape)", () => {
    const fa = TopicScope.forTheme("Flash Attention");
    const effvit = {
      title: "EfficientViT: Memory Efficient Vision Transformer with Cascaded Group Attention",
      abstract: "Vision transformers are costly. We propose cascaded group attention.",
    };
    expect(fa.admitsDescendant(effvit, 1.07)).toBeNull();
    expect(fa.admitsDescendant(effvit, 1.3)).toBe("topic");
  });
});

describe("abstract / title sanity (ERROR_PATTERNS 13)", () => {
  const FA1 = "FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness";

  it("flags an abstract that discusses a later version of the paper (OpenAlex W4281758439)", () => {
    expect(
      abstractContradictsTitle(
        FA1,
        "This note bounds the forward error of FlashAttention-2 for one query; FlashAttention-3 merges this way.",
      ),
    ).toBe(true);
    expect(
      abstractContradictsTitle(
        FA1,
        "We propose FlashAttention, an IO-aware exact attention algorithm that uses tiling.",
      ),
    ).toBe(false);
    expect(
      abstractContradictsTitle(
        "FlashAttention-3: Fast and Accurate Attention",
        "FlashAttention-2 underutilises H100s; FlashAttention-3 fixes this.",
      ),
    ).toBe(false);
    // Model sizes are not versions.
    expect(abstractContradictsTitle("Gemma: Open Models", "We release Gemma 2B and 7B.")).toBe(
      false,
    );
  });

  it("flags an abstract sharing no distinctive title word", () => {
    expect(
      abstractContradictsTitle(
        "Pyramid Vision Transformer: Versatile Backbone for Dense Prediction",
        "We report rainfall statistics in coastal regions over two decades. ".repeat(4),
      ),
    ).toBe(true);
    // Too short to judge (synthetic / truncated abstracts).
    expect(
      abstractContradictsTitle(
        "Pyramid Vision Transformer: Versatile Backbone for Dense Prediction",
        "We report rainfall statistics.",
      ),
    ).toBe(false);
    expect(abstractContradictsTitle("Short Title", "Unrelated text entirely.")).toBe(false);
  });
});

describe("GitHub title-search hits (ERROR_PATTERNS 13)", () => {
  it("ownerMatchesAuthors: surname / name token / initial+surname handles", () => {
    expect(ownerMatchesAuthors("Dao-AILab/flash-attention", ["Tri Dao"])).toBe(true);
    expect(ownerMatchesAuthors("tridao/flash-attention", ["Tri Dao"])).toBe(true);
    expect(ownerMatchesAuthors("xrsrke/flashattention", ["Tri Dao", "Daniel Y. Fu"])).toBe(false);
    expect(ownerMatchesAuthors("whai362/PVT", ["Wenhai Wang"])).toBe(false);
  });

  it("drops a low-star search hit whose owner is not an author; keeps curated and popular repos", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-r217-"));
    const mk = (id: string, ax: string): ThemeGraphNode =>
      ({ id, title: `Paper ${id}`, arxiv_id: ax, authors: ["Tri Dao"], github_stars: 0 }) as never;
    const nodes = [mk("a", "2205.14135"), mk("b", "2307.08691"), mk("c", "2407.08608")];
    const repos: Record<string, string> = {
      "Paper a": "xrsrke/flashattention",
      "Paper b": "someone/popular",
      "Paper c": "tridao/fa3",
    };
    const stars: Record<string, number> = {
      "xrsrke/flashattention": 5,
      "someone/popular": 500,
      "tridao/fa3": 7,
    };
    const n = await enrichGithubStars(nodes, {
      cachePath: join(dir, "gh.json"),
      curated: {},
      searchRepo: async (title) => repos[title] ?? null,
      fetchStars: async (repo) => stars[repo] ?? null,
      now: () => new Date("2026-10-10T00:00:00Z"),
    });
    expect(n).toBe(2);
    expect(nodes.map((x) => x.github_stars)).toEqual([0, 500, 7]);
    // The cached weak hit is not resurrected on the next run either.
    const again = [mk("a", "2205.14135")];
    await enrichGithubStars(again, {
      cachePath: join(dir, "gh.json"),
      curated: {},
      searchRepo: async () => null,
      fetchStars: async () => null,
      now: () => new Date("2026-10-11T00:00:00Z"),
    });
    expect(again[0]?.github_stars).toBe(0);
  });
});

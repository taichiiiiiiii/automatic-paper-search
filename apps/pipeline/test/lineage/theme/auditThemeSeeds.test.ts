/**
 * Vitest port of `paperpilot/tests/test_audit_theme_seeds.py`
 * (LIN-34).
 */
import { describe, expect, it } from "vitest";
import {
  isOnTopic,
  normalize,
  stem,
  stemContains,
} from "../../../src/lineage/theme/auditThemeSeeds.js";

describe("normalize", () => {
  it("handles hyphens and whitespace", () => {
    expect(normalize("Self-Supervised Learning")).toBe("self supervised learning");
    expect(normalize("  Mixture  of   Experts  ")).toBe("mixture of experts");
    expect(normalize("Chain-of-Thought")).toBe("chain of thought");
  });
});

describe("isOnTopic", () => {
  it("skips the filter for single-word themes", () => {
    expect(isOnTopic("RAG", { title: "anything", tldr: "anything" })).toBe(true);
  });

  it("drops LPIPS against Self-Supervised Learning (words only in abstract, not title)", () => {
    const paper = {
      title: "The Unreasonable Effectiveness of Deep Features",
      tldr: "supervised, self-supervised, and even unsupervised; deep learning",
    };
    expect(isOnTopic("Self-Supervised Learning", paper)).toBe(false);
  });

  it("keeps DDPM against Diffusion Models via the title-only fallback", () => {
    const paper = {
      title: "Denoising Diffusion Probabilistic Models",
      tldr: "we present diffusion probabilistic models for image synthesis",
    };
    expect(isOnTopic("Diffusion Models", paper)).toBe(true);
  });

  it("keeps a phrase match across hyphen normalisation", () => {
    const paper = {
      title: "Self-Supervised Learning of Visual Features",
      tldr: "self-supervised learning matured rapidly post-2020",
    };
    expect(isOnTopic("Self-Supervised Learning", paper)).toBe(true);
  });

  it("three-word theme: phrase or ceil(N/2) partial match", () => {
    const paper = {
      title: "Preference Optimization without DPO",
      tldr: "we revisit preference optimization without ...",
    };
    expect(isOnTopic("Direct Preference Optimization", paper)).toBe(true);
  });

  it("three-word theme drops a single-word match", () => {
    const paper = {
      title: "On the Convergence of Direct Methods",
      tldr: "direct methods in numerical analysis",
    };
    expect(isOnTopic("Direct Preference Optimization", paper)).toBe(false);
  });
});

describe("stem", () => {
  it("strips common suffixes so inflectional variants collapse to the same stem", () => {
    expect(stem("distillation")).toBe(stem("distilled"));
    expect(stem("distilled")).toBe(stem("distilling"));
    expect(stem("distillation")).toBe("distill");
    expect(stem("supervision")).toBe(stem("supervised"));
    expect(stem("supervised")).toBe(stem("supervising"));
    expect(stem("optimization")).toBe(stem("optimizing"));
    expect(stem("optimization")).toBe("optimiz");
  });

  it("preserves short words (< 5 chars)", () => {
    expect(stem("self")).toBe("self");
    expect(stem("the")).toBe("the");
    expect(stem("at")).toBe("at");
    expect(stem("each")).toBe("each");
  });

  it("is idempotent", () => {
    expect(stem(stem("distillation"))).toBe(stem("distillation"));
    expect(stem(stem("supervised"))).toBe(stem("supervised"));
  });
});

describe("stemContains", () => {
  it("matches inflectional variants via the shared stem", () => {
    expect(stemContains("distilbert a distilled version of bert", "distillation")).toBe(true);
    expect(stemContains("we propose self supervised pretraining", "supervision")).toBe(true);
    expect(stemContains("ablation studies for the proposed method", "ablations")).toBe(true);
  });
});

describe("isOnTopic (stemming-assisted)", () => {
  it("keeps DistilBERT for Knowledge Distillation via a verbatim tldr phrase", () => {
    const paper = {
      title: "DistilBERT, a distilled version of BERT: smaller, faster, cheaper and lighter",
      tldr: "we apply knowledge distillation to BERT, producing a model that is 40% smaller, 60% faster, and retains 97% of accuracy",
    };
    expect(isOnTopic("Knowledge Distillation", paper)).toBe(true);
  });

  it("stemming helps a 3-word theme match inflected title/tldr words", () => {
    const paper = {
      title: "Searching for Neural Architectures via Reinforcement Learning",
      tldr: "we propose a method for searching neural network architectures",
    };
    expect(isOnTopic("Neural Architecture Search", paper)).toBe(true);
  });

  it("keeps SimCLR for Self-Supervised Learning via tldr", () => {
    const paper = {
      title: "A Simple Framework for Contrastive Learning of Visual Representations",
      tldr: "we present simclr, a simple framework for contrastive self-supervised learning of visual representations",
    };
    expect(isOnTopic("Self-Supervised Learning", paper)).toBe(true);
  });

  it("keeps ViT for Vision Transformer via tldr", () => {
    const paper = {
      title: "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
      tldr: "vision transformer applied directly to image patches outperforms CNN baselines",
    };
    expect(isOnTopic("Vision Transformer", paper)).toBe(true);
  });
});

describe("isOnTopic (short_abstract field, #245)", () => {
  it("prefers short_abstract over tldr, recovering a false positive", () => {
    const shortAbstract =
      "While the Transformer architecture has become the de-facto " +
      "standard for natural language processing tasks, its applications " +
      "to computer vision remain limited. In vision, attention is either " +
      "applied in conjunction with convolutional networks, or used to " +
      "replace certain components of convolutional networks while keeping " +
      "their overall structure in place. We show that this reliance on " +
      "CNNs is not necessary and a pure transformer applied directly " +
      "to sequences of image patches can perform very well on image " +
      "classification tasks. When pre-trained on large amounts of data " +
      "and transferred to multiple mid-sized or small image recognition " +
      "benchmarks (ImageNet, CIFAR-100, VTAB, etc.), Vision Transformer " +
      "(ViT) attains excellent results compared to state-of-the-art " +
      "convolutional networks while requiring substantially fewer " +
      "computational resources to train.";
    const tldr = shortAbstract.slice(0, 140);
    const paperLegacy = {
      title: "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
      tldr,
    };
    const paperNew = { ...paperLegacy, short_abstract: shortAbstract };
    expect(isOnTopic("Vision Transformer", paperLegacy)).toBe(false);
    expect(isOnTopic("Vision Transformer", paperNew)).toBe(true);
  });

  it("falls back to tldr for legacy lineage with no short_abstract", () => {
    const paper = {
      title: "Diffusion Models in Practice",
      tldr: "we present diffusion models for image synthesis",
    };
    expect(isOnTopic("Diffusion Models", paper)).toBe(true);
  });

  it("handles an empty/null short_abstract defensively", () => {
    const paper = {
      title: "Self-Supervised Learning of Visual Features",
      tldr: "",
      short_abstract: null,
    };
    expect(isOnTopic("Self-Supervised Learning", paper)).toBe(true);
  });
});

describe("isOnTopic (title-only fallback distance bound, 2026-06-05 followup)", () => {
  it("drops World Model compound-term false matches", () => {
    const cases = [
      "The Real-World-Weight Cross-Entropy Loss Function: Modeling the Costs of Mislabeling",
      "Toward Real-World Single Image Super-Resolution: A New Benchmark and a New Model",
      "A whole-slide foundation model for digital pathology from real-world data",
    ];
    for (const title of cases) {
      expect(isOnTopic("World Model", { title, tldr: "" })).toBe(false);
    }
  });

  it("keeps legitimate World Model seeds (verbatim phrase)", () => {
    const legit = [
      "Mastering diverse control tasks through world models",
      "Deep learning, reinforcement learning, and world models",
    ];
    for (const title of legit) {
      expect(isOnTopic("World Model", { title, tldr: "" })).toBe(true);
    }
  });
});

/**
 * R2-15: the shared survey/review test (`shared/surveyLike.ts`) — publication
 * type, title and abstract — and its use by the S2 rule set.
 */
import { describe, expect, it } from "vitest";
import { classifyApiRelationV2 } from "../../../src/lineage/classify/apiRelations.js";
import {
  hasReviewPublicationType,
  isSurveyLike,
  isSurveyLikeAbstract,
  isSurveyLikeTitle,
} from "../../../src/lineage/shared/surveyLike.js";
import { workToPaperDict } from "../../../src/lineage/theme/openalexWork.js";

describe("isSurveyLikeTitle", () => {
  it("matches survey words and phrases", () => {
    for (const t of [
      "A Comprehensive Survey on Graph Neural Networks",
      "Graph convolutional networks: a comprehensive review",
      "Towards Incremental Learning in LLMs: A Critical Review",
      "Mixture of Experts: An Overview",
      "A Tutorial on Graph Representation Learning",
      "A Primer on Neural Network Models for NLP",
      "A Perspective on Geometric Deep Learning",
      "Roadmap for Continual Learning",
      "A Comprehensive Study of Vision Transformers",
      "Recent Advances in Graph Neural Networks",
      "Graph Learning: Challenges and Opportunities",
      "Deep learning for molecules: the state of the art",
      "State of the art and open problems in graph learning",
      "An Introduction to Graph Neural Networks",
    ]) {
      expect(isSurveyLikeTitle(t), t).toBe(true);
    }
  });

  it("does not match method papers or look-alike words", () => {
    for (const t of [
      "Graph neural networks for materials science and chemistry",
      "SuperGlue: Learning Feature Matching With Graph Neural Networks",
      "Reviewer Assignment with GNNs",
      "Review-based Recommendation with Graph Neural Networks",
      "Multi-perspective Context Matching for Machine Comprehension",
      "Achieving State-of-the-art Results with Simple Baselines",
      "Deep Residual Learning for Image Recognition",
      "Attention Is All You Need",
      "Video Surveillance with Transformers",
    ]) {
      expect(isSurveyLikeTitle(t), t).toBe(false);
    }
    expect(isSurveyLikeTitle(undefined)).toBe(false);
    expect(isSurveyLikeTitle(42)).toBe(false);
  });
});

describe("isSurveyLikeAbstract", () => {
  it("matches self-referential survey statements", () => {
    for (const a of [
      "In this Review, we provide an overview of the basic principles of GNNs.",
      "We review recent progress in graph learning.",
      "In this survey, we categorise existing methods.",
      "We survey the literature on mixture-of-experts models.",
      "This article reviews attention mechanisms.",
      "We provide a comprehensive overview of vision transformers.",
      "This paper presents a comprehensive overview of FlashAttention variants.",
      "We summarize recent developments in graph neural networks.",
    ]) {
      expect(isSurveyLikeAbstract({ abstract: a }), a).toBe(true);
    }
  });

  it("ignores a method paper's related-work aside", () => {
    for (const a of [
      "We propose a new graph neural network. We briefly review message passing first.",
      "We review related work in Section 2 and then present our model.",
      "We present a novel attention kernel that is 2x faster.",
    ]) {
      expect(isSurveyLikeAbstract({ abstract: a }), a).toBe(false);
    }
  });

  it("reads short_abstract and tldr too", () => {
    expect(isSurveyLikeAbstract({ short_abstract: "In this survey, we ..." })).toBe(true);
    expect(isSurveyLikeAbstract({ tldr: "This review covers GNNs." })).toBe(true);
  });
});

describe("publication type", () => {
  it("OpenAlex type and S2 publicationTypes", () => {
    expect(hasReviewPublicationType({ publicationType: "review" })).toBe(true);
    expect(hasReviewPublicationType({ type: "Review" })).toBe(true);
    expect(hasReviewPublicationType({ publicationTypes: ["JournalArticle", "Review"] })).toBe(true);
    expect(hasReviewPublicationType({ publicationType: "article" })).toBe(false);
    expect(hasReviewPublicationType({ publicationTypes: null })).toBe(false);
  });

  it("workToPaperDict carries the OpenAlex type as publicationType", () => {
    const p = workToPaperDict({
      id: "https://openalex.org/W1",
      title: "GNNs in chemistry",
      type: "review",
    });
    expect(p?.publicationType).toBe("review");
    expect(isSurveyLike(p)).toBe(true);
    const q = workToPaperDict({ id: "https://openalex.org/W2", title: "GNNs in chemistry" });
    expect(q && "publicationType" in q).toBe(false);
  });
});

describe("isSurveyLike", () => {
  it("combines type, title and abstract; defensive on bad input", () => {
    expect(
      isSurveyLike({
        title: "Graph neural networks for materials science and chemistry",
        short_abstract: "In this Review, we provide an overview of the basic principles of GNNs.",
      }),
    ).toBe(true);
    expect(
      isSurveyLike({ title: "Graph neural networks for materials science and chemistry" }),
    ).toBe(false);
    expect(isSurveyLike(null)).toBe(false);
    expect(isSurveyLike(undefined)).toBe(false);
    expect(isSurveyLike({})).toBe(false);
  });
});

describe("S2 rule set v2 uses the full survey test", () => {
  const base = {
    found: true,
    intents: [],
    isInfluential: true,
    contexts: ["Our model builds on [3]."],
  };
  it("citingSurvey overrides the title-only test", () => {
    const materials = "Graph neural networks for materials science and chemistry";
    expect(classifyApiRelationV2({ ...base, citingTitle: materials }).rule).toBe("phrase_build");
    expect(
      classifyApiRelationV2({ ...base, citingTitle: materials, citingSurvey: true }).rule,
    ).toBe("citing_survey");
    expect(
      classifyApiRelationV2({ ...base, citingTitle: "A Survey of GNNs", citingSurvey: false }).rule,
    ).toBe("phrase_build");
    // Title fallback when the flag is absent.
    expect(classifyApiRelationV2({ ...base, citingTitle: "A Survey of GNNs" }).rule).toBe(
      "citing_survey",
    );
  });
});

"""LLM base: PaperEvaluation parsing and prompt builder tests."""

from __future__ import annotations

from datetime import date

from paperpilot.llm.base import (
    AbstractLLMProvider,
    PaperEvaluation,
    RelationClassification,
    build_classify_prompt,
    build_evaluation_prompt,
)
from paperpilot.models import Paper


def test_paper_evaluation_from_dict_ok():
    ev = PaperEvaluation.from_dict(
        {"relevance": 4, "summary_ja": "要約", "reason": "理由", "tags": ["新手法"]}
    )
    assert ev is not None
    assert ev.relevance == 4
    assert ev.summary_ja == "要約"
    assert ev.reason == "理由"
    assert ev.tags == ["新手法"]


def test_paper_evaluation_invalid_relevance():
    assert PaperEvaluation.from_dict({"relevance": 0}) is None
    assert PaperEvaluation.from_dict({"relevance": 6}) is None
    assert PaperEvaluation.from_dict({"relevance": "x"}) is None
    assert PaperEvaluation.from_dict({}) is None


def test_paper_evaluation_non_dict():
    assert PaperEvaluation.from_dict("not a dict") is None
    assert PaperEvaluation.from_dict(None) is None


def test_paper_evaluation_tags_fallback():
    ev = PaperEvaluation.from_dict({"relevance": 3, "tags": "not a list"})
    assert ev is not None
    assert ev.tags == []


def test_build_evaluation_prompt_contains_profile_and_papers():
    papers = [
        Paper(
            title="Paper A",
            authors=["Alice"],
            abstract="Abstract A content.",
            url="http://x/1",
            published_date=date.today(),
            source="arxiv",
            categories=["cs.CL"],
            venue="ICLR",
            github_stars=100,
            citation_count=42,
        )
    ]
    system, user = build_evaluation_prompt(papers, "RAG research")
    assert "JSON配列" in system
    assert "RAG research" in user
    assert "Paper A" in user
    assert "ICLR" in user


def test_build_prompt_fallback_profile_when_empty():
    papers = [
        Paper(
            title="X",
            authors=[],
            abstract="",
            url="u",
            published_date=date.today(),
            source="arxiv",
        )
    ]
    _, user = build_evaluation_prompt(papers, "")
    assert "プロファイル未設定" in user


# ---- RelationClassification ----


def test_relation_classification_from_dict_ok():
    rc = RelationClassification.from_dict(
        {"relation": "supersedes", "confidence": 0.82, "rationale": "同じ課題を改良"}
    )
    assert rc is not None
    assert rc.relation == "supersedes"
    assert rc.confidence == 0.82
    assert rc.rationale == "同じ課題を改良"


def test_relation_classification_rejects_invalid_relation():
    assert RelationClassification.from_dict(
        {"relation": "bogus", "confidence": 0.5, "rationale": "x"}
    ) is None
    assert RelationClassification.from_dict({"confidence": 0.5}) is None
    assert RelationClassification.from_dict(None) is None


def test_relation_classification_requires_rationale():
    # An empty rationale would render an empty tooltip in the viewer — reject.
    assert RelationClassification.from_dict(
        {"relation": "extends", "confidence": 0.6, "rationale": "   "}
    ) is None


def test_relation_classification_clamps_confidence():
    rc = RelationClassification.from_dict(
        {"relation": "contrasts", "confidence": 1.7, "rationale": "異なる手法"}
    )
    assert rc is not None
    assert rc.confidence == 1.0
    rc2 = RelationClassification.from_dict(
        {"relation": "contrasts", "confidence": -0.3, "rationale": "異なる手法"}
    )
    assert rc2 is not None
    assert rc2.confidence == 0.0


def test_build_classify_prompt_contains_both_papers():
    a = {"title": "AlphaNet", "year": 2020, "abstract": "First idea."}
    b = {"title": "BetaNet", "year": 2024, "abstract": "Improved version."}
    system, user = build_classify_prompt(a, b)
    assert "supersedes" in system
    assert "AlphaNet" in user
    assert "BetaNet" in user
    assert "2020" in user
    assert "2024" in user


def test_abstract_provider_classify_relation_returns_none_by_default():
    # Providers that don't override classify_relation must return None (opt-in feature)
    class Dummy(AbstractLLMProvider):
        name = "dummy"

        def evaluate_batch(self, papers, profile):
            return [None] * len(papers)

    provider = Dummy({"enabled": True})
    assert provider.classify_relation({"title": "x"}, {"title": "y"}) is None

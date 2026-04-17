"""LLM base: PaperEvaluation parsing and prompt builder tests."""

from __future__ import annotations

from datetime import date

from paperpilot.llm.base import PaperEvaluation, build_evaluation_prompt
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

"""LLM base: PaperEvaluation parsing and prompt builder tests."""

from __future__ import annotations

from datetime import date

from paperpilot.llm.base import (
    CLASSIFY_SYSTEM_PROMPT,
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


# ---- Prompt quality (#131) ----
# The Llama 3.3 70B production trace showed the LLM consistently
# regurgitating the heuristic templates instead of comparing the two
# abstracts — every "extends" edge had rationale "論文 B は論文 A の
# 手法を異なる領域・タスク・スケールに拡張している。", which is literally
# the Japanese translation of the prompt's `extends:` definition. The
# system prompt now (a) demands paper-specific content, (b) lists the
# templates as forbidden outputs, and (c) shows good/bad examples.


def test_classify_prompt_demands_paper_specific_content():
    """The system prompt must explicitly require referencing a concrete
    technical concept from the abstracts so the LLM stops translating the
    enum definition. This is the core fix for #131 — the prompt is the
    only place where the LLM learns what 'good rationale' looks like."""
    system_lower = CLASSIFY_SYSTEM_PROMPT.lower()
    # Some signal that the prompt asks for concrete content — wording can
    # evolve, but at least one of these markers must survive a refactor.
    markers = ["specific", "concrete", "technical concept", "abstract",
               "paper-specific", "must reference", "must mention"]
    assert any(m in system_lower for m in markers), (
        f"prompt no longer demands paper-specific content: {CLASSIFY_SYSTEM_PROMPT}"
    )


def test_classify_prompt_forbids_template_phrasings():
    """The system prompt must list the heuristic templates as forbidden
    outputs. If the LLM emits one anyway, ``RelationClassification.from_dict``
    has a second-line defence (test below), but the prompt is the cheapest
    place to stop it."""
    # At least one of the canonical heuristic templates must appear in the
    # prompt as a "do not output" example.
    template_fragments = [
        "異なる領域・タスク・スケール",  # extends template
        "研究ラインを継承",  # successor template
        "ベースライン比較にのみ",  # baseline_only template
    ]
    matched = [f for f in template_fragments if f in CLASSIFY_SYSTEM_PROMPT]
    assert len(matched) >= 2, (
        f"prompt must call out at least 2 template phrasings as forbidden; "
        f"only found: {matched}"
    )


def test_classify_prompt_includes_good_examples():
    """Few-shot good examples teach the LLM what paper-specific looks
    like. Without these the LLM falls back to the safest abstract output —
    which is the template translation. The exact wording is flexible but
    SOMETHING that looks like a sample rationale must be present."""
    # An "examples" / "good" section, and at least one example that name-
    # drops a real concept (so the LLM sees the pattern).
    assert "example" in CLASSIFY_SYSTEM_PROMPT.lower(), (
        "prompt lacks the few-shot examples that teach paper-specific output"
    )


def test_relation_classification_rejects_known_template_rationale():
    """Second-line defence (#131): if the LLM regurgitates a template
    string verbatim, treat the response as a failure and fall back to
    the heuristic — outputting the heuristic from ``_apply_llm_classification``
    is identical in user-visible content but doesn't pretend the LLM
    added value."""
    payload = {
        "relation": "extends",
        "confidence": 0.85,
        "rationale": "論文 B は論文 A の手法を異なる領域・タスク・スケールに拡張している。",
    }
    rc = RelationClassification.from_dict(payload)
    assert rc is None, "template rationale must be rejected"


def test_relation_classification_rejects_all_known_templates():
    """Pin every known template so a future template addition can't
    silently skip the rejection."""
    templates = [
        "論文 B は論文 A の手法を異なる領域・タスク・スケールに拡張している。",
        "論文 B は論文 A の研究ラインを継承し自然に発展させている。",
        "論文 B は論文 A をベースライン比較にのみ用いている。",
        "論文 B は論文 A と根本的に異なるアプローチを提案している。",
        "論文 B は論文 A の手法を置き換える改良版として提案されている。",
        "論文 B は論文 A の構成要素を分析・ablation している。",
    ]
    for t in templates:
        payload = {"relation": "extends", "confidence": 0.7, "rationale": t}
        assert RelationClassification.from_dict(payload) is None, (
            f"template not rejected: {t!r}"
        )


def test_relation_classification_keeps_paper_specific_rationale():
    """Sanity counter-test: a real LLM-style paper-specific rationale
    must parse cleanly. The validator must only reject the exact known
    templates, not anything that *looks* generic."""
    payload = {
        "relation": "extends",
        "confidence": 0.85,
        "rationale": (
            "論文 B のグラフ畳み込み層は、論文 A のスペクトル法を空間領域に再定式化し計算量を O(E) に落としている。"
        ),
    }
    rc = RelationClassification.from_dict(payload)
    assert rc is not None
    assert rc.relation == "extends"
    assert "O(E)" in rc.rationale

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


# ---- Invariant pins (#133 followup) ----
# PR #133 fixed an 8-min cancellation regression caused by the #131
# prompt rewrite blowing past Groq's TPM ceiling. The fix wasn't pinned
# by a test, so a future careless edit ("let me add one more example",
# "let me revert to --llm-strict=all") could silently re-introduce
# the same production cancellation. These tests lock the size budget
# and the workflow flag so future edits trip a unit-test failure
# instead of a 15-min CI cancellation.


def test_classify_prompt_within_groq_tpm_budget():
    """The system prompt + a typical user prompt (two 600-char abstracts
    plus boilerplate) must fit under a token budget that lets
    --llm-strict=ambiguous run on Groq's 6,000 TPM free tier without
    burning into the rate limiter.

    Char count is a coarse proxy for tokens — Japanese is ~1.5 tok/char,
    English ~0.25 tok/char — but it's robust enough as a guard against
    obvious blowups (the #131 first-cut prompt was 1,696 chars and caused
    the regression). We cap the system prompt at 1,200 chars (current
    is 855), leaving room for measured iteration without re-triggering
    the production timeout.
    """
    assert len(CLASSIFY_SYSTEM_PROMPT) <= 1200, (
        f"CLASSIFY_SYSTEM_PROMPT is {len(CLASSIFY_SYSTEM_PROMPT)} chars — over 1200 budget. "
        "Production traces (#131 PR #132 first deploy) showed > 1500 chars at 25 RPM "
        "exceeded Groq free-tier 6000 TPM and caused 8-min workflow cancellation. "
        "If a longer prompt is genuinely needed, lower llm.rate_limit_rpm to compensate "
        "OR move to a paid plan (config.yaml llm.rate_limit_rpm = 1000+)."
    )


def test_theme_workflows_use_ambiguous_strict_mode():
    """``--llm-strict=all`` on the Groq free tier blew the TPM budget and
    timed out the workflow (#131 PR #132 deploy → #133 walk-back). Both
    theme-producing workflows — the on-demand single-theme dispatch and
    the weekly bulk regen — MUST stay on ``--llm-strict=ambiguous`` until
    the operator moves to a paid plan; a careless flip back to ``all``
    would silently re-introduce the production cancellation.

    Reading the YAML as plain text (no yaml.safe_load tree walk) keeps
    the test resilient to comment / whitespace re-shuffling — the only
    thing we check is the literal flag value on the command line.
    """
    from pathlib import Path

    repo_root = Path(__file__).resolve().parents[2]
    # Both workflows that invoke build_theme_lineage must use the same
    # strict mode for predictable LLM cost.
    yaml_paths = [
        repo_root / ".github" / "workflows" / "theme-on-demand.yml",
        repo_root / ".github" / "workflows" / "regen-themes.yml",
    ]

    for yaml_path in yaml_paths:
        text = yaml_path.read_text(encoding="utf-8")
        # The literal flag value must be 'ambiguous'. A reviewer who wants
        # to flip back to 'all' must also flip this test, which forces them
        # to look at #131 / #133 and confirm they've taken the paid-plan
        # rate-limit step first.
        assert "--llm-strict ambiguous" in text, (
            f"{yaml_path.name} lost the --llm-strict=ambiguous flag. "
            "Free-tier Groq cannot sustain --llm-strict=all; see #131 / "
            "PR #133 for the cancellation regression this prevents."
        )
    # And the dangerous 'all' must NOT be live (a commented example is fine
        # — only check the un-commented invocation).
        live_lines = [
            line for line in text.splitlines()
            if "--llm-strict" in line
            and not line.lstrip().startswith("#")
        ]
        assert all("ambiguous" in line for line in live_lines), (
            f"{yaml_path.name} has a non-ambiguous --llm-strict line: "
            f"{live_lines}"
        )


def test_classify_prompt_invariants_still_hold():
    """Belt-and-braces: after the #133 size compression, the #131 quality
    requirements still hold. This pins the *intersection* of the two
    fixes: a smaller prompt must not have been achieved by deleting the
    paper-specific demand."""
    # Paper-specific demand markers (kept liberal so the wording can
    # evolve without forcing a test change).
    must_demand = ["concrete", "specific", "abstract", "concept"]
    assert any(m in CLASSIFY_SYSTEM_PROMPT.lower() for m in must_demand), (
        "prompt no longer asks for paper-specific content (#131 regression)"
    )
    # At least two heuristic template phrasings must be called out as
    # forbidden so the LLM doesn't translate the relation enum.
    templates_called_out = [
        "異なる領域・タスク・スケール",
        "研究ラインを継承",
        "ベースライン比較にのみ",
    ]
    matched = [t for t in templates_called_out if t in CLASSIFY_SYSTEM_PROMPT]
    assert len(matched) >= 2, (
        f"prompt no longer forbids template echoes (#131 regression). "
        f"Found only: {matched}"
    )


# ---- Template-rationale single source of truth (#145 followup) ----
# After the constants reorganization, heuristic-template strings live in
# a named dict on base.py and both the reject frozenset and
# build_theme_lineage's heuristic map source from it. These tests pin
# the contract so a future edit to the dict (or to either consumer)
# can't silently break the others.


def test_template_rationales_is_source_of_truth_for_reject_set():
    """``_GENERIC_TEMPLATE_RATIONALES`` (the reject frozenset used by
    ``RelationClassification.from_dict``) must be derived from the
    ``TEMPLATE_RATIONALES`` dict's values. Otherwise an addition to
    either side could silently un-sync."""
    from paperpilot.llm.base import (
        _GENERIC_TEMPLATE_RATIONALES,
        TEMPLATE_RATIONALES,
    )
    assert set(TEMPLATE_RATIONALES.values()) == _GENERIC_TEMPLATE_RATIONALES, (
        "_GENERIC_TEMPLATE_RATIONALES drifted from TEMPLATE_RATIONALES.values()"
    )


def test_template_rationales_used_by_build_theme_lineage():
    """build_theme_lineage._INTENT_RELATION_MAP and _DEFAULT_DERIVED
    must reference TEMPLATE_RATIONALES so the heuristic-emitted strings
    are exactly the same strings the reject set looks for."""
    from paperpilot.llm.base import TEMPLATE_RATIONALES
    from paperpilot.scripts import build_theme_lineage as btl

    # Every rationale emitted by the intent map must be a value from
    # the canonical dict.
    intent_rationales = {rationale for _, _, rationale in btl._INTENT_RELATION_MAP}
    assert intent_rationales.issubset(set(TEMPLATE_RATIONALES.values())), (
        "_INTENT_RELATION_MAP emits rationales outside TEMPLATE_RATIONALES — "
        "they won't be caught by from_dict's reject set."
    )
    # _DEFAULT_DERIVED's rationale must also be canonical.
    assert btl._DEFAULT_DERIVED[1] in TEMPLATE_RATIONALES.values()

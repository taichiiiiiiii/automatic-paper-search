"""Tests for eval_relation_prompt (issue #285 step 3).

Covers the metric computation (macro-F1 / accuracy / per-class p/r) and
the static predictor against the gold fixture. The live predictor needs
a real LLM provider and is exercised by the CI integration test on the
prompt-rewrite PR, not here.

Also covers the --provider flag introduced in PR-A of issue #285 step 4-5:
  _build_eval_provider, refactored _predict_live, and the CLI argument.
"""

from __future__ import annotations

import pytest

from paperpilot.scripts.eval_relation_prompt import (
    _filter_by_confidence,
    _load_records,
    _macro_f1,
    _predict_static,
)


def test_macro_f1_perfect_predictor():
    gold = ["extends", "contrasts", "successor"]
    pred = ["extends", "contrasts", "successor"]
    m = _macro_f1(gold, pred)
    assert m["accuracy"] == 1.0
    assert m["macro_f1"] == 1.0


def test_macro_f1_random_baseline():
    """Single-class predictor scores well only on that class, dragging
    macro-F1 down — this is exactly the issue with the current LLM
    collapsing to extends/contrasts."""
    gold = ["extends", "contrasts", "successor", "unrelated"]
    pred = ["extends", "extends", "extends", "extends"]
    m = _macro_f1(gold, pred)
    assert m["accuracy"] == pytest.approx(0.25)
    # macro-F1 = mean over the union of classes seen in gold + pred.
    # Only "extends" has any TP; everything else is 0 → macro-F1 is low.
    assert m["macro_f1"] < 0.2


def test_macro_f1_handles_none_predictions():
    """LLM call failure → prediction None counts as FN for the gold class."""
    gold = ["extends", "extends"]
    pred = ["extends", None]
    m = _macro_f1(gold, pred)
    assert m["accuracy"] == pytest.approx(0.5)
    # extends: tp=1, fp=0, fn=1 → precision=1.0, recall=0.5, f1=0.667
    assert m["per_class"]["extends"]["tp"] == 1
    assert m["per_class"]["extends"]["fn"] == 1


def test_load_records_skips_doc_header():
    records = _load_records()
    assert len(records) >= 29
    assert all(r.get("_doc") is None for r in records)


def test_predict_static_matches_fixture_field():
    records = _load_records()
    predictions = _predict_static(records)
    assert predictions == [r["current_rel"] for r in records]


def test_filter_by_confidence_high():
    records = _load_records()
    high = _filter_by_confidence(records, "high")
    assert all(r["confidence"] == "high" for r in high)
    assert 0 < len(high) < len(records)


def test_filter_by_confidence_all_returns_unchanged():
    records = _load_records()
    assert _filter_by_confidence(records, "all") is records


def test_current_baseline_macro_f1_below_target_floor():
    """Pin the current-prompt baseline so any future regression is
    surfaced. The threshold (0.30) is the floor we expect the rewrite
    to clear; if the baseline ever exceeds 0.30 on its own, the
    rewrite issue (#285) might no longer be needed.

    Today's measurement is macro-F1=0.237, accuracy=0.448 — pinned
    here as the prompt-rewrite gate."""
    records = _load_records()
    predictions = _predict_static(records)
    metrics = _macro_f1((r["gold_rel"] for r in records), predictions)
    assert metrics["macro_f1"] < 0.30, (
        f"current baseline macro-F1 unexpectedly improved to {metrics['macro_f1']} "
        f"— prompt-rewrite issue #285 may need re-scoping"
    )
    assert metrics["accuracy"] < 0.55, (
        f"current baseline accuracy unexpectedly improved to {metrics['accuracy']}"
    )


# ---------------------------------------------------------------------------
# PR-A: --provider flag tests (issue #285 step 4-5 unblock)
# ---------------------------------------------------------------------------

def test_build_eval_provider_groq_returns_groq_provider(monkeypatch):
    """_build_eval_provider("groq") with a real key returns a GroqProvider."""
    from paperpilot.scripts import eval_relation_prompt as mod

    monkeypatch.setattr(
        mod,
        "_load_env_for_provider",
        lambda: {"groq_api_key": "test-groq-key", "groq_model": "llama-test"},
    )
    from paperpilot.scripts.eval_relation_prompt import _build_eval_provider

    p = _build_eval_provider("groq")
    assert type(p).__name__ == "GroqProvider"
    assert p.enabled is True


def test_build_eval_provider_gemini_returns_gemini_provider(monkeypatch):
    """_build_eval_provider("gemini") with a real key returns a GeminiProvider."""
    from paperpilot.scripts import eval_relation_prompt as mod

    monkeypatch.setattr(
        mod,
        "_load_env_for_provider",
        lambda: {"gemini_api_key": "test-gemini-key", "gemini_model": "gemini-test"},
    )
    from paperpilot.scripts.eval_relation_prompt import _build_eval_provider

    p = _build_eval_provider("gemini")
    assert type(p).__name__ == "GeminiProvider"
    assert p.enabled is True


def test_build_eval_provider_auto_delegates_to_build_provider(monkeypatch):
    """_build_eval_provider("auto") delegates to build_lineage.build_provider."""
    from paperpilot.llm.base import AbstractLLMProvider
    from paperpilot.models import Paper

    class _SentinelProvider(AbstractLLMProvider):
        name = "sentinel"

        def evaluate_batch(
            self, papers: list[Paper], profile: str
        ) -> list:
            return []

    sentinel = _SentinelProvider({"enabled": True})

    import paperpilot.scripts.build_lineage as bl_mod

    monkeypatch.setattr(bl_mod, "build_provider", lambda: (sentinel, 0.0))

    from paperpilot.scripts.eval_relation_prompt import _build_eval_provider

    result = _build_eval_provider("auto")
    assert result is sentinel


def test_build_eval_provider_unknown_choice_raises_valueerror():
    """_build_eval_provider with an unknown choice raises ValueError."""
    from paperpilot.scripts.eval_relation_prompt import _build_eval_provider

    with pytest.raises(ValueError, match="unknown provider"):
        _build_eval_provider("openai")


def test_predict_live_raises_when_chosen_provider_disabled(monkeypatch):
    """_predict_live raises RuntimeError when the chosen provider has no key."""
    from paperpilot.scripts import eval_relation_prompt as mod

    # No keys at all → GeminiProvider.enabled is False
    monkeypatch.setattr(mod, "_load_env_for_provider", lambda: {})

    from paperpilot.scripts.eval_relation_prompt import _predict_live

    record = {
        "parent": {"title": "A", "year": 2020, "abstract": "abs A"},
        "child": {"title": "B", "year": 2021, "abstract": "abs B"},
    }
    with pytest.raises(RuntimeError, match="--provider=gemini"):
        _predict_live([record], provider_choice="gemini")


def test_predict_live_dispatches_to_chosen_provider(monkeypatch):
    """_predict_live calls classify_relation on the provider and collects results."""
    from paperpilot.llm.base import AbstractLLMProvider, RelationClassification
    from paperpilot.models import Paper

    class _StubProvider(AbstractLLMProvider):
        name = "stub"

        def evaluate_batch(
            self, papers: list[Paper], profile: str
        ) -> list:
            return []

        def classify_relation(
            self, a: dict, b: dict
        ) -> RelationClassification:
            return RelationClassification(
                relation="successor",
                confidence=0.9,
                rationale="B は A の研究ラインを継承しより高精度を達成している。",
            )

    stub = _StubProvider({"enabled": True})

    from paperpilot.scripts import eval_relation_prompt as mod

    monkeypatch.setattr(mod, "_build_eval_provider", lambda choice: stub)

    from paperpilot.scripts.eval_relation_prompt import _predict_live

    records = [
        {
            "parent": {"title": "A", "year": 2020, "abstract": "abs A"},
            "child": {"title": "B", "year": 2021, "abstract": "abs B"},
        },
        {
            "parent": {"title": "C", "year": 2019, "abstract": "abs C"},
            "child": {"title": "D", "year": 2022, "abstract": "abs D"},
        },
    ]
    result = _predict_live(records, provider_choice="stub")
    assert result == ["successor", "successor"]


def test_cli_accepts_provider_flag():
    """Argparse accepts --provider=gemini and stores args.provider correctly."""
    from paperpilot.scripts.eval_relation_prompt import _build_arg_parser

    parser = _build_arg_parser()
    args = parser.parse_args(["--predictor=live", "--provider=gemini"])
    assert args.provider == "gemini"


def test_cli_rejects_claude_until_pr_b():
    """--provider=claude is NOT an accepted choice (deferred to PR-B)."""
    from paperpilot.scripts.eval_relation_prompt import _build_arg_parser

    parser = _build_arg_parser()
    with pytest.raises(SystemExit) as exc_info:
        parser.parse_args(["--predictor=live", "--provider=claude"])
    assert exc_info.value.code == 2

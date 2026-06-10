"""Tests for eval_relation_prompt (issue #285 step 3).

Covers the metric computation (macro-F1 / accuracy / per-class p/r) and
the static predictor against the gold fixture. The live predictor needs
a real LLM provider and is exercised by the CI integration test on the
prompt-rewrite PR, not here.
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

"""Tests for --llm-strict {off, ambiguous, all} + _apply_llm_classification.

Phase A Step 1 / CRITICAL C7 of /root/.claude/plans/theme-pipeline-v2.md.
Closes #118.

Three layers exercised:
  1. argparse — the flag exists, defaults to "off", rejects garbage.
  2. derive_relation — provider/strict_mode plumbing decides whether LLM
     is invoked, and the heuristic stays load-bearing when LLM is silent.
  3. _apply_llm_classification + _is_ambiguous — confluence rules
     (rationale = LLM preferred, conf = max, unrelated drops the edge)
     and the ambiguity predicate (intents missing OR not in the
     _INTENT_RELATION_MAP keys).

Why a separate file: the parent test_build_theme_lineage.py is 2200+
lines and the LLM-strict path crosses multiple concerns. Splitting keeps
both files focused.
"""
from __future__ import annotations

import pytest

from paperpilot.llm.base import AbstractLLMProvider, RelationClassification
from paperpilot.scripts import build_theme_lineage as btl

# ---------- Fake provider ----------


class _FakeProvider(AbstractLLMProvider):
    """Stub for AbstractLLMProvider.classify_relation.

    Implements the abstract evaluate_batch with a NotImplementedError so
    every method that's actually called by the code under test (just
    classify_relation) works, and any accidental other-method use trips
    immediately rather than silently.
    """

    name = "fake"

    def __init__(self, queued: list | None = None) -> None:
        super().__init__({"enabled": True})
        self.queued: list = list(queued or [])
        self.calls: list = []

    def classify_relation(self, a, b):
        self.calls.append((a, b))
        if not self.queued:
            return None
        return self.queued.pop(0)

    def evaluate_batch(self, papers, profile):
        raise NotImplementedError("evaluate_batch is not exercised by these tests")


def _rc(rel: str, conf: float = 0.95, rationale: str = "LLM rationale") -> RelationClassification:
    return RelationClassification(relation=rel, confidence=conf, rationale=rationale)


# Sample S2 intent records: one with a mapped intent ("methodology"),
# one with no intents at all (ambiguous), one with an unmapped intent.
_INFLUENTIAL_METHODOLOGY = {
    "paperId": "p_meth",
    "_is_influential": True,
    "_intents": ["methodology"],
    "year": 2020,
    "citationCount": 500,
}
_INFLUENTIAL_NO_INTENTS = {
    "paperId": "p_none",
    "_is_influential": True,
    "_intents": [],
    "year": 2020,
    "citationCount": 500,
}
_INFLUENTIAL_UNMAPPED = {
    "paperId": "p_unk",
    "_is_influential": True,
    "_intents": ["some-future-intent"],
    "year": 2020,
    "citationCount": 500,
}
_NOT_INFLUENTIAL = {
    "paperId": "p_drop",
    "_is_influential": False,
    "_intents": ["methodology"],
}
_PARENT = {"paperId": "p_parent", "year": 2018, "citationCount": 2000, "title": "A"}
_CHILD = {"paperId": "p_child", "year": 2022, "citationCount": 300, "title": "B"}


# ---------- _is_ambiguous ----------


def test_is_ambiguous_true_when_intents_empty():
    assert btl._is_ambiguous(_INFLUENTIAL_NO_INTENTS) is True


def test_is_ambiguous_false_when_intent_matches_map():
    assert btl._is_ambiguous(_INFLUENTIAL_METHODOLOGY) is False


def test_is_ambiguous_true_when_intent_not_in_map():
    assert btl._is_ambiguous(_INFLUENTIAL_UNMAPPED) is True


def test_is_ambiguous_treats_missing_intents_key_as_ambiguous():
    assert btl._is_ambiguous({"paperId": "x"}) is True


# ---------- _apply_llm_classification ----------


def test_apply_keeps_heuristic_when_llm_is_none():
    heuristic = {"relation": "extends", "confidence": 0.7, "rationale": "H"}
    out = btl._apply_llm_classification(heuristic, None)
    assert out == heuristic


def test_apply_drops_edge_when_llm_unrelated():
    heuristic = {"relation": "extends", "confidence": 0.7, "rationale": "H"}
    out = btl._apply_llm_classification(heuristic, _rc("unrelated"))
    assert out is None


def test_apply_takes_llm_relation():
    heuristic = {"relation": "extends", "confidence": 0.7, "rationale": "H"}
    out = btl._apply_llm_classification(heuristic, _rc("supersedes", 0.9, "L"))
    assert out is not None
    assert out["relation"] == "supersedes"


def test_apply_takes_llm_rationale():
    heuristic = {"relation": "extends", "confidence": 0.7, "rationale": "H rationale"}
    out = btl._apply_llm_classification(heuristic, _rc("supersedes", 0.9, "LLM-says-so"))
    assert out is not None
    assert out["rationale"] == "LLM-says-so"


def test_apply_takes_llm_confidence_verbatim_when_high():
    """#209: LLM confidence is used verbatim, not max(heuristic, llm).
    The pre-#209 max-policy hid the LLM's own uncertainty signal
    behind a constant 0.7 floor."""
    heuristic = {"relation": "extends", "confidence": 0.7, "rationale": "H"}
    out = btl._apply_llm_classification(heuristic, _rc("supersedes", 0.95, "L"))
    assert out is not None
    assert out["confidence"] == 0.95


def test_apply_drops_edge_when_llm_confidence_below_threshold():
    """#209: LLM conf < _MIN_LLM_CONFIDENCE (0.4) → drop the edge,
    even when the heuristic gave higher confidence. The LLM has
    actually read both abstracts; emitting the edge with a
    heuristic-floored 0.7 hides the LLM's signal that this relation
    is too weak to render."""
    heuristic = {"relation": "extends", "confidence": 0.7, "rationale": "H"}
    out = btl._apply_llm_classification(heuristic, _rc("supersedes", 0.3, "L"))
    assert out is None


def test_apply_uses_llm_verbatim_at_threshold():
    """Edge case: LLM conf exactly at _MIN_LLM_CONFIDENCE (0.4) — keep."""
    heuristic = {"relation": "extends", "confidence": 0.7, "rationale": "H"}
    out = btl._apply_llm_classification(heuristic, _rc("supersedes", 0.4, "L"))
    assert out is not None
    assert out["confidence"] == 0.4


def test_apply_preserves_relation_keys_in_output_shape():
    heuristic = {"relation": "extends", "confidence": 0.7, "rationale": "H"}
    out = btl._apply_llm_classification(heuristic, _rc("ablation", 0.8, "L"))
    assert out is not None
    assert set(out.keys()) == {"relation", "confidence", "rationale"}


# ---------- derive_relation: strict_mode = "off" (default) ----------


def test_off_does_not_call_provider_even_when_set():
    p = _FakeProvider(queued=[_rc("supersedes")])
    btl.derive_relation(
        _INFLUENTIAL_NO_INTENTS,
        parent=_PARENT, child=_CHILD,
        provider=p, strict_mode="off",
    )
    assert p.calls == []


def test_off_returns_heuristic_unchanged():
    baseline = btl.derive_relation(_INFLUENTIAL_METHODOLOGY, parent=_PARENT, child=_CHILD)
    p = _FakeProvider(queued=[_rc("supersedes")])
    with_off = btl.derive_relation(
        _INFLUENTIAL_METHODOLOGY,
        parent=_PARENT, child=_CHILD,
        provider=p, strict_mode="off",
    )
    assert with_off == baseline


def test_off_is_default_when_provider_omitted():
    """Backward compatibility: existing 76 tests pass none of these args."""
    out = btl.derive_relation(_INFLUENTIAL_METHODOLOGY, parent=_PARENT, child=_CHILD)
    assert out is not None
    assert out["relation"] == "extends"  # methodology → extends


# ---------- derive_relation: strict_mode = "ambiguous" ----------


def test_ambiguous_calls_llm_when_intents_empty():
    p = _FakeProvider(queued=[_rc("supersedes", 0.9, "LL")])
    out = btl.derive_relation(
        _INFLUENTIAL_NO_INTENTS,
        parent=_PARENT, child=_CHILD,
        provider=p, strict_mode="ambiguous",
    )
    assert len(p.calls) == 1
    assert out is not None
    assert out["relation"] == "supersedes"


def test_ambiguous_skips_llm_when_intent_matches_map():
    p = _FakeProvider(queued=[_rc("supersedes")])
    out = btl.derive_relation(
        _INFLUENTIAL_METHODOLOGY,
        parent=_PARENT, child=_CHILD,
        provider=p, strict_mode="ambiguous",
    )
    assert p.calls == []
    assert out is not None
    assert out["relation"] == "extends"  # methodology → extends from heuristic


def test_ambiguous_calls_llm_when_intent_not_in_map():
    p = _FakeProvider(queued=[_rc("contrasts", 0.85, "LL")])
    out = btl.derive_relation(
        _INFLUENTIAL_UNMAPPED,
        parent=_PARENT, child=_CHILD,
        provider=p, strict_mode="ambiguous",
    )
    assert len(p.calls) == 1
    assert out is not None
    assert out["relation"] == "contrasts"


def test_ambiguous_drops_edge_when_llm_unrelated():
    p = _FakeProvider(queued=[_rc("unrelated")])
    out = btl.derive_relation(
        _INFLUENTIAL_NO_INTENTS,
        parent=_PARENT, child=_CHILD,
        provider=p, strict_mode="ambiguous",
    )
    assert out is None


def test_ambiguous_drops_edge_when_llm_returns_none_and_heuristic_is_template():
    """2026-06-05 followup: when the heuristic produced a
    TEMPLATE_RATIONALES rationale (year-delta 1-5 successor catchall:
    parent=2018, child=2022, delta=4) AND the LLM call failed, drop
    the edge instead of keeping the template. A template rationale
    tells the viewer nothing specific about A → B, and the old
    'keep heuristic' branch turned out to be the dominant lineage-
    quality leak on Groq Free quota exhaustion (14 / 21 themes at >=
    95 % template).
    """
    from paperpilot.llm.base import TEMPLATE_RATIONALES

    p = _FakeProvider(queued=[None])
    baseline = btl.derive_relation(_INFLUENTIAL_NO_INTENTS, parent=_PARENT, child=_CHILD)
    # Sanity-check the fixture: the baseline heuristic still uses a
    # template rationale (otherwise this test would mean the wrong
    # thing — the fixture's year delta drives the template-fallback
    # path).
    assert baseline is not None
    assert baseline["rationale"] in TEMPLATE_RATIONALES.values()

    out = btl.derive_relation(
        _INFLUENTIAL_NO_INTENTS,
        parent=_PARENT, child=_CHILD,
        provider=p, strict_mode="ambiguous",
    )
    assert out is None, (
        f"expected template-rationale + LLM-None to drop, got: {out!r}"
    )


# ---------- derive_relation: strict_mode = "all" ----------


def test_all_calls_llm_even_when_intent_matches_map():
    p = _FakeProvider(queued=[_rc("supersedes", 0.9, "LL")])
    out = btl.derive_relation(
        _INFLUENTIAL_METHODOLOGY,
        parent=_PARENT, child=_CHILD,
        provider=p, strict_mode="all",
    )
    assert len(p.calls) == 1
    assert out is not None
    assert out["relation"] == "supersedes"


def test_all_drops_edge_when_llm_unrelated():
    p = _FakeProvider(queued=[_rc("unrelated")])
    out = btl.derive_relation(
        _INFLUENTIAL_METHODOLOGY,
        parent=_PARENT, child=_CHILD,
        provider=p, strict_mode="all",
    )
    assert out is None


# ---------- influential=False stops everything ----------


def test_influential_false_returns_none_even_in_all_mode():
    """LLM must not be called when S2 already flagged citation as non-influential.

    Otherwise we'd pay per-citation LLM cost on the very edges we plan to
    drop anyway.
    """
    p = _FakeProvider(queued=[_rc("supersedes")])
    out = btl.derive_relation(
        _NOT_INFLUENTIAL,
        parent=_PARENT, child=_CHILD,
        provider=p, strict_mode="all",
    )
    assert out is None
    assert p.calls == []


# ---------- argparse integration ----------


def test_argparse_accepts_off(monkeypatch):
    monkeypatch.setattr("sys.argv", ["build_theme_lineage.py", "--theme", "X", "--llm-strict", "off"])
    args = btl._build_arg_parser().parse_args()
    assert args.llm_strict == "off"


def test_argparse_accepts_ambiguous(monkeypatch):
    monkeypatch.setattr("sys.argv", ["build_theme_lineage.py", "--theme", "X", "--llm-strict", "ambiguous"])
    args = btl._build_arg_parser().parse_args()
    assert args.llm_strict == "ambiguous"


def test_argparse_accepts_all(monkeypatch):
    monkeypatch.setattr("sys.argv", ["build_theme_lineage.py", "--theme", "X", "--llm-strict", "all"])
    args = btl._build_arg_parser().parse_args()
    assert args.llm_strict == "all"


def test_argparse_default_is_off(monkeypatch):
    monkeypatch.setattr("sys.argv", ["build_theme_lineage.py", "--theme", "X"])
    args = btl._build_arg_parser().parse_args()
    assert args.llm_strict == "off"


def test_argparse_rejects_invalid(monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["build_theme_lineage.py", "--theme", "X", "--llm-strict", "bogus"])
    with pytest.raises(SystemExit):
        btl._build_arg_parser().parse_args()


# --- #277 foundational ancestor allowlist ---


def test_foundational_ancestor_bypasses_llm_rejection():
    """#277: when the heuristic returns None and the parent is on the
    foundational allowlist, derive_relation emits a stable extends
    edge even without invoking the LLM. Catches the regression where
    canonical ML ancestors (AIAYN, ResNet, AlexNet etc.) silently
    dropped out of theme lineages."""
    parent = {
        "paperId": "openalex:W_alex",
        "title": "ImageNet Classification with Deep Convolutional Neural Networks",
        "year": 2012,
        "citationCount": 100000,
    }
    child = {
        "paperId": "openalex:W_vit",
        "title": "An Image is Worth 16x16 Words",
        "year": 2020,
        "citationCount": None,
    }
    intent_record = {
        "paperId": parent["paperId"],
        "_intents": [],
        "_is_influential": True,
    }
    edge = btl.derive_relation(
        intent_record, parent=parent, child=child,
        provider=None, strict_mode="off",
    )
    assert edge is not None, (
        "foundational allowlist failed to emit an edge — #277 regression"
    )
    assert edge["relation"] == "extends"
    # Rationale must include the title verbatim so it can't collide
    # with the _TEMPLATE_RATIONALES_SET reject filter.
    assert "ImageNet Classification" in edge["rationale"]


def test_non_foundational_parent_drops_when_heuristic_none():
    """Tightness: a parent NOT in the allowlist (random off-topic
    paper) still drops to None when the heuristic fails, preserving
    the #209 noise-reduction invariant."""
    parent = {
        "paperId": "openalex:W_rand",
        "title": "A Survey of Sitting Posture Recognition",
        "year": 2024,
        "citationCount": 50,
    }
    child = {
        "paperId": "openalex:W_vit",
        "title": "An Image is Worth 16x16 Words",
        "year": 2020,
        "citationCount": None,
    }
    intent_record = {
        "paperId": parent["paperId"],
        "_intents": [],
        "_is_influential": True,
    }
    edge = btl.derive_relation(
        intent_record, parent=parent, child=child,
        provider=None, strict_mode="off",
    )
    assert edge is None

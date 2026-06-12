"""Tests for provenance field on lineage edge emit paths.

PR1 of the lineage-edge-provenance-field feature. All 5 emit functions in
``_lineage_classify.py`` must set a ``"provenance"`` key drawn from the
closed enum ``_VALID_PROVENANCES``.

Closed enum (5 values):
  context_pattern       – unarXive citation context regex matched
  intent_map            – S2 intent label matched _INTENT_RELATION_MAP
  year_cite             – year / citation-count contrast heuristic
  foundational_allowlist– title matched lineage_foundational_allowlist.json
  llm                   – LLM provider returned a valid classification

Tests 1–9 live here; test 10 lives in test_build_theme_lineage.py
(see test_build_theme_lineage_edge_serializes_provenance).
"""
from __future__ import annotations

from paperpilot.llm.base import RelationClassification
from paperpilot.scripts._lineage_classify import (
    _VALID_PROVENANCES,
    _apply_llm_classification,
    _build_edge_from_llm,
    _classify_from_contexts,
    _derive_relation_heuristic,
    _foundational_ancestor_edge,
    derive_relation,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _rc(
    relation: str = "extends",
    confidence: float = 0.8,
    rationale: str = "paper-specific reason",
) -> RelationClassification:
    return RelationClassification(
        relation=relation,
        confidence=confidence,
        rationale=rationale,
    )


# ---------------------------------------------------------------------------
# Test 1: intent_map provenance
# ---------------------------------------------------------------------------


def test_make_derived_intent_map_sets_intent_map_provenance():
    """_derive_relation_heuristic with a methodology intent → provenance == 'intent_map'."""
    result = _derive_relation_heuristic({"_intents": ["methodology"]})
    assert result is not None, "expected a non-None edge for methodology intent"
    assert result["provenance"] == "intent_map"


# ---------------------------------------------------------------------------
# Test 2: year_cite provenance
# ---------------------------------------------------------------------------


def test_year_cite_contrast_sets_year_cite_provenance():
    """Year/cite contrast path → provenance == 'year_cite'."""
    # delta 1..5 → successor branch (no matching intent needed)
    parent = {"year": 2019, "citationCount": 0}
    child = {"year": 2021, "citationCount": 0}
    result = _derive_relation_heuristic(
        {},  # no intents
        parent=parent,
        child=child,
    )
    assert result is not None, "expected a non-None edge from year/cite contrast"
    assert result["provenance"] == "year_cite"


# ---------------------------------------------------------------------------
# Test 3: context_pattern provenance
# ---------------------------------------------------------------------------


def test_classify_from_contexts_sets_context_pattern_provenance():
    """_classify_from_contexts with a matching sentence → provenance == 'context_pattern'."""
    result = _classify_from_contexts(["we extend [12] to handle cross-lingual tasks"])
    assert result is not None, "expected a match on 'extend'"
    assert result["provenance"] == "context_pattern"


# ---------------------------------------------------------------------------
# Test 4: foundational_allowlist provenance
# ---------------------------------------------------------------------------


def test_foundational_ancestor_edge_sets_foundational_allowlist_provenance():
    """_foundational_ancestor_edge → provenance == 'foundational_allowlist'."""
    parent = {"title": "Attention Is All You Need"}
    result = _foundational_ancestor_edge(parent)
    assert result["provenance"] == "foundational_allowlist"


# ---------------------------------------------------------------------------
# Test 5: llm provenance from _build_edge_from_llm
# ---------------------------------------------------------------------------


def test_build_edge_from_llm_sets_llm_provenance():
    """_build_edge_from_llm with a valid RC → provenance == 'llm'."""
    rc = _rc(relation="extends", confidence=0.85)
    result = _build_edge_from_llm(rc)
    assert result is not None
    assert result["provenance"] == "llm"


# ---------------------------------------------------------------------------
# Test 6: LLM override path in _apply_llm_classification → "llm"
# ---------------------------------------------------------------------------


def test_apply_llm_classification_overrides_heuristic_sets_llm_provenance():
    """When LLM returns a valid RC, _apply_llm_classification → provenance == 'llm'.

    Specifically tests the 'LLM-rescue path' (verbatim override). The heuristic
    had a paper-specific rationale (not a template), and the LLM also returns
    a non-None, non-unrelated, high-confidence result. The output must carry
    provenance='llm', NOT 'llm_refined_heuristic' or any other value.
    """
    heuristic = {
        "relation": "extends",
        "confidence": 0.7,
        "rationale": "paper-specific heuristic rationale from context",
        "provenance": "context_pattern",
    }
    rc = _rc(relation="successor", confidence=0.9, rationale="paper-specific LLM reason")
    result = _apply_llm_classification(heuristic, rc)
    assert result is not None
    assert result["provenance"] == "llm"


# ---------------------------------------------------------------------------
# Test 7: LLM=None + non-template heuristic → keep original provenance
# ---------------------------------------------------------------------------


def test_apply_llm_classification_llm_none_keeps_heuristic_provenance():
    """LLM returns None + heuristic has paper-specific rationale → keep provenance.

    Per the decision matrix: llm_result is None AND heuristic rationale is NOT
    a template → keep the heuristic. The provenance field must survive unchanged.
    """
    heuristic = {
        "relation": "extends",
        "confidence": 0.7,
        # Paper-specific text — not in TEMPLATE_RATIONALES
        "rationale": "we extend [12] to multimodal settings, adding a cross-modal encoder.",
        "provenance": "context_pattern",
    }
    result = _apply_llm_classification(heuristic, None)
    assert result is not None, "non-template heuristic should be kept when LLM=None"
    assert result["provenance"] == "context_pattern"


# ---------------------------------------------------------------------------
# Test 8: derive_relation end-to-end → result dict has "provenance" key
# ---------------------------------------------------------------------------


def test_derive_relation_end_to_end_persists_provenance():
    """Full derive_relation() call → result dict has 'provenance' in closed enum.

    Tests the intent_map path (methodology intent → derive_relation returns a dict).
    """
    record = {"_intents": ["methodology"]}
    result = derive_relation(record)
    assert result is not None
    assert "provenance" in result
    assert result["provenance"] in _VALID_PROVENANCES


# ---------------------------------------------------------------------------
# Test 9: provenance enum is closed set
# ---------------------------------------------------------------------------


def test_provenance_enum_is_closed_set():
    """All 5 emit paths produce a provenance that is a member of _VALID_PROVENANCES.

    Iterate each path; collect provenance values; assert all ⊆ the closed enum.
    """
    expected = frozenset(
        {"context_pattern", "intent_map", "year_cite", "foundational_allowlist", "llm"}
    )
    assert expected == _VALID_PROVENANCES, (
        f"_VALID_PROVENANCES mismatch: got {_VALID_PROVENANCES}"
    )

    collected: set[str] = set()

    # Path 1: context_pattern
    ctx_edge = _classify_from_contexts(["we extend [12] by adding a visual encoder"])
    assert ctx_edge is not None
    collected.add(ctx_edge["provenance"])

    # Path 2: intent_map
    intent_edge = _derive_relation_heuristic({"_intents": ["methodology"]})
    assert intent_edge is not None
    collected.add(intent_edge["provenance"])

    # Path 3: year_cite
    year_edge = _derive_relation_heuristic(
        {},
        parent={"year": 2018, "citationCount": 0},
        child={"year": 2021, "citationCount": 0},
    )
    assert year_edge is not None
    collected.add(year_edge["provenance"])

    # Path 4: foundational_allowlist
    fa_edge = _foundational_ancestor_edge({"title": "Attention Is All You Need"})
    collected.add(fa_edge["provenance"])

    # Path 5: llm
    llm_edge = _build_edge_from_llm(_rc(relation="extends", confidence=0.85))
    assert llm_edge is not None
    collected.add(llm_edge["provenance"])

    assert collected == expected, (
        f"Some paths did not emit expected provenances. Got: {collected}"
    )
    assert collected.issubset(expected), (
        f"Unknown provenance values emitted: {collected - expected}"
    )

"""Issue #300: slot-filled (paper-specific) heuristic rationales.

Root cause of the "relation collapse" in the family tree: the heuristic
(`_derive_relation_heuristic`) emitted GENERIC `TEMPLATE_RATIONALES`
strings, identical across hundreds of edges. When the LLM was quota-dead
(returned None), `_apply_llm_classification` dropped every such edge
because its rationale was a member of `_TEMPLATE_RATIONALES_SET` — so all
signal-bearing heuristic edges vanished whenever Groq was unavailable.

The fix generalises the slot-fill pattern already used by
`_foundational_ancestor_edge`: every heuristic edge with REAL signal now
embeds the actual parent/child titles + years in the rationale, so it is
NOT a generic template, survives `_apply_llm_classification`, and reads
meaningfully WITHOUT the LLM.

Invariants this file pins:
  * slot-filled rationales are NEVER members of `_TEMPLATE_RATIONALES_SET`
  * no-signal pairs still return None (#209 no-fabrication boundary)
  * a heuristic edge + LLM=None now SURVIVES `_apply_llm_classification`
    (the collapse fix — the key behavioural test)
"""

from paperpilot.llm.base import _MIN_RATIONALE_LEN
from paperpilot.scripts._lineage_classify import (
    _TEMPLATE_RATIONALES_SET,
    _apply_llm_classification,
    _derive_relation_heuristic,
    _slot_fill_rationale,
)

# ---------------------------------------------------------------------------
# _slot_fill_rationale: per-relation output shape
# ---------------------------------------------------------------------------

_PARENT = {
    "title": "Deep Residual Learning for Image Recognition",
    "year": 2015,
}
_CHILD = {
    "title": "An Image is Worth 16x16 Words: Transformers for Image Recognition",
    "year": 2020,
}


def test_slot_fill_successor_embeds_both_titles_and_years():
    out = _slot_fill_rationale("successor", _PARENT, _CHILD)
    assert "Deep Residual Learning" in out
    assert "An Image is Worth 16x16 Words" in out
    assert "2015" in out
    assert "2020" in out
    assert out not in _TEMPLATE_RATIONALES_SET
    assert len(out) >= _MIN_RATIONALE_LEN


def test_slot_fill_contrasts_embeds_both_titles():
    out = _slot_fill_rationale("contrasts", _PARENT, _CHILD)
    assert "Deep Residual Learning" in out
    assert "An Image is Worth 16x16 Words" in out
    assert out not in _TEMPLATE_RATIONALES_SET
    assert len(out) >= _MIN_RATIONALE_LEN


def test_slot_fill_intent_extends_names_the_intent():
    out = _slot_fill_rationale("extends", _PARENT, _CHILD, intent="methodology")
    assert "Deep Residual Learning" in out
    assert "An Image is Worth 16x16 Words" in out
    assert "methodology" in out
    assert out not in _TEMPLATE_RATIONALES_SET


def test_slot_fill_intent_generic_relation_still_names_intent():
    """A relation not in the intent_map specialisation still produces a
    paper-specific sentence that names the intent keyword."""
    out = _slot_fill_rationale("successor", _PARENT, _CHILD, intent="result")
    assert "Deep Residual Learning" in out
    assert "An Image is Worth 16x16 Words" in out
    assert "result" in out
    assert out not in _TEMPLATE_RATIONALES_SET


def test_slot_fill_truncates_long_titles():
    long_parent = {"title": "X" * 200, "year": 2019}
    long_child = {"title": "Y" * 200, "year": 2021}
    out = _slot_fill_rationale("successor", long_parent, long_child)
    # Each title truncated to ~60 chars (+ ellipsis), so no 200-char run.
    assert "X" * 70 not in out
    assert "Y" * 70 not in out
    assert out not in _TEMPLATE_RATIONALES_SET


def test_slot_fill_missing_parent_title_falls_back_gracefully():
    """Mirror _foundational_ancestor_edge: a missing title degrades to a
    non-template placeholder, never an empty string or a template member."""
    out = _slot_fill_rationale("successor", {"year": 2020}, _CHILD)
    assert out  # non-empty
    assert out not in _TEMPLATE_RATIONALES_SET
    assert len(out) >= _MIN_RATIONALE_LEN


def test_slot_fill_both_titles_missing_still_non_template():
    out = _slot_fill_rationale("contrasts", None, None)
    assert out
    assert out not in _TEMPLATE_RATIONALES_SET
    assert len(out) >= _MIN_RATIONALE_LEN


def test_slot_fill_never_emits_a_template_member():
    """Property: across all relations + intents, output is never a template
    string (that's the whole point — it must survive the reject set)."""
    relations = ["successor", "contrasts", "extends", "baseline_only", "supersedes"]
    intents = [None, "methodology", "result", "background"]
    for rel in relations:
        for intent in intents:
            out = _slot_fill_rationale(rel, _PARENT, _CHILD, intent=intent)
            assert out not in _TEMPLATE_RATIONALES_SET, (
                f"slot-fill collided with template set for {rel=} {intent=}"
            )


# ---------------------------------------------------------------------------
# _derive_relation_heuristic now emits slot-filled rationales
# ---------------------------------------------------------------------------


def test_heuristic_year_cite_successor_embeds_titles_and_years():
    """Year/cite successor signal (1<=delta<=5) → rationale embeds both
    titles + years, relation=successor, NOT a template."""
    parent = {"title": "ResNet", "year": 2015, "citationCount": 1000}
    child = {"title": "Vision Transformer", "year": 2020, "citationCount": 800}
    rel = _derive_relation_heuristic({"_intents": []}, parent=parent, child=child)
    assert rel is not None
    assert rel["relation"] == "successor"
    assert rel["provenance"] == "year_cite"
    assert "ResNet" in rel["rationale"]
    assert "Vision Transformer" in rel["rationale"]
    assert "2015" in rel["rationale"]
    assert "2020" in rel["rationale"]
    assert rel["rationale"] not in _TEMPLATE_RATIONALES_SET


def test_heuristic_year_cite_contrasts_embeds_titles():
    """Same-year + similar-citation contrast → contrasts edge with a
    slot-filled rationale (was contrasts_year_cite template)."""
    parent = {"title": "BERT", "year": 2018, "citationCount": 500}
    child = {"title": "RoBERTa", "year": 2018, "citationCount": 600}
    rel = _derive_relation_heuristic({"_intents": []}, parent=parent, child=child)
    assert rel is not None
    assert rel["relation"] == "contrasts"
    assert rel["provenance"] == "year_cite"
    assert "BERT" in rel["rationale"]
    assert "RoBERTa" in rel["rationale"]
    assert rel["rationale"] not in _TEMPLATE_RATIONALES_SET


def test_heuristic_intent_map_match_embeds_titles_and_names_intent():
    """methodology intent → extends, rationale embeds titles + names the
    intent. Slot-fill must work even though intent_map branch historically
    used a template string."""
    parent = {"title": "Word2Vec", "year": 2013}
    child = {"title": "GloVe", "year": 2014}
    rel = _derive_relation_heuristic(
        {"_intents": ["methodology"]}, parent=parent, child=child
    )
    assert rel is not None
    assert rel["relation"] == "extends"
    assert rel["provenance"] == "intent_map"
    assert "Word2Vec" in rel["rationale"]
    assert "GloVe" in rel["rationale"]
    assert "methodology" in rel["rationale"]
    assert rel["rationale"] not in _TEMPLATE_RATIONALES_SET


def test_heuristic_intent_map_without_parent_child_degrades_gracefully():
    """The intent_map branch is reachable without parent/child (many
    existing call sites pass only the intent record). Slot-fill must
    degrade to a non-template placeholder, never crash, never emit a
    template member."""
    rel = _derive_relation_heuristic({"_intents": ["methodology"]})
    assert rel is not None
    assert rel["relation"] == "extends"
    assert rel["provenance"] == "intent_map"
    assert rel["rationale"]
    assert rel["rationale"] not in _TEMPLATE_RATIONALES_SET
    assert len(rel["rationale"]) >= _MIN_RATIONALE_LEN


def test_heuristic_no_signal_still_returns_none():
    """#209 no-fabrication boundary: no intent match AND no year/cite
    trigger → still None. We only changed rationale TEXT of edges that
    already had real signal; we did NOT add new edges."""
    # No intents, no parent/child → nothing fires.
    assert _derive_relation_heuristic({"_intents": []}) is None
    # parent/child present but year gap too large (no trigger).
    parent = {"title": "Old", "year": 2010, "citationCount": 200}
    child = {"title": "New", "year": 2024, "citationCount": 50}
    assert _derive_relation_heuristic({"_intents": []}, parent=parent, child=child) is None


# ---------------------------------------------------------------------------
# THE COLLAPSE FIX: heuristic edge + LLM=None now SURVIVES
# ---------------------------------------------------------------------------


def test_heuristic_edge_with_llm_none_now_survives_apply_classification():
    """KEY behavioural test for #300. A year/cite successor edge with the
    LLM unavailable (None) is now KEPT — because its rationale is
    slot-filled and therefore NOT a template member. Pre-#300 it would be
    dropped at the template-reject step → relation collapse."""
    parent = {"title": "ResNet", "year": 2015, "citationCount": 1000}
    child = {"title": "Vision Transformer", "year": 2020, "citationCount": 800}
    heuristic = _derive_relation_heuristic(
        {"_intents": []}, parent=parent, child=child
    )
    assert heuristic is not None

    kept = _apply_llm_classification(heuristic, None)
    assert kept is not None, (
        "slot-filled heuristic edge must SURVIVE LLM=None (the #300 fix)"
    )
    assert kept["relation"] == "successor"
    assert "ResNet" in kept["rationale"]
    assert "Vision Transformer" in kept["rationale"]


def test_intent_map_edge_with_llm_none_now_survives():
    """Same collapse fix for the intent_map path."""
    parent = {"title": "Word2Vec", "year": 2013}
    child = {"title": "GloVe", "year": 2014}
    heuristic = _derive_relation_heuristic(
        {"_intents": ["methodology"]}, parent=parent, child=child
    )
    assert heuristic is not None
    kept = _apply_llm_classification(heuristic, None)
    assert kept is not None
    assert kept["relation"] == "extends"
    assert "Word2Vec" in kept["rationale"]


def test_template_reject_backstop_still_active_for_literal_template():
    """Invariant: _apply_llm_classification STILL drops a literal template
    rationale on LLM=None (the backstop for LLM echoes / any legacy
    template). The heuristic just stops EMITTING templates; the reject set
    stays intact."""
    from paperpilot.llm.base import TEMPLATE_RATIONALES

    legacy_template_edge = {
        "relation": "successor",
        "confidence": 0.7,
        "rationale": TEMPLATE_RATIONALES["successor_result"],
        "provenance": "year_cite",
    }
    assert _apply_llm_classification(legacy_template_edge, None) is None

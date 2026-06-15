"""Issue #283: dead heuristic emit paths removal regression tests.

Pre-#283 the year/cite heuristic emitted ``supersedes``/``ablation``
with template rationales that were then unconditionally rejected by
``_TEMPLATE_RATIONALES_SET`` whenever the LLM returned ``None`` (the
steady-state condition under Groq free-tier quota exhaustion). The
same applied to the ``background → baseline_only`` intent entry, which
in addition only fires for S2 sources (OpenAlex provides no intent
labels) so it was unreachable on the live OpenAlex-primary pipeline.

Net effect on published lineage: out of 99 edges across vision-
transformer + flash-attention, ``supersedes`` / ``ablation`` /
``baseline_only`` produced zero — every candidate died at the reject
step. This file pins their removal so a future refactor cannot
reintroduce the dead emit.

Kept alive (regression guards): ``contrasts_year_cite`` (16/99 edges
real), ``successor_result`` (heuristic emit still present; out of
scope for #283 even though current data shows 0 successor edges).
"""

from __future__ import annotations

from paperpilot.scripts._lineage_classify import (
    _INTENT_RELATION_MAP,
    _derive_relation_heuristic,
)

# ---- _INTENT_RELATION_MAP: background→baseline_only removed ---------------


def test_intent_map_no_longer_contains_background_baseline_only():
    """The (background, baseline_only, ...) entry was an OpenAlex-unreachable
    dead path — OpenAlex doesn't supply S2 intent labels so the keyword
    never matches, and on S2 inputs the rationale is a template that
    `_apply_llm_classification` always drops when the LLM returns None."""
    keywords = {kw for kw, _, _ in _INTENT_RELATION_MAP}
    assert "background" not in keywords, (
        "background→baseline_only entry reintroduced — see #283"
    )


def test_intent_map_keeps_alive_entries():
    """Regression guard: methodology→extends and result→successor still wire."""
    mapping = {kw: rel for kw, rel, _ in _INTENT_RELATION_MAP}
    assert mapping.get("methodology") == "extends"
    assert mapping.get("result") == "successor"


def test_intent_only_background_returns_none():
    """End-to-end behavior: a paper with only `background` intent now
    falls through the heuristic instead of being mapped to baseline_only."""
    intent_record = {"_intents": ["background"]}
    rel = _derive_relation_heuristic(intent_record)
    assert rel is None, (
        "background-only intent should no longer emit baseline_only "
        "(was dead path — template rationale always rejected)"
    )


def test_background_intent_is_ambiguous_post_removal():
    """Code-review followup: post-#283 a paper with only `background`
    intent no longer matches `_INTENT_RELATION_MAP`, so `_is_ambiguous`
    returns True and the edge routes to the LLM under
    `--llm-strict=ambiguous` (production default) instead of being
    silently dropped via the template-reject step. Pin this new routing
    so a future refactor doesn't reintroduce silent skipping.
    """
    from paperpilot.scripts._lineage_classify import _is_ambiguous

    assert _is_ambiguous({"_intents": ["background"]}) is True
    # Sanity: alive intents are still NOT ambiguous (kept on cheap path).
    assert _is_ambiguous({"_intents": ["methodology"]}) is False
    assert _is_ambiguous({"_intents": ["result"]}) is False


# ---- year/cite heuristic: supersedes_year_cite removed --------------------


def test_year_cite_does_not_emit_supersedes():
    """Pre-#283: delta>=3 + parent_cite>100 + child_cite>=parent*1.5
    emitted ``supersedes`` with the canonical template rationale, which
    `_apply_llm_classification` then drops whenever the LLM is None.

    Post-#283: heuristic returns None for this shape — the LLM is the
    only path to a supersedes edge.
    """
    intent_record: dict = {"_intents": []}
    parent = {"year": 2015, "citationCount": 500}
    child = {"year": 2020, "citationCount": 5000}  # delta=5, cc/pc=10
    rel = _derive_relation_heuristic(intent_record, parent=parent, child=child)
    assert rel is None or rel["relation"] != "supersedes", (
        f"heuristic emitted supersedes={rel} — dead path reintroduced"
    )


# ---- year/cite heuristic: ablation_year_cite removed ----------------------


def test_year_cite_does_not_emit_ablation():
    """Pre-#283: delta<=2 + child_cite<100 + parent_cite>1000 emitted
    ``ablation`` with template rationale → always rejected when LLM is
    None. Post-#283: falls through to the ``1 <= delta <= 5`` successor
    catch-all, not ``ablation``."""
    intent_record: dict = {"_intents": []}
    parent = {"year": 2018, "citationCount": 5000}
    child = {"year": 2019, "citationCount": 30}  # delta=1, cc=30, pc=5000
    rel = _derive_relation_heuristic(intent_record, parent=parent, child=child)
    # Tightened post code-review: assert the exact post-removal landing
    # branch instead of "anything except ablation" so accidental
    # rebinding to a different rel is caught.
    assert rel is not None and rel["relation"] == "successor", (
        f"heuristic landed on rel={rel} — expected fall-through to successor"
    )


# ---- regression guards: contrasts + successor still alive -----------------


def test_year_cite_still_emits_contrasts():
    """contrasts_year_cite is the only year/cite heuristic emit with
    measurable production output (16/99 published edges). Removing it
    would be out of scope for #283 — keep it alive.

    #300: the rationale is now a paper-specific SLOT-FILLED string
    (embedding titles + years) rather than the generic
    TEMPLATE_RATIONALES["contrasts_year_cite"]. The relation enum +
    provenance are unchanged; only the rationale TEXT differs so the edge
    survives _apply_llm_classification when the LLM is None."""
    from paperpilot.scripts._lineage_classify import _TEMPLATE_RATIONALES_SET

    intent_record: dict = {"_intents": []}
    parent = {"title": "ParentNet", "year": 2020, "citationCount": 500}
    child = {"title": "ChildNet", "year": 2020, "citationCount": 600}  # delta=0, cc/pc=1.2
    rel = _derive_relation_heuristic(intent_record, parent=parent, child=child)
    assert rel is not None and rel["relation"] == "contrasts", (
        "contrasts_year_cite path should still fire — see #283 scope"
    )
    # #300: slot-filled, NOT the template.
    assert rel["rationale"] not in _TEMPLATE_RATIONALES_SET
    assert "ParentNet" in rel["rationale"]
    assert "ChildNet" in rel["rationale"]


def test_year_cite_still_emits_successor():
    """successor_result heuristic is out of scope for #283 even though
    current production data shows 0 successor edges — measurement on the
    LLM-only subset is required before declaring it dead."""
    intent_record: dict = {"_intents": []}
    parent = {"year": 2019, "citationCount": 100}
    child = {"year": 2021, "citationCount": 150}  # delta=2, low contrast
    rel = _derive_relation_heuristic(intent_record, parent=parent, child=child)
    # Falls through to "1 <= delta <= 5" successor catch-all.
    assert rel is not None and rel["relation"] == "successor"


# ---- build_deep_lineage lenient fallback: slot-filled, not a template ----


def test_build_deep_lineage_lenient_fallback_is_slot_filled_not_template():
    """#304: the deep-tree lenient classifier's empty-rationale fallback now
    uses `_slot_fill_rationale` (embeds the actual titles), NOT a
    TEMPLATE_RATIONALES member — consistent with the #300 generalisation so
    deep-tree edges carry paper-specific rationales and never collapse on a
    template-reject."""
    from paperpilot.scripts._lineage_classify import (
        _TEMPLATE_RATIONALES_SET,
        _slot_fill_rationale,
    )

    parent = {"title": "Deep Residual Learning", "year": 2015}
    child = {"title": "Identity Mappings in Deep Residual Networks", "year": 2016}
    # _FALLBACK_RATIONALE is gone; the lenient path calls this directly.
    for rel in ("supersedes", "successor", "extends", "ablation", "baseline_only", "contrasts"):
        out = _slot_fill_rationale(rel, parent, child)
        assert out not in _TEMPLATE_RATIONALES_SET, f"{rel} fallback is a template"
        assert "Deep Residual Learning" in out  # embeds the real parent title
    # The old template map must be gone (SSoT obsolete after #304).
    import paperpilot.scripts.build_deep_lineage as bdl

    assert not hasattr(bdl, "_FALLBACK_RATIONALE")

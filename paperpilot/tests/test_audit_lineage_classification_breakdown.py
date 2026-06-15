"""Tests for audit_lineage_classification_breakdown (issue #285 step 1)."""

from __future__ import annotations

import json

import pytest

from paperpilot.llm.base import TEMPLATE_RATIONALES
from paperpilot.scripts.audit_lineage_classification_breakdown import (
    _LEGACY_TEMPLATE_TO_ENUM,
    _NEW_ENUMS,
    _audit_published_themes,
    _classify_edge_provenance,
    _percent_table,
)

# ---------------------------------------------------------------------------
# Existing tests — updated to pass edge dicts instead of raw rationale strings
# and to expect new enum names.
# ---------------------------------------------------------------------------


def test_classify_provenance_foundational():
    rationale = (
        "Deep Residual Learning is a canonical research-lineage ancestor "
        "and is preserved here as a direct extends edge."
    )
    assert _classify_edge_provenance({"rationale": rationale}) == "foundational_allowlist"


def test_classify_provenance_heuristic_template():
    # contrasts_year_cite template → "year_cite" in the new 5-enum set
    template = TEMPLATE_RATIONALES["contrasts_year_cite"]
    assert _classify_edge_provenance({"rationale": template}) == "year_cite"


def test_classify_provenance_llm():
    paper_specific = (
        "B の Shifted Windows は、A のピラミッド構造とは異なる階層的な表現を実現している。"
    )
    assert _classify_edge_provenance({"rationale": paper_specific}) == "llm"


def test_classify_provenance_empty_rationale_is_llm_bucket():
    """Empty rationales shouldn't reach this code (from_dict drops them),
    but if they did the safest bucket is 'llm' since neither foundational
    nor template markers are present."""
    assert _classify_edge_provenance({"rationale": ""}) == "llm"


def test_percent_table_sorted_descending():
    table = _percent_table({"extends": 30, "contrasts": 10, "successor": 5})
    assert list(table) == ["extends", "contrasts", "successor"]
    assert "30 (66.7%)" in table["extends"]


def test_percent_table_empty_input():
    assert _percent_table({}) == {}


# ---------------------------------------------------------------------------
# 9 NEW RED tests — all should fail before GREEN implementation.
# ---------------------------------------------------------------------------


def test_classify_reads_provenance_field_when_present():
    """edge={"provenance":"intent_map", ...} → "intent_map" (field wins)."""
    edge = {"provenance": "intent_map", "rationale": "some rationale text"}
    assert _classify_edge_provenance(edge) == "intent_map"


def test_classify_field_wins_over_rationale_conflict():
    """provenance field overrides even a canonical rationale string."""
    edge = {
        "provenance": "llm",
        "rationale": "Deep Residual Learning is a canonical research-lineage ancestor.",
    }
    assert _classify_edge_provenance(edge) == "llm"


@pytest.mark.parametrize("enum_val", [
    "context_pattern",
    "intent_map",
    "year_cite",
    "title_version",
    "foundational_allowlist",
    "llm",
])
def test_classify_all_new_enums_passthrough(enum_val):
    """Each known enum value passes through as-is when in the field —
    incl. title_version (#305/#321), which previously hit the unknown-
    provenance warning path."""
    edge = {"provenance": enum_val, "rationale": "irrelevant"}
    assert _classify_edge_provenance(edge) == enum_val


def test_new_enums_mirror_valid_provenances():
    """Drift-guard (#305): the breakdown audit's bucket set MUST equal the
    canonical `_VALID_PROVENANCES` closed set, so a new provenance (e.g. the
    #321 title_version) can never silently fall into the unknown-warning
    path. This is the test that would have caught the missing title_version."""
    from paperpilot.scripts._lineage_classify import _VALID_PROVENANCES

    assert set(_NEW_ENUMS) == _VALID_PROVENANCES, (
        f"_NEW_ENUMS {set(_NEW_ENUMS)} != _VALID_PROVENANCES "
        f"{set(_VALID_PROVENANCES)} — sync the breakdown audit's buckets"
    )


def test_classify_slot_filled_rationale_with_provenance_not_unknown():
    """#305: a #300 slot-fill rationale (embeds titles, NOT a template) must
    bucket by its provenance field, never falling to a wrong/unknown bucket.
    Field-first makes this work; pinned here per the issue's concern."""
    from paperpilot.scripts._lineage_classify import _slot_fill_rationale

    rationale = _slot_fill_rationale("successor", {"title": "A", "year": 2018}, {"title": "B", "year": 2020})
    edge = {"provenance": "year_cite", "rationale": rationale}
    assert _classify_edge_provenance(edge) == "year_cite"


def test_classify_legacy_foundational_normalized_to_allowlist():
    """Legacy: no provenance field + canonical rationale → "foundational_allowlist"."""
    rationale = (
        "Attention Is All You Need is a canonical research-lineage ancestor "
        "and is preserved here as a direct extends edge."
    )
    edge = {"rationale": rationale}
    assert _classify_edge_provenance(edge) == "foundational_allowlist"


def test_classify_legacy_year_cite_template_normalized():
    """Legacy: no provenance field + contrasts_year_cite template → "year_cite"."""
    edge = {"rationale": TEMPLATE_RATIONALES["contrasts_year_cite"]}
    assert _classify_edge_provenance(edge) == "year_cite"


def test_classify_legacy_intent_template_normalized():
    """Legacy: no provenance field + successor_result template → "intent_map"."""
    edge = {"rationale": TEMPLATE_RATIONALES["successor_result"]}
    assert _classify_edge_provenance(edge) == "intent_map"


def test_classify_legacy_llm_string_stays_llm():
    """Legacy: no provenance field + paper-specific JA rationale → "llm"."""
    paper_specific = (
        "B の Shifted Windows は、A のピラミッド構造とは異なる階層的な表現を実現している。"
    )
    edge = {"rationale": paper_specific}
    assert _classify_edge_provenance(edge) == "llm"


def test_classify_legacy_empty_edge_is_llm_bucket():
    """Legacy: empty edge dict (no provenance, no rationale) → "llm"."""
    assert _classify_edge_provenance({}) == "llm"


def test_audit_published_themes_five_buckets_present_even_when_empty(tmp_path):
    """_audit_published_themes returns all 5 enum keys in per_provenance_rel
    even if some buckets have zero counts (uses a synthetic themes dir)."""
    # Build a minimal synthetic theme dir with a lineage.json that has no edges
    theme_dir = tmp_path / "test-theme"
    theme_dir.mkdir()
    lineage = {"nodes": [], "edges": [], "meta": {}}
    (theme_dir / "lineage.json").write_text(json.dumps(lineage), encoding="utf-8")

    # Monkey-patch THEMES_DIR for this call
    import paperpilot.scripts.audit_lineage_classification_breakdown as mod
    original = mod.THEMES_DIR
    mod.THEMES_DIR = tmp_path
    try:
        result = _audit_published_themes()
    finally:
        mod.THEMES_DIR = original

    per_prov = result["per_provenance_rel"]
    assert set(per_prov.keys()) == set(_NEW_ENUMS), (
        f"Expected keys {_NEW_ENUMS}, got {list(per_prov.keys())}"
    )


# ---------------------------------------------------------------------------
# #310: per-model cache tally
# ---------------------------------------------------------------------------


def test_audit_cache_by_model_tally(tmp_path):
    """_audit_classifications_cache tallies entries per producing LLM via the
    `model` field (#310); entries without it bucket as "(legacy/none)"."""
    from paperpilot.scripts.audit_lineage_classification_breakdown import (
        _audit_classifications_cache,
    )

    good = "論文 B は論文 A の注意機構を線形時間に近似している実装である。"
    cache = {
        "a->b": {"relation": "extends", "confidence": 0.8, "rationale": good,
                 "model": "gemini:gemini-2.5-flash"},
        "c->d": {"relation": "successor", "confidence": 0.7, "rationale": good,
                 "model": "groq:llama-3.3-70b-versatile"},
        # Legacy entry (pre-#310): no model field.
        "e->f": {"relation": "extends", "confidence": 0.7, "rationale": good},
    }
    cache_path = tmp_path / "classifications.json"
    cache_path.write_text(json.dumps(cache), encoding="utf-8")

    import paperpilot.scripts.audit_lineage_classification_breakdown as mod
    original = mod.CLASSIFICATIONS_CACHE
    mod.CLASSIFICATIONS_CACHE = cache_path
    try:
        result = _audit_classifications_cache()
    finally:
        mod.CLASSIFICATIONS_CACHE = original

    assert result["available"] is True
    by_model = result["by_model"]
    assert by_model["gemini:gemini-2.5-flash"] == 1
    assert by_model["groq:llama-3.3-70b-versatile"] == 1
    assert by_model["(legacy/none)"] == 1


# ---------------------------------------------------------------------------
# Drift assertion test
# ---------------------------------------------------------------------------


def test_legacy_template_map_is_subset_of_template_rationales():
    """_LEGACY_TEMPLATE_TO_ENUM keys must be a subset of TEMPLATE_RATIONALES values.

    Catches typos: a key that's not a real template would never match anything
    and would silently be dead code.
    """
    template_values = set(TEMPLATE_RATIONALES.values())
    for key in _LEGACY_TEMPLATE_TO_ENUM:
        assert key in template_values, (
            f"_LEGACY_TEMPLATE_TO_ENUM key {key!r} not found in "
            f"TEMPLATE_RATIONALES.values() — update _LEGACY_TEMPLATE_TO_ENUM "
            f"when TEMPLATE_RATIONALES changes."
        )


def test_legacy_template_map_covers_all_template_rationales():
    """Every TEMPLATE_RATIONALES value must have an explicit legacy mapping.

    Code-reviewer #285 PR2 MEDIUM: if a pre-#283 lineage.json contains an
    edge with a heuristic-template rationale that we haven't mapped, the
    audit silently buckets it as ``llm``, inflating the LLM count and
    deflating what should be ``intent_map`` / ``year_cite``. This test
    forces an explicit decision the moment ``TEMPLATE_RATIONALES`` gains
    a new key — either map it or document why it's intentionally omitted.
    """
    template_values = set(TEMPLATE_RATIONALES.values())
    mapped = set(_LEGACY_TEMPLATE_TO_ENUM)
    missing = template_values - mapped
    assert not missing, (
        f"_LEGACY_TEMPLATE_TO_ENUM does not cover all TEMPLATE_RATIONALES "
        f"values; missing mappings: {sorted(missing)}. "
        f"Pre-PR-#290 lineage.json files with these rationales would "
        f"misclassify as 'llm'."
    )

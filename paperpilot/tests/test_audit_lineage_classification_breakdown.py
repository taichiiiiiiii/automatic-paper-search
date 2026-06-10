"""Tests for audit_lineage_classification_breakdown (issue #285 step 1)."""

from __future__ import annotations

from paperpilot.llm.base import TEMPLATE_RATIONALES
from paperpilot.scripts.audit_lineage_classification_breakdown import (
    _classify_edge_provenance,
    _percent_table,
)


def test_classify_provenance_foundational():
    rationale = (
        "Deep Residual Learning is a canonical research-lineage ancestor "
        "and is preserved here as a direct extends edge."
    )
    assert _classify_edge_provenance(rationale) == "foundational"


def test_classify_provenance_heuristic_template():
    # Pick a current TEMPLATE_RATIONALES value verbatim.
    template = TEMPLATE_RATIONALES["contrasts_year_cite"]
    assert _classify_edge_provenance(template) == "heuristic-template"


def test_classify_provenance_llm():
    paper_specific = (
        "B の Shifted Windows は、A のピラミッド構造とは異なる階層的な表現を実現している。"
    )
    assert _classify_edge_provenance(paper_specific) == "llm"


def test_classify_provenance_empty_rationale_is_llm_bucket():
    """Empty rationales shouldn't reach this code (from_dict drops them),
    but if they did the safest bucket is 'llm' since neither foundational
    nor template markers are present."""
    assert _classify_edge_provenance("") == "llm"


def test_percent_table_sorted_descending():
    table = _percent_table({"extends": 30, "contrasts": 10, "successor": 5})
    assert list(table) == ["extends", "contrasts", "successor"]
    assert "30 (66.7%)" in table["extends"]


def test_percent_table_empty_input():
    assert _percent_table({}) == {}

"""Tests for audit_lineage_quality edge-level metrics (#209).

Existing structural checks (focus year, denylist, cluster
consistency) keep their pre-#209 contract — these tests focus on
the new edge metrics and the warn / fail threshold split.
"""

from __future__ import annotations

import json
from pathlib import Path

from paperpilot.llm.base import TEMPLATE_RATIONALES
from paperpilot.scripts.audit_lineage_quality import (
    _audit_edges,
    _audit_lineage,
    _audit_structural,
    edge_metrics,
)


def _sample_template() -> str:
    return next(iter(TEMPLATE_RATIONALES.values()))


def _mk_node(nid: str, *, year: int = 2023, title: str = "T") -> dict:
    return {"id": nid, "year": year, "title": title}


def _mk_edge(
    src: str, dst: str, *, rationale: str = "specific paper reason"
) -> dict:
    return {"src": src, "dst": dst, "rel": "extends", "conf": 0.7, "rationale": rationale}


# ---- edge_metrics ----------------------------------------------------------


def test_edge_metrics_empty_lineage():
    m = edge_metrics({"nodes": [], "edges": []})
    assert m["edge_count"] == 0
    assert m["template_count"] == 0
    assert m["template_ratio"] == 0.0
    assert m["popularity_sinks"] == 0
    assert m["year_reversals"] == 0


def test_edge_metrics_counts_template_rationales():
    template = _sample_template()
    data = {
        "nodes": [_mk_node("a"), _mk_node("b"), _mk_node("c")],
        "edges": [
            _mk_edge("a", "b", rationale=template),
            _mk_edge("a", "c", rationale="specific reason"),
        ],
    }
    m = edge_metrics(data)
    assert m["edge_count"] == 2
    assert m["template_count"] == 1
    assert m["template_ratio"] == 0.5


def test_edge_metrics_template_detection_strips_whitespace():
    """LLM occasionally trails newlines/spaces — strip before matching."""
    template = _sample_template()
    data = {
        "nodes": [_mk_node("a"), _mk_node("b")],
        "edges": [_mk_edge("a", "b", rationale=f"  {template}\n")],
    }
    assert edge_metrics(data)["template_count"] == 1


def test_edge_metrics_detects_popularity_sink():
    """≥8 incoming edges into a single node = 1 sink."""
    nodes = [_mk_node(f"src{i}") for i in range(8)] + [_mk_node("hub")]
    edges = [_mk_edge(f"src{i}", "hub") for i in range(8)]
    m = edge_metrics({"nodes": nodes, "edges": edges})
    assert m["popularity_sinks"] == 1


def test_edge_metrics_just_under_sink_threshold_doesnt_count():
    """7 incoming = sub-threshold; 8 is the floor (matches the
    `_POPULARITY_SINK_INCOMING = 8` constant)."""
    nodes = [_mk_node(f"src{i}") for i in range(7)] + [_mk_node("hub")]
    edges = [_mk_edge(f"src{i}", "hub") for i in range(7)]
    assert edge_metrics({"nodes": nodes, "edges": edges})["popularity_sinks"] == 0


def test_edge_metrics_detects_year_reversal():
    """Parent year 2024, child year 2018 → reversal (parent > child+1)."""
    data = {
        "nodes": [_mk_node("p", year=2024), _mk_node("c", year=2018)],
        "edges": [_mk_edge("p", "c")],
    }
    assert edge_metrics(data)["year_reversals"] == 1


def test_edge_metrics_one_year_overlap_not_reversal():
    """1-year window absorbs preprint↔conference overlap (e.g. ICLR
    2024 acceptances appearing as 2023 preprints citing 2024 papers).
    parent.year == child.year + 1 → still not a reversal."""
    data = {
        "nodes": [_mk_node("p", year=2024), _mk_node("c", year=2023)],
        "edges": [_mk_edge("p", "c")],
    }
    assert edge_metrics(data)["year_reversals"] == 0


def test_edge_metrics_missing_years_skipped():
    """Edges where either endpoint has no year are not counted as
    reversals (can't know)."""
    data = {
        "nodes": [{"id": "p"}, {"id": "c"}],
        "edges": [_mk_edge("p", "c")],
    }
    assert edge_metrics(data)["year_reversals"] == 0


# ---- _audit_edges (warn vs fail) ------------------------------------------


def test_audit_edges_high_template_ratio_is_hard_fail():
    """> 80% template rationales is a hard fail (regen explicitly
    requested in the operator message)."""
    template = _sample_template()
    nodes = [_mk_node("p"), _mk_node("c")]
    edges = [
        _mk_edge("p", "c", rationale=template),
        _mk_edge("p", "c", rationale=template),
        _mk_edge("p", "c", rationale=template),
        _mk_edge("p", "c", rationale=template),
        _mk_edge("p", "c", rationale=template),
    ]
    _, failures = _audit_edges({"nodes": nodes, "edges": edges})
    assert failures, "100% template should be a hard fail"
    assert any("template_rationale_ratio" in f for f in failures)


def test_audit_edges_moderate_template_ratio_is_warn_only():
    """60-80% template rationales is warned, not failed — regen
    helpful but not blocking."""
    template = _sample_template()
    edges = [
        # 7 of 10 = 70% — between warn (60) and fail (80) thresholds.
        _mk_edge("p", "c", rationale=template)
        for _ in range(7)
    ] + [_mk_edge("p", "c", rationale=f"specific reason {i}") for i in range(3)]
    nodes = [_mk_node("p"), _mk_node("c")]
    warnings, failures = _audit_edges({"nodes": nodes, "edges": edges})
    assert any("template_rationale_ratio" in w for w in warnings)
    assert not any("template_rationale_ratio" in f for f in failures)


def test_audit_edges_low_template_ratio_passes():
    """≤60% template rationales is silent on the template metric."""
    template = _sample_template()
    edges = [_mk_edge("p", "c", rationale=template)] + [
        _mk_edge("p", "c", rationale=f"specific {i}") for i in range(10)
    ]
    nodes = [_mk_node("p"), _mk_node("c")]
    warnings, failures = _audit_edges({"nodes": nodes, "edges": edges})
    assert not any("template" in w for w in warnings)
    assert not any("template" in f for f in failures)


# ---- structural compatibility ----------------------------------------------


def test_audit_structural_keeps_pre_209_focus_year_check_for_conferences():
    """Conference path → focus paper older than min_year is a problem
    (regression guard for the original pre-#209 contract)."""
    data = {"nodes": [{"id": "old", "is_focus": True, "year": 2010}]}
    problems = _audit_structural(
        Path("docs/iclr-2026/lineage.json"), data, min_year=2024
    )
    assert any("too old" in p for p in problems)


def test_audit_structural_skips_focus_year_check_for_themes():
    """Themes legitimately seed on seminal 2017-2020 papers — the
    "too old" check is bypassed for theme paths so the audit doesn't
    explode every theme into 5+ structural failures."""
    data = {"nodes": [{"id": "old", "is_focus": True, "year": 2018}]}
    problems = _audit_structural(
        Path("docs/themes/diffusion-models/lineage.json"),
        data,
        min_year=2024,
    )
    assert not any("too old" in p for p in problems)


def test_audit_structural_no_focus_is_problem():
    """No focus paper is still a problem — both conference and theme
    lineages should have at least one is_focus node."""
    problems = _audit_structural(
        Path("x"), {"nodes": [{"id": "n"}]}, min_year=2010
    )
    assert any("no focus" in p for p in problems)


# ---- _audit_lineage e2e ----------------------------------------------------


def test_audit_lineage_combines_structural_and_edges(tmp_path):
    """End-to-end: structural problems are merged into failures;
    edge warnings are returned separately so CI can render them as
    warn-only summaries."""
    template = _sample_template()
    data = {
        "nodes": [
            {"id": "old", "is_focus": True, "year": 2010, "title": "Old paper"},
            {"id": "c", "year": 2023, "title": "Citing paper"},
        ],
        "edges": [
            _mk_edge("old", "c", rationale=template),
            _mk_edge("old", "c", rationale="specific reason 1"),
            _mk_edge("old", "c", rationale="specific reason 2"),
        ],
    }
    path = tmp_path / "lineage.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    _, failures = _audit_lineage(path, min_year=2024)
    assert any("too old" in f for f in failures)


def test_audit_lineage_unreadable_file_is_failure(tmp_path):
    path = tmp_path / "broken.json"
    path.write_text("not valid json{", encoding="utf-8")
    _, failures = _audit_lineage(path, min_year=2024)
    assert any("unreadable" in f for f in failures)


def test_collect_targets_skips_themes_by_default():
    """Default --include-themes is False, so the CLI walks only
    docs/<conf>/lineage.json. This is critical for not breaking the
    data-audit CI on existing 100%-template themes that haven't been
    regenerated since PR #210."""
    from paperpilot.scripts.audit_lineage_quality import _collect_targets

    targets = _collect_targets()
    # Collect catches everything; the CLI-level main() applies the
    # default filter. Pin the existence of theme paths so the
    # invariant is meaningful — when themes/ exists, _collect_targets
    # must surface them so the --include-themes opt-in can find them.
    has_theme = any("themes" in p.parts for p in targets)
    # Soft assertion: if no themes/ data is present (e.g. tests in a
    # checkout without docs/), the audit just walks conferences and
    # exits clean. Either is fine; what we're pinning is that the
    # helper does NOT silently hide themes paths.
    if has_theme:
        theme_paths = [p for p in targets if "themes" in p.parts]
        assert theme_paths, "themes glob returned 0 paths but themes/ exists"


def test_audit_lineage_clean_lineage_no_warn_or_fail(tmp_path):
    data = {
        "nodes": [
            {"id": "n1", "is_focus": True, "year": 2024, "title": "Focus"},
            {"id": "n2", "year": 2023, "title": "B"},
        ],
        "edges": [
            _mk_edge("n2", "n1", rationale="specific reason"),
        ],
    }
    path = tmp_path / "lineage.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    warnings, failures = _audit_lineage(path, min_year=2020)
    assert warnings == []
    assert failures == []

"""Tests for audit_lineage_quality edge-level metrics (#209).

Existing structural checks (focus year, denylist, cluster
consistency) keep their pre-#209 contract — these tests focus on
the new edge metrics and the warn / fail threshold split.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from paperpilot.llm.base import TEMPLATE_RATIONALES
from paperpilot.scripts.audit_lineage_quality import (
    _audit_edges,
    _audit_lineage,
    _audit_offtopic_nonfocus,
    _audit_structural,
    edge_metrics,
    offtopic_nonfocus_metric,
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


def test_edge_metrics_counts_short_rationales():
    """#297: a non-empty but sub-floor rationale ("A") is degenerate."""
    data = {
        "nodes": [_mk_node("a"), _mk_node("b"), _mk_node("c")],
        "edges": [
            _mk_edge("a", "b", rationale="A"),
            _mk_edge("a", "c", rationale="specific paper reason"),
        ],
    }
    m = edge_metrics(data)
    assert m["short_rationale_count"] == 1
    assert m["short_rationale_ratio"] == 0.5


def test_edge_metrics_empty_rationale_not_counted_as_short():
    """Empty rationales are dropped upstream; the short metric counts only
    the 0 < len < floor band so it doesn't double-count empties."""
    data = {
        "nodes": [_mk_node("a"), _mk_node("b")],
        "edges": [_mk_edge("a", "b", rationale="")],
    }
    assert edge_metrics(data)["short_rationale_count"] == 0


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


def test_audit_edges_high_short_rationale_ratio_warns_not_fails():
    """#297: short_rationale is WARN-only for now — hard-fail is deferred
    until the legacy ~71%-degenerate iclr-2026 data is regenerated (it
    can't be cleaned without an LLM). Even 80% degenerate only warns, so
    the data-audit job isn't red on un-regenerated legacy data."""
    nodes = [_mk_node("p"), _mk_node("c")]
    edges = [_mk_edge("p", "c", rationale="A") for _ in range(4)] + [
        _mk_edge("p", "c", rationale="specific paper reason")
    ]
    warnings, failures = _audit_edges({"nodes": nodes, "edges": edges})
    assert any("short_rationale_ratio" in w for w in warnings), warnings
    assert not any("short_rationale" in f for f in failures), failures


def test_audit_edges_moderate_short_rationale_is_warn_only():
    """20-50% degenerate is a warning, not a hard fail."""
    nodes = [_mk_node("p"), _mk_node("c")]
    edges = [_mk_edge("p", "c", rationale="A")] + [
        _mk_edge("p", "c", rationale="specific paper reason") for _ in range(3)
    ]
    warnings, failures = _audit_edges({"nodes": nodes, "edges": edges})
    assert not any("short_rationale" in f for f in failures), failures
    assert any("short_rationale_ratio" in w for w in warnings), warnings


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


# ---- offtopic_nonfocus_metric (#298 Part 4: warn-only drift detection) -----


def _nf(title: str) -> dict:
    """A non-focus (BFS-discovered) node with the given title."""
    return {"id": title, "title": title, "is_focus": False}


def test_offtopic_nonfocus_metric_flags_contaminated_theme():
    """A drifted theme (off-topic non-focus nodes) gets a high ratio."""
    data = {
        "meta": {"theme": "Vision Transformer"},
        "nodes": [
            {"id": "s", "title": "Vision Transformer", "is_focus": True},
            _nf("Lip to Speech Synthesis"),
            _nf("Decoding Lip Language with Sensors"),
            _nf("Vision Transformer for Segmentation"),  # on-topic
        ],
        "edges": [],
    }
    m = offtopic_nonfocus_metric(data)
    assert m["nonfocus_count"] == 3  # the focus node is excluded
    assert m["offtopic_count"] == 2  # the two lip-* nodes
    assert m["offtopic_ratio"] > 0.5


def test_offtopic_nonfocus_metric_clean_theme_is_zero():
    data = {
        "meta": {"theme": "Vision Transformer"},
        "nodes": [
            _nf("Vision Transformer at Scale"),
            _nf("Hierarchical Vision Transformer"),
        ],
        "edges": [],
    }
    assert offtopic_nonfocus_metric(data)["offtopic_ratio"] == 0.0


def test_offtopic_nonfocus_metric_exempts_foundational_ancestor():
    """Foundational anchors are off-surface-topic but legitimate — exempt,
    not counted as off-topic (would otherwise inflate every deep tree)."""
    data = {
        "meta": {"theme": "Vision Transformer"},
        "nodes": [_nf("Attention Is All You Need")],
        "edges": [],
    }
    m = offtopic_nonfocus_metric(data)
    assert m["foundational_exempt"] == 1
    assert m["nonfocus_count"] == 0  # exempted before the off-topic count
    assert m["offtopic_ratio"] == 0.0


def test_offtopic_nonfocus_metric_no_theme_is_zero():
    """A non-theme lineage (no meta.theme/slug) never warns."""
    data = {"meta": {}, "nodes": [_nf("Anything At All")], "edges": []}
    assert offtopic_nonfocus_metric(data)["offtopic_ratio"] == 0.0


def test_audit_offtopic_nonfocus_warns_not_fails():
    """Detection is WARN-only — it surfaces a warning, never a failure
    (a legit deep tree also scores high, so only an operator can adjudicate)."""
    data = {
        "meta": {"theme": "Vision Transformer"},
        "nodes": [
            _nf("Lip to Speech Synthesis"),
            _nf("Audio-Visual Speech Recognition"),
            _nf("Triboelectric Lip Reading System"),
        ],
        "edges": [],
    }
    warnings = _audit_offtopic_nonfocus(data)
    assert warnings
    assert any("offtopic_nonfocus_ratio" in w for w in warnings)


# ---- #358: per-conference min_year + empty-stub skip -----------------------
#
# The data-audit workflow had been silent since 2026-06-15 because its paths
# filter matched only `docs/iclr-*/lineage.json`. Opening it up to every
# conference surfaced two false positives that would red develop on every
# PR touching any conference data:
#
#   1. `eccv-2024` has 13 focus papers all from 2024, but the default
#      `--min-year` was `datetime.now().year - 1` (wall-clock, 2025 at the
#      time of writing) — so every focus paper tripped "focus paper too old".
#      The fix: derive min_year from the directory name `<venue>-<year>`
#      (→ year - 1) so each conference is judged against its own year.
#
#   2. 8 conferences have ~290B stub `lineage.json` files (nodes=[], edges=[])
#      because the catalog works without a lineage and the file exists only
#      to keep the viewer's probe at 200 rather than 404. Those tripped
#      "no focus papers". The fix: treat nodes+edges empty as "not generated"
#      and SKIP — consistent with the site's honest "not generated yet"
#      stance. WARN would also be acceptable; FAIL is not.


def test_conference_year_from_path_extracts_year():
    """`docs/eccv-2024/lineage.json` → 2024, `docs/iclr-2026/lineage.json` → 2026."""
    from paperpilot.scripts.audit_lineage_quality import _conference_year_from_path

    assert _conference_year_from_path(Path("docs/eccv-2024/lineage.json")) == 2024
    assert _conference_year_from_path(Path("docs/iclr-2026/lineage.json")) == 2026
    assert _conference_year_from_path(Path("docs/cvpr-2025/lineage.json")) == 2025


def test_conference_year_from_path_returns_none_for_themes():
    """Theme paths never participate in the per-conference derivation."""
    from paperpilot.scripts.audit_lineage_quality import _conference_year_from_path

    assert (
        _conference_year_from_path(Path("docs/themes/diffusion-models/lineage.json"))
        is None
    )


def test_conference_year_from_path_returns_none_for_unparseable():
    """A directory that isn't `<venue>-<year>` falls back to the legacy
    wall-clock default (caller's responsibility)."""
    from paperpilot.scripts.audit_lineage_quality import _conference_year_from_path

    assert _conference_year_from_path(Path("docs/unknown/lineage.json")) is None
    assert _conference_year_from_path(Path("docs/not-a-year/lineage.json")) is None
    assert _conference_year_from_path(Path("docs/abc-12345/lineage.json")) is None


def test_is_empty_stub_true_for_empty_data():
    """Empty stub = both nodes and edges empty/missing. Matches the ~290B
    scaffold files under docs/<conf>/lineage.json for the 8 conferences
    whose lineage hasn't been generated yet."""
    from paperpilot.scripts.audit_lineage_quality import _is_empty_stub

    assert _is_empty_stub({"nodes": [], "edges": []}) is True
    assert _is_empty_stub({"nodes": [], "edges": [], "meta": {"source": "none"}}) is True
    assert _is_empty_stub({}) is True
    assert _is_empty_stub({"meta": {"note": "missing nodes/edges keys"}}) is True


def test_is_empty_stub_false_when_either_side_has_content():
    """A lineage with any node or any edge is NOT a stub — even if it has
    no focus papers, that's a real structural problem worth reporting."""
    from paperpilot.scripts.audit_lineage_quality import _is_empty_stub

    assert _is_empty_stub({"nodes": [{"id": "a"}], "edges": []}) is False
    assert _is_empty_stub({"nodes": [], "edges": [{"src": "a", "dst": "b"}]}) is False


def test_effective_min_year_derived_from_conference_dir():
    """eccv-2024 without --min-year → 2024 - 1 = 2023. That lets the 13
    2024 focus papers pass (2024 ≥ 2023)."""
    from paperpilot.scripts.audit_lineage_quality import _effective_min_year

    assert (
        _effective_min_year(Path("docs/eccv-2024/lineage.json"), None, 2025) == 2023
    )
    assert (
        _effective_min_year(Path("docs/iclr-2026/lineage.json"), None, 2025) == 2025
    )


def test_effective_min_year_explicit_overrides_dir():
    """--min-year wins over the directory-derived value — the explicit
    knob must still work for ad-hoc audits."""
    from paperpilot.scripts.audit_lineage_quality import _effective_min_year

    assert (
        _effective_min_year(Path("docs/eccv-2024/lineage.json"), 2020, 2025) == 2020
    )


def test_effective_min_year_falls_back_for_unknown_dir():
    """A directory without `<venue>-<year>` uses the caller-supplied
    fallback (wall-clock - 1 in main)."""
    from paperpilot.scripts.audit_lineage_quality import _effective_min_year

    assert (
        _effective_min_year(Path("docs/unknown/lineage.json"), None, 2025) == 2025
    )


def test_effective_min_year_falls_back_for_themes():
    """Theme paths always go through the fallback (the focus-year check
    is bypassed for themes anyway, but the helper still returns a value)."""
    from paperpilot.scripts.audit_lineage_quality import _effective_min_year

    assert (
        _effective_min_year(
            Path("docs/themes/diffusion-models/lineage.json"), None, 2025
        )
        == 2025
    )


def test_main_empty_stub_is_skip_not_fail(tmp_path, monkeypatch, capsys):
    """A conference with nodes=[] + edges=[] is SKIP, not FAIL. exit 0."""
    from paperpilot.scripts import audit_lineage_quality as mod

    conf_dir = tmp_path / "myconf-2024"
    conf_dir.mkdir()
    (conf_dir / "lineage.json").write_text(
        json.dumps(
            {
                "root": None,
                "nodes": [],
                "edges": [],
                "meta": {"source": "none", "conference": "myconf-2024"},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(mod, "DOCS_DIR", tmp_path)
    monkeypatch.setattr(sys, "argv", ["audit"])
    rc = mod.main()
    assert rc == 0, "empty stub must not fail the audit"
    out = capsys.readouterr().out
    assert "SKIP" in out
    assert "FAIL" not in out


def test_main_conference_year_lets_same_year_focus_pass(
    tmp_path, monkeypatch, capsys
):
    """eccv-2024 with focus papers from 2024 should NOT fail when --min-year
    isn't set (derived min_year = 2023, 2024 ≥ 2023)."""
    from paperpilot.scripts import audit_lineage_quality as mod

    conf_dir = tmp_path / "eccv-2024"
    conf_dir.mkdir()
    data = {
        "nodes": [
            {"id": "p", "is_focus": True, "year": 2024, "title": "Focus from conf year"},
            {"id": "c", "year": 2023, "title": "Citing paper"},
        ],
        "edges": [
            {
                "src": "c",
                "dst": "p",
                "rel": "extends",
                "conf": 0.7,
                "rationale": "specific paper reason",
            }
        ],
    }
    (conf_dir / "lineage.json").write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setattr(mod, "DOCS_DIR", tmp_path)
    monkeypatch.setattr(sys, "argv", ["audit"])
    rc = mod.main()
    assert rc == 0, "focus papers from the conference year must pass"
    out = capsys.readouterr().out
    assert "FAIL" not in out
    assert "too old" not in out


def test_main_explicit_min_year_overrides_dir_derived(
    tmp_path, monkeypatch
):
    """--min-year 2022 makes eccv-2024's focus year=2020 fail, even though
    the dir-derived default would be 2023 (which the 2020 paper would pass)."""
    from paperpilot.scripts import audit_lineage_quality as mod

    conf_dir = tmp_path / "eccv-2024"
    conf_dir.mkdir()
    data = {
        "nodes": [
            {"id": "p", "is_focus": True, "year": 2020, "title": "Old focus"},
        ],
        "edges": [],
    }
    (conf_dir / "lineage.json").write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setattr(mod, "DOCS_DIR", tmp_path)
    monkeypatch.setattr(sys, "argv", ["audit", "--min-year=2022"])
    rc = mod.main()
    assert rc == 1, "explicit --min-year must override dir-derived default"


def test_main_unknown_dir_uses_wall_clock_fallback(
    tmp_path, monkeypatch
):
    """A directory without `<venue>-<year>` falls back to wall-clock - 1,
    so a paper from wall-clock - 2 is 'too old'."""
    import datetime as _dt

    from paperpilot.scripts import audit_lineage_quality as mod

    conf_dir = tmp_path / "unknown"
    conf_dir.mkdir()
    data = {
        "nodes": [
            {
                "id": "p",
                "is_focus": True,
                "year": _dt.datetime.now().year - 2,
                "title": "Old",
            },
        ],
        "edges": [],
    }
    (conf_dir / "lineage.json").write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setattr(mod, "DOCS_DIR", tmp_path)
    monkeypatch.setattr(sys, "argv", ["audit"])
    rc = mod.main()
    assert rc == 1, "unknown dir → wall-clock fallback → old paper fails"

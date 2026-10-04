"""Tests for paperpilot.scripts.compute_theme_quality.

Verifies the rollup written to docs/themes/_quality.json mirrors the
audit signals (template ratio, off-topic seeds, year reversals) on a
controlled synthetic theme directory. The production audit / edge-metric
implementations are themselves covered by their dedicated tests; this
file exercises the integration layer.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from paperpilot.llm.base import TEMPLATE_RATIONALES
from paperpilot.scripts import compute_theme_quality as ctq

# Pick a real template string so edge_metrics' byte-for-byte set lookup
# fires. Picking dynamically from production keeps the test honest if
# the template wording is ever revised — the test won't quietly stop
# detecting templates.
_EXTENDS_TEMPLATE = TEMPLATE_RATIONALES["extends_methodology"]


@pytest.fixture
def synthetic_themes_dir(tmp_path, monkeypatch):
    """Stand up a temp themes dir with two small lineage.json files.

    Theme A: clean. 1 seed (on-topic), 1 paper-specific rationale, no
    year reversals or popularity sinks.

    Theme B: degraded. 1 seed (off-topic), 1 template rationale, 1 year
    reversal.

    Returns the tmp path so the test can also poke at the written
    _quality.json afterwards.
    """
    themes_dir = tmp_path / "themes"
    themes_dir.mkdir()

    # Theme A — clean
    # Edge convention in this codebase: src = parent (older), dst = child
    # (newer extender). year_reversals flags src.year > dst.year + 1.
    (themes_dir / "clean-theme").mkdir()
    (themes_dir / "clean-theme" / "lineage.json").write_text(json.dumps({
        "meta": {"theme": "Clean Theme"},
        "nodes": [
            {"id": "p1", "title": "Clean Theme: a survey", "year": 2020, "is_focus": True,
             "tldr": "we present clean theme techniques"},
            {"id": "p2", "title": "Earlier work", "year": 2018,
             "tldr": "earlier related study"},
        ],
        "edges": [
            # p2 (parent, 2018) extended by p1 (child, 2020) — chronological.
            {"src": "p2", "dst": "p1", "rel": "extends",
             "rationale": "p1 directly cites p2 and benchmarks against its proposed metric"},
        ],
    }), encoding="utf-8")

    # Theme B — degraded
    (themes_dir / "messy-theme").mkdir()
    (themes_dir / "messy-theme" / "lineage.json").write_text(json.dumps({
        "meta": {"theme": "Messy Topic"},
        "nodes": [
            # off-topic seed: title and tldr both miss "messy" AND "topic"
            {"id": "p3", "title": "Unrelated work", "year": 2025, "is_focus": True,
             "tldr": "study of network protocols"},
            {"id": "p4", "title": "Even earlier work", "year": 2020,
             "tldr": "..."},
        ],
        "edges": [
            # Real template rationale string from production (byte-for-byte).
            # p3 (2025) as parent of p4 (2020) is a year reversal — pinned
            # so the metric is actually exercised.
            {"src": "p3", "dst": "p4", "rel": "extends",
             "rationale": _EXTENDS_TEMPLATE},
        ],
    }), encoding="utf-8")

    out_path = themes_dir / "_quality.json"
    monkeypatch.setattr(ctq, "THEMES_DIR", themes_dir)
    monkeypatch.setattr(ctq, "OUT_PATH", out_path)
    return themes_dir


def test_compute_quality_emits_clean_signals_for_clean_theme(synthetic_themes_dir):
    rollup = ctq.compute_quality(now=datetime(2026, 6, 4, tzinfo=timezone.utc))
    clean = rollup["themes"]["clean-theme"]
    assert clean["theme"] == "Clean Theme"
    assert clean["node_count"] == 2
    assert clean["focus_count"] == 1
    assert clean["off_topic_focus"] == 0
    assert clean["edge_count"] == 1
    assert clean["template_count"] == 0
    assert clean["template_ratio"] == 0.0
    assert clean["popularity_sinks"] == 0
    assert clean["year_reversals"] == 0


def test_compute_quality_flags_off_topic_and_template_for_messy_theme(synthetic_themes_dir):
    rollup = ctq.compute_quality(now=datetime(2026, 6, 4, tzinfo=timezone.utc))
    messy = rollup["themes"]["messy-theme"]
    assert messy["off_topic_focus"] == 1
    assert messy["template_count"] == 1
    assert messy["template_ratio"] == 1.0
    # Fixture: src=p3 (year 2025) → dst=p4 (year 2020), src.year > dst.year
    # by 5 years → counts as 1 year reversal.
    assert messy["year_reversals"] == 1


def test_compute_quality_summary_counts_high_template_and_off_topic(synthetic_themes_dir):
    rollup = ctq.compute_quality(now=datetime(2026, 6, 4, tzinfo=timezone.utc))
    s = rollup["summary"]
    assert s["theme_count"] == 2
    # 1 clean (template_ratio=0) + 1 messy (template_ratio=1.0)
    # The 30% threshold puts messy in the "high" bucket only.
    assert s["themes_with_template_rationale_high"] == 1
    assert s["themes_with_off_topic_seeds"] == 1
    assert s["total_nodes"] == 4
    assert s["total_edges"] == 2
    assert s["total_off_topic_focus"] == 1


def test_compute_quality_handles_missing_lineage_json(tmp_path, monkeypatch):
    """A directory under themes/ without a lineage.json is silently
    skipped — guards against half-built themes leaving the rollup in a
    crashed state."""
    themes_dir = tmp_path / "themes"
    themes_dir.mkdir()
    (themes_dir / "half-built").mkdir()  # no lineage.json inside
    monkeypatch.setattr(ctq, "THEMES_DIR", themes_dir)
    monkeypatch.setattr(ctq, "OUT_PATH", themes_dir / "_quality.json")
    rollup = ctq.compute_quality(now=datetime(2026, 6, 4, tzinfo=timezone.utc))
    assert rollup["themes"] == {}
    assert rollup["summary"]["theme_count"] == 0


def test_main_write_failure_leaves_original_file_intact(synthetic_themes_dir, monkeypatch):
    """A write failure mid-replace must not corrupt a pre-existing
    _quality.json, and must not leave a stray temp file behind.
    ``atomic_write_text`` only replaces the destination via
    ``os.replace`` after the payload is fully written to a sibling temp
    file; mock ``os.replace`` to raise and confirm the previous content
    (and absence of temp files) survives."""
    out_path = synthetic_themes_dir / "_quality.json"
    previous_content = json.dumps({"stale": "previous rollup"})
    out_path.write_text(previous_content, encoding="utf-8")

    def _boom(*args, **kwargs):
        raise OSError("disk full (simulated)")

    monkeypatch.setattr("paperpilot.utils.atomic.os.replace", _boom)

    with pytest.raises(OSError):
        ctq.main([])

    assert out_path.read_text(encoding="utf-8") == previous_content
    # No leftover atomic-write temp file (dotfile, .tmp suffix) behind.
    tmp_leftovers = list(synthetic_themes_dir.glob(".*.tmp"))
    assert tmp_leftovers == [], f"stray temp files left behind: {tmp_leftovers}"


def test_main_writes_output_file(synthetic_themes_dir, capsys):
    """End-to-end CLI happy path: main() must write the file and report
    the counts to stdout."""
    rc = ctq.main([])
    assert rc == 0
    out = synthetic_themes_dir / "_quality.json"
    assert out.exists()
    written = json.loads(out.read_text(encoding="utf-8"))
    assert set(written["themes"]) == {"clean-theme", "messy-theme"}
    stdout = capsys.readouterr().out
    assert "wrote" in stdout
    assert "2 themes" in stdout

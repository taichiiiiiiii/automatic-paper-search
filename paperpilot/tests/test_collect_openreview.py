"""Tests for paperpilot/scripts/collect_openreview.py.

OpenReview is the authoritative accepted-paper source for ICLR / NeurIPS /
ICML. Network is never hit: `build_rows` is pure given duck-typed note
dicts, and `fetch_notes` is exercised by patching `request_with_retry`.

Key invariants:
    - the official decision label (Oral / Spotlight / Poster) parsed from the
      note's `venue` value drives the highlighted set (Oral + Spotlight)
    - output rows carry the SAME schema as collect_conference, so the rest of
      the chain (build_summary_csv -> build_pages -> scaffold) is reused
"""

from __future__ import annotations

import csv as _csv
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.scripts import collect_conference as cc
from paperpilot.scripts import collect_openreview as co


def _note(title, decision, nid, *, venueid="ICLR.cc/2025/Conference", authors=("Alice", "Bob")):
    """An OpenReview API v2 note: content values are wrapped as {value: ...}."""
    label = f"ICLR 2025 {decision}".strip()
    return {
        "id": nid,
        "content": {
            "title": {"value": title},
            "abstract": {"value": "an abstract about representation learning"},
            "authors": {"value": list(authors)},
            "venue": {"value": label},
            "venueid": {"value": venueid},
        },
    }


# ---- _value (v2 content unwrap) ----


def test_value_unwraps_v2_and_plain():
    assert co._value({"k": {"value": "x"}}, "k") == "x"
    assert co._value({"k": "plain"}, "k") == "plain"
    assert co._value({}, "missing", "dft") == "dft"


def test_value_null_value_returns_default_not_none():
    # OpenReview represents a null field as {"value": null}; must not become "None"
    assert co._value({"abstract": {"value": None}}, "abstract", "") == ""
    assert co._value({"abstract": None}, "abstract", "") == ""


# ---- _decision ----


def test_decision_parses_label_case_insensitively():
    assert co._decision("ICLR 2025 Oral") == "Oral"
    assert co._decision("NeurIPS 2024 spotlight") == "Spotlight"
    assert co._decision("ICLR 2025 Poster") == "Poster"
    assert co._decision("Accept") == ""  # no recognised tier word


def test_decision_handles_icml_compound_spotlightposter():
    # ICML 2025 labels spotlight papers "spotlightposter" (no word break) —
    # the \b-bounded bare "spotlight"/"poster" alternatives would miss it.
    assert co._decision("ICML 2025 spotlightposter") == "Spotlight"


def test_decision_spotlightposter_is_highlighted():
    note = {
        "id": "ic1",
        "content": {
            "title": {"value": "ICML spot"},
            "venue": {"value": "ICML 2025 spotlightposter"},
            "venueid": {"value": "ICML.cc/2025/Conference"},
            "authors": {"value": ["A"]},
            "abstract": {"value": "x"},
        },
    }
    _, highlighted = co.build_rows([note], "ICML", "ICML.cc/2025/Conference")
    assert highlighted == ["ICML spot"]


# ---- _venue_tier ----


def test_venue_tier_from_signal_sets():
    assert co._venue_tier("ICLR") == 1
    assert co._venue_tier("neurips") == 1  # lowercase is uppercased inside _venue_tier
    assert co._venue_tier("CVPR") == 2
    assert co._venue_tier("ECCV") == 3
    assert co._venue_tier("UNKNOWN") == 0


# ---- build_rows ----


def test_build_rows_maps_fields_and_highlights_oral_spotlight():
    notes = [
        _note("Oral paper", "Oral", "aaa"),
        _note("Spotlight paper", "Spotlight", "bbb"),
        _note("Poster paper", "Poster", "ccc"),
    ]
    rows, highlighted = co.build_rows(notes, "ICLR", "ICLR.cc/2025/Conference")

    assert {r["title"] for r in rows} == {"Oral paper", "Spotlight paper", "Poster paper"}
    assert all(r["venue"] == "ICLR" and r["venue_tier"] == 1 for r in rows)
    assert all(r["citation_count"] == 0 and r["github_stars"] == 0 for r in rows)
    # forum / pdf URLs derive from the note id
    oral = next(r for r in rows if r["title"] == "Oral paper")
    assert oral["url"] == "https://openreview.net/forum?id=aaa"
    assert oral["pdf_url"] == "https://openreview.net/pdf?id=aaa"
    assert oral["comment"] == "ICLR 2025 Oral"  # official label retained
    # Oral + Spotlight are highlighted; Poster is not
    assert set(highlighted) == {"Oral paper", "Spotlight paper"}


def test_build_rows_authors_joined_with_semicolons():
    rows, _ = co.build_rows([_note("P", "Poster", "x", authors=("A", "B", "C"))], "ICLR", "ICLR.cc/2025/Conference")
    assert rows[0]["authors"] == "A; B; C"


def test_build_rows_dedups_by_note_id():
    notes = [_note("First", "Poster", "dup"), _note("Second same id", "Poster", "dup")]
    rows, _ = co.build_rows(notes, "ICLR", "ICLR.cc/2025/Conference")
    assert len(rows) == 1 and rows[0]["title"] == "First"


def test_build_rows_skips_no_title_or_id():
    notes = [
        _note("", "Poster", "has-id"),  # no title
        {"id": "", "content": {"title": {"value": "no id"}}},  # no id
    ]
    rows, _ = co.build_rows(notes, "ICLR", "ICLR.cc/2025/Conference")
    assert rows == []


def test_build_rows_drops_mismatched_venueid():
    """Rejected/withdrawn notes carry a different venueid; drop them defensively."""
    notes = [
        _note("Accepted", "Poster", "ok", venueid="ICLR.cc/2025/Conference"),
        _note("Withdrawn", "", "wd", venueid="ICLR.cc/2025/Conference/Withdrawn_Submission"),
    ]
    rows, _ = co.build_rows(notes, "ICLR", "ICLR.cc/2025/Conference")
    assert {r["title"] for r in rows} == {"Accepted"}


# ---- fetch_notes (paginated, network mocked) ----


def _resp(notes):
    return SimpleNamespace(status_code=200, json=lambda: {"notes": notes})


def test_fetch_notes_paginates_until_short_page():
    page1 = [_note(f"p{i}", "Poster", f"id{i}") for i in range(1000)]
    page2 = [_note("last", "Poster", "idlast")]  # short page -> stop
    calls = []

    def fake(method, url, *, params=None, **kw):
        calls.append(params["offset"])
        return _resp(page1 if params["offset"] == 0 else page2)

    with patch.object(co, "request_with_retry", side_effect=fake):
        notes = co.fetch_notes("ICLR.cc/2025/Conference", page_size=1000)

    assert len(notes) == 1001
    assert calls == [0, 1000]  # advanced by page_size, stopped after short page


def test_fetch_notes_failsafe_on_api_error():
    with patch.object(co, "request_with_retry", return_value=None):
        assert co.fetch_notes("ICLR.cc/2025/Conference") == []


def test_fetch_notes_returns_partial_on_mid_run_error():
    """Page 1 succeeds, page 2 fails -> the page-1 notes are still returned."""
    page1 = [_note(f"p{i}", "Poster", f"id{i}") for i in range(1000)]
    calls = {"n": 0}

    def fake(method, url, *, params=None, **kw):
        calls["n"] += 1
        return _resp(page1) if calls["n"] == 1 else None

    with patch.object(co, "request_with_retry", side_effect=fake):
        notes = co.fetch_notes("ICLR.cc/2025/Conference", page_size=1000)
    assert len(notes) == 1000


def test_fetch_notes_failsafe_on_non_json_body():
    """200 with a non-JSON body must not raise (Fail-Safe)."""
    def raise_json():
        raise ValueError("no json")

    bad = SimpleNamespace(status_code=200, json=raise_json)
    with patch.object(co, "request_with_retry", return_value=bad):
        assert co.fetch_notes("ICLR.cc/2025/Conference") == []


def test_build_rows_null_abstract_is_empty_not_none_string():
    note = {
        "id": "n1",
        "content": {
            "title": {"value": "Has null abstract"},
            "abstract": {"value": None},
            "venue": {"value": "ICLR 2025 Poster"},
            "venueid": {"value": "ICLR.cc/2025/Conference"},
            "authors": {"value": ["A"]},
        },
    }
    rows, _ = co.build_rows([note], "ICLR", "ICLR.cc/2025/Conference")
    assert rows[0]["abstract"] == ""  # not the literal "None"


def test_fetch_notes_stops_at_max_pages():
    full = [_note(f"p{i}", "Poster", f"id{i}") for i in range(2)]  # always "full"
    with patch.object(co, "request_with_retry", return_value=_resp(full)):
        notes = co.fetch_notes("ICLR.cc/2025/Conference", page_size=2, max_pages=3)
    assert len(notes) == 6  # 3 pages * 2, capped by max_pages


# ---- end-to-end: rows feed collect_conference.write_outputs unchanged ----


def test_rows_write_via_shared_writer(tmp_path: Path):
    notes = [_note("Oral one", "Oral", "z1"), _note("Poster two", "Poster", "z2")]
    rows, highlighted = co.build_rows(notes, "ICLR", "ICLR.cc/2025/Conference")
    csv_path = cc.write_outputs("iclr-2025", rows, highlighted, output_root=tmp_path, date="2026-06-28")

    with csv_path.open(encoding="utf-8-sig") as f:
        read = list(_csv.DictReader(f))
    assert list(read[0].keys()) == cc._CSV_COLUMNS  # schema parity
    oral_md = (tmp_path / "iclr-2025" / "oral_summaries_ja.md").read_text(encoding="utf-8")
    assert "## 1. Oral one" in oral_md
    assert "Poster two" not in oral_md

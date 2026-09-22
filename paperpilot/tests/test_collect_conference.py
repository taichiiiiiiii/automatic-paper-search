"""Tests for paperpilot/scripts/collect_conference.py.

Network (arXiv) is never hit — build_rows / write_outputs are pure given
duck-typed result objects, so we feed SimpleNamespace stand-ins for
arxiv.Result. The key invariant: the SAME VenueSignal acceptance semantics
the pipeline uses (keep "accepted to <venue>", drop workshop / bare-mention /
other-venue) carry through here.
"""

from __future__ import annotations

import csv as _csv
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from paperpilot.scripts import collect_conference as cc


def _result(title: str, comment: str, aid: str, authors: tuple[str, ...] = ("Alice", "Bob")):
    return SimpleNamespace(
        title=title,
        summary="an abstract about computer vision",
        comment=comment,
        entry_id=f"http://arxiv.org/abs/{aid}v1",
        pdf_url=f"https://arxiv.org/pdf/{aid}v1",
        authors=[SimpleNamespace(name=n) for n in authors],
    )


def test_build_rows_keeps_genuine_acceptance_only():
    results = [
        _result("Accepted paper", "Accepted to CVPR 2026", "2604.00001"),
        _result("Highlight paper", "Accepted to CVPR 2026 (Highlight)", "2604.00002"),
        _result("Workshop paper", "CVPR 2026 FGVC Workshop", "2604.00003"),
        _result("Bare mention", "CVPR 2026", "2604.00004"),
        _result("Other venue", "Accepted to ICLR 2026", "2604.00005"),
        _result("No comment", "", "2604.00006"),
    ]
    rows, orals = cc.build_rows(results, "CVPR")

    titles = {r["title"] for r in rows}
    # workshop, bare mention, other venue, and no-comment are all dropped
    assert titles == {"Accepted paper", "Highlight paper"}
    assert all(r["venue"] == "CVPR" and r["venue_tier"] == 2 for r in rows)
    assert all(r["citation_count"] == 0 and r["github_stars"] == 0 for r in rows)
    # only the Highlight one carries an oral marker
    assert orals == ["Highlight paper"]


def test_oral_titles_from_arxiv_overlay():
    """The overlay helper returns only the venue's arXiv oral/highlight titles."""
    from unittest.mock import patch

    results = [
        _result("Oral one", "Accepted to CVPR 2025 (Oral)", "2501.00001"),
        _result("Highlight two", "Accepted to CVPR 2025 Highlight", "2501.00002"),
        _result("Plain poster", "Accepted to CVPR 2025", "2501.00003"),
        _result("Other venue oral", "Accepted to ICLR 2025 (Oral)", "2501.00004"),
    ]
    with patch.object(cc, "fetch_results", return_value=results) as fr:
        titles = cc.oral_titles_from_arxiv('co:"CVPR 2025"', "CVPR")
    fr.assert_called_once()
    assert titles == ["Oral one", "Highlight two"]  # CVPR orals only; poster + other venue excluded


def test_build_rows_is_case_insensitive_on_venue_arg():
    results = [_result("P", "Accepted to CVPR 2026", "2604.00010")]
    rows, _ = cc.build_rows(results, "cvpr")  # lowercase arg
    assert len(rows) == 1 and rows[0]["venue"] == "CVPR"


def test_build_rows_dedups_by_arxiv_id():
    results = [
        _result("First", "Accepted to CVPR 2026", "2604.00001"),
        _result("Duplicate same id", "Accepted to CVPR 2026", "2604.00001"),
    ]
    rows, _ = cc.build_rows(results, "CVPR")
    assert len(rows) == 1 and rows[0]["title"] == "First"


def test_build_rows_skips_unparseable_id():
    bad = SimpleNamespace(
        title="No id",
        summary="x",
        comment="Accepted to CVPR 2026",
        entry_id="not-a-real-url",
        pdf_url="",
        authors=[],
    )
    rows, _ = cc.build_rows([bad], "CVPR")
    assert rows == []


def test_write_outputs_schema_and_oral_md(tmp_path: Path):
    rows, orals = cc.build_rows(
        [_result("Paper One", "Accepted to CVPR 2026 Oral", "2604.00009")], "CVPR"
    )
    csv_path = cc.write_outputs("cvpr-2026", rows, orals, output_root=tmp_path, date="2026-06-28")

    assert csv_path == tmp_path / "cvpr-2026" / "papers_2026-06-28.csv"
    with csv_path.open(encoding="utf-8-sig") as f:
        read = list(_csv.DictReader(f))
    assert list(read[0].keys()) == cc._CSV_COLUMNS
    assert read[0]["arxiv_id"] == "2604.00009"
    assert read[0]["venue"] == "CVPR"
    assert read[0]["source"] == "arxiv"
    assert read[0]["source_id"] == "2604.00009"

    oral_md = (tmp_path / "cvpr-2026" / "oral_summaries_ja.md").read_text(encoding="utf-8")
    assert "## 1. Paper One" in oral_md


def test_write_outputs_no_oral_md_when_empty(tmp_path: Path):
    rows, orals = cc.build_rows([_result("Poster", "Accepted to CVPR 2026", "2604.00011")], "CVPR")
    cc.write_outputs("cvpr-2026", rows, orals, output_root=tmp_path, date="2026-06-28")
    assert not (tmp_path / "cvpr-2026" / "oral_summaries_ja.md").exists()


def test_write_outputs_clears_stale_oral_md_on_empty_recollection(tmp_path: Path):
    """A re-collection with no orals (CVF/ACL) must remove a prior oral file
    so build_summary_csv stops marking the old titles Oral."""
    conf_dir = tmp_path / "cvpr-2025"
    conf_dir.mkdir(parents=True)
    stale = conf_dir / "oral_summaries_ja.md"
    stale.write_text("# old\n## 1. Some Old Oral Title\n", encoding="utf-8")

    cc.write_outputs(
        "cvpr-2025",
        [
            {
                "title": "P",
                "authors": "",
                "venue": "CVPR",
                "venue_tier": 2,
                "citation_count": 0,
                "github_stars": 0,
                "arxiv_id": "",
                "abstract": "",
                "url": "https://arxiv.org/abs/2404.00007",
                "pdf_url": "",
                "comment": "",
            }
        ],
        [],  # no orals this run
        output_root=tmp_path,
        date="2026-06-28",
    )
    assert not stale.exists()


def test_write_outputs_rejects_path_traversal_conference_slug(tmp_path: Path):
    """Regression test (closes #390): a malicious --conference value must
    be rejected outright, never used to escape the output root."""
    rows, orals = cc.build_rows(
        [_result("Paper One", "Accepted to CVPR 2026", "2604.00009")], "CVPR"
    )
    for bad in ("../../etc/passwd", "..", "/etc/passwd", "cvpr/../../escape", ""):
        with pytest.raises(ValueError):
            cc.write_outputs(bad, rows, orals, output_root=tmp_path, date="2026-06-28")
    # Nothing must have been written inside the root...
    assert list(tmp_path.iterdir()) == []
    # ...and prove the "outside" claim concretely: compute exactly what the
    # unvalidated old code (`root / conference`) would have resolved to for
    # one representative traversal string, and assert nothing exists there.
    escape_target = (tmp_path / "../../etc/passwd").resolve()
    assert not escape_target.exists()


def test_main_cli_rejects_malicious_conference_argv(tmp_path: Path, monkeypatch):
    """Regression test (closes #390 follow-up): the actual CLI entry point
    (main(), not just write_outputs() called directly) must refuse a
    malicious --conference argv value before any output is written."""
    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    fake_result = _result("Paper One", "Accepted to CVPR 2026", "2604.00009")
    with patch.object(cc, "fetch_results", return_value=[fake_result]):
        with patch.object(
            sys,
            "argv",
            [
                "collect_conference.py",
                "--conference",
                "../../etc/passwd",
                "--venue",
                "CVPR",
                "--query",
                'co:"CVPR 2026"',
            ],
        ):
            with pytest.raises(ValueError):
                cc.main()
    assert not (tmp_path / "output").exists()


def test_main_writes_nothing_when_zero_papers_matched(tmp_path: Path, monkeypatch):
    """Regression test (closes #389): when 0 papers match, main() must NOT
    call write_outputs() at all — the old ordering wrote a header-only CSV
    for today's date first and checked `if not rows` after, silently
    overwriting/masking an existing good catalog file from an earlier run
    on the same day."""
    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    # A result whose comment doesn't match VenueSignal's acceptance pattern
    # for CVPR -> build_rows() filters it out -> rows == [].
    non_matching = _result("Irrelevant Paper", "Just a preprint, not accepted anywhere", "2604.00099")
    with patch.object(cc, "fetch_results", return_value=[non_matching]):
        with patch.object(
            sys,
            "argv",
            [
                "collect_conference.py",
                "--conference",
                "cvpr-2026",
                "--venue",
                "CVPR",
                "--query",
                'co:"CVPR 2026"',
            ],
        ):
            rc = cc.main()
    assert rc == 1
    # No output/ directory (and thus no papers_<date>.csv) must exist.
    assert not (tmp_path / "output").exists()


def test_main_does_not_overwrite_existing_same_day_csv_on_zero_matches(
    tmp_path: Path, monkeypatch
):
    """Regression test (closes #389): a same-day re-run that matches 0
    papers (e.g. a transient VenueSignal/query issue) must leave an
    existing good papers_<date>.csv from an earlier run untouched."""
    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    today = cc.datetime.now(cc.timezone.utc).strftime("%Y-%m-%d")
    existing_dir = tmp_path / "output" / "cvpr-2026"
    existing_dir.mkdir(parents=True)
    existing_csv = existing_dir / f"papers_{today}.csv"
    existing_csv.write_text("title,authors\nReal Paper,Alice\n", encoding="utf-8")

    non_matching = _result("Irrelevant Paper", "Just a preprint", "2604.00099")
    with patch.object(cc, "fetch_results", return_value=[non_matching]):
        with patch.object(
            sys,
            "argv",
            [
                "collect_conference.py",
                "--conference",
                "cvpr-2026",
                "--venue",
                "CVPR",
                "--query",
                'co:"CVPR 2026"',
            ],
        ):
            rc = cc.main()
    assert rc == 1
    assert existing_csv.read_text(encoding="utf-8") == "title,authors\nReal Paper,Alice\n"


def test_write_outputs_rejects_uppercase_or_space_conference_slug(tmp_path: Path):
    """A conference value that isn't already slug-shaped is rejected, not
    silently coerced (coercion would mask an operator typo)."""
    import pytest

    rows, orals = cc.build_rows(
        [_result("Paper One", "Accepted to CVPR 2026", "2604.00009")], "CVPR"
    )
    for bad in ("CVPR-2026", "cvpr 2026", "cvpr_2026", "-cvpr-2026", "cvpr-2026-"):
        with pytest.raises(ValueError):
            cc.write_outputs(bad, rows, orals, output_root=tmp_path, date="2026-06-28")

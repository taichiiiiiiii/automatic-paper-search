"""Tests for paperpilot/scripts/collect_conference.py.

Network (arXiv) is never hit — build_rows / write_outputs are pure given
duck-typed result objects, so we feed SimpleNamespace stand-ins for
arxiv.Result. The key invariant: the SAME VenueSignal acceptance semantics
the pipeline uses (keep "accepted to <venue>", drop workshop / bare-mention /
other-venue) carry through here.
"""

from __future__ import annotations

import csv as _csv
from pathlib import Path
from types import SimpleNamespace

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
        title="No id", summary="x", comment="Accepted to CVPR 2026",
        entry_id="not-a-real-url", pdf_url="", authors=[],
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

    oral_md = (tmp_path / "cvpr-2026" / "oral_summaries_ja.md").read_text(encoding="utf-8")
    assert "## 1. Paper One" in oral_md


def test_write_outputs_no_oral_md_when_empty(tmp_path: Path):
    rows, orals = cc.build_rows(
        [_result("Poster", "Accepted to CVPR 2026", "2604.00011")], "CVPR"
    )
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
        [{"title": "P", "authors": "", "venue": "CVPR", "venue_tier": 2,
          "citation_count": 0, "github_stars": 0, "arxiv_id": "", "abstract": "",
          "url": "", "pdf_url": "", "comment": ""}],
        [],  # no orals this run
        output_root=tmp_path,
        date="2026-06-28",
    )
    assert not stale.exists()

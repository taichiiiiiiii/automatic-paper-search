"""Tests for paperpilot/scripts/build_pages.py.

The script converts summary.csv -> docs/<conference>/papers.json, which
the static viewer consumes. These tests cover:
    - tag column splits on whitespace
    - authors column splits on ';' or ','
    - conferences.json index is written with aggregated stats
    - missing summary.csv is a no-op (skip) rather than a crash
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from paperpilot.scripts import build_pages


def _write_summary(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "title",
        "type",
        "tags",
        "venue",
        "authors",
        "arxiv_url",
        "pdf_url",
        "abstract",
        "arxiv_id",
        "citation_count",
        "venue_tier",
        "github_stars",
    ]
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for r in rows:
            writer.writerow({k: r.get(k, "") for k in fields})


# ---- abstract preview ----


def test_abstract_preview_keeps_short_text_verbatim():
    assert build_pages._abstract_preview("a short abstract") == "a short abstract"
    assert build_pages._abstract_preview("") == ""
    assert build_pages._abstract_preview(None) == ""


def test_abstract_preview_trims_long_text_on_word_boundary():
    long = "word " * 200  # 1000 chars
    out = build_pages._abstract_preview(long)
    assert out.endswith("…")  # single codepoint U+2026
    assert len(out) <= build_pages._ABSTRACT_PREVIEW_CHARS + 1  # +1 for the ellipsis char
    assert "word word" in out  # whole words retained
    assert not out[:-1].endswith(" ")  # no trailing space before the ellipsis


def test_abstract_preview_hard_cuts_single_long_token():
    # No space to break on -> hard cut at the limit, then the ellipsis.
    out = build_pages._abstract_preview("a" * 500)
    assert out.endswith("…")
    assert len(out) == build_pages._ABSTRACT_PREVIEW_CHARS + 1


def test_abstract_preview_in_papers_json(tmp_path: Path, monkeypatch):
    project = tmp_path / "paperpilot"
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", tmp_path / "docs")
    long_abstract = "lorem ipsum " * 60  # ~720 chars
    _write_summary(
        project / "output" / "iclr-2026" / "summary.csv",
        [{"title": "T", "type": "Poster", "tags": "", "authors": "", "abstract": long_abstract}],
    )
    build_pages.build_conference("iclr-2026")
    data = json.loads((tmp_path / "docs" / "iclr-2026" / "papers.json").read_text(encoding="utf-8"))
    assert data[0]["abstract"].endswith("…")
    assert len(data[0]["abstract"]) <= build_pages._ABSTRACT_PREVIEW_CHARS + 1


# ---- load_summary ----


def test_load_summary_splits_tags_and_authors(tmp_path: Path):
    summary = tmp_path / "summary.csv"
    _write_summary(
        summary,
        [
            {
                "title": "Paper One",
                "type": "Oral",
                "tags": "LLM Transformer",
                "venue": "ICLR",
                "authors": "Alice; Bob, Carol",  # mixed separators
                "arxiv_url": "http://arxiv.org/abs/1",
                "pdf_url": "http://arxiv.org/pdf/1",
                "abstract": "abstract one",
            }
        ],
    )

    rows = build_pages.load_summary(summary)
    assert len(rows) == 1
    assert rows[0]["tags"] == ["LLM", "Transformer"]
    assert rows[0]["authors"] == ["Alice", "Bob", "Carol"]


def test_load_summary_empty_tags_becomes_empty_list(tmp_path: Path):
    summary = tmp_path / "summary.csv"
    _write_summary(
        summary,
        [{"title": "T", "type": "Poster", "tags": "", "authors": ""}],
    )
    rows = build_pages.load_summary(summary)
    assert rows[0]["tags"] == []
    assert rows[0]["authors"] == []


# ---- build_conference ----


def test_build_conference_writes_papers_json(tmp_path: Path, monkeypatch):
    # Redirect PROJECT and DOCS_ROOT so the test writes into tmp_path
    project = tmp_path / "paperpilot"
    docs_root = tmp_path / "docs"
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", docs_root)

    _write_summary(
        project / "output" / "iclr-2026" / "summary.csv",
        [
            {
                "title": "A",
                "type": "Oral",
                "tags": "LLM Theory",
                "venue": "ICLR",
                "authors": "X",
                "arxiv_url": "u",
                "pdf_url": "p",
                "abstract": "a",
            },
            {
                "title": "B",
                "type": "Poster",
                "tags": "LLM",
                "venue": "ICLR",
                "authors": "Y",
                "arxiv_url": "u",
                "pdf_url": "p",
                "abstract": "b",
            },
        ],
    )

    result = build_pages.build_conference("iclr-2026")
    assert result is not None
    assert result["papers"] == 2
    assert result["types"] == {"Oral": 1, "Poster": 1}
    # LLM hits twice, Theory once — top_tags is sorted by count descending
    top_tags = dict(result["top_tags"])
    assert top_tags["LLM"] == 2
    assert top_tags["Theory"] == 1

    # papers.json is written next to the viewer's HTML
    papers_json = docs_root / "iclr-2026" / "papers.json"
    assert papers_json.exists()
    data = json.loads(papers_json.read_text(encoding="utf-8"))
    assert {p["title"] for p in data} == {"A", "B"}
    # tags column must round-trip as a list
    assert all(isinstance(p["tags"], list) for p in data)


def test_load_summary_carries_structured_ids(tmp_path: Path):
    """papers.json must keep arxiv_id / citation_count / venue_tier / github_stars

    so the lineage builder can skip the S2 re-lookup (rule §12) and the
    viewer can size nodes by citation count without another API call.
    """
    summary = tmp_path / "summary.csv"
    _write_summary(
        summary,
        [
            {
                "title": "P",
                "type": "Oral",
                "tags": "LLM",
                "authors": "X",
                "arxiv_url": "http://arxiv.org/abs/2404.00001",
                "pdf_url": "p",
                "abstract": "a",
                "arxiv_id": "2404.00001",
                "citation_count": "17",
                "venue_tier": "3",
                "github_stars": "250",
            }
        ],
    )

    rows = build_pages.load_summary(summary)
    assert rows[0]["arxiv_id"] == "2404.00001"
    # Numeric fields are parsed as ints so the viewer can skip type coercion
    assert rows[0]["citation_count"] == 17
    assert rows[0]["venue_tier"] == 3
    assert rows[0]["github_stars"] == 250


def test_load_summary_numeric_fields_missing_become_none(tmp_path: Path):
    summary = tmp_path / "summary.csv"
    _write_summary(
        summary,
        [
            {
                "title": "Legacy",
                "type": "Poster",
                "tags": "",
                "authors": "",
                "arxiv_id": "",
                "citation_count": "",
                "venue_tier": "",
                "github_stars": "",
            }
        ],
    )
    rows = build_pages.load_summary(summary)
    assert rows[0]["arxiv_id"] == ""
    assert rows[0]["citation_count"] is None
    assert rows[0]["venue_tier"] is None
    assert rows[0]["github_stars"] is None


def test_build_conference_returns_none_when_summary_missing(tmp_path: Path, monkeypatch):
    project = tmp_path / "paperpilot"
    (project / "output" / "empty-conf").mkdir(parents=True)  # no summary.csv
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", tmp_path / "docs")

    assert build_pages.build_conference("empty-conf") is None


# ---- write_index ----


def test_write_index_aggregates_stats(tmp_path: Path, monkeypatch):
    docs_root = tmp_path / "docs"
    docs_root.mkdir()
    monkeypatch.setattr(build_pages, "DOCS_ROOT", docs_root)

    build_pages.write_index(
        [
            {"name": "iclr-2026", "papers": 218, "types": {"Oral": 13}, "top_tags": [("LLM", 90)]},
            {"name": "neurips-2025", "papers": 100, "types": {"Oral": 5}, "top_tags": [("Vision", 40)]},
        ]
    )

    index = json.loads((docs_root / "conferences.json").read_text(encoding="utf-8"))
    assert [c["name"] for c in index] == ["iclr-2026", "neurips-2025"]
    assert index[0]["papers"] == 218


# ---- main() discovery ----


def test_main_skips_daily_pseudo_conference(tmp_path: Path, monkeypatch):
    """`daily` carries a summary.csv but is the daily-watch output, not a
    conference. Auto-discovery (no --conference) must exclude it so it never
    lands in conferences.json (which would render a broken catalog card)."""
    import sys

    project = tmp_path / "paperpilot"
    docs_root = tmp_path / "docs"
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", docs_root)

    row = {
        "title": "A", "type": "Poster", "tags": "Vision", "venue": "CVPR",
        "authors": "X", "arxiv_url": "u", "pdf_url": "p", "abstract": "a",
    }
    _write_summary(project / "output" / "cvpr-2026" / "summary.csv", [row])
    _write_summary(project / "output" / "daily" / "summary.csv", [row])

    monkeypatch.setattr(sys, "argv", ["build_pages"])
    build_pages.main()

    index = json.loads((docs_root / "conferences.json").read_text(encoding="utf-8"))
    names = {c["name"] for c in index}
    assert "cvpr-2026" in names
    assert "daily" not in names
    # ...and no docs/daily/ catalog page is generated.
    assert not (docs_root / "daily" / "papers.json").exists()


# ---- data date stamping ----


def _row() -> dict[str, str]:
    return {
        "title": "A", "type": "Poster", "tags": "Vision", "venue": "CVPR",
        "authors": "X", "arxiv_url": "u", "pdf_url": "p", "abstract": "a",
    }


def test_build_conference_stamps_latest_data_date(tmp_path: Path, monkeypatch):
    """`generated` = the newest papers_YYYY-MM-DD.csv date (the real data
    date), so the viewer's 'last updated' reflects the data, not page load."""
    project = tmp_path / "paperpilot"
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", tmp_path / "docs")

    conf_dir = project / "output" / "cvpr-2026"
    _write_summary(conf_dir / "summary.csv", [_row()])
    (conf_dir / "papers_2026-05-01.csv").write_text("title\nA\n", encoding="utf-8")
    (conf_dir / "papers_2026-06-27.csv").write_text("title\nA\n", encoding="utf-8")

    res = build_pages.build_conference("cvpr-2026")
    assert res is not None
    assert res["generated"] == "2026-06-27"  # newest wins


def test_build_conference_generated_none_without_dated_csv(tmp_path: Path, monkeypatch):
    project = tmp_path / "paperpilot"
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", tmp_path / "docs")

    conf_dir = project / "output" / "legacy-conf"
    _write_summary(conf_dir / "summary.csv", [_row()])  # no papers_*.csv

    res = build_pages.build_conference("legacy-conf")
    assert res is not None
    assert res["generated"] is None

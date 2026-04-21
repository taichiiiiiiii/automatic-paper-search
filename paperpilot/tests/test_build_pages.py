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

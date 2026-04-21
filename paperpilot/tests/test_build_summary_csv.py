"""Tests for paperpilot/scripts/build_summary_csv.py.

The old version hardcoded SRC_CSV = "papers_2026-04-18.csv"; the tests
here enforce that the script now (1) auto-discovers the latest
`papers_YYYY-MM-DD.csv` under a conference directory and (2) accepts
--conference / --input CLI flags so it can be reused beyond ICLR 2026.
"""

from __future__ import annotations

import csv
from pathlib import Path

import pytest

from paperpilot.scripts import build_summary_csv as bsc


def _write_papers_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "title",
        "authors",
        "abstract",
        "url",
        "pdf_url",
        "venue",
        "arxiv_id",
        "citation_count",
        "venue_tier",
        "github_stars",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def _write_oral_md(path: Path, titles: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"## {i}. {t}" for i, t in enumerate(titles, start=1)]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---- find_latest_csv ----


def test_find_latest_csv_picks_newest_date(tmp_path: Path):
    conf = tmp_path / "iclr-2026"
    conf.mkdir()
    (conf / "papers_2026-04-01.csv").write_text("")
    (conf / "papers_2026-04-18.csv").write_text("")
    (conf / "papers_2026-03-10.csv").write_text("")

    latest = bsc.find_latest_csv(conf)
    assert latest.name == "papers_2026-04-18.csv"


def test_find_latest_csv_ignores_other_files(tmp_path: Path):
    conf = tmp_path / "iclr-2026"
    conf.mkdir()
    (conf / "summary.csv").write_text("")
    (conf / "papers_2026-04-01.csv").write_text("")
    (conf / "oral_summaries_ja.md").write_text("")
    (conf / "run_history.jsonl").write_text("")

    latest = bsc.find_latest_csv(conf)
    assert latest.name == "papers_2026-04-01.csv"


def test_find_latest_csv_errors_when_missing(tmp_path: Path):
    conf = tmp_path / "empty"
    conf.mkdir()
    with pytest.raises(FileNotFoundError):
        bsc.find_latest_csv(conf)


# ---- build() end-to-end ----


def test_build_generates_summary_with_auto_discovery(tmp_path: Path):
    conf = tmp_path / "iclr-2026"
    _write_papers_csv(
        conf / "papers_2026-04-18.csv",
        [
            {
                "title": "Scaling Language Models",
                "authors": "Alice; Bob",
                "abstract": "We train a large language model.",
                "url": "http://arxiv.org/abs/2404.00001",
                "pdf_url": "http://arxiv.org/pdf/2404.00001",
                "venue": "ICLR 2026 Oral",
            },
            {
                "title": "Diffusion Baseline",
                "authors": "Carol",
                "abstract": "A diffusion-based image generator.",
                "url": "http://arxiv.org/abs/2404.00002",
                "pdf_url": "http://arxiv.org/pdf/2404.00002",
                "venue": "ICLR 2026",
            },
            {
                "title": "",  # must be dropped
                "authors": "",
                "abstract": "",
                "url": "",
                "pdf_url": "",
                "venue": "",
            },
        ],
    )
    _write_oral_md(
        conf / "oral_summaries_ja.md", ["Scaling Language Models"]
    )

    result = bsc.build(conference_dir=conf)
    assert result.rows_written == 2
    assert result.oral_count == 1

    summary = conf / "summary.csv"
    assert summary.exists()
    with summary.open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    # Sorted: Oral first, then alphabetical
    assert rows[0]["title"] == "Scaling Language Models"
    assert rows[0]["type"] == "Oral"
    assert "LLM" in rows[0]["tags"]
    assert rows[1]["title"] == "Diffusion Baseline"
    assert rows[1]["type"] == "Poster"
    assert "Diffusion" in rows[1]["tags"]


def test_build_with_explicit_input_csv(tmp_path: Path):
    conf = tmp_path / "neurips-2025"
    _write_papers_csv(
        conf / "papers_2025-12-01.csv",
        [
            {
                "title": "Explicit Input Paper",
                "authors": "A",
                "abstract": "x",
                "url": "u",
                "pdf_url": "p",
                "venue": "",
            }
        ],
    )
    _write_oral_md(conf / "oral_summaries_ja.md", [])

    # Caller can point at any CSV path, bypassing auto-discovery
    result = bsc.build(
        conference_dir=conf, input_csv=conf / "papers_2025-12-01.csv"
    )
    assert result.rows_written == 1
    assert result.oral_count == 0


def test_build_preserves_structured_ids_from_pipeline_csv(tmp_path: Path):
    """arxiv_id / citation_count / venue_tier / github_stars round-trip to summary.csv.

    build_lineage.py relies on arxiv_id being present directly rather than
    re-parsing it out of the URL, and the viewer uses citation_count / stars
    for sizing node bubbles.
    """
    conf = tmp_path / "iclr-2026"
    _write_papers_csv(
        conf / "papers_2026-04-18.csv",
        [
            {
                "title": "Paper With IDs",
                "authors": "A",
                "abstract": "x",
                "url": "http://arxiv.org/abs/2404.00001",
                "pdf_url": "p",
                "venue": "ICLR",
                "arxiv_id": "2404.00001",
                "citation_count": "42",
                "venue_tier": "3",
                "github_stars": "120",
            }
        ],
    )

    bsc.build(conference_dir=conf)
    with (conf / "summary.csv").open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    assert rows[0]["arxiv_id"] == "2404.00001"
    assert rows[0]["citation_count"] == "42"
    assert rows[0]["venue_tier"] == "3"
    assert rows[0]["github_stars"] == "120"


def test_build_handles_pipeline_csv_without_ids(tmp_path: Path):
    """Old pipeline output without arxiv_id etc. still works — fields are empty."""
    conf = tmp_path / "legacy"
    # Write a CSV that only has the original columns, no arxiv_id.
    conf.mkdir()
    csv_path = conf / "papers_2024-01-01.csv"
    with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=["title", "authors", "abstract", "url", "pdf_url", "venue"]
        )
        writer.writeheader()
        writer.writerow(
            {
                "title": "Legacy Paper",
                "authors": "Z",
                "abstract": "abs",
                "url": "u",
                "pdf_url": "p",
                "venue": "",
            }
        )

    bsc.build(conference_dir=conf)
    with (conf / "summary.csv").open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    assert rows[0]["title"] == "Legacy Paper"
    assert rows[0]["arxiv_id"] == ""
    assert rows[0]["citation_count"] == ""


def test_build_tolerates_missing_oral_md(tmp_path: Path):
    # When oral_summaries_ja.md is missing, every paper should be "Poster"
    # rather than crashing — the pipeline-layer CSV is the source of truth.
    conf = tmp_path / "iclr-2027"
    _write_papers_csv(
        conf / "papers_2027-01-01.csv",
        [
            {
                "title": "Solo Paper",
                "authors": "X",
                "abstract": "graph neural network",
                "url": "u",
                "pdf_url": "p",
                "venue": "",
            }
        ],
    )

    result = bsc.build(conference_dir=conf)
    assert result.rows_written == 1
    assert result.oral_count == 0

    with (conf / "summary.csv").open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    assert rows[0]["type"] == "Poster"
    assert "Graph" in rows[0]["tags"]

"""Tests for paperpilot/scripts/build_search_index.py.

The script folds every docs/<conference>/papers.json into a single
docs/search-index.json so the landing page can search all conferences at
once. papers.json carries no usable per-paper key -- 95.5% of rows have an
empty arxiv_id -- so the paper id is derived from arxiv_url instead. These
tests cover:
    - id extraction for each of the four venue URL families
    - arXiv version suffixes are stripped so ids are stable across revisions
    - unknown / empty URLs yield None rather than a bogus id
    - the "daily" output dir is excluded (it is not a conference)
    - rows without an extractable id are skipped and reported, not fatal
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from paperpilot.scripts import build_search_index as bsi

# ---- paper_id: the four venue families ----


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        # OpenReview (iclr-2026, icml-2025, neurips-2025 -- 13,894 papers)
        ("https://openreview.net/forum?id=rlZeILv3fm", "rlZeILv3fm"),
        ("https://openreview.net/forum?id=71Mm8GDGYd", "71Mm8GDGYd"),
        # arXiv (aaai-2026, eccv-2024 -- 1,258 papers)
        ("http://arxiv.org/abs/2601.02771v1", "2601.02771"),
        ("http://arxiv.org/abs/2403.06764v3", "2403.06764"),
        ("https://arxiv.org/abs/2403.06764", "2403.06764"),
        # ACL Anthology (acl-2025, emnlp-2025 -- 3,508 papers)
        ("https://aclanthology.org/2025.acl-long.153/", "2025.acl-long.153"),
        ("https://aclanthology.org/2025.emnlp-main.15/", "2025.emnlp-main.15"),
        # CVF open access (cvpr-2025, cvpr-2026, iccv-2025 -- 9,640 papers)
        (
            "https://openaccess.thecvf.com/content/CVPR2025/html/Held_3D_Convex_Splatting_CVPR_2025_paper.html",
            "Held_3D_Convex_Splatting_CVPR_2025_paper",
        ),
    ],
)
def test_paper_id_extracts_stable_id_per_venue_family(url: str, expected: str) -> None:
    assert bsi.paper_id(url) == expected


def test_paper_id_strips_arxiv_version_so_revisions_share_one_id() -> None:
    # v1 and v3 of the same preprint must collapse to the same permalink.
    assert bsi.paper_id("http://arxiv.org/abs/2403.06764v1") == bsi.paper_id(
        "http://arxiv.org/abs/2403.06764v3"
    )


@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        "https://example.com/some/paper",
        "https://openreview.net/forum",  # no id query param
        "https://arxiv.org/",  # no /abs/ segment
        "https://openaccess.thecvf.com/content/CVPR2025/",  # not an /html/*.html path
    ],
)
def test_paper_id_returns_none_for_unusable_urls(url: str) -> None:
    assert bsi.paper_id(url) is None


def test_paper_id_tolerates_none() -> None:
    assert bsi.paper_id(None) is None


# ---- index building ----


def _write_papers(docs: Path, conf: str, rows: list[dict]) -> None:
    d = docs / conf
    d.mkdir(parents=True, exist_ok=True)
    (d / "papers.json").write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")


def test_build_index_emits_title_conference_and_id(tmp_path: Path) -> None:
    _write_papers(
        tmp_path,
        "iclr-2026",
        [
            {
                "title": "Attention Is All You Need",
                "arxiv_url": "https://openreview.net/forum?id=abc123XYZ",
            }
        ],
    )
    entries, skipped = bsi.build_index(tmp_path)
    assert skipped == 0
    assert entries == [["Attention Is All You Need", "iclr-2026", "abc123XYZ"]]


def test_build_index_excludes_non_conference_dirs(tmp_path: Path) -> None:
    # docs/daily/papers.json is the daily-watch byproduct, not a conference,
    # and has no catalog page to link to.
    _write_papers(
        tmp_path, "daily", [{"title": "Daily", "arxiv_url": "http://arxiv.org/abs/2605.28056v1"}]
    )
    _write_papers(
        tmp_path, "aaai-2026", [{"title": "Real", "arxiv_url": "http://arxiv.org/abs/2601.02771v1"}]
    )
    entries, _ = bsi.build_index(tmp_path)
    assert [e[1] for e in entries] == ["aaai-2026"]


def test_build_index_skips_rows_without_extractable_id(tmp_path: Path) -> None:
    _write_papers(
        tmp_path,
        "iclr-2026",
        [
            {"title": "Keeps", "arxiv_url": "https://openreview.net/forum?id=keepme"},
            {"title": "Drops", "arxiv_url": "https://unknown.example/paper/1"},
        ],
    )
    entries, skipped = bsi.build_index(tmp_path)
    assert [e[0] for e in entries] == ["Keeps"]
    assert skipped == 1


def test_build_index_sorts_conferences_for_reproducible_output(tmp_path: Path) -> None:
    # A byte-stable index keeps the ?v= asset hash from churning on rebuild.
    _write_papers(
        tmp_path,
        "neurips-2025",
        [{"title": "N", "arxiv_url": "https://openreview.net/forum?id=nnn"}],
    )
    _write_papers(
        tmp_path,
        "acl-2025",
        [{"title": "A", "arxiv_url": "https://aclanthology.org/2025.acl-long.1/"}],
    )
    entries, _ = bsi.build_index(tmp_path)
    assert [e[1] for e in entries] == ["acl-2025", "neurips-2025"]


def test_build_index_ignores_dirs_without_papers_json(tmp_path: Path) -> None:
    (tmp_path / "assets").mkdir(parents=True)
    (tmp_path / "assets" / "style.css").write_text("body{}", encoding="utf-8")
    _write_papers(
        tmp_path, "aaai-2026", [{"title": "Real", "arxiv_url": "http://arxiv.org/abs/2601.02771v1"}]
    )
    entries, _ = bsi.build_index(tmp_path)
    assert len(entries) == 1


def test_write_index_emits_compact_json(tmp_path: Path) -> None:
    out = bsi.write_index(tmp_path, [["T", "iclr-2026", "abc"]])
    assert out == tmp_path / "search-index.json"
    text = out.read_text(encoding="utf-8")
    # Compact separators: this file is shipped to every searcher, so no
    # gratuitous whitespace.
    assert ", " not in text
    assert json.loads(text) == [["T", "iclr-2026", "abc"]]


def test_write_index_preserves_non_ascii_titles(tmp_path: Path) -> None:
    out = bsi.write_index(tmp_path, [["日本語タイトル", "iclr-2026", "abc"]])
    assert json.loads(out.read_text(encoding="utf-8"))[0][0] == "日本語タイトル"

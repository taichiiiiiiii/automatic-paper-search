"""Tests for paperpilot/scripts/build_search_index.py.

The script folds every docs/<conference>/papers.json into a single
docs/search-index.json so the landing page can search all conferences at
once. An entry is [title, conference]: the catalog pages already read `?q=`
from the URL and filter on title+authors+abstract, so a hit links to
`<conference>/?q=<title>` and needs no per-paper id. These tests cover:
    - entry shape and conference attribution
    - the "daily" output dir is excluded (it is not a conference)
    - rows with no title are skipped and reported, not fatal
    - output ordering is deterministic so rebuilds are byte-identical
"""

from __future__ import annotations

import json
from pathlib import Path

from paperpilot.scripts import build_search_index as bsi


def _write_papers(docs: Path, conf: str, rows: list[dict]) -> None:
    d = docs / conf
    d.mkdir(parents=True, exist_ok=True)
    (d / "papers.json").write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")


def test_build_index_emits_title_and_conference(tmp_path: Path) -> None:
    _write_papers(tmp_path, "iclr-2026", [{"title": "Attention Is All You Need"}])
    entries, skipped = bsi.build_index(tmp_path)
    assert skipped == 0
    assert entries == [["Attention Is All You Need", "iclr-2026"]]


def test_build_index_excludes_non_conference_dirs(tmp_path: Path) -> None:
    # docs/daily/papers.json is the daily-watch byproduct, not a conference,
    # and has no catalog page for a hit to land on.
    _write_papers(tmp_path, "daily", [{"title": "Daily"}])
    _write_papers(tmp_path, "aaai-2026", [{"title": "Real"}])
    entries, _ = bsi.build_index(tmp_path)
    assert [e[bsi.CONFERENCE] for e in entries] == ["aaai-2026"]


def test_build_index_skips_untitled_rows(tmp_path: Path) -> None:
    # A row with no title cannot be searched for or linked to.
    _write_papers(tmp_path, "iclr-2026", [{"title": "Keeps"}, {"title": "   "}, {}])
    entries, skipped = bsi.build_index(tmp_path)
    assert [e[bsi.TITLE] for e in entries] == ["Keeps"]
    assert skipped == 2


def test_build_index_trims_surrounding_whitespace(tmp_path: Path) -> None:
    # A stray newline would break the ?q= exact-title link.
    _write_papers(tmp_path, "iclr-2026", [{"title": "  Padded Title\n"}])
    entries, _ = bsi.build_index(tmp_path)
    assert entries[0][bsi.TITLE] == "Padded Title"


def test_build_index_sorts_conferences_for_reproducible_output(tmp_path: Path) -> None:
    # A byte-stable index keeps the ?v= asset hash from churning on rebuild.
    _write_papers(tmp_path, "neurips-2025", [{"title": "N"}])
    _write_papers(tmp_path, "acl-2025", [{"title": "A"}])
    entries, _ = bsi.build_index(tmp_path)
    assert [e[bsi.CONFERENCE] for e in entries] == ["acl-2025", "neurips-2025"]


def test_build_index_preserves_within_conference_order(tmp_path: Path) -> None:
    # papers.json order is the collection order; the catalog relies on it.
    _write_papers(tmp_path, "iclr-2026", [{"title": "first"}, {"title": "second"}])
    entries, _ = bsi.build_index(tmp_path)
    assert [e[bsi.TITLE] for e in entries] == ["first", "second"]


def test_build_index_ignores_dirs_without_papers_json(tmp_path: Path) -> None:
    (tmp_path / "assets").mkdir(parents=True)
    (tmp_path / "assets" / "style.css").write_text("body{}", encoding="utf-8")
    _write_papers(tmp_path, "aaai-2026", [{"title": "Real"}])
    entries, _ = bsi.build_index(tmp_path)
    assert len(entries) == 1


def test_write_index_emits_compact_json(tmp_path: Path) -> None:
    out = bsi.write_index(tmp_path, [["T", "iclr-2026"]])
    assert out == tmp_path / bsi.INDEX_FILENAME
    text = out.read_text(encoding="utf-8")
    # Compact separators: this file ships to every searcher, so no
    # gratuitous whitespace.
    assert ", " not in text
    assert json.loads(text) == [["T", "iclr-2026"]]


def test_write_index_preserves_non_ascii_titles(tmp_path: Path) -> None:
    out = bsi.write_index(tmp_path, [["日本語タイトル", "iclr-2026"]])
    assert json.loads(out.read_text(encoding="utf-8"))[0][0] == "日本語タイトル"


# ---- guard: the landing page states a paper count in prose ----


def test_landing_search_label_matches_real_index_size() -> None:
    """docs/index.html hardcodes "N 学会 M 本" next to the search box.

    Prose that states a number drifts silently as the catalog grows. This
    pins it to what build_index actually produces, so a stale claim fails
    here instead of misleading a visitor.
    """
    import re

    repo_docs = Path(__file__).resolve().parents[2] / "docs"
    entries, _ = bsi.build_index(repo_docs)
    conferences = {e[bsi.CONFERENCE] for e in entries}

    html = (repo_docs / "index.html").read_text(encoding="utf-8")
    m = re.search(r"(\d+)\s*学会\s*([\d,]+)\s*本", html)
    assert m, "landing page no longer states a '<N> 学会 <M> 本' count"

    stated_conferences = int(m.group(1))
    stated_papers = int(m.group(2).replace(",", ""))
    assert stated_conferences == len(conferences), (
        f"landing says {stated_conferences} conferences, index has {len(conferences)}"
    )
    assert stated_papers == len(entries), (
        f"landing says {stated_papers:,} papers, index has {len(entries):,}"
    )

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

import gzip
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


# ---- v2 identity-rich index ----


def test_build_index_v2_emits_fixed_typed_row(tmp_path: Path) -> None:
    _write_papers(
        tmp_path,
        "iclr-2026",
        [
            {
                "title": "Attention",
                "authors": ["Alice", "Bob"],
                "tags": ["LLM"],
                "type": "Oral",
                "arxiv_url": "https://openreview.net/forum?id=AbC_123",
            }
        ],
    )
    entries, paper_ids = bsi.build_index_v2(tmp_path)
    assert entries == [
        [
            "Attention",
            "iclr-2026",
            0,
            ["Alice", "Bob"],
            ["LLM"],
            2026,
            "Oral",
        ]
    ]
    assert paper_ids == ["b871855522b0b31384df3e40fca6800540085f1f"]


def test_build_index_v2_rejects_mismatched_embedded_identity(tmp_path: Path) -> None:
    _write_papers(
        tmp_path,
        "acl-2025",
        [
            {
                "title": "Mismatch",
                "authors": [],
                "tags": [],
                "type": "Poster",
                "arxiv_url": "https://aclanthology.org/2025.acl-long.153/",
                "paper_id": "0" * 40,
            }
        ],
    )
    import pytest

    with pytest.raises(ValueError, match="paper_id"):
        bsi.build_index_v2(tmp_path)


def test_write_index_v2_is_compact_and_deterministic(tmp_path: Path) -> None:
    entries = [["T", "c-2025", 0, [], [], 2025, "Poster"]]
    first = bsi.write_index_v2(tmp_path, entries).read_bytes()
    second = bsi.write_index_v2(tmp_path, entries).read_bytes()
    assert first == second
    assert b", " not in first
    assert json.loads(first) == entries


def test_write_paper_id_blocks_uses_global_ordinal(tmp_path: Path) -> None:
    paper_ids = [f"{value:040x}" for value in range(300)]
    outputs = bsi.write_paper_id_blocks(tmp_path, paper_ids)
    assert len(outputs) == 2
    first = json.loads(outputs[0].read_text())
    second = json.loads(outputs[1].read_text())
    assert first["start"] == 0
    assert len(first["paper_ids"]) == 256
    assert second["start"] == 256
    assert second["paper_ids"][0] == paper_ids[256]


def test_real_v2_projection_meets_budget_and_resolves_every_ref() -> None:
    repo_docs = Path(__file__).resolve().parents[2] / "docs"
    payload = (repo_docs / bsi.INDEX_V2_FILENAME).read_bytes()
    assert len(payload) <= int(8.5 * 1024 * 1024)
    assert len(gzip.compress(payload, mtime=0)) <= int(2.5 * 1024 * 1024)

    entries = json.loads(payload)
    resolved: list[str] = []
    for path in sorted((repo_docs / "search-paper-ids-v1").glob("*.json")):
        resolved.extend(json.loads(path.read_text(encoding="utf-8"))["paper_ids"])
    assert len(entries) == len(resolved) == 28_300
    assert all(row[bsi.PAPER_REF] == ordinal for ordinal, row in enumerate(entries))
    assert all(len(paper_id) == 40 for paper_id in resolved)


# ---- guard: the landing page states a paper count in prose ----


def test_landing_search_label_matches_real_index_size() -> None:
    """docs/index.html shows N 学会 / M 本 via dynamic injection.

    The S0 landing (#372 P1) no longer hardcodes the count in prose —
    the inline <script> fetches ``conferences.json`` at load and fills
    ``#s0-n`` (conference count) and ``#s0-m`` (paper count) from the
    live data, so the page can never silently lie about its own scale.
    The HTML still ships a numeric fallback for no-JS visitors. This
    test pins:
      - the dynamic injection mechanism is wired (target elements exist
        and the inline script fetches ``conferences.json``)
      - the fallback numerals are numeric and sane
      - ``conferences.json``'s aggregate still matches the search index
        (so the JS fills the same value this test can verify offline).
    """
    import json
    import re

    repo_docs = Path(__file__).resolve().parents[2] / "docs"
    entries, _ = bsi.build_index(repo_docs)
    conferences = {e[bsi.CONFERENCE] for e in entries}

    html = (repo_docs / "index.html").read_text(encoding="utf-8")

    # 1) Dynamic injection: the two target elements must exist.
    assert re.search(r'id="s0-n"', html), "landing is missing #s0-n for conf count"
    assert re.search(r'id="s0-m"', html), "landing is missing #s0-m for paper count"
    # And the inline script must fetch conferences.json (the single source
    # of truth for the landing numerals; papers.json per conference is not
    # what the landing shows).
    assert "conferences.json" in html, (
        "landing no longer fetches conferences.json for the dynamic N/M"
    )

    # 2) Fallback numerals — extract the text inside each target element.
    m_n = re.search(r'<span[^>]*id="s0-n"[^>]*>(\d[\d,]*)</span>', html)
    m_m = re.search(r'<span[^>]*id="s0-m"[^>]*>(\d[\d,]*)</span>', html)
    assert m_n and m_m, "landing #s0-n / #s0-m should ship a numeric fallback"
    fallback_n = int(m_n.group(1).replace(",", ""))
    fallback_m = int(m_m.group(1).replace(",", ""))
    assert fallback_n > 0 and fallback_m > 0

    # 3) conferences.json aggregate must match the search-index entries.
    #    The inline script reads conferences.json; if its total diverged
    #    from the search index, the landing would show a different number
    #    than the actual searchable corpus — which is exactly the kind
    #    of drift this test was originally catching.
    confs_path = repo_docs / "conferences.json"
    confs = json.loads(confs_path.read_text(encoding="utf-8"))
    assert len(confs) == len(conferences), (
        f"conferences.json has {len(confs)} entries, search-index has {len(conferences)}"
    )
    confs_total = sum(c.get("papers", 0) for c in confs)
    assert confs_total == len(entries), (
        f"conferences.json total papers {confs_total:,} != search-index {len(entries):,}"
    )

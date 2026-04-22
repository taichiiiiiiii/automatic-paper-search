"""Tests for paperpilot/scripts/generate_deep_manifest.py.

The manifest generator globs ``deep-<arxiv_id>.json`` files in a
conference directory and produces ``deep-manifest.json`` listing each
as ``{arxiv_id, title, filename}``. Keeping the manifest derived from
filesystem state (rather than written side-effect-style by
``build_deep_lineage.py``) avoids lost-update races when multiple
builds run in parallel.
"""

from __future__ import annotations

import json
from pathlib import Path

from paperpilot.scripts import generate_deep_manifest as gm

# --------------------- Fixtures ----------------------------------------


def _write_deep_json(
    dir_: Path, arxiv_id: str, title: str, *, root_id: str = "s2abc"
) -> Path:
    """Write a minimal but realistic deep-<arxiv_id>.json file."""
    payload = {
        "root": root_id,
        "nodes": [
            {
                "id": root_id,
                "title": title,
                "year": 2026,
                "venue": "ICLR 2026",
                "venue_tier": "A+",
                "authors": ["Author One"],
                "kinds": ["focus"],
                "citation_count": 0,
                "github_stars": 0,
                "tldr": "",
                "is_focus": True,
            }
        ],
        "edges": [],
        "meta": {
            "source": "build_deep_lineage.py",
            "arxiv_id": arxiv_id,
            "depth": 2,
            "generated_at": "2026-04-23T00:00:00Z",
        },
    }
    path = dir_ / f"deep-{arxiv_id}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False))
    return path


# --------------------- generate_manifest -------------------------------


def test_generate_manifest_empty_dir_returns_empty_list(tmp_path: Path) -> None:
    entries = gm.generate_manifest(tmp_path)
    assert entries == []


def test_generate_manifest_single_file(tmp_path: Path) -> None:
    _write_deep_json(tmp_path, "1706.03762", "Attention Is All You Need")
    entries = gm.generate_manifest(tmp_path)
    assert entries == [
        {
            "arxiv_id": "1706.03762",
            "title": "Attention Is All You Need",
            "filename": "deep-1706.03762.json",
        }
    ]


def test_generate_manifest_multiple_files_sorted_by_arxiv_id(tmp_path: Path) -> None:
    _write_deep_json(tmp_path, "2602.18473", "Paper B")
    _write_deep_json(tmp_path, "1706.03762", "Paper A")
    _write_deep_json(tmp_path, "2512.23447", "Paper C")
    entries = gm.generate_manifest(tmp_path)
    assert [e["arxiv_id"] for e in entries] == [
        "1706.03762",
        "2512.23447",
        "2602.18473",
    ]


def test_generate_manifest_ignores_unrelated_files(tmp_path: Path) -> None:
    _write_deep_json(tmp_path, "1706.03762", "Deep A")
    (tmp_path / "lineage.json").write_text("{}")
    (tmp_path / "papers.json").write_text("[]")
    (tmp_path / "deep-manifest.json").write_text("[]")
    entries = gm.generate_manifest(tmp_path)
    assert len(entries) == 1
    assert entries[0]["arxiv_id"] == "1706.03762"


def test_generate_manifest_skips_file_with_unparseable_name_and_no_meta(
    tmp_path: Path,
) -> None:
    """If the filename isn't a valid arxiv pattern and meta is missing,
    there's no way to recover the id — skip rather than emit a broken
    entry that the JS viewer can't fetch."""
    broken = tmp_path / "deep-broken.json"
    broken.write_text(json.dumps({"nodes": [], "edges": []}))  # no meta, bad name
    _write_deep_json(tmp_path, "1706.03762", "OK")
    entries = gm.generate_manifest(tmp_path)
    assert [e["arxiv_id"] for e in entries] == ["1706.03762"]


def test_generate_manifest_skips_file_with_non_arxiv_meta(tmp_path: Path) -> None:
    """meta.arxiv_id must match the arXiv id format to be usable as a URL
    parameter — otherwise the JS viewer can't construct a safe fetch URL."""
    path = tmp_path / "deep-1234.56789.json"
    path.write_text(
        json.dumps(
            {
                "root": "r",
                "nodes": [{"id": "r", "title": "x", "is_focus": True}],
                "edges": [],
                "meta": {"arxiv_id": "../../etc/passwd"},
            }
        )
    )
    _write_deep_json(tmp_path, "1706.03762", "OK")
    entries = gm.generate_manifest(tmp_path)
    # meta.arxiv_id is rejected, filename fallback gives "1234.56789" — valid.
    assert sorted(e["arxiv_id"] for e in entries) == ["1234.56789", "1706.03762"]


def test_generate_manifest_falls_back_to_filename_arxiv_id(tmp_path: Path) -> None:
    """If meta.arxiv_id is missing but filename is deep-<id>.json, we still
    recover the id from the filename — belt and braces."""
    path = tmp_path / "deep-2602.18473.json"
    path.write_text(
        json.dumps(
            {
                "root": "r1",
                "nodes": [
                    {
                        "id": "r1",
                        "title": "Filename Fallback",
                        "is_focus": True,
                    }
                ],
                "edges": [],
                "meta": {"source": "test"},  # no arxiv_id
            }
        )
    )
    entries = gm.generate_manifest(tmp_path)
    assert entries == [
        {
            "arxiv_id": "2602.18473",
            "title": "Filename Fallback",
            "filename": "deep-2602.18473.json",
        }
    ]


def test_generate_manifest_skips_file_with_unreadable_json(tmp_path: Path) -> None:
    (tmp_path / "deep-bad.json").write_text("not json at all")
    _write_deep_json(tmp_path, "1706.03762", "OK")
    entries = gm.generate_manifest(tmp_path)
    assert [e["arxiv_id"] for e in entries] == ["1706.03762"]


# --------------------- write_manifest ----------------------------------


def test_write_manifest_creates_file(tmp_path: Path) -> None:
    _write_deep_json(tmp_path, "1706.03762", "Attention")
    out = gm.write_manifest(tmp_path)
    assert out == tmp_path / "deep-manifest.json"
    data = json.loads(out.read_text())
    assert data == [
        {
            "arxiv_id": "1706.03762",
            "title": "Attention",
            "filename": "deep-1706.03762.json",
        }
    ]


def test_write_manifest_overwrites_existing(tmp_path: Path) -> None:
    (tmp_path / "deep-manifest.json").write_text('[{"stale": true}]')
    _write_deep_json(tmp_path, "1706.03762", "Attention")
    gm.write_manifest(tmp_path)
    data = json.loads((tmp_path / "deep-manifest.json").read_text())
    assert len(data) == 1
    assert data[0]["arxiv_id"] == "1706.03762"


def test_write_manifest_empty_produces_empty_array(tmp_path: Path) -> None:
    gm.write_manifest(tmp_path)
    data = json.loads((tmp_path / "deep-manifest.json").read_text())
    assert data == []


# --------------------- CLI entry point ---------------------------------


def test_main_accepts_docs_dir_argument(tmp_path: Path) -> None:
    _write_deep_json(tmp_path, "1706.03762", "Attention")
    rc = gm.main(["--docs-dir", str(tmp_path)])
    assert rc == 0
    assert (tmp_path / "deep-manifest.json").exists()


def test_main_returns_nonzero_when_dir_does_not_exist(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist"
    rc = gm.main(["--docs-dir", str(missing)])
    assert rc != 0

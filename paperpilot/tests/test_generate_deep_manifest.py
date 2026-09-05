"""Strict deep-manifest-v1 generation tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from paperpilot.scripts import generate_deep_manifest as gm

PAPER_ID_A = "1" * 40
PAPER_ID_B = "2" * 40


@pytest.fixture
def docs_dir(tmp_path: Path) -> Path:
    path = tmp_path / "iclr-2026"
    path.mkdir()
    return path


def _provenance() -> dict:
    return {
        "producer": {"name": "fixture", "version": "1"},
        "evidence": {"source": "fixture", "kind": "citation", "sha256": "a" * 64},
        "classification": {
            "method": "citation_heuristic",
            "provider": None,
            "model": None,
            "prompt_version": None,
            "schema_version": "fixture-v1",
        },
    }


def _add_catalog_paper(
    directory: Path,
    paper_id: str,
    arxiv_id: str | None = None,
) -> None:
    path = directory / "papers.json"
    rows = json.loads(path.read_text()) if path.exists() else []
    if paper_id not in {row["paper_id"] for row in rows}:
        row = {"paper_id": paper_id}
        if arxiv_id is not None:
            row.update({"source": "arxiv", "source_id": arxiv_id, "arxiv_id": arxiv_id})
        rows.append(row)
    path.write_text(json.dumps(rows))


def _write_deep_json(
    directory: Path,
    arxiv_id: str,
    title: str,
    *,
    paper_id: str = PAPER_ID_A,
    root_id: str = "S2-root",
) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    _add_catalog_paper(directory, paper_id, arxiv_id)
    aliases = [["arxiv", arxiv_id], ["semantic_scholar", root_id]]
    payload = {
        "schema_version": "lineage-artifact-v1",
        "root": root_id,
        "nodes": [
            {
                "id": root_id,
                "title": title,
                "is_focus": True,
                "seed_paper_id": paper_id,
                "aliases": aliases,
            }
        ],
        "edges": [],
        "clusters": [],
        "meta": {
            "kind": "deep",
            "generator": "fixture",
            "arxiv_id": arxiv_id,
            "seed_paper_id": paper_id,
            "aliases": aliases,
            "generated_at": "2026-08-30T00:00:00Z",
        },
    }
    path = directory / f"deep-{arxiv_id}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False))
    return path


def test_empty_dir_returns_wrapper_not_legacy_array(docs_dir: Path) -> None:
    manifest = gm.generate_manifest(docs_dir)
    assert manifest == {
        "schema_version": "deep-manifest-v1",
        "conference": "iclr-2026",
        "generated_at": "1970-01-01T00:00:00Z",
        "entries": [],
    }


def test_generate_manifest_emits_exact_identity_entry(docs_dir: Path) -> None:
    _write_deep_json(docs_dir, "1706.03762", "Attention Is All You Need")
    manifest = gm.generate_manifest(docs_dir)
    assert manifest["schema_version"] == "deep-manifest-v1"
    assert manifest["generated_at"] == "2026-08-30T00:00:00Z"
    assert manifest["entries"] == [
        {
            "paper_id": PAPER_ID_A,
            "aliases": [["arxiv", "1706.03762"], ["semantic_scholar", "S2-root"]],
            "arxiv_id": "1706.03762",
            "title": "Attention Is All You Need",
            "filename": "deep-1706.03762.json",
        }
    ]


def test_entries_sort_by_canonical_paper_id(docs_dir: Path) -> None:
    _write_deep_json(docs_dir, "2602.18473", "B", paper_id=PAPER_ID_B, root_id="S2-B")
    _write_deep_json(docs_dir, "1706.03762", "A", paper_id=PAPER_ID_A, root_id="S2-A")
    manifest = gm.generate_manifest(docs_dir)
    assert [entry["paper_id"] for entry in manifest["entries"]] == [
        PAPER_ID_A,
        PAPER_ID_B,
    ]


def test_legacy_artifact_is_skipped_without_filename_or_first_node_fallback(
    docs_dir: Path,
) -> None:
    _add_catalog_paper(docs_dir, PAPER_ID_A, "2602.18473")
    (docs_dir / "deep-2602.18473.json").write_text(
        json.dumps(
            {
                "root": "missing",
                "nodes": [{"id": "first", "title": "Legacy", "is_focus": True}],
                "edges": [],
                "meta": {},
            }
        )
    )
    assert gm.generate_manifest(docs_dir)["entries"] == []


def test_meta_filename_arxiv_mismatch_is_skipped(docs_dir: Path) -> None:
    path = _write_deep_json(docs_dir, "2602.18473", "Mismatch")
    payload = json.loads(path.read_text())
    payload["meta"]["arxiv_id"] = "1706.03762"
    path.write_text(json.dumps(payload))
    assert gm.generate_manifest(docs_dir)["entries"] == []


def test_catalog_paper_id_and_arxiv_must_come_from_the_same_row(docs_dir: Path) -> None:
    path = _write_deep_json(docs_dir, "2602.18473", "Wrong canonical join")
    catalog = json.loads((docs_dir / "papers.json").read_text())
    catalog[0]["source_id"] = "2401.00001"
    catalog[0]["arxiv_id"] = "2401.00001"
    (docs_dir / "papers.json").write_text(json.dumps(catalog))

    assert gm.generate_manifest(docs_dir)["entries"] == []
    assert path.exists()


def test_root_must_be_the_unique_focus(docs_dir: Path) -> None:
    path = _write_deep_json(docs_dir, "2602.18473", "No fallback")
    payload = json.loads(path.read_text())
    payload["root"] = "unknown"
    path.write_text(json.dumps(payload))
    assert gm.generate_manifest(docs_dir)["entries"] == []


def test_seed_and_aliases_must_match_root_and_meta(docs_dir: Path) -> None:
    path = _write_deep_json(docs_dir, "2602.18473", "Alias mismatch")
    payload = json.loads(path.read_text())
    payload["nodes"][0]["aliases"][1][1] = "different-root"
    path.write_text(json.dumps(payload))
    assert gm.generate_manifest(docs_dir)["entries"] == []


def test_duplicate_exact_alias_fails_entire_manifest(docs_dir: Path) -> None:
    _write_deep_json(docs_dir, "1706.03762", "A", paper_id=PAPER_ID_A, root_id="shared-root")
    _write_deep_json(docs_dir, "2602.18473", "B", paper_id=PAPER_ID_B, root_id="shared-root")
    with pytest.raises(ValueError, match="ambiguous"):
        gm.generate_manifest(docs_dir)


def test_write_manifest_is_wrapper_and_overwrites_existing(docs_dir: Path) -> None:
    (docs_dir / "deep-manifest.json").write_text("[]")
    _write_deep_json(docs_dir, "1706.03762", "Attention")
    out = gm.write_manifest(docs_dir)
    data = json.loads(out.read_text())
    assert data["schema_version"] == "deep-manifest-v1"
    assert len(data["entries"]) == 1


def test_main_returns_nonzero_when_dir_does_not_exist(tmp_path: Path) -> None:
    assert gm.main(["--docs-dir", str(tmp_path / "missing")]) != 0

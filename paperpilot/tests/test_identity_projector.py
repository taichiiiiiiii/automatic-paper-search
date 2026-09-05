"""Identity Lite catalog projection and conflict-gate tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from paperpilot.identity.projector import project_catalogs
from paperpilot.scripts import build_identity_lite


def _write_catalog(docs: Path, slug: str, rows: list[dict]) -> None:
    target = docs / slug
    target.mkdir(parents=True, exist_ok=True)
    (target / "papers.json").write_text(json.dumps(rows), encoding="utf-8")


def test_project_catalogs_enriches_without_changing_existing_fields(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    original = {
        "title": "A",
        "authors": ["Alice"],
        "tags": ["LLM"],
        "type": "Poster",
        "arxiv_url": "https://openreview.net/forum?id=AbC_123",
        "abstract": "preview",
        "arxiv_id": "2404.00001",
    }
    _write_catalog(docs, "iclr-2026", [original])

    result = project_catalogs(docs, ["iclr-2026"], as_of="2026-08-30T00:00:00Z")
    assert result.valid
    enriched = result.catalogs["iclr-2026"][0]
    assert {key: enriched[key] for key in original} == original
    assert enriched["source"] == "openreview"
    assert enriched["source_id"] == "AbC_123"
    assert len(enriched["paper_id"]) == 40
    assert ["arxiv", "2404.00001", enriched["paper_id"]] in result.aliases
    assert ["openreview", "AbC_123", enriched["paper_id"]] in result.aliases
    assert result.coverage["resolved_rows"] == 1


def test_project_catalogs_reports_alias_conflict(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _write_catalog(
        docs,
        "iclr-2026",
        [
            {
                "title": "A",
                "arxiv_url": "https://openreview.net/forum?id=one",
                "arxiv_id": "2404.00001",
            },
            {
                "title": "B",
                "arxiv_url": "https://openreview.net/forum?id=two",
                "arxiv_id": "2404.00001",
            },
        ],
    )
    result = project_catalogs(docs, ["iclr-2026"], as_of="2026-08-30T00:00:00Z")
    assert not result.valid
    assert result.coverage["alias_conflicts"] == 1


def test_project_catalogs_records_parse_failure_without_fallback(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _write_catalog(docs, "bad-2026", [{"title": "Looks usable", "arxiv_url": "bad"}])
    result = project_catalogs(docs, ["bad-2026"], as_of="2026-08-30T00:00:00Z")
    assert not result.valid
    assert result.coverage["resolved_rows"] == 0
    assert result.coverage["failures"][0]["title"] == "Looks usable"


def test_identity_writer_refuses_partial_publish_on_invalid_projection(
    tmp_path: Path,
) -> None:
    docs = tmp_path / "docs"
    _write_catalog(docs, "bad-2026", [{"title": "Bad", "arxiv_url": "bad"}])
    alias_path = docs / "identity-aliases-v1.json"
    alias_path.write_text('[["arxiv","old","' + "a" * 40 + '"]]')

    with pytest.raises(ValueError, match="coverage"):
        build_identity_lite.build(
            docs_root=docs,
            conference_names=["bad-2026"],
            as_of="2026-08-30T00:00:00Z",
            coverage_path=tmp_path / "coverage.json",
        )
    assert json.loads(alias_path.read_text()) == [["arxiv", "old", "a" * 40]]

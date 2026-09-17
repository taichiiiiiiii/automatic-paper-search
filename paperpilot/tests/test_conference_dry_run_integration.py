"""Independent local dry-run checks against existing catalog/search producers.

All inputs are synthetic. These checks never collect or publish conference data.
"""

from __future__ import annotations

import json
import socket
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest

from paperpilot.conference_watch.candidate import build_catalog_candidate
from paperpilot.conference_watch.dry_run import build_catalog_update_dry_run
from paperpilot.conference_watch.fingerprint import source_fingerprint
from paperpilot.identity.projector import project_catalogs
from paperpilot.replay import canonical_json_bytes, sha256_bytes
from paperpilot.scripts import build_pages, build_search_index
from paperpilot.tests.test_conference_watch_candidate import _edition, _ready, _snapshot


def _long_snapshot():
    original = _snapshot()
    rows = tuple(
        replace(row, abstract="Synthetic full abstract. " * 30 + row.source_id)
        for row in original.rows
    )
    return replace(
        original,
        rows=rows,
        source_fingerprint=source_fingerprint(
            adapter_version=original.adapter_version,
            edition_id=original.edition_id,
            source_id=original.source_id,
            rows=rows,
        ),
    )


def _baseline(tmp_path: Path, candidate):
    summary = tmp_path / "synthetic-summary.csv"
    summary.write_bytes(candidate.summary_csv_bytes)
    rows, details = build_pages.load_summary_with_details(summary)
    catalog_bytes = json.dumps(rows, ensure_ascii=False, indent=0).encode("utf-8")
    detail_bytes = canonical_json_bytes(
        {
            "schema_version": "conference-current-details-v1",
            "edition_id": candidate.edition_id,
            "papers": [[paper_id, details[paper_id]] for paper_id in sorted(details)],
        }
    )
    return catalog_bytes, detail_bytes


def test_dry_run_no_change_projects_exact_existing_catalog_and_search(tmp_path: Path) -> None:
    edition, snapshot = _edition(), _long_snapshot()
    readiness = _ready(snapshot)
    candidate = build_catalog_candidate(edition, readiness, snapshot)
    current, details = _baseline(tmp_path, candidate)
    result = build_catalog_update_dry_run(
        edition,
        readiness,
        snapshot,
        current_catalog_bytes=current,
        current_details_bytes=details,
    )
    assert result.outcome == "no_change"
    assert result.candidate_catalog_bytes == current
    assert result.details_bytes == candidate.details_bytes
    assert result.run_binding_bytes == candidate.run_binding_bytes
    assert result.summary_csv_bytes == candidate.summary_csv_bytes
    assert sha256_bytes(current).encode() in result.report_bytes
    assert sha256_bytes(details).encode() in result.report_bytes
    assert b'"publication_authorized":false' in result.report_bytes
    assert b'"promotion_authorized":false' in result.staging_plan_bytes

    local_docs = tmp_path / "synthetic-site"
    catalog_directory = local_docs / edition.edition_id
    catalog_directory.mkdir(parents=True)
    (catalog_directory / "papers.json").write_bytes(result.candidate_catalog_bytes)
    projected = project_catalogs(
        local_docs, [edition.edition_id], as_of=candidate.source_observed_at
    )
    assert projected.valid
    search, ids = build_search_index.build_index_v2(local_docs)
    assert len(search) == len(ids) == len(candidate.rows)
    assert set(ids) == {row.paper_id for row in candidate.rows}


def test_dry_run_detects_full_abstract_change_without_preview_change(tmp_path: Path) -> None:
    edition, snapshot = _edition(), _long_snapshot()
    readiness = _ready(snapshot)
    candidate = build_catalog_candidate(edition, readiness, snapshot)
    current, details = _baseline(tmp_path, candidate)
    prior_details = json.loads(details)
    prior_details["papers"][0][1] += " Synthetic previous-only final sentence."
    result = build_catalog_update_dry_run(
        edition,
        readiness,
        snapshot,
        current_catalog_bytes=current,
        current_details_bytes=canonical_json_bytes(prior_details),
    )
    assert result.candidate_catalog_bytes == current
    assert result.outcome == "changes_detected"
    assert b"Synthetic previous-only final sentence" not in result.report_bytes
    assert b"Synthetic full abstract" not in result.report_bytes


def test_dry_run_missing_full_details_never_claims_no_change(tmp_path: Path) -> None:
    edition, snapshot = _edition(), _snapshot()
    readiness = _ready(snapshot)
    candidate = build_catalog_candidate(edition, readiness, snapshot)
    current, _ = _baseline(tmp_path, candidate)
    result = build_catalog_update_dry_run(
        edition, readiness, snapshot, current_catalog_bytes=current
    )
    assert result.outcome == "indeterminate"
    assert result.candidate_catalog_bytes == current


def test_dry_run_performs_no_filesystem_network_or_process_io(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    edition, snapshot = _edition(), _snapshot()
    readiness = _ready(snapshot)
    candidate = build_catalog_candidate(edition, readiness, snapshot)
    current, details = _baseline(tmp_path, candidate)

    def unexpected_io(*args, **kwargs):
        pytest.fail("Pure dry-run attempted external I/O")

    with monkeypatch.context() as guarded:
        guarded.setattr("builtins.open", unexpected_io)
        guarded.setattr(Path, "open", unexpected_io)
        guarded.setattr(socket, "socket", unexpected_io)
        guarded.setattr(subprocess, "Popen", unexpected_io)
        result = build_catalog_update_dry_run(
            edition,
            readiness,
            snapshot,
            current_catalog_bytes=current,
            current_details_bytes=details,
        )
    assert result.outcome == "no_change"

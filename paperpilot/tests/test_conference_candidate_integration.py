"""Independent C3a compatibility checks through the existing site producers.

All proceedings below are explicitly synthetic. No production files, source
APIs, persistent readiness state, or publication permissions are used.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from paperpilot.conference_watch.candidate import build_catalog_candidate
from paperpilot.conference_watch.models import CountGate, DetectionKind
from paperpilot.conference_watch.openreview import OPENREVIEW_API_URL, OpenReviewV2Adapter
from paperpilot.conference_watch.registry import load_registry, plan_editions
from paperpilot.conference_watch.stability import (
    initial_state,
    observation_from_detection,
    reduce_readiness,
)
from paperpilot.identity.projector import project_catalogs
from paperpilot.replay import canonical_json_bytes, sha256_bytes
from paperpilot.scripts import build_pages, build_search_index

ROOT = Path(__file__).resolve().parents[2]
AT = datetime(2026, 4, 1, tzinfo=timezone.utc)


class _Response:
    status_code = 200
    request_count = 1

    def __init__(self, notes: list[dict]) -> None:
        self.content = canonical_json_bytes({"count": len(notes), "notes": notes})

    def json(self) -> dict:
        body: dict = json.loads(self.content)
        return body


class _OnePage:
    def __init__(self, notes: list[dict]) -> None:
        self.notes = notes
        self.calls = 0

    def get(self, url, *, params, limits, deadline):
        assert url == OPENREVIEW_API_URL
        assert params["content.venueid"] == "ICLR.cc/2026/Conference"
        assert params["offset"] == 0
        self.calls += 1
        assert self.calls == 1
        return _Response(self.notes)


def _candidate(*, reversed_order: bool = False):
    registry = load_registry(ROOT / "paperpilot/data/conference-sources-v1.yaml")
    registry = replace(registry, venues=(replace(registry.venues[0], enabled=True),))
    edition = replace(plan_editions(registry, AT)[0], count_gate=CountGate(1, 0.7, 1.5))
    notes = [
        {
            "id": source_id,
            "content": {
                "venueid": {"value": edition.source_id},
                "title": {"value": "Synthetic Transformer Memory"},
                "authors": {"value": ["架空 太郎", "Synthetic Coauthor"]},
                "abstract": {"value": ("Synthetic abstract; not a real paper. " * 30) + source_id},
                "venue": {"value": f"ICLR 2026 {decision}"},
            },
        }
        for source_id, decision in (("SyntheticA1", "Oral"), ("SyntheticB2", "Poster"))
    ]
    if reversed_order:
        notes.reverse()
    transport = _OnePage(notes)
    detection = OpenReviewV2Adapter(transport, monotonic=lambda: 0.0).collect(edition)
    assert detection.kind is DetectionKind.SNAPSHOT and detection.snapshot is not None
    assert transport.calls == 1
    state = initial_state(edition)
    for ordinal in range(2):
        observation = observation_from_detection(
            edition,
            detection,
            observed_at=AT + timedelta(hours=6 * ordinal),
            run_id=f"independent-fixture-{ordinal}",
        )
        state = reduce_readiness(state, observation, edition).state
    return build_catalog_candidate(edition, state, detection.snapshot)


@pytest.mark.parametrize("reversed_order", [False, True])
def test_candidate_survives_catalog_identity_search_and_detail_projection(
    tmp_path: Path, monkeypatch, reversed_order: bool
) -> None:
    candidate = _candidate(reversed_order=reversed_order)
    summary = tmp_path / "summary.csv"
    summary.write_bytes(candidate.summary_csv_bytes)
    papers, details = build_pages.load_summary_with_details(summary)

    # Native IDs keep same-title papers separate, including their decision.
    assert len(papers) == len(details) == 2
    assert [paper["type"] for paper in papers] == ["Oral", "Poster"]
    assert len({paper["paper_id"] for paper in papers}) == 2
    assert len({paper["title"] for paper in papers}) == 1
    assert all(paper["authors"] == ["架空 太郎", "Synthetic Coauthor"] for paper in papers)
    assert details == {row.paper_id: row.abstract for row in candidate.rows}
    assert all(len(paper["abstract"]) < len(details[paper["paper_id"]]) for paper in papers)

    local_docs = tmp_path / "local-site"
    edition_dir = local_docs / candidate.edition_id
    edition_dir.mkdir(parents=True)
    (edition_dir / "papers.json").write_bytes(canonical_json_bytes(papers))
    identity = project_catalogs(
        local_docs, [candidate.edition_id], as_of=candidate.source_observed_at
    )
    assert identity.valid
    assert identity.catalogs[candidate.edition_id] == papers
    search, paper_ids = build_search_index.build_index_v2(local_docs)
    assert paper_ids == [paper["paper_id"] for paper in papers]
    assert [entry[6] for entry in search] == ["Oral", "Poster"]
    assert all(entry[5] == 2026 for entry in search)
    assert all(entry[3] == ["架空 太郎", "Synthetic Coauthor"] for entry in search)

    monkeypatch.setattr(build_pages, "DOCS_ROOT", local_docs)
    shard_paths = build_pages.write_detail_shards(details)
    assert len(shard_paths) == 256
    restored = {}
    for path in shard_paths:
        shard = json.loads(path.read_bytes())
        restored.update(shard["papers"])
    assert restored == details
    binding = json.loads(candidate.run_binding_bytes)
    assert binding["outputs"]["summary_csv"]["sha256"] == sha256_bytes(summary.read_bytes())
    assert binding["publication_authorized"] is False
    assert binding["promotion_authorized"] is False


def test_candidate_retries_bind_date_and_content_without_wall_clock_changes() -> None:
    first, reordered = _candidate(), _candidate(reversed_order=True)
    assert first == reordered
    assert first.source_observed_at == "2026-04-01T06:00:00Z"
    assert json.loads(first.source_quality_bytes)["duplicate_title_count"] == 1
    assert json.loads(first.run_binding_bytes)["trusted_persistent_state_proof"] is False

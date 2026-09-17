from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest

from paperpilot.conference_watch.models import (
    DetectionKind,
    DetectionResult,
    NormalizedPaper,
    SourceSnapshot,
    public_dict,
)
from paperpilot.conference_watch.registry import load_registry, plan_editions
from paperpilot.conference_watch.stability import (
    canonical_state_bytes,
    initial_state,
    observation_from_detection,
)

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "schemas"
REGISTRY = ROOT / "paperpilot" / "data" / "conference-sources-v1.yaml"


def _snapshot():
    registry = load_registry(REGISTRY)
    registry = replace(registry, venues=(replace(registry.venues[0], enabled=True),))
    edition = plan_editions(
        registry,
        datetime(2026, 4, 1, tzinfo=timezone.utc),
    )[0]
    row = NormalizedPaper(
        source="openreview",
        source_id="paperA",
        paper_id="a" * 40,
        title="Paper",
        authors=("Alice",),
        abstract="Abstract",
        landing_url="https://openreview.net/forum?id=paperA",
        pdf_url="https://openreview.net/pdf?id=paperA",
        decision_label="ICLR 2026 Poster",
    )
    snapshot = SourceSnapshot(
        schema_version="conference-source-snapshot-v1",
        edition_id=edition.edition_id,
        adapter="openreview-v2",
        adapter_version="1",
        source_id=edition.source_id,
        rows=(row,),
        source_fingerprint="b" * 64,
        unknown_decisions=(),
        duplicate_title_count=0,
        request_count=1,
        page_count=1,
        response_bytes=100,
    )
    return edition, snapshot


def test_all_conference_schemas_are_valid_draft_2020_12():
    jsonschema = pytest.importorskip("jsonschema")
    paths = sorted(SCHEMAS.glob("conference-*-v1.schema.json"))
    assert {path.name for path in paths} == {
        "conference-baseline-assessment-v1.schema.json",
        "conference-probe-observation-v1.schema.json",
        "conference-release-state-v1.schema.json",
        "conference-source-snapshot-v1.schema.json",
        "conference-sources-v1.schema.json",
    }
    for path in paths:
        jsonschema.Draft202012Validator.check_schema(json.loads(path.read_text(encoding="utf-8")))


def test_snapshot_and_observation_serialization_match_closed_schemas():
    jsonschema = pytest.importorskip("jsonschema")
    edition, snapshot = _snapshot()
    snapshot_schema = json.loads(
        (SCHEMAS / "conference-source-snapshot-v1.schema.json").read_text(encoding="utf-8")
    )
    observation_schema = json.loads(
        (SCHEMAS / "conference-probe-observation-v1.schema.json").read_text(encoding="utf-8")
    )
    jsonschema.Draft202012Validator(snapshot_schema).validate(public_dict(snapshot))
    observation = observation_from_detection(
        edition,
        DetectionResult(DetectionKind.SNAPSHOT, snapshot=snapshot),
        observed_at=datetime(2026, 4, 1, tzinfo=timezone.utc),
        run_id="fixture-1",
    )
    jsonschema.Draft202012Validator(observation_schema).validate(public_dict(observation))


def test_empty_reducer_state_serialization_matches_closed_state_schema():
    jsonschema = pytest.importorskip("jsonschema")
    edition, _ = _snapshot()
    schema = json.loads(
        (SCHEMAS / "conference-release-state-v1.schema.json").read_text(encoding="utf-8")
    )
    payload = json.loads(canonical_state_bytes(initial_state(edition)))
    jsonschema.Draft202012Validator(schema).validate(payload)

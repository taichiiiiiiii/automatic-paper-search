from __future__ import annotations

import csv
import io
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone, tzinfo
from pathlib import Path

import pytest

from paperpilot.conference_watch.candidate import (
    CandidateErrorCode,
    CandidateValidationError,
    build_catalog_candidate,
)
from paperpilot.conference_watch.models import (
    CountGate,
    DetectionKind,
    DetectionResult,
    EditionState,
    ErrorCode,
    FetchLimits,
    ReadinessPhase,
    TrackPolicy,
)
from paperpilot.conference_watch.openreview import OpenReviewV2Adapter
from paperpilot.conference_watch.registry import load_registry, plan_editions
from paperpilot.conference_watch.stability import (
    initial_state,
    observation_from_detection,
    reduce_readiness,
)
from paperpilot.scripts.build_pages import load_summary_with_details

ROOT = Path(__file__).resolve().parents[2]
REGISTRY = ROOT / "paperpilot/data/conference-sources-v1.yaml"
FIXTURE = ROOT / "paperpilot/tests/fixtures/conference-watch/openreview-iclr-2026.json"
T0 = datetime(2026, 4, 1, tzinfo=timezone.utc)


class _Response:
    status_code = 200
    request_count = 1

    def __init__(self, body):
        self._body = body
        self.content = json.dumps(body, separators=(",", ":")).encode()

    def json(self):
        return self._body


class _Transport:
    def __init__(self, pages):
        self.pages = iter(pages)

    def get(self, url, *, params, limits, deadline):
        return _Response(next(self.pages))


def _edition():
    registry = load_registry(REGISTRY)
    registry = replace(registry, venues=(replace(registry.venues[0], enabled=True),))
    edition = plan_editions(registry, T0)[0]
    return replace(edition, count_gate=CountGate(1, 0.7, 1.5))


def _snapshot():
    pages = json.loads(FIXTURE.read_text(encoding="utf-8"))["pages"]
    transport = _Transport(pages)
    result = OpenReviewV2Adapter(transport, monotonic=lambda: 0.0).collect(
        _edition(),
        FetchLimits(page_size=2),
    )
    assert result.kind is DetectionKind.SNAPSHOT and result.snapshot is not None
    return result.snapshot


def _ready(snapshot=None) -> EditionState:
    edition = _edition()
    snapshot = snapshot or _snapshot()
    detection = DetectionResult(DetectionKind.SNAPSHOT, snapshot=snapshot)
    first_observation = observation_from_detection(
        edition, detection, observed_at=T0, run_id="fixture-1"
    )
    first = reduce_readiness(initial_state(edition), first_observation, edition).state
    second_observation = observation_from_detection(
        edition,
        detection,
        observed_at=T0 + timedelta(hours=6),
        run_id="fixture-2",
    )
    return reduce_readiness(first, second_observation, edition).state


def _error(exc: pytest.ExceptionInfo[CandidateValidationError]) -> CandidateErrorCode:
    code: CandidateErrorCode = exc.value.code
    return code


def test_ready_snapshot_builds_deterministic_local_only_candidate(tmp_path: Path):
    edition = _edition()
    snapshot = _snapshot()
    ready = _ready(snapshot)

    first = build_catalog_candidate(edition, ready, snapshot)
    second = build_catalog_candidate(edition, ready, snapshot)

    assert first == second
    assert first.schema_version == "conference-catalog-candidate-v1"
    assert first.generation_key == second.generation_key
    assert [row.source_id for row in first.rows] == ["paperA1", "paperB2", "paperC3"]
    assert [row.paper_type for row in first.rows] == ["Oral", "Poster", "Poster"]
    assert all(row.source == "openreview" for row in first.rows)
    assert len(first.details) == snapshot.accepted_count

    quality = json.loads(first.source_quality_bytes)
    assert quality["status"] == "local_checks_passed"
    assert quality["accepted_count"] == quality["projected_count"] == 3
    assert quality["identity_resolved_count"] == 3
    assert quality["identity_coverage"] == 1.0
    assert quality["unknown_decision_count"] == 1
    assert quality["gates"] == {
        "first_edition_human_dry_run": "not_checked",
        "identity": "passed",
        "minimum_absolute": "passed",
        "previous_edition_ratio": "not_checked",
        "published_continuity": "passed",
        "readiness": "passed",
        "snapshot_binding": "passed",
    }
    binding = json.loads(first.run_binding_bytes)
    assert binding["scope"] == "local_candidate_only"
    assert binding["trusted_persistent_state_proof"] is False
    assert binding["promotion_authorized"] is False
    assert binding["publication_authorized"] is False
    assert set(binding["outputs"]) == {
        "catalog_rows",
        "details",
        "source_quality",
        "summary_csv",
    }

    # Exercise the real existing catalog reader, not a duplicate test parser.
    summary = tmp_path / "summary.csv"
    summary.write_bytes(first.summary_csv_bytes)
    papers, details = load_summary_with_details(summary)
    assert len(papers) == len(details) == snapshot.accepted_count
    assert {paper["paper_id"] for paper in papers} == {row.paper_id for row in snapshot.rows}
    assert all(paper["source"] == "openreview" for paper in papers)


def test_input_order_does_not_change_any_candidate_bytes():
    edition = _edition()
    snapshot = _snapshot()
    candidate = build_catalog_candidate(edition, _ready(snapshot), snapshot)
    reversed_snapshot = replace(snapshot, rows=tuple(reversed(snapshot.rows)))
    reordered = build_catalog_candidate(edition, _ready(reversed_snapshot), reversed_snapshot)

    assert reordered.catalog_rows_bytes == candidate.catalog_rows_bytes
    assert reordered.details_bytes == candidate.details_bytes
    assert reordered.summary_csv_bytes == candidate.summary_csv_bytes
    assert reordered.source_quality_bytes == candidate.source_quality_bytes
    assert reordered.run_binding_bytes == candidate.run_binding_bytes


@pytest.mark.parametrize(
    "state_mutator",
    [
        lambda state: replace(state, phase=ReadinessPhase.STABILIZING),
        lambda state: replace(state, stable_observations=1),
        lambda state: replace(state, stable_observations=True),
        lambda state: replace(state, stable_fingerprint="f" * 64),
        lambda state: replace(state, stable_since_at=None),
        lambda state: replace(state, last_qualifying_at=None),
        lambda state: replace(state, last_qualifying_run_id=None),
        lambda state: replace(state, last_qualifying_at=state.stable_since_at + timedelta(hours=2)),
        lambda state: replace(state, year=True),
    ],
)
def test_invalid_or_insufficient_readiness_is_rejected(state_mutator):
    snapshot = _snapshot()
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(_edition(), state_mutator(_ready(snapshot)), snapshot)
    assert _error(exc) is CandidateErrorCode.READINESS_INVALID


def test_transient_failure_after_ready_is_allowed_but_contradictory_evidence_is_not():
    edition = _edition()
    snapshot = _snapshot()
    ready = _ready(snapshot)
    failure = observation_from_detection(
        edition,
        DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_TIMEOUT),
        observed_at=T0 + timedelta(hours=7),
        run_id="fixture-3",
    )
    after_failure = reduce_readiness(ready, failure, edition).state
    assert build_catalog_candidate(edition, after_failure, snapshot).rows

    contradictory = replace(
        after_failure,
        last_observation=replace(failure, source_id="ICLR.cc/2099/Conference"),
    )
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(edition, contradictory, snapshot)
    assert _error(exc) is CandidateErrorCode.READINESS_INVALID

    malformed_run = replace(after_failure, last_observation=replace(failure, run_id="bad run"))
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(edition, malformed_run, snapshot)
    assert _error(exc) is CandidateErrorCode.READINESS_INVALID


def test_later_same_fingerprint_observations_preserve_ready_candidate_provenance():
    edition = _edition()
    snapshot = _snapshot()
    state = _ready(snapshot)
    original_qualifying_at = state.last_qualifying_at
    original_qualifying_run = state.last_qualifying_run_id

    for hours, run_id in ((7, "fixture-2"), (8, "fixture-3"), (55, "fixture-4")):
        observation = observation_from_detection(
            edition,
            DetectionResult(DetectionKind.SNAPSHOT, snapshot=snapshot),
            observed_at=T0 + timedelta(hours=hours),
            run_id=run_id,
        )
        state = reduce_readiness(state, observation, edition).state
        assert state.phase is ReadinessPhase.READY
        assert state.last_qualifying_at == original_qualifying_at
        assert state.last_qualifying_run_id == original_qualifying_run
        candidate = build_catalog_candidate(edition, state, snapshot)
        assert candidate.source_observed_at == "2026-04-01T06:00:00Z"
        assert candidate.readiness_run_id == "fixture-2"


@pytest.mark.parametrize(
    "snapshot_mutator",
    [
        lambda snapshot: replace(snapshot, edition_id="iclr-2027"),
        lambda snapshot: replace(snapshot, adapter="other"),
        lambda snapshot: replace(snapshot, source_id="ICLR.cc/2027/Conference"),
        lambda snapshot: replace(snapshot, source_fingerprint="f" * 64),
        lambda snapshot: replace(snapshot, request_count=True),
        lambda snapshot: replace(snapshot, request_count=1, page_count=2),
        lambda snapshot: replace(snapshot, response_bytes=-1),
        lambda snapshot: replace(snapshot, duplicate_title_count=True),
    ],
)
def test_malformed_or_mismatched_snapshot_is_rejected(snapshot_mutator):
    snapshot = _snapshot()
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(_edition(), _ready(snapshot), snapshot_mutator(snapshot))
    assert _error(exc) in {
        CandidateErrorCode.CANDIDATE_MISMATCH,
        CandidateErrorCode.VALIDATION_FAILED,
    }


@pytest.mark.parametrize(
    "row_mutator",
    [
        lambda row: replace(row, paper_id="0" * 40),
        lambda row: replace(row, source="arxiv"),
        lambda row: replace(row, landing_url="http://openreview.net/forum?id=paperA1"),
        lambda row: replace(row, pdf_url="https://openreview.net/pdf?id=other"),
        lambda row: replace(row, title=" not normalized"),
        lambda row: replace(row, title="bad\ud800title"),
        lambda row: replace(row, authors=("Alice\nBob",)),
    ],
)
def test_forged_identity_url_or_text_is_rejected_even_with_refingerprinting(row_mutator):
    edition = _edition()
    snapshot = _snapshot()
    rows = list(snapshot.rows)
    rows[0] = row_mutator(rows[0])
    from paperpilot.conference_watch.fingerprint import source_fingerprint

    try:
        fingerprint = source_fingerprint(
            adapter_version=snapshot.adapter_version,
            edition_id=snapshot.edition_id,
            source_id=snapshot.source_id,
            rows=tuple(rows),
        )
    except UnicodeEncodeError:
        # A malformed scalar cannot itself be canonically fingerprinted; the
        # candidate validator must still reject it before trusting the hash.
        fingerprint = "f" * 64
    forged = replace(snapshot, rows=tuple(rows), source_fingerprint=fingerprint)
    forged_ready = replace(_ready(snapshot), stable_fingerprint=forged.source_fingerprint)
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(edition, forged_ready, forged)
    assert _error(exc) in {
        CandidateErrorCode.IDENTITY_INVALID,
        CandidateErrorCode.VALIDATION_FAILED,
    }


def test_duplicate_ids_are_rejected_but_duplicate_titles_are_retained_and_reported():
    edition = _edition()
    snapshot = _snapshot()
    duplicate = replace(snapshot, rows=(snapshot.rows[0], snapshot.rows[0]))
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(edition, _ready(snapshot), duplicate)
    assert _error(exc) is CandidateErrorCode.DUPLICATE_ID

    same_title_rows = list(snapshot.rows)
    same_title_rows[1] = replace(same_title_rows[1], title=same_title_rows[0].title)
    from paperpilot.conference_watch.fingerprint import source_fingerprint

    rows = tuple(same_title_rows)
    fingerprint = source_fingerprint(
        adapter_version="1", edition_id=edition.edition_id, source_id=edition.source_id, rows=rows
    )
    same_title = replace(
        snapshot, rows=rows, source_fingerprint=fingerprint, duplicate_title_count=1
    )
    candidate = build_catalog_candidate(edition, _ready(same_title), same_title)
    assert len(candidate.rows) == 3
    assert json.loads(candidate.source_quality_bytes)["duplicate_title_count"] == 1


def test_declared_unknown_decisions_and_duplicate_titles_are_recomputed():
    snapshot = _snapshot()
    for malformed in (
        replace(snapshot, unknown_decisions=()),
        replace(snapshot, duplicate_title_count=1),
    ):
        with pytest.raises(CandidateValidationError) as exc:
            build_catalog_candidate(_edition(), _ready(snapshot), malformed)
        assert _error(exc) is CandidateErrorCode.CANDIDATE_MISMATCH


def test_published_continuity_and_qualifying_observation_binding_are_rechecked():
    edition = _edition()
    snapshot = _snapshot()
    ready = _ready(snapshot)
    published = replace(
        ready,
        published_fingerprint="e" * 64,
        published_count=4,
        published_source_ids=("paperA1", "paperB2", "paperC3", "paperD4"),
    )
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(edition, published, snapshot)
    assert _error(exc) is CandidateErrorCode.PUBLISHED_CONTINUITY_INVALID

    last = ready.last_observation
    assert last is not None
    contradictory = replace(ready, last_observation=replace(last, accepted_count=2))
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(edition, contradictory, snapshot)
    assert _error(exc) is CandidateErrorCode.READINESS_INVALID


def test_summary_bytes_have_exact_existing_pipeline_columns():
    snapshot = _snapshot()
    candidate = build_catalog_candidate(_edition(), _ready(snapshot), snapshot)
    rows = list(csv.DictReader(io.StringIO(candidate.summary_csv_bytes.decode("utf-8"))))
    assert len(rows) == snapshot.accepted_count
    assert list(rows[0]) == [
        "title",
        "type",
        "tags",
        "venue",
        "authors",
        "arxiv_url",
        "pdf_url",
        "abstract",
        "arxiv_id",
        "citation_count",
        "venue_tier",
        "github_stars",
        "source",
        "source_id",
    ]


@pytest.mark.parametrize(
    "edition_mutator",
    [
        lambda edition: replace(edition, count_gate=None),
        lambda edition: replace(edition, tracks=None),
        lambda edition: replace(
            edition,
            tracks=TrackPolicy(True, ("poster", "poster"), ("poster",)),
        ),
        lambda edition: replace(
            edition,
            tracks=TrackPolicy(True, ("poster",), ("oral",)),
        ),
        lambda edition: replace(edition, edition_id="../escape"),
        lambda edition: replace(edition, source_id="ICLR.cc/2099/Conference"),
    ],
)
def test_malformed_nested_edition_values_have_stable_rejections(edition_mutator):
    snapshot = _snapshot()
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(edition_mutator(_edition()), _ready(snapshot), snapshot)
    assert _error(exc) in {
        CandidateErrorCode.CANDIDATE_MISMATCH,
        CandidateErrorCode.VALIDATION_FAILED,
    }


def test_huge_ratio_is_a_stable_validation_failure() -> None:
    snapshot = _snapshot()
    edition = replace(
        _edition(),
        count_gate=CountGate(1, 10**10_000, 10**10_000),
    )
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(edition, _ready(snapshot), snapshot)
    assert _error(exc) is CandidateErrorCode.VALIDATION_FAILED


def test_hostile_timezone_is_a_stable_readiness_failure() -> None:
    class HostileTimezone(tzinfo):
        def utcoffset(self, dt):
            raise ValueError("untrusted timezone detail")

        def dst(self, dt):
            return None

        def tzname(self, dt):
            return None

    snapshot = _snapshot()
    hostile = replace(
        _ready(snapshot),
        stable_since_at=datetime(2026, 4, 1, tzinfo=HostileTimezone()),
    )
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(_edition(), hostile, snapshot)
    assert _error(exc) is CandidateErrorCode.READINESS_INVALID
    assert "untrusted timezone detail" not in str(exc.value)


def test_large_aggregate_inputs_are_rejected_before_projection() -> None:
    snapshot = _snapshot()
    oversized_unknown = replace(
        snapshot,
        unknown_decisions=tuple((f"label{i}", 1) for i in range(25_001)),
    )
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(_edition(), _ready(snapshot), oversized_unknown)
    assert _error(exc) is CandidateErrorCode.VALIDATION_FAILED

    ready = replace(
        _ready(snapshot),
        published_fingerprint="e" * 64,
        published_count=25_000,
        published_source_ids=tuple(f"paper{i}" for i in range(25_001)),
    )
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(_edition(), ready, snapshot)
    assert _error(exc) is CandidateErrorCode.PUBLISHED_CONTINUITY_INVALID


@pytest.mark.parametrize("author", ["Doe, Jane", "Jane; PhD"])
def test_legacy_summary_csv_rejects_author_delimiters_that_change_author_arrays(author):
    edition = _edition()
    snapshot = _snapshot()
    rows = list(snapshot.rows)
    rows[0] = replace(rows[0], authors=(author,))
    from paperpilot.conference_watch.fingerprint import source_fingerprint

    forged_rows = tuple(rows)
    fingerprint = source_fingerprint(
        adapter_version="1",
        edition_id=edition.edition_id,
        source_id=edition.source_id,
        rows=forged_rows,
    )
    forged = replace(snapshot, rows=forged_rows, source_fingerprint=fingerprint)
    forged_ready = _ready(forged)
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(edition, forged_ready, forged)
    assert _error(exc) is CandidateErrorCode.VALIDATION_FAILED


def test_duplicate_titles_keep_distinct_native_decision_types():
    edition = _edition()
    snapshot = _snapshot()
    rows = list(snapshot.rows)
    rows[1] = replace(rows[1], title=rows[0].title)
    from paperpilot.conference_watch.fingerprint import source_fingerprint

    rows_tuple = tuple(rows)
    fingerprint = source_fingerprint(
        adapter_version="1",
        edition_id=edition.edition_id,
        source_id=edition.source_id,
        rows=rows_tuple,
    )
    duplicate_titles = replace(
        snapshot,
        rows=rows_tuple,
        source_fingerprint=fingerprint,
        duplicate_title_count=1,
    )
    candidate = build_catalog_candidate(edition, _ready(duplicate_titles), duplicate_titles)
    same_title = [row for row in candidate.rows if row.title == rows[0].title]
    assert {row.paper_type for row in same_title} == {"Oral", "Poster"}
    assert len({row.paper_id for row in same_title}) == 2


@pytest.mark.parametrize(
    "state_mutator",
    [
        lambda state: replace(state, published_fingerprint="e" * 64),
        lambda state: replace(state, published_count=0),
        lambda state: replace(state, published_source_ids=([],)),
    ],
)
def test_partial_or_malformed_published_evidence_is_rejected(state_mutator):
    snapshot = _snapshot()
    with pytest.raises(CandidateValidationError) as exc:
        build_catalog_candidate(_edition(), state_mutator(_ready(snapshot)), snapshot)
    assert _error(exc) is CandidateErrorCode.PUBLISHED_CONTINUITY_INVALID

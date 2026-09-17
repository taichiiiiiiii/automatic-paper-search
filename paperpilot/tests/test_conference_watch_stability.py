from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

from paperpilot.conference_watch.fingerprint import source_fingerprint
from paperpilot.conference_watch.models import (
    CountGate,
    DetectionKind,
    DetectionResult,
    EditionState,
    ErrorCode,
    NormalizedPaper,
    ReadinessPhase,
    ReductionAction,
    SourceSnapshot,
)
from paperpilot.conference_watch.registry import load_registry, plan_editions
from paperpilot.conference_watch.stability import (
    canonical_state_bytes,
    initial_state,
    observation_from_detection,
    reduce_readiness,
)

ROOT = Path(__file__).resolve().parents[2]
REGISTRY = ROOT / "paperpilot" / "data" / "conference-sources-v1.yaml"
T0 = datetime(2026, 4, 1, tzinfo=timezone.utc)


def _edition():
    registry = load_registry(REGISTRY)
    registry = replace(registry, venues=(replace(registry.venues[0], enabled=True),))
    edition = plan_editions(registry, T0)[0]
    return replace(edition, count_gate=CountGate(1, 0.7, 1.5))


def _row(source_id="paperA", *, title="Paper"):
    return NormalizedPaper(
        source="openreview",
        source_id=source_id,
        paper_id=(source_id.lower().encode().hex() + "0" * 40)[:40],
        title=title,
        authors=("Alice",),
        abstract="Abstract",
        landing_url=f"https://openreview.net/forum?id={source_id}",
        pdf_url=f"https://openreview.net/pdf?id={source_id}",
        decision_label="ICLR 2026 Poster",
    )


def _result(*rows):
    edition = _edition()
    immutable = tuple(sorted(rows or (_row(),), key=lambda row: row.source_id))
    fingerprint = source_fingerprint(
        adapter_version="1",
        edition_id=edition.edition_id,
        source_id=edition.source_id,
        rows=immutable,
    )
    return DetectionResult(
        DetectionKind.SNAPSHOT,
        snapshot=SourceSnapshot(
            schema_version="conference-source-snapshot-v1",
            edition_id=edition.edition_id,
            adapter=edition.adapter,
            adapter_version="1",
            source_id=edition.source_id,
            rows=immutable,
            source_fingerprint=fingerprint,
            unknown_decisions=(),
            duplicate_title_count=0,
            request_count=1,
            page_count=1,
            response_bytes=1,
        ),
    )


def _observation(at=T0, run="run-1", result=None, previous_count=None):
    return observation_from_detection(
        _edition(),
        result or _result(),
        observed_at=at,
        run_id=run,
        previous_edition_count=previous_count,
    )


def test_exactly_two_distinct_separated_successes_become_ready():
    edition = _edition()
    first = reduce_readiness(initial_state(edition), _observation(), edition)
    assert first.state.phase is ReadinessPhase.STABILIZING
    assert first.state.stable_observations == 1
    second = reduce_readiness(
        first.state,
        _observation(T0 + timedelta(hours=6), "run-2"),
        edition,
    )
    assert second.action is ReductionAction.READY
    assert second.state.phase is ReadinessPhase.READY
    assert second.state.stable_observations == 2


def test_same_run_and_too_soon_are_typed_noops_without_advancing_count():
    edition = _edition()
    first = reduce_readiness(initial_state(edition), _observation(), edition).state
    same_run = reduce_readiness(first, _observation(T0 + timedelta(hours=6), "run-1"), edition)
    assert same_run.action is ReductionAction.NO_OP
    assert same_run.state.stable_observations == 1
    too_soon = reduce_readiness(
        same_run.state, _observation(T0 + timedelta(hours=5), "run-2"), edition
    )
    assert too_soon.action is ReductionAction.NO_OP
    assert too_soon.state.stable_observations == 1


def test_ready_is_not_downgraded_by_same_run_too_soon_or_transient_failure():
    edition = _edition()
    first = reduce_readiness(initial_state(edition), _observation(), edition).state
    ready = reduce_readiness(first, _observation(T0 + timedelta(hours=6), "run-2"), edition).state
    same_run = reduce_readiness(ready, _observation(T0 + timedelta(hours=7), "run-2"), edition)
    assert same_run.state.phase is ReadinessPhase.READY
    too_soon = reduce_readiness(
        same_run.state, _observation(T0 + timedelta(hours=8), "run-3"), edition
    )
    assert too_soon.state.phase is ReadinessPhase.READY
    failure = DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_TIMEOUT)
    failed = reduce_readiness(
        too_soon.state,
        _observation(T0 + timedelta(hours=9), "run-4", failure),
        edition,
    )
    assert failed.state.phase is ReadinessPhase.READY
    assert failed.state.stable_observations == 2


def test_max_separation_and_changed_fingerprint_restart_at_one():
    edition = _edition()
    first = reduce_readiness(initial_state(edition), _observation(), edition).state
    late = reduce_readiness(first, _observation(T0 + timedelta(hours=49), "run-2"), edition)
    assert late.state.stable_observations == 1
    assert late.state.stable_since_at == T0 + timedelta(hours=49)

    changed_result = _result(_row(title="Metadata corrected"))
    changed = reduce_readiness(
        late.state,
        _observation(T0 + timedelta(hours=55), "run-3", changed_result),
        edition,
    )
    assert changed.reason is ErrorCode.SOURCE_FINGERPRINT_CHANGED
    assert changed.state.stable_observations == 1


def test_failure_does_not_advance_or_erase_last_success():
    edition = _edition()
    first = reduce_readiness(initial_state(edition), _observation(), edition).state
    failure = DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_TIMEOUT)
    failed = reduce_readiness(
        first,
        _observation(T0 + timedelta(hours=2), "run-2", failure),
        edition,
    )
    assert failed.action is ReductionAction.FAILED
    assert failed.state.stable_fingerprint == first.stable_fingerprint
    assert failed.state.stable_observations == 1
    assert failed.state.last_failure_code is ErrorCode.SOURCE_TIMEOUT


def test_count_gate_classifies_below_minimum_and_above_previous_maximum():
    edition = replace(_edition(), count_gate=CountGate(5, 0.7, 1.5))
    below = observation_from_detection(edition, _result(), observed_at=T0, run_id="run-low")
    assert below.error_code is ErrorCode.COUNT_BELOW_MINIMUM
    assert below.status.value == "partial"

    many = _result(*[_row(f"paper{i}") for i in range(4)])
    above = observation_from_detection(
        replace(edition, count_gate=CountGate(1, 0.7, 1.5)),
        many,
        observed_at=T0,
        run_id="run-high",
        previous_edition_count=2,
    )
    assert above.error_code is ErrorCode.COUNT_ABOVE_MAXIMUM
    assert above.status.value == "anomaly"


def test_partial_or_anomaly_interrupts_unpublished_stable_evidence():
    edition = _edition()
    first = reduce_readiness(initial_state(edition), _observation(), edition).state
    strict_edition = replace(edition, count_gate=CountGate(5, 0.7, 1.5))
    partial_observation = observation_from_detection(
        strict_edition,
        _result(),
        observed_at=T0 + timedelta(hours=2),
        run_id="run-partial",
    )
    partial = reduce_readiness(first, partial_observation, strict_edition)
    assert partial.state.stable_observations == 0
    assert partial.state.stable_fingerprint is None
    restarted = reduce_readiness(
        partial.state,
        _observation(T0 + timedelta(hours=6), "run-after-partial"),
        edition,
    )
    assert restarted.state.stable_observations == 1
    assert restarted.state.phase is ReadinessPhase.STABILIZING

    anomaly_observation = observation_from_detection(
        edition,
        _result(*[_row(f"paper{i}") for i in range(4)]),
        observed_at=T0 + timedelta(hours=8),
        run_id="run-anomaly",
        previous_edition_count=2,
    )
    anomaly = reduce_readiness(restarted.state, anomaly_observation, edition)
    assert anomaly.state.phase is ReadinessPhase.ANOMALY
    assert anomaly.state.stable_observations == 0
    assert anomaly.state.stable_fingerprint is None


def test_published_unchanged_is_noop_but_shrink_or_id_removal_is_anomaly():
    edition = _edition()
    base_result = _result(_row("paperA"), _row("paperB"))
    observation = _observation(result=base_result)
    assert base_result.snapshot is not None
    published = EditionState(
        edition_id=edition.edition_id,
        venue_key=edition.venue_key,
        year=edition.year,
        phase=ReadinessPhase.PUBLISHED,
        published_fingerprint=base_result.snapshot.source_fingerprint,
        published_count=2,
        published_source_ids=("paperA", "paperB"),
    )
    unchanged = reduce_readiness(published, observation, edition)
    assert unchanged.action is ReductionAction.NO_OP
    assert unchanged.state.phase is ReadinessPhase.PUBLISHED

    shrink = reduce_readiness(published, _observation(result=_result(_row("paperA"))), edition)
    assert shrink.action is ReductionAction.ANOMALY
    assert shrink.reason is ErrorCode.COUNT_SHRINK

    replacement = _result(_row("paperA"), _row("paperC"))
    missing = reduce_readiness(published, _observation(result=replacement, run="run-2"), edition)
    assert missing.action is ReductionAction.ANOMALY
    assert missing.reason is ErrorCode.IDENTITY_CONFLICT


def test_published_shrink_is_anomaly_even_when_snapshot_is_below_count_gate():
    edition = replace(_edition(), count_gate=CountGate(5, 0.7, 1.5))
    published = EditionState(
        edition_id=edition.edition_id,
        venue_key=edition.venue_key,
        year=edition.year,
        phase=ReadinessPhase.PUBLISHED,
        published_fingerprint="f" * 64,
        published_count=2,
        published_source_ids=("paperA", "paperB"),
    )
    partial_observation = observation_from_detection(
        edition,
        _result(_row("paperA")),
        observed_at=T0,
        run_id="run-partial-shrink",
    )
    assert partial_observation.status.value == "partial"
    reduced = reduce_readiness(published, partial_observation, edition)
    assert reduced.action is ReductionAction.ANOMALY
    assert reduced.reason is ErrorCode.COUNT_SHRINK
    assert reduced.state.phase is ReadinessPhase.ANOMALY
    assert reduced.state.published_count == 2
    assert reduced.state.published_source_ids == ("paperA", "paperB")
    assert reduced.state.published_fingerprint == "f" * 64

    published_same_count = replace(
        published,
        published_count=1,
        published_source_ids=("paperA",),
    )
    partial_replacement = observation_from_detection(
        edition,
        _result(_row("paperC")),
        observed_at=T0,
        run_id="run-partial-id-loss",
    )
    missing = reduce_readiness(published_same_count, partial_replacement, edition)
    assert missing.action is ReductionAction.ANOMALY
    assert missing.reason is ErrorCode.IDENTITY_CONFLICT
    assert missing.state.published_count == 1
    assert missing.state.published_source_ids == ("paperA",)


def test_reducer_retry_and_serialization_are_byte_identical():
    edition = _edition()
    observation = _observation()
    once = reduce_readiness(initial_state(edition), observation, edition)
    retried = reduce_readiness(once.state, observation, edition)
    assert retried.action is ReductionAction.NO_OP
    assert retried.state == once.state
    assert canonical_state_bytes(retried.state) == canonical_state_bytes(once.state)

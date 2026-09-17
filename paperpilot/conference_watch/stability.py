"""Pure probe classification and fixed two-observation readiness reduction."""

from __future__ import annotations

import json
import math
import re
from dataclasses import replace
from datetime import datetime, timezone
from typing import TypedDict

from .models import (
    DetectionKind,
    DetectionResult,
    Edition,
    EditionState,
    ErrorCode,
    ObservationStatus,
    ProbeObservation,
    ReadinessPhase,
    ReductionAction,
    ReductionResult,
    public_dict,
)
from .registry import STABLE_PROBE_COUNT

_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class _ObservationCommon(TypedDict):
    schema_version: str
    edition_id: str
    adapter: str
    adapter_version: str
    source_id: str
    observed_at: datetime
    run_id: str


def observation_from_detection(
    edition: Edition,
    result: DetectionResult,
    *,
    observed_at: datetime,
    run_id: str,
    previous_edition_count: int | None = None,
) -> ProbeObservation:
    """Classify one typed adapter result without mutating durable state."""

    if observed_at.tzinfo is None:
        raise ValueError("observed_at must be timezone-aware")
    observed_at = observed_at.astimezone(timezone.utc)
    if not _RUN_ID_RE.fullmatch(run_id):
        raise ValueError("run_id is invalid")

    if previous_edition_count is not None and (
        type(previous_edition_count) is not int or isinstance(previous_edition_count, bool)
    ):
        raise ValueError("previous_edition_count_invalid") from None
    if previous_edition_count is not None and not (0 <= previous_edition_count <= 25_000):
        raise ValueError("previous_edition_count_invalid") from None

    common: _ObservationCommon = {
        "schema_version": "conference-probe-observation-v1",
        "edition_id": edition.edition_id,
        "adapter": edition.adapter,
        "adapter_version": "1",
        "source_id": edition.source_id,
        "observed_at": observed_at,
        "run_id": run_id,
    }
    if result.kind is DetectionKind.UNAVAILABLE:
        return ProbeObservation(
            **common,
            http_class="unavailable",
            accepted_count=0,
            unknown_label_count=0,
            source_fingerprint=None,
            source_ids=(),
            status=ObservationStatus.UNAVAILABLE,
            error_code=ErrorCode.SOURCE_UNAVAILABLE,
        )
    if result.kind is DetectionKind.ERROR:
        return ProbeObservation(
            **common,
            http_class="error",
            accepted_count=0,
            unknown_label_count=0,
            source_fingerprint=None,
            source_ids=(),
            status=ObservationStatus.FAILED,
            error_code=result.error_code,
        )

    snapshot = result.snapshot
    if snapshot is None:  # protected by DetectionResult, defensive for typed callers
        raise ValueError("snapshot result is missing its snapshot")
    count = snapshot.accepted_count
    effective_minimum = edition.count_gate.minimum_absolute
    effective_maximum: int | None = None
    if previous_edition_count is not None:
        effective_minimum = max(
            effective_minimum,
            math.floor(previous_edition_count * edition.count_gate.previous_edition_min_ratio),
        )
        effective_maximum = math.ceil(
            previous_edition_count * edition.count_gate.previous_edition_max_ratio
        )

    status = ObservationStatus.STABILIZING
    error_code = None
    if count < effective_minimum:
        status = ObservationStatus.PARTIAL
        error_code = ErrorCode.COUNT_BELOW_MINIMUM
    elif effective_maximum is not None and count > effective_maximum:
        status = ObservationStatus.ANOMALY
        error_code = ErrorCode.COUNT_ABOVE_MAXIMUM
    return ProbeObservation(
        **common,
        http_class="ok",
        accepted_count=count,
        unknown_label_count=sum(amount for _, amount in snapshot.unknown_decisions),
        source_fingerprint=snapshot.source_fingerprint,
        source_ids=tuple(row.source_id for row in snapshot.rows),
        status=status,
        error_code=error_code,
    )


def initial_state(edition: Edition) -> EditionState:
    """Create the empty state for one planned edition."""

    return EditionState(
        edition_id=edition.edition_id,
        venue_key=edition.venue_key,
        year=edition.year,
    )


def reduce_readiness(
    previous: EditionState,
    observation: ProbeObservation,
    edition: Edition,
) -> ReductionResult:
    """Apply one observation with v1's immutable two-probe readiness rule."""

    if previous.edition_id != edition.edition_id or observation.edition_id != edition.edition_id:
        raise ValueError("state, observation, and edition must have the same edition_id")
    if previous.last_observation == observation:
        return ReductionResult(previous, ReductionAction.NO_OP)

    updated = replace(previous, last_observation=observation)
    if observation.status is ObservationStatus.FAILED:
        return ReductionResult(
            replace(updated, last_failure_code=observation.error_code),
            ReductionAction.FAILED,
            observation.error_code,
        )
    if observation.status is ObservationStatus.UNAVAILABLE:
        phase = (
            ReadinessPhase.PUBLISHED
            if previous.phase is ReadinessPhase.PUBLISHED
            else ReadinessPhase.UNAVAILABLE
        )
        return ReductionResult(
            replace(
                updated,
                phase=phase,
                stable_fingerprint=(
                    previous.stable_fingerprint if phase is ReadinessPhase.PUBLISHED else None
                ),
                stable_observations=(
                    previous.stable_observations if phase is ReadinessPhase.PUBLISHED else 0
                ),
                stable_since_at=(
                    previous.stable_since_at if phase is ReadinessPhase.PUBLISHED else None
                ),
                last_qualifying_at=(
                    previous.last_qualifying_at if phase is ReadinessPhase.PUBLISHED else None
                ),
                last_qualifying_run_id=(
                    previous.last_qualifying_run_id if phase is ReadinessPhase.PUBLISHED else None
                ),
                last_failure_code=None,
            ),
            ReductionAction.OBSERVED,
        )

    # Every positive source snapshot must protect the published identity set
    # before count-gate classification can return ``partial`` or ``anomaly``.
    # The published fields themselves are intentionally retained for recovery.
    if observation.http_class == "ok" and previous.published_count is not None:
        if observation.accepted_count < previous.published_count:
            anomaly = replace(
                updated,
                phase=ReadinessPhase.ANOMALY,
                stable_fingerprint=None,
                stable_observations=0,
                stable_since_at=None,
                last_qualifying_at=None,
                last_qualifying_run_id=None,
                last_failure_code=ErrorCode.COUNT_SHRINK,
            )
            return ReductionResult(anomaly, ReductionAction.ANOMALY, ErrorCode.COUNT_SHRINK)
        if not set(previous.published_source_ids).issubset(observation.source_ids):
            anomaly = replace(
                updated,
                phase=ReadinessPhase.ANOMALY,
                stable_fingerprint=None,
                stable_observations=0,
                stable_since_at=None,
                last_qualifying_at=None,
                last_qualifying_run_id=None,
                last_failure_code=ErrorCode.IDENTITY_CONFLICT,
            )
            return ReductionResult(anomaly, ReductionAction.ANOMALY, ErrorCode.IDENTITY_CONFLICT)
    if observation.status is ObservationStatus.PARTIAL:
        phase = (
            ReadinessPhase.PUBLISHED
            if previous.phase is ReadinessPhase.PUBLISHED
            else ReadinessPhase.PARTIAL
        )
        return ReductionResult(
            replace(
                updated,
                phase=phase,
                stable_fingerprint=(
                    previous.stable_fingerprint if phase is ReadinessPhase.PUBLISHED else None
                ),
                stable_observations=(
                    previous.stable_observations if phase is ReadinessPhase.PUBLISHED else 0
                ),
                stable_since_at=(
                    previous.stable_since_at if phase is ReadinessPhase.PUBLISHED else None
                ),
                last_qualifying_at=(
                    previous.last_qualifying_at if phase is ReadinessPhase.PUBLISHED else None
                ),
                last_qualifying_run_id=(
                    previous.last_qualifying_run_id if phase is ReadinessPhase.PUBLISHED else None
                ),
                last_failure_code=None,
            ),
            ReductionAction.OBSERVED,
            observation.error_code,
        )
    if observation.status is ObservationStatus.ANOMALY:
        return ReductionResult(
            replace(
                updated,
                phase=ReadinessPhase.ANOMALY,
                stable_fingerprint=None,
                stable_observations=0,
                stable_since_at=None,
                last_qualifying_at=None,
                last_qualifying_run_id=None,
                last_failure_code=observation.error_code,
            ),
            ReductionAction.ANOMALY,
            observation.error_code,
        )

    fingerprint = observation.source_fingerprint
    if fingerprint is None:
        raise ValueError("successful observation must contain a fingerprint")
    if previous.published_fingerprint == fingerprint:
        return ReductionResult(
            replace(updated, phase=ReadinessPhase.PUBLISHED, last_failure_code=None),
            ReductionAction.NO_OP,
        )

    if previous.stable_fingerprint != fingerprint:
        reset = replace(
            updated,
            phase=ReadinessPhase.STABILIZING,
            stable_fingerprint=fingerprint,
            stable_observations=1,
            stable_since_at=observation.observed_at,
            last_qualifying_at=observation.observed_at,
            last_qualifying_run_id=observation.run_id,
            last_failure_code=None,
        )
        reason = (
            ErrorCode.SOURCE_FINGERPRINT_CHANGED
            if previous.stable_fingerprint is not None
            else None
        )
        return ReductionResult(reset, ReductionAction.OBSERVED, reason)

    if previous.phase is ReadinessPhase.READY:
        return ReductionResult(
            replace(updated, phase=ReadinessPhase.READY, last_failure_code=None),
            ReductionAction.NO_OP,
        )

    if previous.last_qualifying_run_id == observation.run_id:
        phase = (
            previous.phase
            if previous.phase in {ReadinessPhase.READY, ReadinessPhase.PUBLISHED}
            else ReadinessPhase.STABILIZING
        )
        return ReductionResult(
            replace(updated, phase=phase, last_failure_code=None),
            ReductionAction.NO_OP,
        )
    if previous.last_qualifying_at is None:
        raise ValueError("stable fingerprint is missing its qualifying timestamp")
    separation = (observation.observed_at - previous.last_qualifying_at).total_seconds() / 3600
    if separation < 0:
        raise ValueError("observations must not move backwards in time")
    if separation < edition.stable_min_separation_hours:
        phase = (
            previous.phase
            if previous.phase in {ReadinessPhase.READY, ReadinessPhase.PUBLISHED}
            else ReadinessPhase.STABILIZING
        )
        return ReductionResult(
            replace(updated, phase=phase, last_failure_code=None),
            ReductionAction.NO_OP,
        )
    if separation > edition.stable_max_separation_hours:
        reset = replace(
            updated,
            phase=ReadinessPhase.STABILIZING,
            stable_observations=1,
            stable_since_at=observation.observed_at,
            last_qualifying_at=observation.observed_at,
            last_qualifying_run_id=observation.run_id,
            last_failure_code=None,
        )
        return ReductionResult(reset, ReductionAction.OBSERVED)

    count = min(STABLE_PROBE_COUNT, previous.stable_observations + 1)
    phase = ReadinessPhase.READY if count == STABLE_PROBE_COUNT else ReadinessPhase.STABILIZING
    action = ReductionAction.READY if phase is ReadinessPhase.READY else ReductionAction.OBSERVED
    return ReductionResult(
        replace(
            updated,
            phase=phase,
            stable_observations=count,
            last_qualifying_at=observation.observed_at,
            last_qualifying_run_id=observation.run_id,
            last_failure_code=None,
        ),
        action,
    )


def canonical_state_bytes(state: EditionState) -> bytes:
    """Serialize reducer state deterministically for compare-and-swap candidates."""

    return (
        json.dumps(
            {
                "schema_version": "conference-release-state-v1",
                "editions": [public_dict(state)],
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")

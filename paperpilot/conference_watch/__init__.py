"""Read-only, fail-closed top-conference release detection."""

from .baseline import (
    PreviousEditionRatioAssessment,
    PreviousEditionRatioAssessmentError,
    assess_previous_edition_ratio,
)
from .models import (
    ConferenceRegistry,
    ConferenceSourceAdapter,
    DetectionKind,
    DetectionResult,
    Edition,
    EditionState,
    ErrorCode,
    FetchLimits,
    ProbeObservation,
    ReadinessPhase,
    ReductionAction,
    ReductionResult,
    SourceSnapshot,
)
from .openreview import OpenReviewV2Adapter, SecurePinnedTransport
from .registry import STABLE_PROBE_COUNT, load_registry, plan_editions
from .stability import (
    canonical_state_bytes,
    initial_state,
    observation_from_detection,
    reduce_readiness,
)

__all__ = [
    "STABLE_PROBE_COUNT",
    "ConferenceRegistry",
    "ConferenceSourceAdapter",
    "DetectionKind",
    "DetectionResult",
    "Edition",
    "EditionState",
    "ErrorCode",
    "FetchLimits",
    "OpenReviewV2Adapter",
    "PreviousEditionRatioAssessment",
    "PreviousEditionRatioAssessmentError",
    "ProbeObservation",
    "ReadinessPhase",
    "ReductionAction",
    "ReductionResult",
    "SecurePinnedTransport",
    "SourceSnapshot",
    "assess_previous_edition_ratio",
    "canonical_state_bytes",
    "initial_state",
    "load_registry",
    "observation_from_detection",
    "plan_editions",
    "reduce_readiness",
]

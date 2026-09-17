"""Typed domain objects for the read-only conference release detector."""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Protocol


class ConferenceWatchError(ValueError):
    """Base class for rejected conference-watch input or state."""


class RegistryError(ConferenceWatchError):
    """The curated registry is invalid or attempts to widen the v1 boundary."""


class DetectionKind(str, Enum):
    """Strict adapter result kinds; errors never carry a partial snapshot."""

    SNAPSHOT = "snapshot"
    UNAVAILABLE = "unavailable"
    ERROR = "error"


class ErrorCode(str, Enum):
    """Stable detector/reducer failure taxonomy."""

    REGISTRY_INVALID = "CONF_REGISTRY_INVALID"
    EDITION_OUT_OF_RANGE = "CONF_EDITION_OUT_OF_RANGE"
    SOURCE_UNAVAILABLE = "CONF_SOURCE_UNAVAILABLE"
    SOURCE_RATE_LIMITED = "CONF_SOURCE_RATE_LIMITED"
    SOURCE_TIMEOUT = "CONF_SOURCE_TIMEOUT"
    SOURCE_HTTP_ERROR = "CONF_SOURCE_HTTP_ERROR"
    SOURCE_PARSE_ERROR = "CONF_SOURCE_PARSE_ERROR"
    SOURCE_PARTIAL = "CONF_SOURCE_PARTIAL"
    SOURCE_FINGERPRINT_CHANGED = "CONF_SOURCE_FINGERPRINT_CHANGED"
    COUNT_BELOW_MINIMUM = "CONF_COUNT_BELOW_MINIMUM"
    COUNT_ABOVE_MAXIMUM = "CONF_COUNT_ABOVE_MAXIMUM"
    COUNT_SHRINK = "CONF_COUNT_SHRINK"
    IDENTITY_MISSING = "CONF_IDENTITY_MISSING"
    IDENTITY_CONFLICT = "CONF_IDENTITY_CONFLICT"
    DUPLICATE_ID = "CONF_DUPLICATE_ID"


@dataclass(frozen=True)
class FetchLimits:
    """Hard resource bounds for one complete OpenReview retrieval."""

    page_size: int = 1000
    max_pages: int = 25
    max_notes: int = 25_000
    max_response_bytes: int = 128 * 1024 * 1024
    connect_timeout_seconds: float = 10.0
    read_timeout_seconds: float = 30.0
    request_timeout_seconds: float = 60.0
    job_deadline_seconds: float = 20 * 60.0
    max_retries: int = 3

    def __post_init__(self) -> None:
        integer_limits = {
            "page_size": (self.page_size, 1000),
            "max_pages": (self.max_pages, 25),
            "max_notes": (self.max_notes, 25_000),
            "max_response_bytes": (self.max_response_bytes, 128 * 1024 * 1024),
        }
        for name, (integer_value, integer_ceiling) in integer_limits.items():
            if type(integer_value) is not int or not 1 <= integer_value <= integer_ceiling:
                raise ValueError(f"{name} must be an integer in [1, {integer_ceiling}]")

        timing_limits = {
            "connect_timeout_seconds": (self.connect_timeout_seconds, 10.0),
            "read_timeout_seconds": (self.read_timeout_seconds, 30.0),
            "request_timeout_seconds": (self.request_timeout_seconds, 60.0),
            "job_deadline_seconds": (self.job_deadline_seconds, 20 * 60.0),
        }
        for name, (timing_value, timing_ceiling) in timing_limits.items():
            if (
                type(timing_value) not in {int, float}
                or not math.isfinite(timing_value)
                or not 0 < timing_value <= timing_ceiling
            ):
                raise ValueError(f"{name} must be a finite number in (0, {timing_ceiling}]")
        if type(self.max_retries) is not int or not 0 <= self.max_retries <= 3:
            raise ValueError("max_retries must be an integer in [0, 3]")


@dataclass(frozen=True)
class CountGate:
    minimum_absolute: int
    previous_edition_min_ratio: float
    previous_edition_max_ratio: float


@dataclass(frozen=True)
class TrackPolicy:
    accepted_only: bool
    accepted_decision_labels: tuple[str, ...]
    highlighted_labels: tuple[str, ...]


@dataclass(frozen=True)
class Venue:
    venue_key: str
    enabled: bool
    curated_class: str
    display_template: str
    slug_template: str
    adapter: str
    source_id_template: str
    first_year: int
    active_months_utc: tuple[int, ...]
    count_gate: CountGate
    tracks: TrackPolicy


@dataclass(frozen=True)
class RegistryDefaults:
    probe_interval_hours: int
    stable_min_separation_hours: int
    stable_max_separation_hours: int
    max_future_years: int


@dataclass(frozen=True)
class ConferenceRegistry:
    schema_version: str
    apply_enabled: bool
    defaults: RegistryDefaults
    venues: tuple[Venue, ...]


@dataclass(frozen=True)
class Edition:
    """One bounded edition derived exclusively from a validated registry row."""

    edition_id: str
    venue_key: str
    year: int
    display_name: str
    adapter: str
    source_id: str
    count_gate: CountGate
    tracks: TrackPolicy
    stable_min_separation_hours: int
    stable_max_separation_hours: int


@dataclass(frozen=True)
class NormalizedPaper:
    """Minimal accepted row retained by the immutable source snapshot."""

    source: str
    source_id: str
    paper_id: str
    title: str
    authors: tuple[str, ...]
    abstract: str
    landing_url: str
    pdf_url: str
    decision_label: str

    def fingerprint_fields(self) -> dict[str, Any]:
        """Return exactly the fields included in the source fingerprint."""

        return {
            "source_id": self.source_id,
            "title": self.title,
            "authors": list(self.authors),
            "abstract": self.abstract,
            "landing_url": self.landing_url,
            "pdf_url": self.pdf_url,
            "decision_label": self.decision_label,
        }


@dataclass(frozen=True)
class SourceSnapshot:
    schema_version: str
    edition_id: str
    adapter: str
    adapter_version: str
    source_id: str
    rows: tuple[NormalizedPaper, ...]
    source_fingerprint: str
    unknown_decisions: tuple[tuple[str, int], ...]
    duplicate_title_count: int
    request_count: int
    page_count: int
    response_bytes: int

    @property
    def accepted_count(self) -> int:
        return len(self.rows)


@dataclass(frozen=True)
class DetectionResult:
    """A complete snapshot, an expected absence, or a sanitized typed error."""

    kind: DetectionKind
    snapshot: SourceSnapshot | None = None
    error_code: ErrorCode | None = None

    def __post_init__(self) -> None:
        if self.kind is DetectionKind.SNAPSHOT:
            if self.snapshot is None or self.error_code is not None:
                raise ValueError("snapshot result must carry only a snapshot")
        elif self.snapshot is not None or self.error_code is None:
            raise ValueError("non-snapshot result must carry only an error code")


class ConferenceSourceAdapter(Protocol):
    """Read-only source boundary shared by probes and exact collection."""

    name: str
    version: str

    def probe(self, edition: Edition, limits: FetchLimits = FetchLimits()) -> DetectionResult: ...

    def collect(self, edition: Edition, limits: FetchLimits = FetchLimits()) -> DetectionResult: ...


class ObservationStatus(str, Enum):
    UNAVAILABLE = "unavailable"
    PARTIAL = "partial"
    STABILIZING = "stabilizing"
    ANOMALY = "anomaly"
    FAILED = "failed"


@dataclass(frozen=True)
class ProbeObservation:
    schema_version: str
    edition_id: str
    adapter: str
    adapter_version: str
    source_id: str
    observed_at: datetime
    run_id: str
    http_class: str
    accepted_count: int
    unknown_label_count: int
    source_fingerprint: str | None
    source_ids: tuple[str, ...]
    status: ObservationStatus
    error_code: ErrorCode | None = None


class ReadinessPhase(str, Enum):
    UNAVAILABLE = "unavailable"
    PARTIAL = "partial"
    STABILIZING = "stabilizing"
    READY = "ready"
    PUBLISHED = "published"
    ANOMALY = "anomaly"


@dataclass(frozen=True)
class EditionState:
    edition_id: str
    venue_key: str
    year: int
    phase: ReadinessPhase = ReadinessPhase.UNAVAILABLE
    last_observation: ProbeObservation | None = None
    stable_fingerprint: str | None = None
    stable_observations: int = 0
    stable_since_at: datetime | None = None
    last_qualifying_at: datetime | None = None
    last_qualifying_run_id: str | None = None
    published_fingerprint: str | None = None
    published_count: int | None = None
    published_source_ids: tuple[str, ...] = field(default_factory=tuple)
    last_failure_code: ErrorCode | None = None


class ReductionAction(str, Enum):
    NO_OP = "no_op"
    OBSERVED = "observed"
    READY = "ready"
    ANOMALY = "anomaly"
    FAILED = "failed"


@dataclass(frozen=True)
class ReductionResult:
    state: EditionState
    action: ReductionAction
    reason: ErrorCode | None = None


def public_dict(value: Any) -> dict[str, Any]:
    """Convert a domain dataclass to JSON-compatible values for later CLIs."""

    def convert(item: Any) -> Any:
        if isinstance(item, Enum):
            return item.value
        if isinstance(item, datetime):
            return item.isoformat().replace("+00:00", "Z")
        if isinstance(item, tuple):
            return [convert(part) for part in item]
        if isinstance(item, dict):
            return {key: convert(part) for key, part in item.items()}
        if isinstance(item, list):
            return [convert(part) for part in item]
        return item

    converted = convert(asdict(value))
    if not isinstance(converted, dict):  # pragma: no cover - asdict always returns a dict
        raise TypeError("dataclass serialization did not produce an object")
    return converted

"""Pure, bounded previous-edition checks; never a publication authorization.

Caller-supplied dataclasses are revalidated just like transport input. Catalog
and snapshot rules are reused rather than weakened for the ratio assessment.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import Literal, NoReturn

from paperpilot.replay import canonical_json_bytes

from .candidate import _HASH_RE, _SOURCE_ID_RE, _validate_candidate_snapshot, _validate_edition
from .dry_run import MAX_ROWS, CatalogDryRunError, _validate_catalog
from .models import (
    ConferenceRegistry,
    CountGate,
    Edition,
    EditionState,
    ReadinessPhase,
    RegistryDefaults,
    SourceSnapshot,
    TrackPolicy,
    Venue,
)
from .registry import MAX_REGISTRY_BYTES, _edition, parse_registry

_ERROR_CODES = frozenset(
    "CONF_BASELINE_" + suffix
    for suffix in (
        "INPUT_INVALID",
        "REGISTRY_INVALID",
        "EDITION_MISMATCH",
        "FIRST_EDITION",
        "STATE_INVALID",
        "CATALOG_INVALID",
        "CATALOG_MISMATCH",
        "SNAPSHOT_INVALID",
    )
)


class PreviousEditionRatioAssessmentError(ValueError):
    """A closed error code without caller values or upstream exception text."""

    def __init__(self, code: str) -> None:
        self.code = (
            code if type(code) is str and code in _ERROR_CODES else "CONF_BASELINE_INPUT_INVALID"
        )
        super().__init__(self.code)


def _fail(suffix: str) -> NoReturn:
    raise PreviousEditionRatioAssessmentError("CONF_BASELINE_" + suffix) from None


def _integer(value: object, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        raise ValueError("invalid")
    return value


def _boolean(value: object) -> bool:
    if type(value) is not bool:
        raise ValueError("invalid")
    return value


def _text(value: object, maximum: int = MAX_REGISTRY_BYTES) -> str:
    if type(value) is not str or len(value) > maximum:
        raise ValueError("invalid")
    if len(value.encode("utf-8", errors="strict")) > maximum:
        raise ValueError("invalid")
    return value


def _sequence(value: object, maximum: int) -> tuple[object, ...]:
    if type(value) is not tuple or not 1 <= len(value) <= maximum:
        raise ValueError("invalid")
    return value


def _ratio(value: object) -> float:
    # Compare the bounded plain number before float()/isfinite(): huge ints
    # must never reach conversion, and subclasses cannot run custom methods.
    if type(value) not in (int, float) or not isinstance(value, (int, float)):
        raise ValueError("invalid")
    if not 0 < value <= 10 or not math.isfinite(value):
        raise ValueError("invalid")
    return float(value)


def _gate(value: object) -> dict[str, object]:
    if type(value) is not CountGate:
        raise ValueError("invalid")
    minimum = _ratio(value.previous_edition_min_ratio)
    maximum = _ratio(value.previous_edition_max_ratio)
    if minimum > maximum:
        raise ValueError("invalid")
    return {
        "minimum_absolute": _integer(value.minimum_absolute, 1, MAX_ROWS),
        "previous_edition_min_ratio": minimum,
        "previous_edition_max_ratio": maximum,
    }


def _tracks(value: object) -> dict[str, object]:
    if type(value) is not TrackPolicy:
        raise ValueError("invalid")
    return {
        "accepted_only": _boolean(value.accepted_only),
        "accepted_decision_labels": [
            _text(item, 32) for item in _sequence(value.accepted_decision_labels, 32)
        ],
        "highlighted_labels": [_text(item, 32) for item in _sequence(value.highlighted_labels, 32)],
    }


def _validated_registry(registry: ConferenceRegistry) -> ConferenceRegistry:
    try:
        defaults = registry.defaults
        if type(defaults) is not RegistryDefaults:
            raise ValueError("invalid")
        raw_defaults = {
            "probe_interval_hours": _integer(defaults.probe_interval_hours, 1, 24),
            "stable_min_separation_hours": _integer(defaults.stable_min_separation_hours, 1, 168),
            "stable_max_separation_hours": _integer(defaults.stable_max_separation_hours, 1, 336),
            "max_future_years": _integer(defaults.max_future_years, 0, 1),
        }
        venues = []
        for venue in _sequence(registry.venues, 32):
            if type(venue) is not Venue:
                raise ValueError("invalid")
            venues.append(
                {
                    "venue_key": _text(venue.venue_key),
                    "enabled": _boolean(venue.enabled),
                    "curated_class": _text(venue.curated_class),
                    "display_template": _text(venue.display_template),
                    "slug_template": _text(venue.slug_template),
                    "adapter": _text(venue.adapter),
                    "source_id_template": _text(venue.source_id_template),
                    "first_year": _integer(venue.first_year, 2000, 2100),
                    "active_months_utc": [
                        _integer(month, 1, 12) for month in _sequence(venue.active_months_utc, 12)
                    ],
                    "count_gate": _gate(venue.count_gate),
                    "tracks": _tracks(venue.tracks),
                }
            )
        raw = {
            "schema_version": _text(registry.schema_version),
            "apply_enabled": _boolean(registry.apply_enabled),
            "defaults": raw_defaults,
            "venues": venues,
        }
        if len(canonical_json_bytes(raw)) > MAX_REGISTRY_BYTES:
            raise ValueError("invalid")
        validated: ConferenceRegistry = parse_registry(raw)
        if validated != registry:
            raise ValueError("invalid")
    except (AttributeError, ValueError, TypeError, OverflowError, RecursionError):
        _fail("REGISTRY_INVALID")
    return validated


@dataclass(frozen=True, slots=True)
class _ValidatedPreviousBaseline:
    previous_edition_id: str
    previous_year: int
    previous_count: int
    published_fingerprint: str
    previous_catalog_sha256: str


def _validate_previous_baseline(
    registry: object,
    edition: object,
    previous_state: object,
    *,
    previous_catalog_bytes: object,
) -> _ValidatedPreviousBaseline:
    if (
        type(registry) is not ConferenceRegistry
        or type(edition) is not Edition
        or type(previous_state) is not EditionState
    ):
        _fail("INPUT_INVALID")
    registry = _validated_registry(registry)
    try:
        for value in (
            edition.edition_id,
            edition.venue_key,
            edition.display_name,
            edition.adapter,
            edition.source_id,
        ):
            _text(value)
        _integer(edition.year, 2000, 2100)
        _integer(edition.stable_min_separation_hours, 1, 168)
        _integer(edition.stable_max_separation_hours, 1, 336)
        _gate(edition.count_gate)
        _tracks(edition.tracks)
        _validate_edition(edition)
        matches = [venue for venue in registry.venues if venue.venue_key == edition.venue_key]
        if len(matches) != 1:
            raise ValueError("invalid")
        venue = matches[0]
        if _edition(registry, venue, edition.year, current_year=edition.year) != edition:
            raise ValueError("invalid")
    except (AttributeError, ValueError, TypeError, OverflowError, RecursionError):
        _fail("EDITION_MISMATCH")
    if edition.year == venue.first_year:
        _fail("FIRST_EDITION")
    previous = _edition(registry, venue, edition.year - 1, current_year=edition.year)
    state = previous_state
    try:
        if (
            _text(state.edition_id) != previous.edition_id
            or _text(state.venue_key) != previous.venue_key
            or _integer(state.year, 2000, 2100) != previous.year
            or state.phase is not ReadinessPhase.PUBLISHED
        ):
            raise ValueError("invalid")
        count = _integer(state.published_count, 1, MAX_ROWS)
        ids = tuple(_text(item, 256) for item in _sequence(state.published_source_ids, MAX_ROWS))
        fingerprint = _text(state.published_fingerprint, 64)
        if (
            len(ids) != count
            or len(set(ids)) != count
            or any(_SOURCE_ID_RE.fullmatch(item) is None for item in ids)
            or _HASH_RE.fullmatch(fingerprint) is None
        ):
            raise ValueError("invalid")
    except (AttributeError, ValueError, TypeError, OverflowError, RecursionError):
        _fail("STATE_INVALID")
    try:
        rows = _validate_catalog(previous_catalog_bytes, prefix="previous_catalog")
    except CatalogDryRunError:
        _fail("CATALOG_INVALID")
    if len(rows) != count or {row["source_id"] for row in rows} != set(ids):
        _fail("CATALOG_MISMATCH")
    # The reused catalog validator already requires exact bytes.
    if type(previous_catalog_bytes) is not bytes:
        _fail("CATALOG_INVALID")
    return _ValidatedPreviousBaseline(
        previous.edition_id,
        previous.year,
        count,
        fingerprint,
        hashlib.sha256(previous_catalog_bytes).hexdigest(),
    )


@dataclass(frozen=True, slots=True)
class PreviousEditionRatioAssessment:
    """Local consistency only, not trusted state or permission to publish."""

    status: Literal["passed", "below_minimum", "above_maximum"]
    previous_edition_id: str
    previous_year: int
    previous_count: int
    current_count: int
    effective_minimum: int
    effective_maximum: int
    previous_catalog_sha256: str
    published_fingerprint: str
    current_source_fingerprint: str
    report_bytes: bytes


def assess_previous_edition_ratio(
    registry: ConferenceRegistry,
    edition: Edition,
    snapshot: SourceSnapshot,
    previous_state: EditionState,
    *,
    previous_catalog_bytes: bytes,
) -> PreviousEditionRatioAssessment:
    """Revalidate bounded caller inputs and calculate inclusive count bounds.

    Performs no I/O or state changes. A passed result does not grant readiness,
    provenance, staging, promotion, or publication authority.
    """
    previous = _validate_previous_baseline(
        registry, edition, previous_state, previous_catalog_bytes=previous_catalog_bytes
    )
    try:
        rows, _, _ = _validate_candidate_snapshot(edition, snapshot)
        current_count = len(rows)
    except (AttributeError, ValueError, TypeError, OverflowError, RecursionError):
        _fail("SNAPSHOT_INVALID")
    minimum = max(
        edition.count_gate.minimum_absolute,
        math.floor(previous.previous_count * edition.count_gate.previous_edition_min_ratio),
    )
    maximum = math.ceil(previous.previous_count * edition.count_gate.previous_edition_max_ratio)
    status: Literal["passed", "below_minimum", "above_maximum"] = "passed"
    if current_count < minimum:
        status = "below_minimum"
    elif current_count > maximum:
        status = "above_maximum"
    report = {
        "schema_version": "conference-baseline-assessment-v1",
        "scope": "local_assessment_only",
        "edition_id": edition.edition_id,
        "venue_key": edition.venue_key,
        "year": edition.year,
        "status": status,
        "previous_edition_id": previous.previous_edition_id,
        "previous_year": previous.previous_year,
        "previous_count": previous.previous_count,
        "current_count": current_count,
        "effective_minimum": minimum,
        "effective_maximum": maximum,
        "previous_catalog_sha256": previous.previous_catalog_sha256,
        "published_fingerprint": previous.published_fingerprint,
        "current_source_fingerprint": snapshot.source_fingerprint,
        "authority": {
            "trusted_persistent_state_proof": False,
            "baseline_state_trusted": False,
            "fresh_tip_checked": False,
            "staging_materialized": False,
            "promotion_authorized": False,
            "publication_authorized": False,
        },
    }
    return PreviousEditionRatioAssessment(
        status,
        previous.previous_edition_id,
        previous.previous_year,
        previous.previous_count,
        current_count,
        minimum,
        maximum,
        previous.previous_catalog_sha256,
        previous.published_fingerprint,
        snapshot.source_fingerprint,
        canonical_json_bytes(report),
    )

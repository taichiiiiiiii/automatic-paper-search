"""Pure, local-only catalog candidates from revalidated ready snapshots.

The returned bytes do not prove that the supplied state came from trusted
persistent storage and do not authorize staging, promotion, or publication.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, NoReturn

from paperpilot.identity.source_ids import IdentityError, identity_from_url, make_paper_id
from paperpilot.scripts.build_summary_csv import classify_tags

from .fingerprint import source_fingerprint
from .models import (
    ConferenceWatchError,
    CountGate,
    Edition,
    EditionState,
    ErrorCode,
    NormalizedPaper,
    ObservationStatus,
    ProbeObservation,
    ReadinessPhase,
    SourceSnapshot,
    TrackPolicy,
)
from .openreview import (
    ADAPTER_NAME,
    ADAPTER_VERSION,
    OPENREVIEW_FORUM_URL,
    OPENREVIEW_PDF_URL,
    _normalize_decision,
)
from .registry import STABLE_PROBE_COUNT

_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SOURCE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,256}$")
_FIELD_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,127}$")
_EDITION_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")
_VENUE_RE = re.compile(r"^[a-z0-9-]+$")
_LABEL_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_SOURCE_EDITION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,63}/([0-9]{4})/Conference$")
_MAX_AUTHORS_PER_PAPER = 512
_MAX_PROJECTED_TEXT_BYTES = 128 * 1024 * 1024

_SUMMARY_FIELDS = (
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
)


class CandidateErrorCode(str, Enum):
    """Stable, non-sensitive C3a rejection codes."""

    READINESS_INVALID = "CONF_CANDIDATE_READINESS_INVALID"
    CANDIDATE_MISMATCH = "CONF_CANDIDATE_MISMATCH"
    IDENTITY_INVALID = "CONF_IDENTITY_CONFLICT"
    DUPLICATE_ID = "CONF_DUPLICATE_ID"
    PUBLISHED_CONTINUITY_INVALID = "CONF_COUNT_SHRINK"
    VALIDATION_FAILED = "CONF_VALIDATION_FAILED"


class CandidateValidationError(ConferenceWatchError):
    """A stable error code plus a sanitized field name, never upstream text."""

    def __init__(self, code: CandidateErrorCode, field: str) -> None:
        self.code = code
        self.field = field if _FIELD_RE.fullmatch(field) else "candidate"
        super().__init__(f"{code.value}:{self.field}")


@dataclass(frozen=True)
class CandidateCatalogRow:
    title: str
    paper_type: str
    tags: tuple[str, ...]
    venue: str
    authors: tuple[str, ...]
    landing_url: str
    pdf_url: str
    abstract: str
    arxiv_id: str
    citation_count: int | None
    venue_tier: int | None
    github_stars: int | None
    paper_id: str
    source: str
    source_id: str


@dataclass(frozen=True)
class CandidateDetail:
    paper_id: str
    abstract: str


@dataclass(frozen=True)
class CatalogCandidate:
    """Immutable C3a values and deterministic transport bytes."""

    schema_version: str
    edition_id: str
    source_fingerprint: str
    source_observed_at: str
    readiness_run_id: str
    generation_key: str
    rows: tuple[CandidateCatalogRow, ...]
    details: tuple[CandidateDetail, ...]
    catalog_rows_bytes: bytes
    details_bytes: bytes
    summary_csv_bytes: bytes
    source_quality_bytes: bytes
    run_binding_bytes: bytes


def _fail(code: CandidateErrorCode, field: str) -> NoReturn:
    raise CandidateValidationError(code, field)


def _plain_int(value: object, field: str, *, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        _fail(CandidateErrorCode.VALIDATION_FAILED, field)
    return value


def _finite_ratio(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(CandidateErrorCode.VALIDATION_FAILED, field)
    try:
        finite = math.isfinite(value)
    except (OverflowError, TypeError, ValueError):
        _fail(CandidateErrorCode.VALIDATION_FAILED, field)
    if not finite or not 0 < value <= 10:
        _fail(CandidateErrorCode.VALIDATION_FAILED, field)
    return float(value)


def _text(value: object, field: str, *, required: bool, maximum: int) -> str:
    if not isinstance(value, str):
        _fail(CandidateErrorCode.VALIDATION_FAILED, field)
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        _fail(CandidateErrorCode.VALIDATION_FAILED, field)
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        _fail(CandidateErrorCode.VALIDATION_FAILED, field)
    if value != " ".join(value.split()) or len(value) > maximum or (required and not value):
        _fail(CandidateErrorCode.VALIDATION_FAILED, field)
    return value


def _utc(value: object, field: str) -> datetime:
    if type(value) is not datetime:
        _fail(CandidateErrorCode.READINESS_INVALID, field)
    try:
        if value.tzinfo is None or value.utcoffset() is None:
            _fail(CandidateErrorCode.READINESS_INVALID, field)
        normalized = value.astimezone(timezone.utc)
    except (OverflowError, TypeError, ValueError):
        _fail(CandidateErrorCode.READINESS_INVALID, field)
    return normalized


def _timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _json_bytes(value: Any) -> bytes:
    try:
        text = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError, UnicodeEncodeError):
        _fail(CandidateErrorCode.VALIDATION_FAILED, "candidate.serialization")
    try:
        return (text + "\n").encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        _fail(CandidateErrorCode.VALIDATION_FAILED, "candidate.serialization")


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _validate_edition(edition: Edition) -> None:
    _text(edition.edition_id, "edition.edition_id", required=True, maximum=40)
    if _EDITION_RE.fullmatch(edition.edition_id) is None or edition.edition_id == "daily":
        _fail(CandidateErrorCode.VALIDATION_FAILED, "edition.edition_id")
    _text(edition.venue_key, "edition.venue_key", required=True, maximum=40)
    if _VENUE_RE.fullmatch(edition.venue_key) is None or edition.venue_key == "daily":
        _fail(CandidateErrorCode.VALIDATION_FAILED, "edition.venue_key")
    _plain_int(edition.year, "edition.year", minimum=2000, maximum=2100)
    _text(edition.display_name, "edition.display_name", required=True, maximum=200)
    if edition.adapter != ADAPTER_NAME:
        _fail(CandidateErrorCode.CANDIDATE_MISMATCH, "edition.adapter")
    _text(edition.source_id, "edition.source_id", required=True, maximum=256)
    source_match = _SOURCE_EDITION_RE.fullmatch(edition.source_id)
    if source_match is None or int(source_match.group(1)) != edition.year:
        _fail(CandidateErrorCode.VALIDATION_FAILED, "edition.source_id")
    if type(edition.count_gate) is not CountGate or type(edition.tracks) is not TrackPolicy:
        _fail(CandidateErrorCode.VALIDATION_FAILED, "edition.policy")
    _plain_int(
        edition.count_gate.minimum_absolute,
        "edition.minimum_absolute",
        minimum=1,
        maximum=25_000,
    )
    minimum_ratio = _finite_ratio(
        edition.count_gate.previous_edition_min_ratio, "edition.minimum_ratio"
    )
    maximum_ratio = _finite_ratio(
        edition.count_gate.previous_edition_max_ratio, "edition.maximum_ratio"
    )
    accepted = edition.tracks.accepted_decision_labels
    highlighted = edition.tracks.highlighted_labels
    if (
        maximum_ratio < minimum_ratio
        or edition.tracks.accepted_only is not True
        or not isinstance(accepted, tuple)
        or not 1 <= len(accepted) <= 32
        or any(
            not isinstance(label, str) or _LABEL_RE.fullmatch(label) is None for label in accepted
        )
        or len(set(accepted)) != len(accepted)
        or not isinstance(highlighted, tuple)
        or not 1 <= len(highlighted) <= 32
        or any(
            not isinstance(label, str) or _LABEL_RE.fullmatch(label) is None
            for label in highlighted
        )
        or len(set(highlighted)) != len(highlighted)
        or not set(highlighted).issubset(accepted)
    ):
        _fail(CandidateErrorCode.VALIDATION_FAILED, "edition.policy")
    _plain_int(
        edition.stable_min_separation_hours, "edition.min_separation", minimum=1, maximum=168
    )
    _plain_int(
        edition.stable_max_separation_hours, "edition.max_separation", minimum=1, maximum=336
    )
    if edition.stable_max_separation_hours < edition.stable_min_separation_hours:
        _fail(CandidateErrorCode.VALIDATION_FAILED, "edition.separation")


def _validate_readiness(
    edition: Edition, state: EditionState, snapshot: SourceSnapshot
) -> tuple[datetime, str]:
    if (
        state.edition_id != edition.edition_id
        or state.venue_key != edition.venue_key
        or type(state.year) is not int
        or state.year != edition.year
        or state.phase is not ReadinessPhase.READY
        or type(state.stable_observations) is not int
        or state.stable_observations != STABLE_PROBE_COUNT
        or not isinstance(state.stable_fingerprint, str)
        or _HASH_RE.fullmatch(state.stable_fingerprint) is None
        or state.stable_fingerprint != snapshot.source_fingerprint
    ):
        _fail(CandidateErrorCode.READINESS_INVALID, "readiness.state")
    if state.last_failure_code is not None and type(state.last_failure_code) is not ErrorCode:
        _fail(CandidateErrorCode.READINESS_INVALID, "readiness.last_failure_code")
    first = _utc(state.stable_since_at, "readiness.stable_since_at")
    last = _utc(state.last_qualifying_at, "readiness.last_qualifying_at")
    if not isinstance(state.last_qualifying_run_id, str) or not _RUN_ID_RE.fullmatch(
        state.last_qualifying_run_id
    ):
        _fail(CandidateErrorCode.READINESS_INVALID, "readiness.run_id")
    separation = (last - first).total_seconds() / 3600
    if not edition.stable_min_separation_hours <= separation <= edition.stable_max_separation_hours:
        _fail(CandidateErrorCode.READINESS_INVALID, "readiness.separation")

    observation = state.last_observation
    if type(observation) is not ProbeObservation:
        _fail(CandidateErrorCode.READINESS_INVALID, "readiness.last_observation")
    if (
        not isinstance(observation.source_ids, tuple)
        or len(observation.source_ids) > 25_000
        or any(
            not isinstance(source_id, str) or _SOURCE_ID_RE.fullmatch(source_id) is None
            for source_id in observation.source_ids
        )
        or len(set(observation.source_ids)) != len(observation.source_ids)
    ):
        _fail(CandidateErrorCode.READINESS_INVALID, "readiness.source_ids")
    if (
        observation.schema_version != "conference-probe-observation-v1"
        or not isinstance(observation.run_id, str)
        or _RUN_ID_RE.fullmatch(observation.run_id) is None
        or observation.edition_id != edition.edition_id
        or observation.adapter != edition.adapter
        or observation.adapter_version != snapshot.adapter_version
        or observation.source_id != edition.source_id
        or _utc(observation.observed_at, "readiness.observed_at") < last
    ):
        _fail(CandidateErrorCode.READINESS_INVALID, "readiness.last_observation")
    if observation.status is ObservationStatus.FAILED:
        if (
            observation.http_class != "error"
            or observation.source_fingerprint is not None
            or observation.source_ids != ()
            or type(observation.accepted_count) is not int
            or observation.accepted_count != 0
            or type(observation.error_code) is not ErrorCode
            or state.last_failure_code is not observation.error_code
            or type(observation.unknown_label_count) is not int
            or observation.unknown_label_count != 0
        ):
            _fail(CandidateErrorCode.READINESS_INVALID, "readiness.failure")
    elif (
        observation.status is not ObservationStatus.STABILIZING
        or observation.http_class != "ok"
        or observation.error_code is not None
        or state.last_failure_code is not None
        or observation.source_fingerprint != snapshot.source_fingerprint
        or type(observation.accepted_count) is not int
        or observation.accepted_count != len(snapshot.rows)
        or set(observation.source_ids) != {row.source_id for row in snapshot.rows}
        or len(observation.source_ids) != len(snapshot.rows)
        or type(observation.unknown_label_count) is not int
        or observation.unknown_label_count
        != sum(amount for _, amount in snapshot.unknown_decisions)
    ):
        _fail(CandidateErrorCode.READINESS_INVALID, "readiness.qualifying_observation")
    return last, state.last_qualifying_run_id


def _validate_snapshot_header(edition: Edition, snapshot: SourceSnapshot) -> None:
    if (
        snapshot.schema_version != "conference-source-snapshot-v1"
        or snapshot.edition_id != edition.edition_id
        or snapshot.adapter != edition.adapter
        or snapshot.adapter_version != ADAPTER_VERSION
        or snapshot.source_id != edition.source_id
        or not isinstance(snapshot.source_fingerprint, str)
        or _HASH_RE.fullmatch(snapshot.source_fingerprint) is None
    ):
        _fail(CandidateErrorCode.CANDIDATE_MISMATCH, "snapshot.header")
    if not isinstance(snapshot.rows, tuple) or not 1 <= len(snapshot.rows) <= 25_000:
        _fail(CandidateErrorCode.VALIDATION_FAILED, "snapshot.rows")
    _plain_int(snapshot.request_count, "snapshot.request_count", minimum=1, maximum=100)
    page_count = _plain_int(snapshot.page_count, "snapshot.page_count", minimum=1, maximum=25)
    if snapshot.request_count < page_count:
        _fail(CandidateErrorCode.VALIDATION_FAILED, "snapshot.request_count")
    _plain_int(
        snapshot.response_bytes, "snapshot.response_bytes", minimum=0, maximum=128 * 1024 * 1024
    )
    _plain_int(
        snapshot.duplicate_title_count, "snapshot.duplicate_titles", minimum=0, maximum=24_999
    )
    if (
        not isinstance(snapshot.unknown_decisions, tuple)
        or len(snapshot.unknown_decisions) > 25_000
    ):
        _fail(CandidateErrorCode.VALIDATION_FAILED, "snapshot.unknown_decisions")
    unknown_total = 0
    unknown_labels: list[str] = []
    for entry in snapshot.unknown_decisions:
        if not isinstance(entry, tuple) or len(entry) != 2:
            _fail(CandidateErrorCode.VALIDATION_FAILED, "snapshot.unknown_decisions")
        label, amount = entry
        label = _text(label, "snapshot.unknown_decision", required=True, maximum=1_000)
        if label != label.casefold():
            _fail(CandidateErrorCode.VALIDATION_FAILED, "snapshot.unknown_decision")
        unknown_labels.append(label)
        unknown_total += _plain_int(
            amount, "snapshot.unknown_decision_count", minimum=1, maximum=25_000
        )
    if (
        unknown_labels != sorted(unknown_labels)
        or len(set(unknown_labels)) != len(unknown_labels)
        or unknown_total > len(snapshot.rows)
        or snapshot.duplicate_title_count >= len(snapshot.rows)
    ):
        _fail(CandidateErrorCode.VALIDATION_FAILED, "snapshot.unknown_decisions")


def _validated_rows(
    edition: Edition, snapshot: SourceSnapshot
) -> tuple[tuple[CandidateCatalogRow, ...], tuple[tuple[str, int], ...], int]:
    seen_source_ids: set[str] = set()
    seen_paper_ids: set[str] = set()
    seen_landing_urls: set[str] = set()
    unknown: Counter[str] = Counter()
    projected: list[CandidateCatalogRow] = []
    projected_text_bytes = 0
    for raw in snapshot.rows:
        if type(raw) is not NormalizedPaper:
            _fail(CandidateErrorCode.VALIDATION_FAILED, "snapshot.row")
        if (
            raw.source != "openreview"
            or not isinstance(raw.source_id, str)
            or not _SOURCE_ID_RE.fullmatch(raw.source_id)
        ):
            _fail(CandidateErrorCode.IDENTITY_INVALID, "snapshot.row_identity")
        try:
            expected_paper_id = make_paper_id(raw.source, raw.source_id)
            landing_identity = identity_from_url(raw.landing_url)
        except (IdentityError, TypeError, ValueError):
            _fail(CandidateErrorCode.IDENTITY_INVALID, "snapshot.row_identity")
        if (
            raw.paper_id != expected_paper_id
            or landing_identity.paper_id != expected_paper_id
            or raw.landing_url != f"{OPENREVIEW_FORUM_URL}{raw.source_id}"
            or raw.pdf_url != f"{OPENREVIEW_PDF_URL}{raw.source_id}"
        ):
            _fail(CandidateErrorCode.IDENTITY_INVALID, "snapshot.row_identity")
        if (
            raw.source_id in seen_source_ids
            or raw.paper_id in seen_paper_ids
            or raw.landing_url in seen_landing_urls
        ):
            _fail(CandidateErrorCode.DUPLICATE_ID, "snapshot.row_identity")
        seen_source_ids.add(raw.source_id)
        seen_paper_ids.add(raw.paper_id)
        seen_landing_urls.add(raw.landing_url)

        title = _text(raw.title, "snapshot.title", required=True, maximum=10_000)
        abstract = _text(raw.abstract, "snapshot.abstract", required=False, maximum=100_000)
        decision_label = _text(
            raw.decision_label, "snapshot.decision_label", required=True, maximum=1_000
        )
        if (
            not isinstance(raw.authors, tuple)
            or not 1 <= len(raw.authors) <= _MAX_AUTHORS_PER_PAPER
        ):
            _fail(CandidateErrorCode.IDENTITY_INVALID, "snapshot.authors")
        authors = tuple(
            _text(author, "snapshot.author", required=True, maximum=1_000) for author in raw.authors
        )
        if any("," in author or ";" in author for author in authors):
            _fail(CandidateErrorCode.VALIDATION_FAILED, "snapshot.author_delimiter")
        projected_text_bytes += len(
            "".join((title, abstract, decision_label, *authors)).encode("utf-8")
        )
        if projected_text_bytes > _MAX_PROJECTED_TEXT_BYTES:
            _fail(CandidateErrorCode.VALIDATION_FAILED, "snapshot.text_bytes")
        try:
            decision = _normalize_decision(decision_label, edition.tracks.accepted_decision_labels)
        except (TypeError, ValueError):
            _fail(CandidateErrorCode.VALIDATION_FAILED, "snapshot.decision_label")
        if decision is None:
            unknown[decision_label.casefold()] += 1
        paper_type = "Oral" if decision in edition.tracks.highlighted_labels else "Poster"
        projected.append(
            CandidateCatalogRow(
                title=title,
                paper_type=paper_type,
                tags=tuple(classify_tags(title, abstract)) or ("Other",),
                venue=edition.display_name,
                authors=authors,
                landing_url=raw.landing_url,
                pdf_url=raw.pdf_url,
                abstract=abstract,
                arxiv_id="",
                citation_count=None,
                venue_tier=None,
                github_stars=None,
                paper_id=raw.paper_id,
                source=raw.source,
                source_id=raw.source_id,
            )
        )
    duplicate_titles = sum(
        count - 1 for count in Counter(row.title for row in projected).values() if count > 1
    )
    return (
        tuple(sorted(projected, key=lambda row: row.source_id)),
        tuple(sorted(unknown.items())),
        duplicate_titles,
    )


def _summary_csv(rows: tuple[CandidateCatalogRow, ...]) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=_SUMMARY_FIELDS, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow(
            {
                "title": row.title,
                "type": row.paper_type,
                "tags": " ".join(row.tags),
                "venue": row.venue,
                "authors": "; ".join(row.authors),
                "arxiv_url": row.landing_url,
                "pdf_url": row.pdf_url,
                "abstract": row.abstract,
                "arxiv_id": "",
                "citation_count": "",
                "venue_tier": "",
                "github_stars": "",
                "source": row.source,
                "source_id": row.source_id,
            }
        )
    return stream.getvalue().encode("utf-8")


def _validate_candidate_snapshot(
    edition: Edition,
    snapshot: SourceSnapshot,
) -> tuple[
    tuple[CandidateCatalogRow, ...],
    tuple[tuple[str, int], ...],
    int,
]:
    if type(edition) is not Edition or type(snapshot) is not SourceSnapshot:
        _fail(CandidateErrorCode.VALIDATION_FAILED, "candidate.input")
    _validate_edition(edition)
    _validate_snapshot_header(edition, snapshot)
    rows, unknown_decisions, duplicate_titles = _validated_rows(edition, snapshot)
    if (
        unknown_decisions != snapshot.unknown_decisions
        or duplicate_titles != snapshot.duplicate_title_count
    ):
        _fail(CandidateErrorCode.CANDIDATE_MISMATCH, "snapshot.statistics")
    try:
        recomputed_fingerprint = source_fingerprint(
            adapter_version=snapshot.adapter_version,
            edition_id=snapshot.edition_id,
            source_id=snapshot.source_id,
            rows=snapshot.rows,
        )
    except (TypeError, ValueError, UnicodeEncodeError):
        _fail(CandidateErrorCode.VALIDATION_FAILED, "snapshot.fingerprint")
    if recomputed_fingerprint != snapshot.source_fingerprint:
        _fail(CandidateErrorCode.CANDIDATE_MISMATCH, "snapshot.fingerprint")
    return (rows, unknown_decisions, duplicate_titles)


def build_catalog_candidate(
    edition: Edition,
    readiness: EditionState,
    snapshot: SourceSnapshot,
) -> CatalogCandidate:
    """Revalidate caller-supplied evidence and return deterministic local bytes."""

    if (
        type(edition) is not Edition
        or type(readiness) is not EditionState
        or type(snapshot) is not SourceSnapshot
    ):
        _fail(CandidateErrorCode.VALIDATION_FAILED, "candidate.input")
    rows, unknown_decisions, duplicate_titles = _validate_candidate_snapshot(edition, snapshot)
    if len(rows) < edition.count_gate.minimum_absolute:
        _fail(CandidateErrorCode.READINESS_INVALID, "readiness.count")
    observed_at, readiness_run_id = _validate_readiness(edition, readiness, snapshot)

    if (
        not isinstance(readiness.published_source_ids, tuple)
        or len(readiness.published_source_ids) > 25_000
    ):
        _fail(CandidateErrorCode.PUBLISHED_CONTINUITY_INVALID, "readiness.published_source_ids")
    published_fields_present = (
        readiness.published_fingerprint is not None,
        readiness.published_count is not None,
        bool(readiness.published_source_ids),
    )
    if any(published_fields_present) and not all(published_fields_present):
        _fail(CandidateErrorCode.PUBLISHED_CONTINUITY_INVALID, "readiness.published_evidence")
    if readiness.published_count is not None:
        published_count = _plain_int(
            readiness.published_count, "readiness.published_count", minimum=0, maximum=25_000
        )
        if (
            not isinstance(readiness.published_source_ids, tuple)
            or any(
                not isinstance(source_id, str) or _SOURCE_ID_RE.fullmatch(source_id) is None
                for source_id in readiness.published_source_ids
            )
            or len(set(readiness.published_source_ids)) != len(readiness.published_source_ids)
            or published_count != len(readiness.published_source_ids)
            or len(rows) < published_count
            or not set(readiness.published_source_ids).issubset({row.source_id for row in rows})
        ):
            _fail(
                CandidateErrorCode.PUBLISHED_CONTINUITY_INVALID,
                "readiness.published_continuity",
            )
    if readiness.published_fingerprint is not None and (
        not isinstance(readiness.published_fingerprint, str)
        or _HASH_RE.fullmatch(readiness.published_fingerprint) is None
    ):
        _fail(CandidateErrorCode.PUBLISHED_CONTINUITY_INVALID, "readiness.published_fingerprint")

    source_observed_at = _timestamp(observed_at)
    generation_key = _sha256(
        _json_bytes(
            {
                "schema_version": "conference-catalog-generation-key-v1",
                "edition_id": edition.edition_id,
                "source_fingerprint": snapshot.source_fingerprint,
            }
        )
    )
    details = tuple(
        CandidateDetail(row.paper_id, row.abstract)
        for row in sorted(rows, key=lambda row: row.paper_id)
    )
    catalog_rows_bytes = _json_bytes(
        {
            "schema_version": "conference-catalog-rows-v1",
            "edition_id": edition.edition_id,
            "source_fingerprint": snapshot.source_fingerprint,
            "source_observed_at": source_observed_at,
            "rows": [asdict(row) for row in rows],
        }
    )
    details_bytes = _json_bytes(
        {
            "schema_version": "conference-candidate-details-v1",
            "edition_id": edition.edition_id,
            "source_fingerprint": snapshot.source_fingerprint,
            "papers": [[detail.paper_id, detail.abstract] for detail in details],
        }
    )
    summary_csv_bytes = _summary_csv(rows)
    source_quality_bytes = _json_bytes(
        {
            "schema_version": "conference-source-quality-v1",
            "status": "local_checks_passed",
            "scope": "local_candidate_only",
            "edition_id": edition.edition_id,
            "adapter": snapshot.adapter,
            "adapter_version": snapshot.adapter_version,
            "source_id": snapshot.source_id,
            "source_fingerprint": snapshot.source_fingerprint,
            "source_observed_at": source_observed_at,
            "accepted_count": len(snapshot.rows),
            "projected_count": len(rows),
            "identity_resolved_count": len(rows),
            "identity_coverage": 1.0,
            "duplicate_title_count": duplicate_titles,
            "unknown_decision_count": sum(amount for _, amount in unknown_decisions),
            "unknown_decisions": [list(item) for item in unknown_decisions],
            "gates": {
                "readiness": "passed",
                "snapshot_binding": "passed",
                "identity": "passed",
                "minimum_absolute": "passed",
                "previous_edition_ratio": "not_checked",
                "first_edition_human_dry_run": "not_checked",
                "published_continuity": "passed",
            },
        }
    )
    outputs = {
        "catalog_rows": catalog_rows_bytes,
        "details": details_bytes,
        "summary_csv": summary_csv_bytes,
        "source_quality": source_quality_bytes,
    }
    run_binding_bytes = _json_bytes(
        {
            "schema_version": "conference-candidate-run-binding-v1",
            "scope": "local_candidate_only",
            "edition_id": edition.edition_id,
            "source_fingerprint": snapshot.source_fingerprint,
            "source_observed_at": source_observed_at,
            "readiness_run_id": readiness_run_id,
            "generation_key": generation_key,
            "trusted_persistent_state_proof": False,
            "promotion_authorized": False,
            "publication_authorized": False,
            "outputs": {
                name: {"sha256": _sha256(payload), "size_bytes": len(payload)}
                for name, payload in sorted(outputs.items())
            },
        }
    )
    return CatalogCandidate(
        schema_version="conference-catalog-candidate-v1",
        edition_id=edition.edition_id,
        source_fingerprint=snapshot.source_fingerprint,
        source_observed_at=source_observed_at,
        readiness_run_id=readiness_run_id,
        generation_key=generation_key,
        rows=rows,
        details=details,
        catalog_rows_bytes=catalog_rows_bytes,
        details_bytes=details_bytes,
        summary_csv_bytes=summary_csv_bytes,
        source_quality_bytes=source_quality_bytes,
        run_binding_bytes=run_binding_bytes,
    )

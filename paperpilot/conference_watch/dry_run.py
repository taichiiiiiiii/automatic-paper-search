"""Pure comparison of a C3 conference candidate with a supplied local baseline.

This module produces review artifacts only.  It does not read or write files and
does not grant staging, promotion, or publication authority.
"""

from __future__ import annotations

import hashlib
import json
import unicodedata
from dataclasses import dataclass
from typing import NoReturn

from paperpilot.identity.source_ids import IdentityError, identity_from_url
from paperpilot.replay import canonical_json_bytes, strict_json_loads
from paperpilot.scripts.build_pages import _abstract_preview

from .candidate import CandidateValidationError, CatalogCandidate, build_catalog_candidate
from .models import Edition, EditionState, SourceSnapshot

MAX_CATALOG_BYTES = 16 * 1024 * 1024
MAX_DETAILS_BYTES = 128 * 1024 * 1024
MAX_REPORT_BYTES = 16 * 1024 * 1024
MAX_STAGING_PLAN_BYTES = 16 * 1024 * 1024
MAX_ROWS = 25_000

_MAX_TITLE_CHARS = 2_048
_MAX_ABSTRACT_CHARS = 2_048
_MAX_DETAIL_ABSTRACT_CHARS = 200_000
_MAX_URL_CHARS = 4_096
_MAX_SCALAR_CHARS = 512
_MAX_TAGS = 128
_MAX_TAG_CHARS = 128
_MAX_AUTHORS = 512
_MAX_AUTHOR_CHARS = 512
_MAX_METRIC = 2**53 - 1

_CATALOG_KEYS = frozenset(
    {
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
        "paper_id",
        "source",
        "source_id",
    }
)
_AUTHORITY = {
    "trusted_persistent_state_proof": False,
    "baseline_state_trusted": False,
    "fresh_tip_checked": False,
    "staging_materialized": False,
    "promotion_authorized": False,
    "publication_authorized": False,
}
_REQUIRED_REGENERATION = [
    "catalog_date",
    "paper_links",
    "conferences_index",
    "identity_aliases_and_coverage",
    "search_indexes_and_id_blocks",
    "full_detail_shards",
    "lineage_quality",
    "asset_versions",
]


class CatalogDryRunError(ValueError):
    """A stable, sanitized local dry-run rejection."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class CatalogUpdateDryRun:
    """Immutable bytes produced by a local-only catalog comparison."""

    outcome: str
    candidate_catalog_bytes: bytes
    report_bytes: bytes
    staging_plan_bytes: bytes
    catalog_rows_bytes: bytes
    details_bytes: bytes
    summary_csv_bytes: bytes
    source_quality_bytes: bytes
    run_binding_bytes: bytes


def _fail(code: str) -> NoReturn:
    raise CatalogDryRunError(code) from None


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _parse_json(payload: object, *, prefix: str, maximum: int) -> object:
    if type(payload) is not bytes:
        _fail(f"{prefix}_bytes_required")
    if not payload or len(payload) > maximum:
        _fail(f"{prefix}_size")
    try:
        text = payload.decode("utf-8", errors="strict")
        if text.startswith("\ufeff"):
            _fail(f"{prefix}_invalid")
        value = strict_json_loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, TypeError, ValueError):
        _fail(f"{prefix}_invalid")
    return value


def _text(
    value: object,
    *,
    maximum: int,
    required: bool = False,
    abstract: bool = False,
) -> str | None:
    if type(value) is not str or len(value) > maximum or (required and not value):
        return None
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        return None
    for character in value:
        if unicodedata.category(character) == "Cc" and not (abstract and character in "\t\n\r"):
            return None
    return value


def _metric(value: object) -> bool:
    return value is None or (type(value) is int and 0 <= value <= _MAX_METRIC)


def _validate_row(row: object, *, prefix: str) -> dict[str, object]:
    if type(row) is not dict or set(row) != _CATALOG_KEYS:
        _fail(f"{prefix}_row_invalid")

    scalar_limits = {
        "title": (_MAX_TITLE_CHARS, True, False),
        "venue": (_MAX_SCALAR_CHARS, True, False),
        "arxiv_url": (_MAX_URL_CHARS, True, False),
        "pdf_url": (_MAX_URL_CHARS, True, False),
        "abstract": (_MAX_ABSTRACT_CHARS, False, True),
        "arxiv_id": (_MAX_SCALAR_CHARS, False, False),
        "paper_id": (_MAX_SCALAR_CHARS, True, False),
        "source": (_MAX_SCALAR_CHARS, True, False),
        "source_id": (_MAX_SCALAR_CHARS, True, False),
    }
    for field, (maximum, required, abstract) in scalar_limits.items():
        if _text(row[field], maximum=maximum, required=required, abstract=abstract) is None:
            _fail(f"{prefix}_row_invalid")
    if type(row["type"]) is not str or row["type"] not in {"Oral", "Poster"}:
        _fail(f"{prefix}_row_invalid")

    tags = row["tags"]
    if (
        type(tags) is not list
        or len(tags) > _MAX_TAGS
        or any(_text(item, maximum=_MAX_TAG_CHARS, required=True) is None for item in tags)
    ):
        _fail(f"{prefix}_row_invalid")
    authors = row["authors"]
    if (
        type(authors) is not list
        or not 1 <= len(authors) <= _MAX_AUTHORS
        or any(_text(item, maximum=_MAX_AUTHOR_CHARS, required=True) is None for item in authors)
    ):
        _fail(f"{prefix}_row_invalid")
    if any(not _metric(row[field]) for field in ("citation_count", "venue_tier", "github_stars")):
        _fail(f"{prefix}_row_invalid")

    source_id = row["source_id"]
    assert isinstance(source_id, str)
    forum_url = f"https://openreview.net/forum?id={source_id}"
    pdf_url = f"https://openreview.net/pdf?id={source_id}"
    if (
        row["source"] != "openreview"
        or row["arxiv_id"] != ""
        or row["arxiv_url"] != forum_url
        or row["pdf_url"] != pdf_url
    ):
        _fail(f"{prefix}_identity_invalid")
    try:
        identity = identity_from_url(forum_url)
    except (IdentityError, TypeError, ValueError):
        _fail(f"{prefix}_identity_invalid")
    if (
        identity.source != row["source"]
        or identity.source_id != source_id
        or identity.paper_id != row["paper_id"]
    ):
        _fail(f"{prefix}_identity_invalid")
    return row


def _validate_catalog(payload: object, *, prefix: str) -> list[dict[str, object]]:
    value = _parse_json(payload, prefix=prefix, maximum=MAX_CATALOG_BYTES)
    if type(value) is not list or not 1 <= len(value) <= MAX_ROWS:
        _fail(f"{prefix}_shape")
    rows = [_validate_row(row, prefix=prefix) for row in value]
    paper_ids = [row["paper_id"] for row in rows]
    source_ids = [row["source_id"] for row in rows]
    if len(set(paper_ids)) != len(rows) or len(set(source_ids)) != len(rows):
        _fail(f"{prefix}_duplicate_id")
    return rows


def _validate_details(
    payload: object,
    *,
    edition_id: str,
    current_rows: list[dict[str, object]],
) -> dict[str, str]:
    value = _parse_json(payload, prefix="current_details", maximum=MAX_DETAILS_BYTES)
    if type(value) is not dict or set(value) != {"schema_version", "edition_id", "papers"}:
        _fail("current_details_shape")
    if value["schema_version"] != "conference-current-details-v1":
        _fail("current_details_shape")
    if value["edition_id"] != edition_id:
        _fail("current_details_edition")
    papers = value["papers"]
    if type(papers) is not list or len(papers) > MAX_ROWS:
        _fail("current_details_shape")

    details: dict[str, str] = {}
    for item in papers:
        if type(item) is not list or len(item) != 2:
            _fail("current_details_row_invalid")
        paper_id = _text(item[0], maximum=_MAX_SCALAR_CHARS, required=True)
        abstract = _text(item[1], maximum=_MAX_DETAIL_ABSTRACT_CHARS, abstract=True)
        if paper_id is None or abstract is None:
            _fail("current_details_row_invalid")
        if paper_id in details:
            _fail("current_details_duplicate_id")
        details[paper_id] = abstract

    current_by_id = {str(row["paper_id"]): row for row in current_rows}
    if set(details) != set(current_by_id):
        _fail("current_details_id_set")
    if any(
        current_by_id[paper_id]["abstract"] != _abstract_preview(abstract)
        for paper_id, abstract in details.items()
    ):
        _fail("current_details_preview_mismatch")
    return details


def _project_candidate(candidate: CatalogCandidate) -> list[dict[str, object]]:
    return [
        {
            "title": row.title,
            "type": row.paper_type,
            "tags": list(row.tags),
            "venue": row.venue,
            "authors": list(row.authors),
            "arxiv_url": row.landing_url,
            "pdf_url": row.pdf_url,
            "abstract": _abstract_preview(row.abstract),
            "arxiv_id": row.arxiv_id,
            "citation_count": row.citation_count,
            "venue_tier": row.venue_tier,
            "github_stars": row.github_stars,
            "paper_id": row.paper_id,
            "source": row.source,
            "source_id": row.source_id,
        }
        for row in candidate.rows
    ]


def _artifact_binding(payload: bytes) -> dict[str, object]:
    return {"sha256": _sha256(payload), "size_bytes": len(payload)}


def _bounded_canonical(value: object, *, maximum: int, code: str) -> bytes:
    try:
        payload: bytes = canonical_json_bytes(value)
    except (RecursionError, TypeError, ValueError, UnicodeEncodeError):
        _fail(code)
    if len(payload) > maximum:
        _fail(code)
    return payload


def build_catalog_update_dry_run(
    edition: Edition,
    readiness: EditionState,
    snapshot: SourceSnapshot,
    *,
    current_catalog_bytes: bytes,
    current_details_bytes: bytes | None = None,
) -> CatalogUpdateDryRun:
    """Build deterministic review bytes without touching local or remote state."""

    try:
        candidate = build_catalog_candidate(edition, readiness, snapshot)
    except CandidateValidationError as error:
        _fail(error.code.value)

    current_rows = _validate_catalog(current_catalog_bytes, prefix="current_catalog")
    public_rows = _project_candidate(candidate)
    try:
        candidate_catalog_bytes = json.dumps(
            public_rows, ensure_ascii=False, indent=0, allow_nan=False
        ).encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeEncodeError):
        _fail("candidate_catalog_invalid")
    candidate_rows = _validate_catalog(candidate_catalog_bytes, prefix="candidate_catalog")

    current_details: dict[str, str] | None = None
    if current_details_bytes is not None:
        current_details = _validate_details(
            current_details_bytes,
            edition_id=candidate.edition_id,
            current_rows=current_rows,
        )

    current_by_id = {str(row["paper_id"]): row for row in current_rows}
    candidate_by_id = {str(row["paper_id"]): row for row in candidate_rows}
    current_ids = set(current_by_id)
    candidate_ids = set(candidate_by_id)
    common_ids = current_ids & candidate_ids
    metadata_changed = []
    unchanged = []
    for paper_id in sorted(common_ids):
        fields = sorted(
            field
            for field in _CATALOG_KEYS
            if current_by_id[paper_id][field] != candidate_by_id[paper_id][field]
        )
        if fields:
            metadata_changed.append({"paper_id": paper_id, "fields": fields})
        else:
            unchanged.append(paper_id)

    full_abstract_changed: list[str] = []
    if current_details is not None:
        candidate_details = {detail.paper_id: detail.abstract for detail in candidate.details}
        full_abstract_changed = sorted(
            paper_id
            for paper_id in common_ids
            if current_details[paper_id] != candidate_details[paper_id]
        )
    added = sorted(candidate_ids - current_ids)
    removed = sorted(current_ids - candidate_ids)
    catalog_bytes_changed = current_catalog_bytes != candidate_catalog_bytes
    order_changed = current_ids == candidate_ids and [row["paper_id"] for row in current_rows] != [
        row["paper_id"] for row in candidate_rows
    ]

    if removed:
        outcome = "blocked"
        changed: bool | None = True
    elif catalog_bytes_changed or full_abstract_changed:
        outcome = "changes_detected"
        changed = True
    elif current_details is None:
        outcome = "indeterminate"
        changed = None
    else:
        outcome = "no_change"
        changed = False

    blockers = ["catalog_date_projection_unresolved", "shared_projection_not_materialized"]
    if removed:
        blockers.append("current_catalog_removal_detected")
    blockers.sort()
    artifacts = {
        "candidate_catalog": _artifact_binding(candidate_catalog_bytes),
        "catalog_rows": _artifact_binding(candidate.catalog_rows_bytes),
        "details": _artifact_binding(candidate.details_bytes),
        "summary_csv": _artifact_binding(candidate.summary_csv_bytes),
        "source_quality": _artifact_binding(candidate.source_quality_bytes),
        "run_binding": _artifact_binding(candidate.run_binding_bytes),
    }
    delta = {
        "added": added,
        "removed": removed,
        "metadata_changed": metadata_changed,
        "unchanged": unchanged,
        "full_abstract_changed": full_abstract_changed,
        "catalog_bytes_changed": catalog_bytes_changed,
        "order_changed": order_changed,
    }
    report = {
        "schema_version": "conference-catalog-dry-run-v1",
        "scope": "local_dry_run_only",
        "edition_id": candidate.edition_id,
        "source_fingerprint": candidate.source_fingerprint,
        "source_observed_at": candidate.source_observed_at,
        "current_catalog_sha256": _sha256(current_catalog_bytes),
        "current_details_sha256": (
            _sha256(current_details_bytes) if current_details_bytes is not None else None
        ),
        "generation_key": candidate.generation_key,
        "run_binding_sha256": _sha256(candidate.run_binding_bytes),
        "counts": {
            "current": len(current_rows),
            "candidate": len(candidate_rows),
            "added": len(added),
            "removed": len(removed),
            "metadata_changed": len(metadata_changed),
            "unchanged": len(unchanged),
            "full_abstract_changed": len(full_abstract_changed),
        },
        "delta": delta,
        "changed": changed,
        "outcome": outcome,
        "detail_comparison": "complete" if current_details is not None else "not_checked",
        "errors": [],
        "blockers": blockers,
        "gates": {
            "previous_edition_ratio": "not_checked",
            "first_edition_human_dry_run": "not_checked",
        },
        "authority": _AUTHORITY,
        "artifacts": artifacts,
    }
    report_bytes = _bounded_canonical(report, maximum=MAX_REPORT_BYTES, code="report_size")

    statuses = {
        "changes_detected": "planned_not_materialized",
        "no_change": "not_required",
        "blocked": "blocked",
        "indeterminate": "blocked",
    }
    repository_candidates = []
    if outcome == "changes_detected":
        repository_candidates = [
            {
                "path": f"docs/{candidate.edition_id}/papers.json",
                **_artifact_binding(candidate_catalog_bytes),
            },
            {
                "path": f"paperpilot/output/{candidate.edition_id}/summary.csv",
                **_artifact_binding(candidate.summary_csv_bytes),
            },
        ]
    plan = {
        "schema_version": "conference-catalog-staging-plan-v1",
        "scope": "local_dry_run_only",
        "status": statuses[outcome],
        "edition_id": candidate.edition_id,
        "source_fingerprint": candidate.source_fingerprint,
        "generation_key": candidate.generation_key,
        "outcome": outcome,
        "report": _artifact_binding(report_bytes),
        "repository_candidates": repository_candidates,
        "artifact_only": ["catalog_rows", "details", "source_quality", "run_binding"],
        "required_regeneration": _REQUIRED_REGENERATION,
        "blockers": blockers,
        "authority": _AUTHORITY,
    }
    staging_plan_bytes = _bounded_canonical(
        plan, maximum=MAX_STAGING_PLAN_BYTES, code="staging_plan_size"
    )
    return CatalogUpdateDryRun(
        outcome=outcome,
        candidate_catalog_bytes=candidate_catalog_bytes,
        report_bytes=report_bytes,
        staging_plan_bytes=staging_plan_bytes,
        catalog_rows_bytes=candidate.catalog_rows_bytes,
        details_bytes=candidate.details_bytes,
        summary_csv_bytes=candidate.summary_csv_bytes,
        source_quality_bytes=candidate.source_quality_bytes,
        run_binding_bytes=candidate.run_binding_bytes,
    )

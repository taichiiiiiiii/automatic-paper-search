"""Pure intake of private human answers bound to a factory review bundle.

This module records only supplied, self-declared review answers.  It does not
authenticate reviewers, prove blinding, adjudicate disagreements, build audit
fixtures or quality manifests, update artifacts, or authorize publication.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal, NoReturn, cast

from paperpilot.replay import canonical_json_bytes, strict_json_loads
from paperpilot.scripts._lineage_contract_v2 import COMPARISON, GENEALOGY

from .review_prep import validated_private_review_files

ReviewStatus = Literal["pending", "complete", "disagreement"]

INTAKE_VERSION = "lineage-private-review-intake-v1"
REVIEW_IDENTITY_BOUNDARY = "self_declared_reviewers_and_blinding_not_authenticated"
MAX_ANSWER_BYTES = 16 * 1024 * 1024
MAX_TOTAL_ANSWER_BYTES = 32 * 1024 * 1024
MAX_RESULT_BYTES = 16 * 1024 * 1024
MAX_ANSWER_JSON_DEPTH = 64
MAX_CANDIDATES = 256

_REVIEWER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_RESPONSE_FIELDS = (
    "reviewer_id",
    "blind_to_model",
    "blind_to_peer",
    "citation_valid",
    "gold_family",
    "gold_relation",
    "evidence_support",
    "notes",
    "reviewed_at",
)
_RESPONSE_FIELD_SET = frozenset(_RESPONSE_FIELDS)
_NULL_RESPONSE = {field: None for field in _RESPONSE_FIELDS}
_AGREEMENT_FIELDS = (
    "citation_valid",
    "gold_family",
    "gold_relation",
    "evidence_support",
)
_SUPPORT_VALUES = frozenset({"supports", "insufficient", "conflicts"})


class ReviewIntakeError(ValueError):
    """A stable, non-sensitive failure at the private answer boundary."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _fail(code: str) -> NoReturn:
    raise ReviewIntakeError(code) from None


@dataclass(frozen=True)
class PrivateReviewIntake:
    """Immutable private result bytes and summary-safe intake state."""

    status: ReviewStatus
    candidate_count: int
    dual_reviewed_count: int
    pending_review_ids: tuple[str, ...]
    disagreement_review_ids: tuple[str, ...]
    result_bytes: bytes
    result_sha256: str


def _validate_depth(value: object) -> None:
    stack: list[tuple[object, int]] = [(value, 1)]
    while stack:
        item, depth = stack.pop()
        if depth > MAX_ANSWER_JSON_DEPTH:
            _fail("answer_depth")
        if type(item) is dict:
            stack.extend((child, depth + 1) for child in cast(dict[str, object], item).values())
        elif type(item) is list:
            stack.extend((child, depth + 1) for child in cast(list[object], item))


def _load_answer(payload: bytes) -> dict[str, Any]:
    if payload.startswith(b"\xef\xbb\xbf"):
        _fail("answer_invalid")
    try:
        text = payload.decode("utf-8", errors="strict")
        value = strict_json_loads(text)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail("answer_invalid")
    if type(value) is not dict:
        _fail("answer_shape")
    return cast(dict[str, Any], value)


def _load_original(payload: bytes) -> dict[str, Any]:
    try:
        value = strict_json_loads(payload.decode("utf-8", errors="strict"))
        if type(value) is not dict or canonical_json_bytes(value) != payload:
            _fail("original_bundle_invalid")
    except ReviewIntakeError:
        raise
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail("original_bundle_invalid")
    return cast(dict[str, Any], value)


def _parse_timestamp(value: object, code: str) -> datetime:
    if type(value) is not str or len(value) > 64 or "T" not in value:
        _fail(code)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            _fail(code)
        return parsed.astimezone(timezone.utc)
    except ReviewIntakeError:
        raise
    except (OverflowError, TypeError, ValueError):
        _fail(code)


def _valid_notes(value: object) -> bool:
    if type(value) is not str or len(value) > 4_000:
        return False
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        return False
    return all(
        character in "\t\n\r" or unicodedata.category(character) != "Cc" for character in value
    )


def _validate_response(
    value: object,
    *,
    created_at: datetime,
    incorporated_at: datetime,
) -> dict[str, object] | None:
    if type(value) is not dict or set(value) != _RESPONSE_FIELD_SET:
        _fail("response_shape")
    response = cast(dict[str, object], value)
    if all(response[field] is None for field in _RESPONSE_FIELDS):
        return None

    reviewer_id = response["reviewer_id"]
    family = response["gold_family"]
    relation = response["gold_relation"]
    reviewed_at = response["reviewed_at"]
    if (
        type(reviewer_id) is not str
        or _REVIEWER_ID_RE.fullmatch(reviewer_id) is None
        or response["blind_to_model"] is not True
        or response["blind_to_peer"] is not True
        or type(response["citation_valid"]) is not bool
        or not (family is None or (type(family) is str and family in {"genealogy", "comparison"}))
        or not (relation is None or (type(relation) is str and relation in GENEALOGY | COMPARISON))
        or (family is None) != (relation is None)
        or (family == "genealogy" and relation not in GENEALOGY)
        or (family == "comparison" and relation not in COMPARISON)
        or type(response["evidence_support"]) is not str
        or response["evidence_support"] not in _SUPPORT_VALUES
        or not _valid_notes(response["notes"])
    ):
        _fail("response_invalid")
    reviewed = _parse_timestamp(reviewed_at, "response_invalid")
    if reviewed < created_at or reviewed > incorporated_at:
        _fail("response_invalid")
    return {field: response[field] for field in _RESPONSE_FIELDS}


def _original_candidates(pack: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = pack.get("candidates")
    if (
        type(candidates) is not list
        or not candidates
        or len(candidates) > MAX_CANDIDATES
        or pack.get("candidate_count") != len(candidates)
    ):
        _fail("original_bundle_invalid")
    parsed: list[dict[str, Any]] = []
    seen: set[str] = set()
    for candidate in candidates:
        if type(candidate) is not dict or set(candidate) != {
            "review_id",
            "src",
            "dst",
            "evidence_sha256",
            "evidence",
            "response",
        }:
            _fail("original_bundle_invalid")
        review_id = candidate.get("review_id")
        if type(review_id) is not str or review_id in seen:
            _fail("original_bundle_invalid")
        response = candidate.get("response")
        if type(response) is not dict or response != _NULL_RESPONSE:
            _fail("original_bundle_invalid")
        seen.add(review_id)
        parsed.append(cast(dict[str, Any], candidate))
    return parsed


def _validate_originals(
    *,
    coordinator: dict[str, Any],
    pack_a: dict[str, Any],
    pack_b: dict[str, Any],
) -> tuple[list[dict[str, Any]], datetime]:
    candidates_a = _original_candidates(pack_a)
    candidates_b = _original_candidates(pack_b)
    coordinator_candidates = coordinator.get("candidates")
    coordinator_bindings = coordinator.get("bindings")
    if (
        type(coordinator_candidates) is not list
        or len(coordinator_candidates) != len(candidates_a)
        or type(coordinator_bindings) is not dict
        or type(coordinator_bindings.get("source_snapshots")) is not list
        or pack_a.get("reviewer_slot") != "a"
        or pack_b.get("reviewer_slot") != "b"
    ):
        _fail("original_bundle_invalid")
    common_fields = (
        "fixture_id",
        "created_at",
        "collection_id",
        "release_id",
        "evidence_boundary",
        "bindings",
        "candidate_count",
    )
    if any(pack_a.get(field) != pack_b.get(field) for field in common_fields):
        _fail("original_bundle_invalid")
    if any(
        coordinator.get(field) != pack_a.get(field)
        for field in (
            "fixture_id",
            "created_at",
            "collection_id",
            "release_id",
            "evidence_boundary",
        )
    ) or any(
        coordinator_bindings.get(field) != pack_a.get("bindings", {}).get(field)
        for field in ("artifact_sha256", "catalog_sha256", "candidate_snapshot_sha256")
    ):
        _fail("original_bundle_invalid")
    seen: set[str] = set()
    for original_a, original_b, coordinator_candidate in zip(
        candidates_a, candidates_b, coordinator_candidates, strict=True
    ):
        if type(coordinator_candidate) is not dict:
            _fail("original_bundle_invalid")
        review_id = original_a["review_id"]
        src = original_a.get("src")
        dst = original_a.get("dst")
        if (
            review_id in seen
            or original_b.get("review_id") != review_id
            or original_b.get("evidence_sha256") != original_a.get("evidence_sha256")
            or type(src) is not dict
            or type(dst) is not dict
            or coordinator_candidate.get("review_id") != review_id
            or coordinator_candidate.get("src") != src.get("node_id")
            or coordinator_candidate.get("dst") != dst.get("node_id")
            or coordinator_candidate.get("evidence_sha256") != original_a.get("evidence_sha256")
        ):
            _fail("original_bundle_invalid")
        seen.add(review_id)
    return candidates_a, _parse_timestamp(pack_a.get("created_at"), "original_bundle_invalid")


def _parse_answer(
    payload: bytes | None,
    *,
    original_bytes: bytes,
    original_pack: dict[str, Any],
    original_candidates: list[dict[str, Any]],
    created_at: datetime,
    incorporated_at: datetime,
) -> tuple[list[dict[str, object] | None], str | None, str | None]:
    if payload is None:
        return [None] * len(original_candidates), None, None
    answer = _load_answer(payload)
    if set(answer) != set(original_pack):
        _fail("answer_shape")
    candidates = answer.get("candidates")
    if (
        type(candidates) is not list
        or len(candidates) > MAX_CANDIDATES
        or len(candidates) != len(original_candidates)
    ):
        _fail("answer_shape")
    for candidate, original in zip(candidates, original_candidates, strict=True):
        if type(candidate) is not dict or set(candidate) != set(original):
            _fail("answer_shape")

    # Reject invalid outer envelopes before walking or canonicalizing their
    # potentially wide contents. Parsing remains bounded by the byte ceiling.
    _validate_depth(answer)
    try:
        canonical_json_bytes(answer)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail("answer_invalid")

    responses: list[dict[str, object] | None] = []
    masked_candidates: list[dict[str, Any]] = []
    reviewer_ids: set[str] = set()
    for candidate in candidates:
        response = _validate_response(
            candidate.get("response"),
            created_at=created_at,
            incorporated_at=incorporated_at,
        )
        if response is not None:
            reviewer_id = response["reviewer_id"]
            if type(reviewer_id) is not str:
                _fail("response_invalid")
            reviewer_ids.add(reviewer_id)
        responses.append(response)
        masked_candidate = dict(candidate)
        masked_candidate["response"] = dict(_NULL_RESPONSE)
        masked_candidates.append(masked_candidate)
    if len(reviewer_ids) > 1:
        _fail("reviewer_panel_invalid")

    masked_pack = dict(answer)
    masked_pack["candidates"] = masked_candidates
    try:
        if canonical_json_bytes(masked_pack) != original_bytes:
            _fail("answer_binding_mismatch")
    except ReviewIntakeError:
        raise
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail("answer_invalid")
    reviewer_id = next(iter(reviewer_ids), None)
    return responses, reviewer_id, hashlib.sha256(payload).hexdigest()


def ingest_blind_review_answers(
    bundle: object,
    *,
    answered_reviewer_a_bytes: bytes | None,
    answered_reviewer_b_bytes: bytes | None,
    incorporated_at: str,
) -> PrivateReviewIntake:
    """Validate and record supplied answers without granting any authority."""

    files = validated_private_review_files(bundle)
    answers = (answered_reviewer_a_bytes, answered_reviewer_b_bytes)
    total = 0
    for payload in answers:
        if payload is None:
            continue
        if type(payload) is not bytes:
            _fail("answer_bytes_required")
        if not payload or len(payload) > MAX_ANSWER_BYTES:
            _fail("answer_size")
        total += len(payload)
    if total > MAX_TOTAL_ANSWER_BYTES:
        _fail("answers_size")

    coordinator = _load_original(files["coordinator.json"])
    pack_a = _load_original(files["reviewer-a.json"])
    pack_b = _load_original(files["reviewer-b.json"])
    original_candidates, created_at = _validate_originals(
        coordinator=coordinator,
        pack_a=pack_a,
        pack_b=pack_b,
    )
    incorporated = _parse_timestamp(incorporated_at, "incorporated_at_invalid")
    if incorporated < created_at:
        _fail("incorporated_at_invalid")

    responses_a, reviewer_a, answer_hash_a = _parse_answer(
        answered_reviewer_a_bytes,
        original_bytes=files["reviewer-a.json"],
        original_pack=pack_a,
        original_candidates=original_candidates,
        created_at=created_at,
        incorporated_at=incorporated,
    )
    responses_b, reviewer_b, answer_hash_b = _parse_answer(
        answered_reviewer_b_bytes,
        original_bytes=files["reviewer-b.json"],
        original_pack=pack_b,
        original_candidates=original_candidates,
        created_at=created_at,
        incorporated_at=incorporated,
    )
    if reviewer_a is not None and reviewer_b is not None and reviewer_a == reviewer_b:
        _fail("reviewer_independence_invalid")

    coordinator_candidates = cast(list[dict[str, Any]], coordinator["candidates"])
    result_candidates: list[dict[str, object]] = []
    pending_ids: list[str] = []
    disagreement_ids: list[str] = []
    dual_reviewed = 0
    for coordinator_candidate, response_a, response_b in zip(
        coordinator_candidates, responses_a, responses_b, strict=True
    ):
        review_id = cast(str, coordinator_candidate["review_id"])
        if response_a is None or response_b is None:
            candidate_status = "pending"
            pending_ids.append(review_id)
        else:
            dual_reviewed += 1
            first = tuple(response_a[field] for field in _AGREEMENT_FIELDS)
            second = tuple(response_b[field] for field in _AGREEMENT_FIELDS)
            if first == second:
                candidate_status = "agreed"
            else:
                candidate_status = "disagreement"
                disagreement_ids.append(review_id)
        result_candidates.append(
            {
                "review_id": review_id,
                "src": coordinator_candidate["src"],
                "dst": coordinator_candidate["dst"],
                "evidence_sha256": coordinator_candidate["evidence_sha256"],
                "status": candidate_status,
                "responses": {"a": response_a, "b": response_b},
            }
        )

    status: ReviewStatus
    if pending_ids:
        status = "pending"
    elif disagreement_ids:
        status = "disagreement"
    else:
        status = "complete"

    coordinator_bindings = cast(dict[str, Any], coordinator["bindings"])
    result = {
        "schema_version": INTAKE_VERSION,
        "scope": "coordinator_only",
        "fixture_id": coordinator["fixture_id"],
        "collection_id": coordinator["collection_id"],
        "release_id": coordinator["release_id"],
        "incorporated_at": incorporated_at,
        "evidence_boundary": coordinator["evidence_boundary"],
        "review_identity_boundary": REVIEW_IDENTITY_BOUNDARY,
        "status": status,
        "candidate_count": len(result_candidates),
        "dual_reviewed_count": dual_reviewed,
        "pending_review_ids": pending_ids,
        "disagreement_review_ids": disagreement_ids,
        "bindings": {
            "artifact_sha256": coordinator_bindings["artifact_sha256"],
            "catalog_sha256": coordinator_bindings["catalog_sha256"],
            "candidate_snapshot_sha256": coordinator_bindings["candidate_snapshot_sha256"],
            "coordinator_sha256": hashlib.sha256(files["coordinator.json"]).hexdigest(),
            "pending_packs": [
                {
                    "reviewer_slot": slot,
                    "pack_id": pack["pack_id"],
                    "sha256": hashlib.sha256(files[f"reviewer-{slot}.json"]).hexdigest(),
                }
                for slot, pack in (("a", pack_a), ("b", pack_b))
            ],
            "answered_packs": [
                {"reviewer_slot": "a", "sha256": answer_hash_a},
                {"reviewer_slot": "b", "sha256": answer_hash_b},
            ],
            "source_snapshots": coordinator_bindings["source_snapshots"],
        },
        "candidates": result_candidates,
        "audit_fixture_authorized": False,
        "artifact_update_authorized": False,
        "quality_authorized": False,
        "publication_authorized": False,
    }
    try:
        result_bytes = canonical_json_bytes(result)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail("result_invalid")
    if len(result_bytes) > MAX_RESULT_BYTES:
        _fail("result_size")
    return PrivateReviewIntake(
        status=status,
        candidate_count=len(result_candidates),
        dual_reviewed_count=dual_reviewed,
        pending_review_ids=tuple(pending_ids),
        disagreement_review_ids=tuple(disagreement_ids),
        result_bytes=result_bytes,
        result_sha256=hashlib.sha256(result_bytes).hexdigest(),
    )


__all__ = [
    "INTAKE_VERSION",
    "MAX_ANSWER_BYTES",
    "MAX_ANSWER_JSON_DEPTH",
    "MAX_RESULT_BYTES",
    "MAX_TOTAL_ANSWER_BYTES",
    "REVIEW_IDENTITY_BOUNDARY",
    "PrivateReviewIntake",
    "ReviewIntakeError",
    "ReviewStatus",
    "ingest_blind_review_answers",
]

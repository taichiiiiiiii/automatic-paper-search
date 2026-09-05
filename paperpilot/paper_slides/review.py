"""Offline SD4 candidate review and reviewed-public projection boundary.

The boundary accepts canonical candidate bytes rather than filesystem paths.
It performs no publication, network, workflow, credential, or repository I/O.
Only the code-owned renderer assets resolved by ``public_index`` are read.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from types import MappingProxyType
from typing import NoReturn, cast

from paperpilot.paper_slides.contract import (
    MAX_RAW_INPUT_BYTES,
    PAPER_SLIDE_CANDIDATE_EXPIRED,
    PAPER_SLIDE_OUTPUT_INVALID,
    PAPER_SLIDE_REVIEW_REJECTED,
    PAPER_SLIDE_REVIEW_REQUIRED,
    ReviewRecordReference,
    SlideDeckValidationContext,
    SlideDeckValidationError,
    canonical_review_record_bytes,
    canonical_review_record_sha256,
    canonical_slide_deck_bytes,
    load_slide_deck,
    public_review_record_path,
)
from paperpilot.paper_slides.public_index import (
    MAX_PUBLIC_BUNDLE_BYTES,
    PublicIndexBundle,
    PublicIndexEntry,
    ReviewedDeckCandidate,
    SlidePublicIndexError,
    build_public_index_shards,
    project_reviewed_deck,
    snapshot_slide_validation_context,
)
from paperpilot.replay import strict_json_loads

MAX_CANDIDATE_AGE_SECONDS = 14 * 24 * 60 * 60


class SlideReviewPromotionError(ValueError):
    """Stable SD4 failure that does not retain candidate or reviewer prose."""

    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__(f"{error_code}:{issue_code}")


@dataclass(frozen=True, slots=True)
class ReviewedSlideArtifacts:
    """One immutable, exact-byte candidate-to-public promotion result."""

    candidate_bytes: bytes = field(repr=False)
    candidate_sha256: str
    review_record_bytes: bytes = field(repr=False)
    review_record_sha256: str
    review_record_path: str
    reviewed_deck_bytes: bytes = field(repr=False)
    reviewed_deck_sha256: str
    reviewed_deck_path: str
    html_bytes: bytes = field(repr=False)
    html_sha256: str
    html_path: str
    entry: PublicIndexEntry = field(repr=False)
    files: Mapping[str, bytes] = field(repr=False)
    _context: SlideDeckValidationContext = field(repr=False)

    def as_public_index_candidate(self) -> ReviewedDeckCandidate:
        """Return a detached candidate accepted by ``build_public_index_shards``."""

        try:
            deck = strict_json_loads(self.reviewed_deck_bytes)
        except (TypeError, ValueError, UnicodeDecodeError, RecursionError):
            raise SlideReviewPromotionError(
                PAPER_SLIDE_OUTPUT_INVALID, "reviewed_artifact_integrity"
            ) from None
        if type(deck) is not dict:
            raise SlideReviewPromotionError(
                PAPER_SLIDE_OUTPUT_INVALID, "reviewed_artifact_integrity"
            ) from None
        return ReviewedDeckCandidate(deck=deck, context=self._context)

    def build_consistent_public_index_bundle(self) -> PublicIndexBundle:
        """Build one-entry shards only if this checkout reproduces exact artifacts."""

        failure: tuple[str, str] | None = None
        bundle: PublicIndexBundle | None = None
        try:
            bundle = build_public_index_shards([self.as_public_index_candidate()])
            shard = strict_json_loads(bundle.shards[self.entry.paper_id[:2]])
            expected_files = {
                path: payload
                for path, payload in self.files.items()
                if path != self.review_record_path
            }
            if (
                type(shard) is not dict
                or shard.get("entries") != [self.entry.as_dict()]
                or self.review_record_path in bundle.files
                or any(
                    bundle.files.get(path) != payload for path, payload in expected_files.items()
                )
            ):
                failure = (PAPER_SLIDE_OUTPUT_INVALID, "immutable_checkout_changed")
        except (KeyboardInterrupt, SystemExit):
            raise
        except SlideReviewPromotionError as error:
            failure = (error.error_code, error.issue_code)
        except SlidePublicIndexError:
            failure = (PAPER_SLIDE_OUTPUT_INVALID, "immutable_checkout_changed")
        except Exception:
            failure = (PAPER_SLIDE_OUTPUT_INVALID, "immutable_checkout_changed")
        if failure is not None or bundle is None:
            raise SlideReviewPromotionError(
                *(failure or (PAPER_SLIDE_OUTPUT_INVALID, "immutable_checkout_changed"))
            )
        return bundle


def _fail(error_code: str, issue_code: str) -> NoReturn:
    raise SlideReviewPromotionError(error_code, issue_code) from None


def _copy_review(value: object) -> ReviewRecordReference:
    if type(value) is not ReviewRecordReference:
        _fail(PAPER_SLIDE_REVIEW_REQUIRED, "review_record_invalid")
    record = cast(ReviewRecordReference, value)
    try:
        if type(record.checklist) is not tuple:
            raise TypeError
        return ReviewRecordReference(
            deck_id=record.deck_id,
            candidate_sha256=record.candidate_sha256,
            pdf_sha256=record.pdf_sha256,
            reviewer_id=record.reviewer_id,
            decision=record.decision,
            reviewed_at=record.reviewed_at,
            checklist=tuple(record.checklist),
            reason=record.reason,
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        _fail(PAPER_SLIDE_REVIEW_REQUIRED, "review_record_invalid")


def _timestamp(value: object, issue_code: str) -> datetime:
    if type(value) is not str:
        _fail(PAPER_SLIDE_REVIEW_REQUIRED, issue_code)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        _fail(PAPER_SLIDE_REVIEW_REQUIRED, issue_code)
    if parsed.utcoffset() is None:
        _fail(PAPER_SLIDE_REVIEW_REQUIRED, issue_code)
    return parsed


def _validate_candidate_bytes(
    value: object, context: SlideDeckValidationContext
) -> tuple[dict[str, object], bytes, str]:
    if type(value) is not bytes:
        _fail(PAPER_SLIDE_OUTPUT_INVALID, "candidate_bytes_required")
    candidate_bytes = cast(bytes, value)
    if not candidate_bytes or len(candidate_bytes) > MAX_RAW_INPUT_BYTES:
        _fail(PAPER_SLIDE_OUTPUT_INVALID, "candidate_size")
    try:
        candidate = load_slide_deck(candidate_bytes, context=context)
        canonical = canonical_slide_deck_bytes(candidate, context=context)
    except SlideDeckValidationError as error:
        _fail(error.code, error.issue_code)
    if canonical != candidate_bytes:
        _fail(PAPER_SLIDE_OUTPUT_INVALID, "candidate_noncanonical")
    review = candidate.get("review")
    if type(review) is not dict or review != {
        "status": "provisional",
        "review_record": None,
    }:
        _fail(PAPER_SLIDE_REVIEW_REQUIRED, "candidate_not_provisional")
    return candidate, canonical, hashlib.sha256(canonical).hexdigest()


def _validate_review_time(
    candidate: dict[str, object],
    record: ReviewRecordReference,
    review_as_of: object,
) -> None:
    generated_at = _timestamp(candidate.get("generated_at"), "candidate_time_invalid")
    reviewed_at = _timestamp(record.reviewed_at, "review_time_invalid")
    as_of = _timestamp(review_as_of, "review_as_of_invalid")
    if not generated_at <= reviewed_at <= as_of:
        _fail(PAPER_SLIDE_REVIEW_REQUIRED, "review_time_mismatch")
    age_seconds = (as_of - generated_at).total_seconds()
    if age_seconds > MAX_CANDIDATE_AGE_SECONDS:
        _fail(PAPER_SLIDE_CANDIDATE_EXPIRED, "candidate_expired")


def _build_reviewed_slide_artifacts(
    candidate_bytes: bytes,
    *,
    review_record: ReviewRecordReference,
    context: SlideDeckValidationContext,
) -> ReviewedSlideArtifacts:
    """Approve, revalidate, and render one candidate without publishing it."""

    try:
        if type(context) is not SlideDeckValidationContext:
            _fail(PAPER_SLIDE_REVIEW_REQUIRED, "review_context_invalid")
        trusted_context = snapshot_slide_validation_context(context)
        if trusted_context.review_records:
            _fail(PAPER_SLIDE_REVIEW_REQUIRED, "review_context_not_pristine")
        record = _copy_review(review_record)
        try:
            review_bytes = canonical_review_record_bytes(record)
            review_sha256 = canonical_review_record_sha256(record)
            review_path = public_review_record_path(record)
        except (TypeError, ValueError, RecursionError):
            _fail(PAPER_SLIDE_REVIEW_REQUIRED, "review_record_invalid")
        if record.decision != "approved":
            issue = "review_rejected" if record.decision == "rejected" else "review_needs_changes"
            _fail(PAPER_SLIDE_REVIEW_REJECTED, issue)

        candidate, exact_candidate_bytes, candidate_sha256 = _validate_candidate_bytes(
            candidate_bytes, trusted_context
        )
        _validate_review_time(candidate, record, trusted_context.review_as_of)

        if review_sha256 != hashlib.sha256(review_bytes).hexdigest():
            _fail(PAPER_SLIDE_OUTPUT_INVALID, "review_record_integrity")

        reviewed = dict(candidate)
        reviewed["review"] = {"status": "reviewed", "review_record": review_path}
        reviewed_context = SlideDeckValidationContext(
            expected_envelope_sha256=trusted_context.expected_envelope_sha256,
            pdf_chunks=trusted_context.pdf_chunks,
            abstract_sha256=trusted_context.abstract_sha256,
            abstract_source_anchor=trusted_context.abstract_source_anchor,
            lineage_claims=trusted_context.lineage_claims,
            review_records=MappingProxyType({review_path: record}),
            current_lineage_calibration_id=trusted_context.current_lineage_calibration_id,
            review_as_of=trusted_context.review_as_of,
        )
        reviewed_bytes = canonical_slide_deck_bytes(reviewed, context=reviewed_context)
        projection = project_reviewed_deck(reviewed, context=reviewed_context)
        if projection.deck_bytes != reviewed_bytes:
            _fail(PAPER_SLIDE_OUTPUT_INVALID, "reviewed_artifact_integrity")

        files = dict(projection.files)
        if review_path in files:
            _fail(PAPER_SLIDE_OUTPUT_INVALID, "reviewed_artifact_collision")
        files[review_path] = review_bytes
        if sum(len(payload) for payload in files.values()) > MAX_PUBLIC_BUNDLE_BYTES:
            _fail(PAPER_SLIDE_OUTPUT_INVALID, "reviewed_artifact_size")
        return ReviewedSlideArtifacts(
            candidate_bytes=exact_candidate_bytes,
            candidate_sha256=candidate_sha256,
            review_record_bytes=review_bytes,
            review_record_sha256=review_sha256,
            review_record_path=review_path,
            reviewed_deck_bytes=reviewed_bytes,
            reviewed_deck_sha256=projection.entry.deck_sha256,
            reviewed_deck_path=projection.entry.deck_json_path,
            html_bytes=projection.html_bytes,
            html_sha256=projection.entry.html_sha256,
            html_path=projection.entry.deck_path,
            entry=projection.entry,
            files=MappingProxyType(files),
            _context=reviewed_context,
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except SlideReviewPromotionError:
        raise
    except SlideDeckValidationError as error:
        raise SlideReviewPromotionError(error.code, error.issue_code) from None
    except SlidePublicIndexError as error:
        raise SlideReviewPromotionError(PAPER_SLIDE_REVIEW_REQUIRED, error.code) from None
    except Exception:
        raise SlideReviewPromotionError(
            PAPER_SLIDE_OUTPUT_INVALID, "review_promotion_failed"
        ) from None


def build_reviewed_slide_artifacts(
    candidate_bytes: bytes,
    *,
    review_record: ReviewRecordReference,
    context: SlideDeckValidationContext,
) -> ReviewedSlideArtifacts:
    """Approve, revalidate, and render one candidate without publishing it."""

    failure: tuple[str, str] | None = None
    try:
        return _build_reviewed_slide_artifacts(
            candidate_bytes,
            review_record=review_record,
            context=context,
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except SlideReviewPromotionError as error:
        failure = (error.error_code, error.issue_code)
    except Exception:
        failure = (PAPER_SLIDE_OUTPUT_INVALID, "review_promotion_failed")
    assert failure is not None
    raise SlideReviewPromotionError(*failure)


__all__ = [
    "MAX_CANDIDATE_AGE_SECONDS",
    "ReviewedSlideArtifacts",
    "SlideReviewPromotionError",
    "build_reviewed_slide_artifacts",
]

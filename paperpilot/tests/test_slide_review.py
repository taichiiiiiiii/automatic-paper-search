"""Focused offline tests for the SD4 review/promotion boundary."""

from __future__ import annotations

import hashlib
import json
from dataclasses import FrozenInstanceError, replace
from pathlib import Path
from types import MappingProxyType
from typing import cast

import pytest

import paperpilot.paper_slides as paper_slides
import paperpilot.paper_slides.public_index as public_index_module
from paperpilot.paper_slides.contract import (
    MAX_RAW_INPUT_BYTES,
    PAPER_SLIDE_CANDIDATE_EXPIRED,
    PAPER_SLIDE_OUTPUT_INVALID,
    PAPER_SLIDE_REVIEW_REJECTED,
    PAPER_SLIDE_REVIEW_REQUIRED,
    REVIEW_CHECKLIST,
    PdfChunkReference,
    ReviewRecordReference,
    SlideDeckValidationContext,
    canonical_slide_deck_bytes,
    trusted_envelope_sha256,
)
from paperpilot.paper_slides.public_index import (
    PublicAssetSnapshot,
    build_public_index_shards,
)
from paperpilot.paper_slides.render import AssetReferences
from paperpilot.paper_slides.review import (
    SlideReviewPromotionError,
    build_reviewed_slide_artifacts,
)

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "paperpilot" / "tests" / "fixtures" / "paper-slides-v1" / "full-text.json"
ABSTRACT_FIXTURE = (
    ROOT / "paperpilot" / "tests" / "fixtures" / "paper-slides-v1" / "abstract-only.json"
)


def test_review_boundary_is_available_from_the_package_api() -> None:
    assert paper_slides.build_reviewed_slide_artifacts is build_reviewed_slide_artifacts
    assert paper_slides.SlideReviewPromotionError is SlideReviewPromotionError
    assert paper_slides.snapshot_slide_validation_context.__name__ == (
        "snapshot_slide_validation_context"
    )


def _candidate() -> tuple[bytes, dict, SlideDeckValidationContext]:
    deck = json.loads(FIXTURE.read_text(encoding="utf-8"))
    citation = deck["citations"][0]
    context = SlideDeckValidationContext(
        expected_envelope_sha256=trusted_envelope_sha256(deck),
        pdf_chunks={
            citation["chunk_id"]: PdfChunkReference(
                page=citation["page"],
                sha256=citation["chunk_sha256"],
                source_anchor=citation["source_anchor"],
                pdf_sha256=deck["source"]["pdf_sha256"],
            )
        },
        review_as_of="2026-09-05T00:00:00Z",
    )
    return canonical_slide_deck_bytes(deck, context=context), deck, context


def _record(candidate_bytes: bytes, deck: dict, **changes: object) -> ReviewRecordReference:
    value = ReviewRecordReference(
        deck_id=deck["deck_id"],
        candidate_sha256=hashlib.sha256(candidate_bytes).hexdigest(),
        pdf_sha256=deck["source"]["pdf_sha256"],
        reviewer_id="reviewer-1",
        decision="approved",
        reviewed_at="2026-09-01T00:00:00Z",
        checklist=REVIEW_CHECKLIST,
        reason="引用、表示、権利表記を確認済み",
    )
    return replace(value, **changes)


def _assert_error(
    call, error_code: str, issue_code: str | None = None
) -> SlideReviewPromotionError:
    with pytest.raises(SlideReviewPromotionError) as captured:
        call()
    assert captured.value.error_code == error_code
    if issue_code is not None:
        assert captured.value.issue_code == issue_code
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    return captured.value


def test_approved_candidate_returns_one_exact_immutable_public_unit() -> None:
    candidate_bytes, deck, context = _candidate()
    record = _record(candidate_bytes, deck)
    result = build_reviewed_slide_artifacts(candidate_bytes, review_record=record, context=context)

    assert result.candidate_bytes == candidate_bytes
    assert result.candidate_sha256 == hashlib.sha256(candidate_bytes).hexdigest()
    assert result.review_record_sha256 == hashlib.sha256(result.review_record_bytes).hexdigest()
    assert result.review_record_path.endswith(f"/{result.review_record_sha256}.json")
    assert result.reviewed_deck_sha256 == hashlib.sha256(result.reviewed_deck_bytes).hexdigest()
    assert result.html_sha256 == hashlib.sha256(result.html_bytes).hexdigest()
    assert result.reviewed_deck_path == result.entry.deck_json_path
    assert result.html_path == result.entry.deck_path
    assert result.files[result.review_record_path] == result.review_record_bytes
    assert result.files[result.reviewed_deck_path] == result.reviewed_deck_bytes
    assert result.files[result.html_path] == result.html_bytes
    assert candidate_bytes not in result.files.values()
    assert b"%PDF-" not in b"".join(result.files.values())
    assert b'"status":"reviewed"' in result.reviewed_deck_bytes
    assert result.review_record_path.encode() in result.html_bytes

    with pytest.raises(TypeError):
        cast(dict[str, bytes], result.files)[result.html_path] = b"changed"
    with pytest.raises(FrozenInstanceError):
        result.html_path = "/changed"  # type: ignore[misc]


def test_result_feeds_existing_public_index_shard_builder() -> None:
    candidate_bytes, deck, context = _candidate()
    result = build_reviewed_slide_artifacts(
        candidate_bytes,
        review_record=_record(candidate_bytes, deck),
        context=context,
    )
    bundle = result.build_consistent_public_index_bundle()
    assert bundle.manifest_bytes.endswith(b"\n")
    assert result.entry.paper_id.encode() in bundle.shards[result.entry.paper_id[:2]]
    assert result.review_record_path not in bundle.files


def test_consistent_bundle_fails_if_checkout_assets_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    candidate_bytes, deck, context = _candidate()
    result = build_reviewed_slide_artifacts(
        candidate_bytes,
        review_record=_record(candidate_bytes, deck),
        context=context,
    )
    css = b"changed css bytes\n"
    script = b"changed script bytes\n"
    css_sha = hashlib.sha256(css).hexdigest()
    script_sha = hashlib.sha256(script).hexdigest()
    changed = PublicAssetSnapshot(
        references=AssetReferences(
            stylesheet_path=f"/automatic-paper-search/assets/paper-slides.{css_sha}.css",
            stylesheet_sha256=css_sha,
            script_path=f"/automatic-paper-search/assets/paper-slides.{script_sha}.js",
            script_sha256=script_sha,
        ),
        files=MappingProxyType(
            {
                f"/automatic-paper-search/assets/paper-slides.{css_sha}.css": css,
                f"/automatic-paper-search/assets/paper-slides.{script_sha}.js": script,
            }
        ),
    )
    monkeypatch.setattr(public_index_module, "resolve_public_slide_assets", lambda: changed)

    _assert_error(
        result.build_consistent_public_index_bundle,
        PAPER_SLIDE_OUTPUT_INVALID,
        "immutable_checkout_changed",
    )


def test_abstract_only_review_requires_null_pdf_and_exact_abstract_binding() -> None:
    deck = json.loads(ABSTRACT_FIXTURE.read_text(encoding="utf-8"))
    citation = deck["citations"][0]
    context = SlideDeckValidationContext(
        expected_envelope_sha256=trusted_envelope_sha256(deck),
        abstract_sha256=citation["chunk_sha256"],
        abstract_source_anchor=citation["source_anchor"],
        review_as_of="2026-09-05T00:00:00Z",
    )
    candidate_bytes = canonical_slide_deck_bytes(deck, context=context)
    record = _record(candidate_bytes, deck, pdf_sha256=None)
    result = build_reviewed_slide_artifacts(candidate_bytes, review_record=record, context=context)
    assert result.entry.coverage == "abstract_only"
    assert json.loads(result.review_record_bytes)["pdf_sha256"] is None


@pytest.mark.parametrize("decision", ["rejected", "needs_changes"])
def test_nonapproved_decisions_never_render_or_project(decision: str) -> None:
    candidate_bytes, deck, context = _candidate()
    error = _assert_error(
        lambda: build_reviewed_slide_artifacts(
            candidate_bytes,
            review_record=_record(candidate_bytes, deck, decision=decision),
            context=context,
        ),
        PAPER_SLIDE_REVIEW_REJECTED,
    )
    assert error.issue_code == f"review_{decision}"


@pytest.mark.parametrize(
    "change",
    [
        {"candidate_sha256": "0" * 64},
        {"deck_id": "sd1-" + "0" * 64},
        {"pdf_sha256": "0" * 64},
    ],
)
def test_candidate_deck_and_pdf_mismatches_fail_closed(change: dict[str, object]) -> None:
    candidate_bytes, deck, context = _candidate()
    _assert_error(
        lambda: build_reviewed_slide_artifacts(
            candidate_bytes,
            review_record=_record(candidate_bytes, deck, **change),
            context=context,
        ),
        PAPER_SLIDE_REVIEW_REQUIRED,
        "review_record_mismatch",
    )


@pytest.mark.parametrize(
    "change",
    [
        {"reviewer_id": "person@example.com"},
        {"checklist": REVIEW_CHECKLIST[:-1]},
        {"reason": "api_key=supersecret"},
        {"reviewed_at": "2026-09-01T00:00:00.1234567Z"},
        {"decision": "unknown"},
    ],
)
def test_malformed_review_records_fail_before_projection(change: dict[str, object]) -> None:
    candidate_bytes, deck, context = _candidate()
    _assert_error(
        lambda: build_reviewed_slide_artifacts(
            candidate_bytes,
            review_record=_record(candidate_bytes, deck, **change),
            context=context,
        ),
        PAPER_SLIDE_REVIEW_REQUIRED,
        "review_record_invalid",
    )


def test_future_reverse_and_expired_review_times_fail_closed() -> None:
    candidate_bytes, deck, context = _candidate()
    before_generation = _record(candidate_bytes, deck, reviewed_at="2026-08-29T23:59:59Z")
    _assert_error(
        lambda: build_reviewed_slide_artifacts(
            candidate_bytes, review_record=before_generation, context=context
        ),
        PAPER_SLIDE_REVIEW_REQUIRED,
        "review_time_mismatch",
    )
    after_as_of = _record(candidate_bytes, deck, reviewed_at="2026-09-06T00:00:00Z")
    _assert_error(
        lambda: build_reviewed_slide_artifacts(
            candidate_bytes, review_record=after_as_of, context=context
        ),
        PAPER_SLIDE_REVIEW_REQUIRED,
        "review_time_mismatch",
    )
    expired_context = replace(context, review_as_of="2026-09-14T00:00:01Z")
    _assert_error(
        lambda: build_reviewed_slide_artifacts(
            candidate_bytes,
            review_record=_record(candidate_bytes, deck),
            context=expired_context,
        ),
        PAPER_SLIDE_CANDIDATE_EXPIRED,
        "candidate_expired",
    )


def test_noncanonical_duplicate_oversize_and_deep_candidate_bytes_are_rejected() -> None:
    candidate_bytes, deck, context = _candidate()
    record = _record(candidate_bytes, deck)
    pretty = json.dumps(json.loads(candidate_bytes), indent=2).encode()
    _assert_error(
        lambda: build_reviewed_slide_artifacts(pretty, review_record=record, context=context),
        PAPER_SLIDE_OUTPUT_INVALID,
        "candidate_noncanonical",
    )
    duplicate = candidate_bytes.replace(b"{", b'{"schema_version":"slide-deck-v1",', 1)
    _assert_error(
        lambda: build_reviewed_slide_artifacts(duplicate, review_record=record, context=context),
        PAPER_SLIDE_OUTPUT_INVALID,
        "json_parse",
    )
    _assert_error(
        lambda: build_reviewed_slide_artifacts(
            b"x" * (MAX_RAW_INPUT_BYTES + 1),
            review_record=record,
            context=context,
        ),
        PAPER_SLIDE_OUTPUT_INVALID,
        "candidate_size",
    )
    deep = (b"[" * 40) + b"0" + (b"]" * 40)
    _assert_error(
        lambda: build_reviewed_slide_artifacts(deep, review_record=record, context=context),
        PAPER_SLIDE_OUTPUT_INVALID,
        "json_depth",
    )


def test_path_and_symlink_inputs_are_rejected_without_opening_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    candidate_bytes, deck, context = _candidate()
    target = tmp_path / "candidate.json"
    target.write_bytes(candidate_bytes)
    link = tmp_path / "candidate-link.json"
    link.symlink_to(target)
    record = _record(candidate_bytes, deck)

    def forbidden_open(*args: object, **kwargs: object) -> None:
        raise AssertionError("candidate path must never be opened")

    monkeypatch.setattr(Path, "open", forbidden_open)
    for candidate in (target, link, str(target), bytearray(candidate_bytes)):
        _assert_error(
            lambda candidate=candidate: build_reviewed_slide_artifacts(  # type: ignore[misc]
                candidate,
                review_record=record,
                context=context,
            ),
            PAPER_SLIDE_OUTPUT_INVALID,
            "candidate_bytes_required",
        )


def test_caller_context_and_review_mutation_cannot_change_finished_result() -> None:
    candidate_bytes, deck, context = _candidate()
    record = _record(candidate_bytes, deck)
    result = build_reviewed_slide_artifacts(candidate_bytes, review_record=record, context=context)
    original_review_bytes = result.review_record_bytes
    original_deck_bytes = result.reviewed_deck_bytes
    cast(dict, context.pdf_chunks).clear()
    object.__setattr__(record, "reason", "changed after return")
    assert result.review_record_bytes == original_review_bytes
    assert result.reviewed_deck_bytes == original_deck_bytes
    bundle = build_public_index_shards([result.as_public_index_candidate()])
    assert result.entry.paper_id.encode() in bundle.shards[result.entry.paper_id[:2]]

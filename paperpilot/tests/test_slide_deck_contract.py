"""SD0 contract tests for ``slide-deck-v1``."""

from __future__ import annotations

import hashlib
import json
import math
from copy import deepcopy
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from paperpilot.paper_slides import (
    ABSTRACT_ONLY_LABEL,
    FULL_TEXT_LABEL,
    MAX_RAW_INPUT_BYTES,
    PAPER_SLIDE_CITATION_INVALID,
    PAPER_SLIDE_OUTPUT_INVALID,
    PAPER_SLIDE_REVIEW_REQUIRED,
    PAPER_SLIDE_SECRET_DETECTED,
    PAPER_SLIDES_PUBLIC_ROOT,
    REVIEW_CHECKLIST,
    LineageClaimReference,
    PdfChunkReference,
    ReviewRecordReference,
    SlideDeckValidationContext,
    SlideDeckValidationError,
    canonical_review_record_bytes,
    canonical_review_record_sha256,
    canonical_slide_deck_bytes,
    canonical_slide_deck_sha256,
    derive_candidate_sha256,
    derive_deck_id,
    load_slide_deck,
    public_review_record_path,
    trusted_envelope_sha256,
    validate_slide_deck,
)

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).parent / "fixtures" / "paper-slides-v1"
SCHEMA_PATH = ROOT / "schemas" / "slide-deck-v1.schema.json"


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _context(deck: dict | None = None) -> SlideDeckValidationContext:
    if deck is None:
        deck = _load("full-text.json")
    return SlideDeckValidationContext(
        expected_envelope_sha256=trusted_envelope_sha256(deck),
        pdf_chunks={
            "p003-c02": PdfChunkReference(
                page=3,
                sha256="b" * 64,
                source_anchor="https://arxiv.org/pdf/2601.01234#page=3",
                pdf_sha256="a" * 64,
            )
        },
        abstract_sha256="d" * 64,
        abstract_source_anchor="https://arxiv.org/abs/2601.01234",
    )


def _issue_codes(deck: object, context: SlideDeckValidationContext | None = None) -> set[str]:
    return {issue.issue_code for issue in validate_slide_deck(deck, context=context)}


@pytest.mark.parametrize("name", ["full-text.json", "abstract-only.json"])
def test_positive_fixtures_pass_schema_and_runtime(name: str) -> None:
    deck = _load(name)
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    schema_errors = list(
        Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(deck)
    )

    assert schema_errors == []
    assert validate_slide_deck(deck, context=_context(deck)) == []
    assert deck["deck_id"] == derive_deck_id(deck)


def test_schema_is_closed_at_every_nested_object() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    locations = [
        (),
        ("coverage",),
        ("source",),
        ("generator",),
        ("slides", 0),
        ("slides", 1, "bullets", 0),
        ("slides", 1, "visual"),
        ("slides", 1, "speaker_notes", 0),
        ("citations", 0),
        ("review",),
    ]

    for location in locations:
        deck = _load("full-text.json")
        target = deck
        for part in location:
            target = target[part]
        target["unexpected"] = True
        assert list(validator.iter_errors(deck)), location
        assert "object_fields" in _issue_codes(deck, _context()), location


def test_negative_fixture_rejects_unresolved_citation() -> None:
    deck = _load("invalid-unresolved-citation.json")
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    # Cross-reference integrity intentionally belongs to the stdlib runtime
    # validator; JSON Schema validates the individual object shapes.
    assert (
        list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(deck)) == []
    )
    issues = validate_slide_deck(deck, context=_context())
    assert any(
        issue.error_code == PAPER_SLIDE_CITATION_INVALID
        and issue.issue_code == "citation_unresolved"
        for issue in issues
    )


def test_citations_are_discriminated_closed_shapes() -> None:
    deck = _load("full-text.json")
    citation = deck["citations"][0]
    citation["artifact_path"] = "/themes/example/lineage.json"
    assert "object_fields" in _issue_codes(deck, _context())

    abstract = _load("abstract-only.json")
    citation = abstract["citations"][0]
    citation["page"] = 1
    assert "abstract_citation_shape" in _issue_codes(abstract, _context())

    lineage = _load("full-text.json")
    lineage["citations"].append(
        {
            "citation_id": "c02",
            "source_kind": "lineage_assertion",
            "page": None,
            "artifact_path": "/themes/vit/lineage.json",
            "claim_id": f"claim:{'f' * 64}",
            "artifact_sha256": "e" * 64,
            "quality_path": "/lineage-quality-v2.json",
            "quality_sha256": "9" * 64,
            "source_anchor": f"/themes/vit/?claim=claim%3A{'f' * 64}",
        }
    )
    lineage["slides"][1]["bullets"].append(
        {
            "text": "系譜上の位置づけです。",
            "citation_ids": ["c02"],
            "content_origin": "lineage",
        }
    )
    assert "lineage_context_required" in _issue_codes(lineage, _context())
    trusted = SlideDeckValidationContext(
        pdf_chunks=_context().pdf_chunks,
        lineage_claims={
            ("/themes/vit/lineage.json", f"claim:{'f' * 64}"): LineageClaimReference(
                artifact_sha256="e" * 64,
                quality_path="/lineage-quality-v2.json",
                quality_sha256="9" * 64,
                source_anchor=f"/themes/vit/?claim=claim%3A{'f' * 64}",
                decision="accepted",
                trust_tier="corroborated",
                quality_status="ready",
                quality_result="passed",
                claim_family="genealogy",
                calibrated_probability=0.82,
                calibration_id="lineage-calibration-current",
                independent_source_work_ids=(
                    "arxiv:2501.00001",
                    "doi:10.1000/example",
                ),
                verified_by_review=False,
            )
        },
        expected_envelope_sha256=trusted_envelope_sha256(lineage),
        current_lineage_calibration_id="lineage-calibration-current",
    )
    assert validate_slide_deck(lineage, context=trusted) == []


def test_trusted_context_is_required_and_exact() -> None:
    deck = _load("full-text.json")
    assert "pdf_context_required" in _issue_codes(deck)

    wrong = SlideDeckValidationContext(
        pdf_chunks={
            "p003-c02": PdfChunkReference(
                page=4,
                sha256="b" * 64,
                source_anchor="https://arxiv.org/pdf/2601.01234#page=4",
                pdf_sha256="a" * 64,
            )
        }
    )
    assert "pdf_citation_mismatch" in _issue_codes(deck, wrong)

    abstract = _load("abstract-only.json")
    assert "abstract_context_required" in _issue_codes(abstract)


def test_id_order_reference_rules_and_coverage_rules_fail_closed() -> None:
    deck = _load("full-text.json")
    deck["slides"].reverse()
    assert {"slide_id_order", "title_slide_position"} <= _issue_codes(deck, _context())

    deck = _load("full-text.json")
    deck["citations"].append(deepcopy(deck["citations"][0]))
    assert "citation_id_duplicate" in _issue_codes(deck, _context())

    deck = _load("full-text.json")
    deck["slides"][1]["bullets"][0]["citation_ids"] = []
    assert "bullet_citation_required" in _issue_codes(deck, _context())

    deck = _load("abstract-only.json")
    deck["citations"][0]["source_kind"] = "pdf_page"
    deck["citations"][0]["page"] = 3
    deck["citations"][0]["chunk_id"] = "p003-c02"
    deck["citations"][0]["chunk_sha256"] = "b" * 64
    deck["citations"][0]["source_anchor"] = "https://arxiv.org/pdf/2601.01234#page=3"
    assert "coverage_citation_kind" in _issue_codes(deck, _context())


def test_visual_payloads_and_external_content_are_rejected() -> None:
    for malicious in (
        "<svg onload=alert(1)>",
        "javascript:alert(1)",
        "data:image/png;base64,AAAA",
        "https://remote.example/image.png",
    ):
        deck = _load("full-text.json")
        deck["slides"][1]["visual"] = {
            "kind": "generated_diagram",
            "alt": "方法の概念図",
            "spec": malicious,
        }
        assert "visual_content_unsafe" in _issue_codes(deck, _context())


def test_background_origin_and_unsafe_urls_are_rejected() -> None:
    deck = _load("full-text.json")
    deck["slides"][1]["bullets"][0]["content_origin"] = "background"
    assert "content_origin" in _issue_codes(deck, _context())

    for unsafe_url in (
        "http://arxiv.org/abs/2601.01234",
        "https://user@example.org/paper",
        "https://127.0.0.1/paper",
        "https://example.org:8443/paper",
        "https://example.org/a\\b",
    ):
        deck = _load("full-text.json")
        deck["source"]["landing_url"] = unsafe_url
        issues = validate_slide_deck(deck, context=_context())
        assert "source_url" in {issue.issue_code for issue in issues} or any(
            issue.error_code == PAPER_SLIDE_SECRET_DETECTED for issue in issues
        )


def test_full_text_coverage_requires_pdf_hash_access_and_page_consistency() -> None:
    deck = _load("full-text.json")
    deck["source"]["pdf_sha256"] = None
    deck["source"]["access"] = "unknown"
    deck["source"]["fetched_at"] = None
    deck["coverage"]["extracted_page_count"] = 15
    assert {
        "full_text_pdf_hash",
        "full_text_access",
        "full_text_fetched_at",
        "coverage_page_count_order",
    } <= _issue_codes(deck, _context())


def test_schema_citation_capacity_matches_citation_id_namespace() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    assert schema["properties"]["citations"]["maxItems"] == 99


def test_reviewed_deck_requires_matching_trusted_review_record() -> None:
    deck = _load("full-text.json")
    record = ReviewRecordReference(
        deck_id=deck["deck_id"],
        candidate_sha256=derive_candidate_sha256(deck),
        pdf_sha256=deck["source"]["pdf_sha256"],
        reviewer_id="reviewer-1",
        decision="approved",
        reviewed_at="2026-08-30T01:00:00Z",
        checklist=REVIEW_CHECKLIST,
        reason="引用と表示を確認済み",
    )
    review_path = public_review_record_path(record)
    deck["review"] = {
        "status": "reviewed",
        "review_record": review_path,
    }
    assert "review_context_required" in _issue_codes(deck, _context())

    context = deepcopy(_context())
    context = SlideDeckValidationContext(
        expected_envelope_sha256=trusted_envelope_sha256(deck),
        pdf_chunks=context.pdf_chunks,
        review_records={review_path: record},
        review_as_of="2026-08-30T02:00:00Z",
    )
    assert validate_slide_deck(deck, context=context) == []

    wrong_binding = SlideDeckValidationContext(
        expected_envelope_sha256=trusted_envelope_sha256(deck),
        pdf_chunks=context.pdf_chunks,
        review_records={
            review_path: ReviewRecordReference(
                deck_id=deck["deck_id"],
                candidate_sha256="0" * 64,
                pdf_sha256="1" * 64,
                reviewer_id="reviewer-1",
                decision="approved",
                reviewed_at="2026-08-30T01:00:00Z",
                checklist=REVIEW_CHECKLIST,
                reason="引用と表示を確認済み",
            )
        },
        review_as_of="2026-08-30T02:00:00Z",
    )
    assert "review_record_mismatch" in _issue_codes(deck, wrong_binding)


def test_review_record_has_canonical_full_hash_and_content_addressed_path() -> None:
    deck = _load("full-text.json")
    record = ReviewRecordReference(
        deck_id=deck["deck_id"],
        candidate_sha256=derive_candidate_sha256(deck),
        pdf_sha256=deck["source"]["pdf_sha256"],
        reviewer_id="reviewer-1",
        decision="approved",
        reviewed_at="2026-08-30T01:00:00Z",
        checklist=REVIEW_CHECKLIST,
        reason="引用と表示を確認済み",
    )

    payload = canonical_review_record_bytes(record)
    digest = canonical_review_record_sha256(record)

    assert payload.endswith(b"\n")
    assert digest == hashlib.sha256(payload).hexdigest()
    assert json.loads(payload) == {
        "candidate_sha256": record.candidate_sha256,
        "checklist": list(REVIEW_CHECKLIST),
        "decision": "approved",
        "deck_id": record.deck_id,
        "pdf_sha256": record.pdf_sha256,
        "reason": record.reason,
        "reviewed_at": record.reviewed_at,
        "reviewer_id": record.reviewer_id,
        "schema_version": "paper-slide-review-record-v1",
    }
    assert public_review_record_path(record) == (
        f"{PAPER_SLIDES_PUBLIC_ROOT}/reviews/{record.deck_id}/{digest}.json"
    )


def test_review_record_canonicalization_rejects_unbounded_or_invalid_fields_first() -> None:
    deck = _load("full-text.json")
    base = ReviewRecordReference(
        deck_id=deck["deck_id"],
        candidate_sha256=derive_candidate_sha256(deck),
        pdf_sha256=deck["source"]["pdf_sha256"],
        reviewer_id="reviewer-1",
        decision="approved",
        reviewed_at="2026-08-30T01:00:00Z",
        checklist=REVIEW_CHECKLIST,
        reason="引用と表示を確認済み",
    )

    with pytest.raises(TypeError, match="exact ReviewRecordReference"):
        canonical_review_record_bytes(object())  # type: ignore[arg-type]
    for change in (
        {"deck_id": "sd1-invalid"},
        {"candidate_sha256": "A" * 64},
        {"pdf_sha256": "0"},
        {"reviewer_id": "person@example.com"},
        {"decision": "maybe"},
        {"reviewed_at": "not-a-time"},
        {"checklist": ["x"] * 100_000},
        {"reason": "x" * 281},
    ):
        invalid = ReviewRecordReference(**({**base.__dict__, **change}))
        with pytest.raises(ValueError, match="fields are invalid"):
            canonical_review_record_bytes(invalid)


def test_review_path_changes_for_another_candidate_with_the_same_deck_id() -> None:
    deck = _load("full-text.json")
    first = ReviewRecordReference(
        deck_id=deck["deck_id"],
        candidate_sha256=derive_candidate_sha256(deck),
        pdf_sha256=deck["source"]["pdf_sha256"],
        reviewer_id="reviewer-1",
        decision="approved",
        reviewed_at="2026-08-30T01:00:00Z",
        checklist=REVIEW_CHECKLIST,
        reason="引用と表示を確認済み",
    )
    deck["slides"][1]["title"] = "A separately reviewed revision"
    second = ReviewRecordReference(
        **{**first.__dict__, "candidate_sha256": derive_candidate_sha256(deck)}
    )

    assert first.deck_id == second.deck_id
    assert public_review_record_path(first) != public_review_record_path(second)


def test_legacy_mutable_review_path_is_rejected() -> None:
    deck = _load("full-text.json")
    legacy_path = f"{PAPER_SLIDES_PUBLIC_ROOT}/reviews/{deck['deck_id']}.json"
    deck["review"] = {"status": "reviewed", "review_record": legacy_path}

    assert "review_path" in _issue_codes(deck, _context())


def test_canonical_bytes_are_stable_and_validation_precedes_serialization() -> None:
    deck = _load("full-text.json")
    reordered = {key: deck[key] for key in reversed(deck)}

    payload = canonical_slide_deck_bytes(deck, context=_context())
    assert payload.endswith(b"\n")
    assert payload == canonical_slide_deck_bytes(reordered, context=_context())
    assert canonical_slide_deck_sha256(deck, context=_context()) == (
        "ec89ec6007e00290431322a5d4ce136319eac8e013862c715c7d594fd3605f83"
    )

    invalid = deepcopy(deck)
    invalid["unknown"] = True
    with pytest.raises(SlideDeckValidationError) as exc:
        canonical_slide_deck_bytes(invalid, context=_context())
    assert exc.value.code == PAPER_SLIDE_OUTPUT_INVALID
    assert exc.value.path == "$"


def test_strict_loader_rejects_duplicate_keys_and_non_finite_numbers() -> None:
    with pytest.raises(SlideDeckValidationError) as duplicate:
        load_slide_deck('{"schema_version":"slide-deck-v1","schema_version":"x"}')
    assert duplicate.value.code == PAPER_SLIDE_OUTPUT_INVALID
    assert duplicate.value.issue_code == "json_parse"

    with pytest.raises(SlideDeckValidationError) as non_finite:
        load_slide_deck('{"value":NaN}')
    assert non_finite.value.issue_code == "json_parse"


def test_stable_public_error_categories_are_exposed_without_raw_detail() -> None:
    deck = _load("invalid-unresolved-citation.json")
    with pytest.raises(SlideDeckValidationError) as exc:
        canonical_slide_deck_bytes(deck, context=_context())

    assert exc.value.code == PAPER_SLIDE_CITATION_INVALID
    assert exc.value.issue_code == "citation_unresolved"
    assert "missing-private-text" not in str(exc.value)
    assert PAPER_SLIDE_REVIEW_REQUIRED == "PAPER_SLIDE_REVIEW_REQUIRED"


@pytest.mark.parametrize(
    "value",
    [None, True, 1, 1.5, "text", [], [1], {"schema_version": []}],
)
def test_validator_is_total_for_every_json_value_kind(value: object) -> None:
    issues = validate_slide_deck(value)
    assert issues
    assert all(issue.error_code.startswith("PAPER_SLIDE_") for issue in issues)


def test_validator_bounds_depth_containers_cycles_and_malformed_enums() -> None:
    nested: object = None
    for _ in range(40):
        nested = [nested]
    assert validate_slide_deck(nested)[0].issue_code == "json_depth"

    many = [[] for _ in range(2100)]
    assert validate_slide_deck(many)[0].issue_code == "json_container_limit"

    cycle: list = []
    cycle.append(cycle)
    assert validate_slide_deck(cycle)[0].issue_code == "json_cycle"

    for path, value in (
        (("coverage", "kind"), []),
        (("source", "access"), {}),
        (("slides", 0, "kind"), []),
        (("citations", 0, "source_kind"), []),
        (("review", "status"), []),
    ):
        deck = _load("full-text.json")
        target = deck
        for part in path[:-1]:
            target = target[part]
        target[path[-1]] = value
        assert validate_slide_deck(deck, context=_context())


def test_loader_rejects_raw_oversize_and_invalid_utf8_before_validation() -> None:
    with pytest.raises(SlideDeckValidationError) as oversized:
        load_slide_deck(b" " * (MAX_RAW_INPUT_BYTES + 1))
    assert oversized.value.issue_code == "input_size"

    with pytest.raises(SlideDeckValidationError) as invalid_utf8:
        load_slide_deck(b"\xff")
    assert invalid_utf8.value.issue_code == "json_parse"


def test_trusted_envelope_rejects_forgery_even_after_deck_id_recalculation() -> None:
    original = _load("full-text.json")
    context = _context(original)
    forged = deepcopy(original)
    forged["source"]["title"] = "Forged trusted title"
    forged["deck_id"] = derive_deck_id(forged)

    assert "trusted_envelope_mismatch" in _issue_codes(forged, context)


def test_pdf_context_binds_chunk_to_source_pdf_and_page_count() -> None:
    deck = _load("full-text.json")
    wrong_pdf = SlideDeckValidationContext(
        expected_envelope_sha256=trusted_envelope_sha256(deck),
        pdf_chunks={
            "p003-c02": PdfChunkReference(
                page=3,
                sha256="b" * 64,
                source_anchor="https://arxiv.org/pdf/2601.01234#page=3",
                pdf_sha256="f" * 64,
            )
        },
    )
    assert "pdf_citation_mismatch" in _issue_codes(deck, wrong_pdf)

    page_overflow = deepcopy(deck)
    page_overflow["coverage"]["page_count"] = 2
    page_overflow["coverage"]["extracted_page_count"] = 2
    page_overflow["deck_id"] = derive_deck_id(page_overflow)
    overflow_context = SlideDeckValidationContext(
        expected_envelope_sha256=trusted_envelope_sha256(page_overflow),
        pdf_chunks=_context().pdf_chunks,
    )
    assert "citation_page_count" in _issue_codes(page_overflow, overflow_context)


def test_fixed_coverage_labels_and_limitations_are_required() -> None:
    for name in ("full-text.json", "abstract-only.json"):
        deck = _load(name)
        deck["coverage"]["label"] = "曖昧な表示"
        deck["limitations"] = ["任意の注意書き"]
        codes = _issue_codes(deck, _context(deck))
        assert {"coverage_label", "required_limitation"} <= codes


def test_corroborated_lineage_requires_current_calibration_and_independent_evidence() -> None:
    deck = _load("full-text.json")
    # Reuse the existing lineage fixture construction, then progressively
    # supply an unqualified trusted claim.
    deck["citations"].append(
        {
            "citation_id": "c02",
            "source_kind": "lineage_assertion",
            "page": None,
            "artifact_path": "/themes/vit/lineage.json",
            "claim_id": f"claim:{'f' * 64}",
            "artifact_sha256": "e" * 64,
            "quality_path": "/lineage-quality-v2.json",
            "quality_sha256": "9" * 64,
            "source_anchor": f"/themes/vit/?claim=claim%3A{'f' * 64}",
        }
    )
    deck["slides"][1]["bullets"].append(
        {"text": "系譜上の位置づけです。", "citation_ids": ["c02"], "content_origin": "lineage"}
    )
    weak = LineageClaimReference(
        artifact_sha256="e" * 64,
        quality_path="/lineage-quality-v2.json",
        quality_sha256="9" * 64,
        source_anchor=f"/themes/vit/?claim=claim%3A{'f' * 64}",
        decision="accepted",
        trust_tier="corroborated",
        quality_status="ready",
        quality_result="passed",
        claim_family="genealogy",
        calibrated_probability=math.nan,
        calibration_id="stale",
        independent_source_work_ids=("arxiv:2501.00001", "arxiv:2501.00001"),
        verified_by_review=False,
    )
    context = SlideDeckValidationContext(
        expected_envelope_sha256=trusted_envelope_sha256(deck),
        pdf_chunks=_context().pdf_chunks,
        lineage_claims={("/themes/vit/lineage.json", f"claim:{'f' * 64}"): weak},
        current_lineage_calibration_id="current",
    )
    assert "lineage_claim_unqualified" in _issue_codes(deck, context)


def test_secret_and_active_content_scan_covers_all_generated_text() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    schema_validator = Draft202012Validator(schema, format_checker=FormatChecker())
    deck = _load("full-text.json")
    deck["source"]["title"] = "github_pat_1234567890abcdef"
    issues = validate_slide_deck(deck, context=_context())
    assert issues[0].error_code == PAPER_SLIDE_SECRET_DETECTED

    for active in (
        "<script>alert(1)</script>",
        "javascript:alert(1)",
        "data:text/html;base64,AAAA",
        "https://attacker.example/payload",
    ):
        deck = _load("full-text.json")
        deck["slides"][1]["bullets"][0]["text"] = active
        assert "active_content" in _issue_codes(deck, _context())
        assert list(schema_validator.iter_errors(deck))


def test_schema_runtime_parity_for_malformed_type_and_same_origin_traversal() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())

    malformed = _load("full-text.json")
    malformed["coverage"]["kind"] = []
    assert list(validator.iter_errors(malformed))
    assert "coverage_kind" in _issue_codes(malformed, _context())

    traversal = _load("full-text.json")
    traversal["citations"].append(
        {
            "citation_id": "c02",
            "source_kind": "lineage_assertion",
            "page": None,
            "artifact_path": "/themes/../private.json",
            "claim_id": f"claim:{'f' * 64}",
            "artifact_sha256": "e" * 64,
            "quality_path": "/lineage-quality-v2.json",
            "quality_sha256": "9" * 64,
            "source_anchor": "/themes/../private/",
        }
    )
    assert list(validator.iter_errors(traversal))
    assert "lineage_citation_shape" in _issue_codes(traversal, _context())


def test_review_requires_derived_path_opaque_id_timestamp_checklist_and_reason() -> None:
    deck = _load("full-text.json")
    base = ReviewRecordReference(
        deck_id=deck["deck_id"],
        candidate_sha256=derive_candidate_sha256(deck),
        pdf_sha256=deck["source"]["pdf_sha256"],
        reviewer_id="reviewer-1",
        decision="approved",
        reviewed_at="2026-08-30T01:00:00Z",
        checklist=REVIEW_CHECKLIST,
        reason="引用と表示を確認済み",
    )
    review_path = public_review_record_path(base)
    deck["review"] = {"status": "reviewed", "review_record": review_path}
    context = SlideDeckValidationContext(
        expected_envelope_sha256=trusted_envelope_sha256(deck),
        pdf_chunks=_context().pdf_chunks,
        review_records={review_path: base},
        review_as_of="2026-08-30T02:00:00Z",
    )
    assert validate_slide_deck(deck, context=context) == []

    for change in (
        {"reviewer_id": "person@example.com"},
        {"reviewed_at": "not-a-time"},
        {"checklist": ("citation_pages_checked",)},
        {"checklist": ["x"] * 100_000},
        {"reason": "https://example.com"},
    ):
        invalid = ReviewRecordReference(**({**base.__dict__, **change}))
        invalid_context = SlideDeckValidationContext(
            expected_envelope_sha256=trusted_envelope_sha256(deck),
            pdf_chunks=_context().pdf_chunks,
            review_records={deck["review"]["review_record"]: invalid},
            review_as_of="2026-08-30T02:00:00Z",
        )
        assert "review_record_mismatch" in _issue_codes(deck, invalid_context)


@pytest.mark.parametrize(
    "secret_assignment",
    [
        "AWS_SECRET_ACCESS_KEY=abcdefghijklmnop",
        "aws secret access key : abcdefghijklmnop",
        "API_KEY = 'abcdefgh12345678'",
        "api key:`abcdefgh12345678`",
        "Password : hunter2-secret",
        "client-secret=abcdefgh12345678",
        "DB_PASSWORD = abcdefgh12345678",
        "OPENAI_API_KEY:'abcdefgh12345678'",
        "anthropic-api-key = `abcdefgh12345678`",
        "REFRESH TOKEN: abcdefgh12345678",
        "authorization = abcdefgh12345678",
    ],
)
def test_secret_assignment_strings_are_rejected(secret_assignment: str) -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    deck = _load("full-text.json")
    deck["source"]["title"] = secret_assignment
    issues = validate_slide_deck(deck, context=_context())
    assert issues[0].error_code == PAPER_SLIDE_SECRET_DETECTED
    assert issues[0].issue_code == "secret_detected"
    assert list(validator.iter_errors(deck))


@pytest.mark.parametrize("plain_text", ["notpassword=abcdefgh", "noauthorization=abcdefgh"])
def test_secret_assignment_boundary_does_not_reject_plain_text(plain_text: str) -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    deck = _load("full-text.json")
    deck["source"]["title"] = plain_text
    deck["deck_id"] = derive_deck_id(deck)
    context = _context(deck)
    assert validate_slide_deck(deck, context=context) == []
    assert list(validator.iter_errors(deck)) == []


@pytest.mark.parametrize(
    "unsafe_url",
    [
        "https://localhost/paper",
        "https://internal/paper",
        "https://2130706433/paper",
        "https://0x7f000001/paper",
        "https://017700000001/paper",
        "https://127.1/paper",
        "https://example .com/paper",
        'https://example.com/"quote',
        "https://example.com/`tick",
        "https://example.com/<tag>",
        "https://example.com/%0a",
        "https://example.com/%00",
        "https://example.com/%25",
        "https://example.com/?q=%3Cscript%3E",
        "https://example.com/%41",
        "https://example.com:0443/x",
    ],
)
def test_https_url_rejects_ambiguous_hosts_and_raw_active_chars(unsafe_url: str) -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    deck = _load("full-text.json")
    deck["source"]["landing_url"] = unsafe_url
    assert "source_url" in _issue_codes(deck, _context())
    assert list(validator.iter_errors(deck))


@pytest.mark.parametrize(
    ("artifact_path", "source_anchor"),
    [
        ("/themes/%76it/lineage.json", "/themes/vit/?claim=ok"),
        ("/themes/vit/lineage.json", "/themes/%76it/?claim=ok"),
        ("/themes/vit/lineage.json", "/themes/vit/?claim=%00"),
        ("/themes/vit/lineage.json", "/themes/vit/?claim=%2500"),
        ("/themes/vit/lineage.json", "/themes/vit/?claim=<raw>"),
        ("/テーマ/vit/lineage.json", "/themes/vit/?claim=ok"),
        ("/themes/vit/lineage.json", "/themes/vit/?claim=論文"),
        ("/themes:vit/lineage.json", "/themes/vit/?claim=ok"),
        ("/themes/vit/lineage.json", "/themes/vit/?q=[x]"),
        ("/themes/vit/lineage.json", "/themes/vit/?q=//"),
        ("/themes/vit/lineage.json", "/themes/vit/#//"),
    ],
)
def test_same_origin_paths_reject_encoding_and_active_chars(
    artifact_path: str, source_anchor: str
) -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    deck = _load("full-text.json")
    deck["citations"].append(
        {
            "citation_id": "c02",
            "source_kind": "lineage_assertion",
            "page": None,
            "artifact_path": artifact_path,
            "claim_id": f"claim:{'f' * 64}",
            "artifact_sha256": "e" * 64,
            "quality_path": "/lineage-quality-v2.json",
            "quality_sha256": "9" * 64,
            "source_anchor": source_anchor,
        }
    )
    assert "lineage_citation_shape" in _issue_codes(deck, _context())
    assert list(validator.iter_errors(deck))


@pytest.mark.parametrize(
    ("path", "active"),
    [
        (("source", "title"), "https://attacker.example/title"),
        (("source", "authors", 0), "<b>Author</b>"),
        (("source", "license"), "javascript:license"),
        (("generator", "model"), "data:text/html,bad"),
    ],
)
def test_source_and_generator_display_metadata_are_plain_text(path: tuple, active: str) -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    deck = _load("full-text.json")
    target = deck
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = active
    assert "active_content" in _issue_codes(deck, _context())
    assert list(validator.iter_errors(deck))


@pytest.mark.parametrize("name", ["full-text.json", "abstract-only.json"])
def test_english_fixed_labels_and_limitations_pass_schema_and_runtime(name: str) -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    deck = _load(name)
    deck["language"] = "en"
    deck["limitations"] = ["Machine-generated summary; verify against the original paper."]
    if deck["coverage"]["kind"] == "full_text":
        deck["coverage"]["label"] = "Generated from the public PDF full text"
    else:
        warning = "Generated from the abstract only. This is not a summary of the full paper."
        deck["coverage"]["label"] = warning
        deck["limitations"].insert(0, warning)
    deck["deck_id"] = derive_deck_id(deck)
    context = _context(deck)
    assert validate_slide_deck(deck, context=context) == []
    assert list(validator.iter_errors(deck)) == []

    deck["coverage"]["label"] = FULL_TEXT_LABEL if name == "full-text.json" else ABSTRACT_ONLY_LABEL
    assert "coverage_label" in _issue_codes(deck, context)
    assert list(validator.iter_errors(deck))


def test_review_timestamp_must_follow_generation_and_precede_trusted_as_of() -> None:
    deck = _load("full-text.json")

    for reviewed_at, review_as_of in (
        ("2026-08-29T23:59:59Z", "2026-08-30T02:00:00Z"),
        ("2026-08-30T03:00:00Z", "2026-08-30T02:00:00Z"),
    ):
        record = ReviewRecordReference(
            deck_id=deck["deck_id"],
            candidate_sha256=derive_candidate_sha256(deck),
            pdf_sha256=deck["source"]["pdf_sha256"],
            reviewer_id="reviewer-1",
            decision="approved",
            reviewed_at=reviewed_at,
            checklist=REVIEW_CHECKLIST,
            reason="引用と表示を確認済み",
        )
        review_path = public_review_record_path(record)
        deck["review"] = {"status": "reviewed", "review_record": review_path}
        context = SlideDeckValidationContext(
            expected_envelope_sha256=trusted_envelope_sha256(deck),
            pdf_chunks=_context().pdf_chunks,
            review_records={review_path: record},
            review_as_of=review_as_of,
        )
        assert "review_record_mismatch" in _issue_codes(deck, context)


@pytest.mark.parametrize(
    "bullets", [[], [{"text": "No citation", "citation_ids": [], "content_origin": "paper"}]]
)
def test_non_title_slide_requires_at_least_one_cited_bullet(bullets: list) -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    deck = _load("full-text.json")
    deck["slides"][1]["bullets"] = bullets
    assert "non_title_cited_bullet" in _issue_codes(deck, _context())
    assert list(validator.iter_errors(deck))


def test_lineage_independence_requires_distinct_canonical_source_work_ids() -> None:
    doc = " ".join((LineageClaimReference.__doc__ or "").split())
    assert "independent_source_work_ids" in doc
    assert "ASCII-visible" in doc
    assert "merge aliases" in doc
    deck = _load("full-text.json")
    deck["citations"].append(
        {
            "citation_id": "c02",
            "source_kind": "lineage_assertion",
            "page": None,
            "artifact_path": "/themes/vit/lineage.json",
            "claim_id": f"claim:{'f' * 64}",
            "artifact_sha256": "e" * 64,
            "quality_path": "/lineage-quality-v2.json",
            "quality_sha256": "9" * 64,
            "source_anchor": f"/themes/vit/?claim=claim%3A{'f' * 64}",
        }
    )
    deck["slides"][1]["bullets"].append(
        {"text": "系譜上の位置づけです。", "citation_ids": ["c02"], "content_origin": "lineage"}
    )
    for invalid_source_ids in (
        ("p003-c02", "p004-c01"),
        ("arxiv:2501.00001", "doi:bad\x00id"),
        ("arxiv:2501.00001", "doi:bad id"),
        ("arxiv:2501.00001", "doi:論文"),
    ):
        claim = LineageClaimReference(
            artifact_sha256="e" * 64,
            quality_path="/lineage-quality-v2.json",
            quality_sha256="9" * 64,
            source_anchor=f"/themes/vit/?claim=claim%3A{'f' * 64}",
            decision="accepted",
            trust_tier="corroborated",
            quality_status="ready",
            quality_result="passed",
            claim_family="genealogy",
            calibrated_probability=0.9,
            calibration_id="current",
            independent_source_work_ids=invalid_source_ids,
            verified_by_review=False,
        )
        context = SlideDeckValidationContext(
            expected_envelope_sha256=trusted_envelope_sha256(deck),
            pdf_chunks=_context().pdf_chunks,
            lineage_claims={("/themes/vit/lineage.json", f"claim:{'f' * 64}"): claim},
            current_lineage_calibration_id="current",
        )
        assert "lineage_claim_unqualified" in _issue_codes(deck, context)

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict
from typing import Any, cast

import pytest

from paperpilot.paper_slides.contract import PAPER_SLIDE_EXTRACTION_FAILED
from paperpilot.paper_slides.extract import _sanitize_page_text
from paperpilot.paper_slides.visible_contract import (
    MAX_CHUNKS,
    MAX_PAGE_DIMENSION_PX,
    MAX_PAGE_RASTER_BYTES,
    MAX_PAGE_TEXT_CODEPOINTS,
    MAX_PAGE_WALL_MILLISECONDS,
    MAX_PAGES,
    MAX_PDF_BYTES,
    MAX_RENDER_DPI,
    MAX_RESULT_BYTES,
    MAX_TOTAL_PIXELS,
    MAX_TOTAL_TEXT_CODEPOINTS,
    MAX_TOTAL_WALL_MILLISECONDS,
    TEST_ONLY_ENGINE_ATTESTATION,
    VISIBLE_TEXT_PROFILE,
    VisibleTextContractError,
    VisibleTextEngineAttestation,
    VisibleTextExpectations,
    VisibleTextOptions,
    _validate_visible_text_result_for_test,
    derive_visible_text_extractor,
    validate_visible_text_result,
)

FIRST_TEXT = " ".join(f"alpha{i:03d}" for i in range(32))
SECOND_TEXT = " ".join(f"beta{i:03d}" for i in range(36))


def _pdf() -> bytes:
    return b"%PDF-1.7\n" + b"x" * 512


def _options() -> VisibleTextOptions:
    return VisibleTextOptions()


def _expectations() -> VisibleTextExpectations:
    return VisibleTextExpectations(
        pdf_bytes=_pdf(),
        page_count=2,
        options=_options(),
        engine_id=TEST_ONLY_ENGINE_ATTESTATION.engine_id,
    )


def _chunk(chunk_id: str, page: int, text: str) -> dict[str, object]:
    return {
        "chunk_id": chunk_id,
        "page": page,
        "text": text,
        "sha256": hashlib.sha256(text.encode()).hexdigest(),
        "section_hint": text.partition("\n")[0][:160].rstrip() or None,
    }


def _payload() -> dict[str, object]:
    first = _chunk("p001-c01", 1, FIRST_TEXT)
    second = _chunk("p002-c01", 2, SECOND_TEXT)
    pages = []
    for page, chunk in ((1, first), (2, second)):
        text = str(chunk["text"])
        pages.append(
            {
                "page": page,
                "width_px": 1200,
                "height_px": 1600,
                "pixel_count": 1_920_000,
                "raster_bytes": 5_760_000,
                "raster_sha256": hashlib.sha256(f"raster-{page}".encode()).hexdigest(),
                "wall_time_milliseconds": 800,
                "word_count": 20,
                "median_confidence": 91.5,
                "visible_character_ratio": 0.98,
                "text_codepoints": len(text),
                "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
                "chunk_ids": [chunk["chunk_id"]],
            }
        )
    engine = asdict(TEST_ONLY_ENGINE_ATTESTATION)
    options = asdict(_options())
    return {
        "schema_version": "visible-text-result-v1",
        "profile": VISIBLE_TEXT_PROFILE,
        "pdf_sha256": hashlib.sha256(_pdf()).hexdigest(),
        "page_count": 2,
        "ocr_page_count": 2,
        "extractor": derive_visible_text_extractor(TEST_ONLY_ENGINE_ATTESTATION),
        "options": options,
        "engine": engine,
        "pages": pages,
        "chunks": [first, second],
        "total_pixels": 3_840_000,
        "total_wall_time_milliseconds": 1_600,
        "total_text_codepoints": len(FIRST_TEXT) + len(SECOND_TEXT),
    }


def _bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def _validate(value: object | None = None):
    payload = _payload() if value is None else value
    return _validate_visible_text_result_for_test(_bytes(payload), _expectations())


def _assert_issue(payload: bytes, issue_code: str, expectations: object | None = None) -> None:
    with pytest.raises(VisibleTextContractError) as caught:
        _validate_visible_text_result_for_test(
            payload,
            cast(
                VisibleTextExpectations,
                _expectations() if expectations is None else expectations,
            ),
        )
    assert caught.value.error_code == PAPER_SLIDE_EXTRACTION_FAILED
    assert caught.value.issue_code == issue_code
    assert str(caught.value) == f"{PAPER_SLIDE_EXTRACTION_FAILED}:{issue_code}"
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


def test_valid_result_is_bound_normalized_and_immutable() -> None:
    result = _validate()
    assert result.pdf_sha256 == hashlib.sha256(_pdf()).hexdigest()
    assert result.extractor == derive_visible_text_extractor(TEST_ONLY_ENGINE_ATTESTATION)
    assert result.options == _options()
    assert result.engine == TEST_ONLY_ENGINE_ATTESTATION
    assert tuple(page.page for page in result.pages) == (1, 2)
    assert tuple(chunk.chunk_id for chunk in result.chunks) == ("p001-c01", "p002-c01")
    assert tuple(result.page_by_number) == (1, 2)
    with pytest.raises(TypeError):
        cast(Any, result.page_by_number)[1] = result.pages[0]
    with pytest.raises(AttributeError):
        cast(Any, result.chunks[0]).text = "changed"
    assert FIRST_TEXT[:40] not in repr(result)


def test_extractor_is_exactly_derived_from_authorized_attestation() -> None:
    expected = (
        "visible-text-v1:1.26.3+5.5.0+eng-" + TEST_ONLY_ENGINE_ATTESTATION.language_data_sha256[:16]
    )
    assert derive_visible_text_extractor(TEST_ONLY_ENGINE_ATTESTATION) == expected

    class EvilEngine(VisibleTextEngineAttestation):
        pass

    with pytest.raises(VisibleTextContractError) as caught:
        derive_visible_text_extractor(EvilEngine(**asdict(TEST_ONLY_ENGINE_ATTESTATION)))
    assert caught.value.issue_code == "visible_text_engine_invalid"


def test_production_registry_is_fail_closed() -> None:
    with pytest.raises(VisibleTextContractError) as caught:
        validate_visible_text_result(_bytes(_payload()), _expectations())
    assert caught.value.issue_code == "visible_text_engine_not_authorized"


@pytest.mark.parametrize(
    ("payload", "issue"),
    [
        (b"", "visible_text_payload_size"),
        (b"[]", "visible_text_result_shape"),
        (b'{"a":1,"a":2}', "visible_text_json_duplicate_key"),
        (b'{"x":NaN}', "visible_text_json_non_finite"),
        (b"\xff", "visible_text_payload_utf8"),
        (b"{" + b'"x":[' * 18 + b"0" + b"]" * 18 + b"}", "visible_text_json_depth"),
    ],
)
def test_hostile_json_has_stable_bounded_failures(payload: bytes, issue: str) -> None:
    _assert_issue(payload, issue)


def test_payload_byte_limit_is_checked_before_decode(monkeypatch: pytest.MonkeyPatch) -> None:
    import paperpilot.paper_slides.visible_contract as module

    monkeypatch.setattr(module, "MAX_RESULT_BYTES", 8)
    _assert_issue(b"{" + b"x" * 8, "visible_text_payload_size")
    assert MAX_RESULT_BYTES >= MAX_TOTAL_TEXT_CODEPOINTS


def test_top_level_profile_options_engine_and_unknown_fields_are_closed() -> None:
    for field in ("profile", "options", "engine", "pages", "chunks"):
        value = _payload()
        del value[field]
        _assert_issue(_bytes(value), "visible_text_result_shape")
    value = _payload()
    value["unknown"] = True
    _assert_issue(_bytes(value), "visible_text_result_shape")

    value = _payload()
    assert isinstance(value["options"], dict)
    value["options"]["unknown"] = 1
    _assert_issue(_bytes(value), "visible_text_options_invalid")
    value = _payload()
    assert isinstance(value["engine"], dict)
    value["engine"]["unknown"] = 1
    _assert_issue(_bytes(value), "visible_text_engine_invalid")


def test_pdf_page_profile_options_and_engine_are_bound_to_parent() -> None:
    mutations = (
        ("pdf_sha256", "f" * 64, "visible_text_pdf_binding_invalid"),
        ("page_count", 1, "visible_text_page_manifest_invalid"),
        ("profile", "visible-text-v2", "visible_text_profile_invalid"),
        ("extractor", "visible-text-v1:forged", "visible_text_engine_invalid"),
    )
    for field, replacement, issue in mutations:
        value = _payload()
        value[field] = replacement
        _assert_issue(_bytes(value), issue)

    value = _payload()
    assert isinstance(value["options"], dict)
    value["options"]["render_dpi"] = 179
    _assert_issue(_bytes(value), "visible_text_options_invalid")

    value = _payload()
    assert isinstance(value["engine"], dict)
    value["engine"]["ocr_sha256"] = "f" * 64
    _assert_issue(_bytes(value), "visible_text_engine_not_authorized")


def test_every_hard_ceiling_is_fixed_in_defaults() -> None:
    options = _options()
    assert options.max_pdf_bytes == MAX_PDF_BYTES == 32 * 1024 * 1024
    assert options.max_pages == MAX_PAGES == 32
    assert options.render_dpi == MAX_RENDER_DPI == 180
    assert options.max_page_dimension_px == MAX_PAGE_DIMENSION_PX == 4096
    assert options.max_total_pixels == MAX_TOTAL_PIXELS == 100_000_000
    assert options.max_page_raster_bytes == MAX_PAGE_RASTER_BYTES == 32 * 1024 * 1024
    assert options.max_page_wall_milliseconds == MAX_PAGE_WALL_MILLISECONDS == 15_000
    assert options.max_total_wall_milliseconds == MAX_TOTAL_WALL_MILLISECONDS == 180_000
    assert options.max_page_text_codepoints == MAX_PAGE_TEXT_CODEPOINTS == 100_000
    assert options.max_total_text_codepoints == MAX_TOTAL_TEXT_CODEPOINTS == 1_500_000
    assert options.max_chunks == MAX_CHUNKS == 64


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("max_pdf_bytes", 32 * 1024 * 1024 + 1),
        ("max_pages", 33),
        ("render_dpi", 181),
        ("render_dpi", True),
        ("max_page_dimension_px", 4097),
        ("max_total_pixels", 100_000_001),
        ("max_page_raster_bytes", 32 * 1024 * 1024 + 1),
        ("max_page_wall_milliseconds", 15_001),
        ("max_total_wall_milliseconds", 180_001),
        ("max_page_text_codepoints", 100_001),
        ("max_total_text_codepoints", 1_500_001),
        ("max_chunks", 65),
        ("minimum_median_confidence", math.nan),
        ("minimum_median_confidence", 49.9),
        ("minimum_visible_character_ratio", 1.1),
        ("minimum_visible_character_ratio", 0.49),
    ],
)
def test_parent_options_cannot_raise_or_corrupt_limits(field: str, replacement: object) -> None:
    expectations = _expectations()
    bad_options = _options()
    object.__setattr__(bad_options, field, replacement)
    object.__setattr__(expectations, "options", bad_options)
    _assert_issue(_bytes(_payload()), "visible_text_expectations_invalid", expectations)


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("width_px", 4097),
        ("height_px", 4097),
        ("pixel_count", 1_920_001),
        ("raster_bytes", 32 * 1024 * 1024 + 1),
        ("wall_time_milliseconds", 15_001),
        ("word_count", -1),
        ("median_confidence", 101),
        ("visible_character_ratio", -0.1),
    ],
)
def test_page_dimensions_pixels_resource_and_quality_bounds(
    field: str, replacement: object
) -> None:
    value = _payload()
    pages = value["pages"]
    assert isinstance(pages, list) and isinstance(pages[0], dict)
    pages[0][field] = replacement
    _assert_issue(_bytes(value), "visible_text_page_manifest_invalid")


def test_non_finite_page_metric_is_rejected_during_json_decode() -> None:
    value = _payload()
    pages = value["pages"]
    assert isinstance(pages, list) and isinstance(pages[0], dict)
    pages[0]["visible_character_ratio"] = math.inf
    _assert_issue(_bytes(value), "visible_text_json_non_finite")


def test_aggregate_pixels_wall_text_and_chunk_limits_are_recomputed() -> None:
    for field, replacement, issue in (
        ("total_pixels", 1, "visible_text_resource_totals_invalid"),
        ("total_wall_time_milliseconds", 1, "visible_text_resource_totals_invalid"),
        ("total_text_codepoints", 1, "visible_text_text_totals_invalid"),
        ("ocr_page_count", 1, "visible_text_page_manifest_invalid"),
    ):
        value = _payload()
        value[field] = replacement
        _assert_issue(_bytes(value), issue)


def test_physical_page_and_chunk_order_ids_and_hashes_are_exact() -> None:
    value = _payload()
    assert isinstance(value["pages"], list)
    value["pages"].reverse()
    _assert_issue(_bytes(value), "visible_text_page_manifest_invalid")

    value = _payload()
    assert isinstance(value["chunks"], list)
    value["chunks"].reverse()
    _assert_issue(_bytes(value), "visible_text_chunk_invalid")

    for field, replacement in (
        ("chunk_id", "p001-c02"),
        ("page", 2),
        ("sha256", "0" * 64),
        ("section_hint", "forged"),
    ):
        value = _payload()
        assert isinstance(value["chunks"], list) and isinstance(value["chunks"][0], dict)
        value["chunks"][0][field] = replacement
        _assert_issue(_bytes(value), "visible_text_chunk_invalid")

    value = _payload()
    assert isinstance(value["pages"], list) and isinstance(value["pages"][0], dict)
    value["pages"][0]["text_sha256"] = "0" * 64
    _assert_issue(_bytes(value), "visible_text_page_manifest_invalid")


def test_text_must_be_exact_existing_sanitizer_output_and_meet_minimum() -> None:
    value = _payload()
    assert isinstance(value["chunks"], list) and isinstance(value["chunks"][0], dict)
    value["chunks"][0]["text"] = "  not normalized  "
    value["chunks"][0]["sha256"] = hashlib.sha256(b"  not normalized  ").hexdigest()
    _assert_issue(_bytes(value), "visible_text_chunk_invalid")
    assert _sanitize_page_text("  not normalized  ") == "not normalized"

    value = _payload()
    assert isinstance(value["chunks"], list) and isinstance(value["chunks"][1], dict)
    value["chunks"][1]["text"] = SECOND_TEXT[:-20]
    value["chunks"][1]["sha256"] = hashlib.sha256(SECOND_TEXT[:-20].encode()).hexdigest()
    _assert_issue(_bytes(value), "visible_text_page_manifest_invalid")


@pytest.mark.parametrize(
    "unsafe_text",
    [
        "https://attacker.invalid/collect",
        "file:///etc/passwd",
        "/Users/person/.aws/credentials",
        "/secrets/worker/token.txt",
        "../../private/token.txt",
        r"C:\\Users\\person\\secret.txt",
        "authorization=Bearer secret-token-value",
        "api_key=sk-1234567890abcdef",
    ],
)
def test_visible_urls_paths_and_secret_shaped_paper_text_are_retained_but_repr_redacted(
    unsafe_text: str,
) -> None:
    value = _payload()
    text = FIRST_TEXT + " " + unsafe_text
    assert isinstance(value["chunks"], list) and isinstance(value["chunks"][0], dict)
    value["chunks"][0] = _chunk("p001-c01", 1, text)
    assert isinstance(value["pages"], list) and isinstance(value["pages"][0], dict)
    value["pages"][0]["text_codepoints"] = len(text)
    value["pages"][0]["text_sha256"] = hashlib.sha256(text.encode()).hexdigest()
    value["total_text_codepoints"] = len(text) + len(SECOND_TEXT)
    result = _validate(value)
    assert result.chunks[0].text == text
    assert unsafe_text not in repr(result)


def test_unknown_nested_fields_and_boolean_numeric_values_are_rejected() -> None:
    for container in ("pages", "chunks"):
        value = _payload()
        rows = value[container]
        assert isinstance(rows, list) and isinstance(rows[0], dict)
        rows[0]["unknown"] = 1
        issue = (
            "visible_text_page_manifest_invalid"
            if container == "pages"
            else "visible_text_chunk_invalid"
        )
        _assert_issue(_bytes(value), issue)
    value = _payload()
    assert isinstance(value["pages"], list) and isinstance(value["pages"][0], dict)
    value["pages"][0]["word_count"] = True
    _assert_issue(_bytes(value), "visible_text_page_manifest_invalid")


def test_hostile_expectation_subclasses_cycles_and_custom_objects_are_redacted() -> None:
    class EvilExpectations(VisibleTextExpectations):
        pass

    evil = EvilExpectations(**asdict(_expectations()))
    _assert_issue(_bytes(_payload()), "visible_text_expectations_invalid", evil)

    expectations = _expectations()
    object.__setattr__(expectations, "options", expectations)
    _assert_issue(_bytes(_payload()), "visible_text_expectations_invalid", expectations)

    class Custom:
        def __repr__(self) -> str:
            raise AssertionError("repr must not be called")

    expectations = _expectations()
    object.__setattr__(expectations, "engine_id", Custom())
    _assert_issue(_bytes(_payload()), "visible_text_expectations_invalid", expectations)

    class BytesSubclass(bytes):
        pass

    expectations = _expectations()
    object.__setattr__(expectations, "pdf_bytes", BytesSubclass(_pdf()))
    _assert_issue(_bytes(_payload()), "visible_text_expectations_invalid", expectations)


def test_output_does_not_retain_raster_or_bbox_fields() -> None:
    result = _validate()
    assert not hasattr(result.pages[0], "raster")
    assert not hasattr(result.pages[0], "bbox")
    assert not hasattr(result.chunks[0], "bbox")
    assert result.pages[0].raster_sha256

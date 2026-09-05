"""Closed VT0 contract for render/OCR visible-text worker output.

This module does not rasterize PDFs or invoke OCR.  It is the stdlib-only,
trusted-parent validator for bytes returned by that future worker.  Production
authorization is intentionally empty until a dedicated image passes the VT4
release gates; the private fixture seam exists only for deterministic tests.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field, fields
from types import MappingProxyType
from typing import Any, NoReturn, cast

from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_EXTRACTION_FAILED,
    PAPER_SLIDE_EXTRACTION_INSUFFICIENT,
)
from paperpilot.paper_slides.extract import MAX_SECTION_HINT_CODEPOINTS, _sanitize_page_text

VISIBLE_TEXT_SCHEMA_VERSION = "visible-text-result-v1"
VISIBLE_TEXT_PROFILE = "visible-text-v1"

MAX_PDF_BYTES = 32 * 1024 * 1024
MAX_PAGES = 32
MAX_RENDER_DPI = 180
MAX_PAGE_DIMENSION_PX = 4096
MAX_TOTAL_PIXELS = 100_000_000
MAX_PAGE_RASTER_BYTES = 32 * 1024 * 1024
MAX_PAGE_WALL_MILLISECONDS = 15_000
MAX_TOTAL_WALL_MILLISECONDS = 180_000
MAX_PAGE_TEXT_CODEPOINTS = 100_000
MAX_TOTAL_TEXT_CODEPOINTS = 1_500_000
MAX_CHUNKS = 64
MIN_TOTAL_TEXT_CODEPOINTS = 500
MIN_MEDIAN_CONFIDENCE = 50.0
MIN_VISIBLE_CHARACTER_RATIO = 0.50
MAX_RESULT_BYTES = 32 * 1024 * 1024

_MAX_JSON_DEPTH = 16
_MAX_JSON_CONTAINERS = 512
_MAX_JSON_TOKENS = 16_384
_MAX_JSON_SCALAR_CODEPOINTS = MAX_TOTAL_TEXT_CODEPOINTS + 1
_MAX_JSON_NUMBER_CHARACTERS = 128
_ENGINE_HASH_PREFIX_LENGTH = 16

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ENGINE_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")
_VERSION_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?$")
_CHUNK_ID_RE = re.compile(r"^p(?:00[1-9]|0[1-2][0-9]|03[0-2])-c(?:0[1-9]|[1-5][0-9]|6[0-4])$")

_TOP_FIELDS = frozenset(
    {
        "schema_version",
        "profile",
        "pdf_sha256",
        "page_count",
        "ocr_page_count",
        "extractor",
        "options",
        "engine",
        "pages",
        "chunks",
        "total_pixels",
        "total_wall_time_milliseconds",
        "total_text_codepoints",
    }
)
_PAGE_FIELDS = frozenset(
    {
        "page",
        "width_px",
        "height_px",
        "pixel_count",
        "raster_bytes",
        "raster_sha256",
        "wall_time_milliseconds",
        "word_count",
        "median_confidence",
        "visible_character_ratio",
        "text_codepoints",
        "text_sha256",
        "chunk_ids",
    }
)
_CHUNK_FIELDS = frozenset({"chunk_id", "page", "text", "sha256", "section_hint"})


class VisibleTextContractError(ValueError):
    """Stable, non-sensitive VT0 validation failure."""

    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__(f"{error_code}:{issue_code}")


class _VisibleTextIssueError(Exception):
    def __init__(
        self,
        issue_code: str,
        error_code: str = PAPER_SLIDE_EXTRACTION_FAILED,
    ) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__()


@dataclass(frozen=True, slots=True)
class VisibleTextOptions:
    """Effective worker limits, each bounded by the visible-text-v1 ceiling."""

    max_pdf_bytes: int = MAX_PDF_BYTES
    max_pages: int = MAX_PAGES
    render_dpi: int = MAX_RENDER_DPI
    max_page_dimension_px: int = MAX_PAGE_DIMENSION_PX
    max_total_pixels: int = MAX_TOTAL_PIXELS
    max_page_raster_bytes: int = MAX_PAGE_RASTER_BYTES
    max_page_wall_milliseconds: int = MAX_PAGE_WALL_MILLISECONDS
    max_total_wall_milliseconds: int = MAX_TOTAL_WALL_MILLISECONDS
    max_page_text_codepoints: int = MAX_PAGE_TEXT_CODEPOINTS
    max_total_text_codepoints: int = MAX_TOTAL_TEXT_CODEPOINTS
    max_chunks: int = MAX_CHUNKS
    language: str = "eng"
    minimum_page_word_count: int = 1
    minimum_median_confidence: float = MIN_MEDIAN_CONFIDENCE
    minimum_visible_character_ratio: float = MIN_VISIBLE_CHARACTER_RATIO
    minimum_total_text_codepoints: int = MIN_TOTAL_TEXT_CODEPOINTS


@dataclass(frozen=True, slots=True)
class VisibleTextEngineAttestation:
    """Exact credential-free engine identity approved by repository code."""

    engine_id: str
    rasterizer_id: str
    rasterizer_version: str
    rasterizer_sha256: str
    ocr_id: str
    ocr_version: str
    ocr_sha256: str
    language_data_id: str
    language_data_version: str
    language_data_sha256: str
    credential_mode: str = "none"
    network_mode: str = "none"
    runtime_downloads: bool = False


@dataclass(frozen=True, slots=True)
class VisibleTextExpectations:
    """Trusted parent inputs to which one worker response must be bound."""

    pdf_bytes: bytes = field(repr=False)
    page_count: int
    options: VisibleTextOptions
    engine_id: str


@dataclass(frozen=True, slots=True)
class VisibleTextChunk:
    chunk_id: str
    page: int
    text: str = field(repr=False)
    sha256: str
    section_hint: str | None = field(repr=False)


@dataclass(frozen=True, slots=True)
class VisibleTextPageManifest:
    page: int
    width_px: int
    height_px: int
    pixel_count: int
    raster_bytes: int
    raster_sha256: str
    wall_time_milliseconds: int
    word_count: int
    median_confidence: float
    visible_character_ratio: float
    text_codepoints: int
    text_sha256: str
    chunk_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class VisibleTextResult:
    schema_version: str
    profile: str
    pdf_sha256: str
    page_count: int
    ocr_page_count: int
    extractor: str
    options: VisibleTextOptions
    engine: VisibleTextEngineAttestation
    pages: tuple[VisibleTextPageManifest, ...]
    chunks: tuple[VisibleTextChunk, ...] = field(repr=False)
    total_pixels: int
    total_wall_time_milliseconds: int
    total_text_codepoints: int
    page_by_number: Mapping[int, VisibleTextPageManifest] = field(repr=False)


# Deliberately not a production authorization.  These hashes are deterministic
# test fixtures and do not attest any shipped binary or image.
TEST_ONLY_ENGINE_ATTESTATION = VisibleTextEngineAttestation(
    engine_id="paperpilot-visible-text-test-fixture-v1",
    rasterizer_id="mutool",
    rasterizer_version="1.26.3",
    rasterizer_sha256="1" * 64,
    ocr_id="tesseract",
    ocr_version="5.5.0",
    ocr_sha256="2" * 64,
    language_data_id="tessdata-best-eng",
    language_data_version="4.1.0",
    language_data_sha256="3" * 64,
)

_PRODUCTION_ENGINE_REGISTRY: Mapping[str, VisibleTextEngineAttestation] = MappingProxyType({})
_TEST_ONLY_ENGINE_REGISTRY: Mapping[str, VisibleTextEngineAttestation] = MappingProxyType(
    {TEST_ONLY_ENGINE_ATTESTATION.engine_id: TEST_ONLY_ENGINE_ATTESTATION}
)


def _issue(
    issue_code: str,
    error_code: str = PAPER_SLIDE_EXTRACTION_FAILED,
) -> NoReturn:
    raise _VisibleTextIssueError(issue_code, error_code)


def _exact_dict(value: object, keys: frozenset[str], issue_code: str) -> dict[str, Any]:
    if type(value) is not dict or frozenset(value) != keys:
        _issue(issue_code)
    return value


def _exact_int(value: object, *, minimum: int, maximum: int, issue_code: str) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        _issue(issue_code)
    return value


def _finite_number(
    value: object,
    *,
    minimum: float,
    maximum: float,
    issue_code: str,
) -> float:
    if type(value) not in (int, float):
        _issue(issue_code)
    converted = float(cast("int | float", value))
    if not math.isfinite(converted) or not minimum <= converted <= maximum:
        _issue(issue_code)
    return converted


def _sha256(value: object, issue_code: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        _issue(issue_code)
    return value


def _bounded_parse_int(value: str) -> int:
    if not 1 <= len(value) <= _MAX_JSON_NUMBER_CHARACTERS:
        raise ValueError("integer length")
    return int(value, 10)


def _bounded_parse_float(value: str) -> float:
    if not 1 <= len(value) <= _MAX_JSON_NUMBER_CHARACTERS:
        raise ValueError("float length")
    converted = float(value)
    if not math.isfinite(converted):
        raise _VisibleTextIssueError("visible_text_json_non_finite")
    return converted


def _duplicate_key_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _issue("visible_text_json_duplicate_key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> NoReturn:
    _issue("visible_text_json_non_finite")


def _preflight_json(payload: object) -> str:
    if type(payload) is not bytes or not payload or len(payload) > MAX_RESULT_BYTES:
        _issue("visible_text_payload_size")
    try:
        text = payload.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        _issue("visible_text_payload_utf8")

    depth = 0
    containers = 0
    tokens = 0
    position = 0
    while position < len(text):
        character = text[position]
        if character.isspace():
            position += 1
            continue
        if character in "{[":
            depth += 1
            containers += 1
            tokens += 1
            if depth > _MAX_JSON_DEPTH:
                _issue("visible_text_json_depth")
            if containers > _MAX_JSON_CONTAINERS or tokens > _MAX_JSON_TOKENS:
                _issue("visible_text_json_complexity")
            position += 1
            continue
        if character in "}]":
            depth -= 1
            tokens += 1
            if depth < 0:
                _issue("visible_text_json_syntax")
            position += 1
            continue
        if character in ",:":
            tokens += 1
            position += 1
            continue
        if character == '"':
            tokens += 1
            position += 1
            scalar_size = 0
            closed = False
            while position < len(text):
                current = text[position]
                if current == '"':
                    closed = True
                    position += 1
                    break
                if ord(current) < 0x20:
                    _issue("visible_text_json_syntax")
                if current == "\\":
                    position += 1
                    if position >= len(text) or text[position] not in '"\\/bfnrtu':
                        _issue("visible_text_json_syntax")
                    if text[position] == "u":
                        if position + 4 >= len(text) or any(
                            digit not in "0123456789abcdefABCDEF"
                            for digit in text[position + 1 : position + 5]
                        ):
                            _issue("visible_text_json_syntax")
                        position += 4
                scalar_size += 1
                if scalar_size > _MAX_JSON_SCALAR_CODEPOINTS:
                    _issue("visible_text_json_scalar")
                position += 1
            if not closed:
                _issue("visible_text_json_syntax")
            continue
        tokens += 1
        start = position
        while position < len(text) and text[position] not in '{}[],.:" \t\r\n':
            position += 1
            if position - start > _MAX_JSON_NUMBER_CHARACTERS:
                _issue("visible_text_json_scalar")
        if position == start:
            # A dot is permitted inside a number but cannot start a JSON token.
            position += 1
        if tokens > _MAX_JSON_TOKENS:
            _issue("visible_text_json_complexity")
    if depth != 0:
        _issue("visible_text_json_syntax")
    return text


def _load_json(payload: object) -> object:
    text = _preflight_json(payload)
    try:
        return json.loads(
            text,
            object_pairs_hook=_duplicate_key_hook,
            parse_int=_bounded_parse_int,
            parse_float=_bounded_parse_float,
            parse_constant=_reject_constant,
        )
    except _VisibleTextIssueError:
        raise
    except (
        UnicodeError,
        json.JSONDecodeError,
        OverflowError,
        RecursionError,
        TypeError,
        ValueError,
    ):
        _issue("visible_text_json_syntax")


def _snapshot_options(value: object, issue_code: str) -> VisibleTextOptions:
    if type(value) is not VisibleTextOptions:
        _issue(issue_code)
    option = value
    integer_ceilings = (
        (option.max_pdf_bytes, MAX_PDF_BYTES),
        (option.max_pages, MAX_PAGES),
        (option.render_dpi, MAX_RENDER_DPI),
        (option.max_page_dimension_px, MAX_PAGE_DIMENSION_PX),
        (option.max_total_pixels, MAX_TOTAL_PIXELS),
        (option.max_page_raster_bytes, MAX_PAGE_RASTER_BYTES),
        (option.max_page_wall_milliseconds, MAX_PAGE_WALL_MILLISECONDS),
        (option.max_total_wall_milliseconds, MAX_TOTAL_WALL_MILLISECONDS),
        (option.max_page_text_codepoints, MAX_PAGE_TEXT_CODEPOINTS),
        (option.max_total_text_codepoints, MAX_TOTAL_TEXT_CODEPOINTS),
        (option.max_chunks, MAX_CHUNKS),
    )
    if any(type(item) is not int or not 1 <= item <= ceiling for item, ceiling in integer_ceilings):
        _issue(issue_code)
    if (
        type(option.language) is not str
        or option.language != "eng"
        or option.render_dpi != MAX_RENDER_DPI
        or type(option.minimum_page_word_count) is not int
        or not 1 <= option.minimum_page_word_count <= option.max_page_text_codepoints
        or type(option.minimum_total_text_codepoints) is not int
        or not MIN_TOTAL_TEXT_CODEPOINTS
        <= option.minimum_total_text_codepoints
        <= option.max_total_text_codepoints
    ):
        _issue(issue_code)
    median = _finite_number(
        option.minimum_median_confidence,
        minimum=MIN_MEDIAN_CONFIDENCE,
        maximum=100.0,
        issue_code=issue_code,
    )
    ratio = _finite_number(
        option.minimum_visible_character_ratio,
        minimum=MIN_VISIBLE_CHARACTER_RATIO,
        maximum=1.0,
        issue_code=issue_code,
    )
    return VisibleTextOptions(
        max_pdf_bytes=option.max_pdf_bytes,
        max_pages=option.max_pages,
        render_dpi=option.render_dpi,
        max_page_dimension_px=option.max_page_dimension_px,
        max_total_pixels=option.max_total_pixels,
        max_page_raster_bytes=option.max_page_raster_bytes,
        max_page_wall_milliseconds=option.max_page_wall_milliseconds,
        max_total_wall_milliseconds=option.max_total_wall_milliseconds,
        max_page_text_codepoints=option.max_page_text_codepoints,
        max_total_text_codepoints=option.max_total_text_codepoints,
        max_chunks=option.max_chunks,
        language="eng",
        minimum_page_word_count=option.minimum_page_word_count,
        minimum_median_confidence=median,
        minimum_visible_character_ratio=ratio,
        minimum_total_text_codepoints=option.minimum_total_text_codepoints,
    )


def _snapshot_expectations(value: object) -> VisibleTextExpectations:
    if type(value) is not VisibleTextExpectations:
        _issue("visible_text_expectations_invalid")
    options = _snapshot_options(value.options, "visible_text_expectations_invalid")
    if (
        type(value.pdf_bytes) is not bytes
        or not 5 <= len(value.pdf_bytes) <= options.max_pdf_bytes
        or not value.pdf_bytes.startswith(b"%PDF-")
        or type(value.page_count) is not int
        or not 1 <= value.page_count <= options.max_pages
        or type(value.engine_id) is not str
        or _ENGINE_ID_RE.fullmatch(value.engine_id) is None
    ):
        _issue("visible_text_expectations_invalid")
    return VisibleTextExpectations(
        pdf_bytes=bytes(value.pdf_bytes),
        page_count=value.page_count,
        options=options,
        engine_id=value.engine_id,
    )


def _validate_engine_shape(value: object) -> VisibleTextEngineAttestation:
    keys = frozenset(item.name for item in fields(VisibleTextEngineAttestation))
    row = _exact_dict(value, keys, "visible_text_engine_invalid")
    string_fields = tuple(key for key in keys if key not in {"runtime_downloads"})
    if any(type(row[key]) is not str for key in string_fields):
        _issue("visible_text_engine_invalid")
    if (
        _ENGINE_ID_RE.fullmatch(row["engine_id"]) is None
        or _ENGINE_ID_RE.fullmatch(row["rasterizer_id"]) is None
        or _ENGINE_ID_RE.fullmatch(row["ocr_id"]) is None
        or _ENGINE_ID_RE.fullmatch(row["language_data_id"]) is None
        or any(
            _VERSION_RE.fullmatch(row[key]) is None
            for key in (
                "rasterizer_version",
                "ocr_version",
                "language_data_version",
            )
        )
        or any(
            _SHA256_RE.fullmatch(row[key]) is None
            for key in (
                "rasterizer_sha256",
                "ocr_sha256",
                "language_data_sha256",
            )
        )
        or row["credential_mode"] != "none"
        or row["network_mode"] != "none"
        or type(row["runtime_downloads"]) is not bool
        or row["runtime_downloads"]
    ):
        _issue("visible_text_engine_invalid")
    return VisibleTextEngineAttestation(**row)


def _snapshot_authorized_engine(
    value: object,
    expected_engine_id: str,
    registry: Mapping[str, VisibleTextEngineAttestation],
) -> VisibleTextEngineAttestation:
    engine = _validate_engine_shape(value)
    if engine.engine_id != expected_engine_id:
        _issue("visible_text_engine_not_authorized")
    authorized = registry.get(expected_engine_id)
    if (
        authorized is None
        or type(authorized) is not VisibleTextEngineAttestation
        or engine != authorized
    ):
        _issue("visible_text_engine_not_authorized")
    return VisibleTextEngineAttestation(
        **{item.name: getattr(engine, item.name) for item in fields(engine)}
    )


def derive_visible_text_extractor(engine: VisibleTextEngineAttestation) -> str:
    """Derive the exact v1 extractor identifier from one exact attestation."""

    failure: tuple[str, str] | None = None
    try:
        if type(engine) is not VisibleTextEngineAttestation:
            _issue("visible_text_engine_invalid")
        shaped = _validate_engine_shape(
            {item.name: getattr(engine, item.name) for item in fields(engine)}
        )
        return (
            f"{VISIBLE_TEXT_PROFILE}:{shaped.rasterizer_version}+{shaped.ocr_version}"
            f"+eng-{shaped.language_data_sha256[:_ENGINE_HASH_PREFIX_LENGTH]}"
        )
    except _VisibleTextIssueError as error:
        failure = (error.error_code, error.issue_code)
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        failure = (PAPER_SLIDE_EXTRACTION_FAILED, "visible_text_engine_invalid")
    assert failure is not None
    raise VisibleTextContractError(*failure) from None


def _options_from_json(value: object, expected: VisibleTextOptions) -> VisibleTextOptions:
    keys = frozenset(item.name for item in fields(VisibleTextOptions))
    row = _exact_dict(value, keys, "visible_text_options_invalid")
    expected_values = {item.name: getattr(expected, item.name) for item in fields(expected)}
    if any(
        type(row[key]) is not type(expected_value) or row[key] != expected_value
        for key, expected_value in expected_values.items()
    ):
        _issue("visible_text_options_invalid")
    return expected


def _decode_chunks(
    value: object, options: VisibleTextOptions, page_count: int
) -> tuple[VisibleTextChunk, ...]:
    if type(value) is not list or not 1 <= len(value) <= options.max_chunks:
        _issue("visible_text_chunk_invalid")
    chunks: list[VisibleTextChunk] = []
    page_counts: dict[int, int] = {}
    seen_ids: set[str] = set()
    seen_text: set[str] = set()
    previous_page = 0
    for item in value:
        row = _exact_dict(item, _CHUNK_FIELDS, "visible_text_chunk_invalid")
        page = _exact_int(
            row["page"], minimum=1, maximum=page_count, issue_code="visible_text_chunk_invalid"
        )
        chunk_id = row["chunk_id"]
        text = row["text"]
        digest = row["sha256"]
        hint = row["section_hint"]
        number = page_counts.get(page, 0) + 1
        expected_id = f"p{page:03d}-c{number:02d}"
        if (
            page < previous_page
            or type(chunk_id) is not str
            or _CHUNK_ID_RE.fullmatch(chunk_id) is None
            or chunk_id != expected_id
            or chunk_id in seen_ids
            or type(text) is not str
            or not text
            or len(text) > options.max_page_text_codepoints
            or _sanitize_page_text(text) != text
            or text in seen_text
            or type(digest) is not str
            or _SHA256_RE.fullmatch(digest) is None
            or hashlib.sha256(text.encode("utf-8")).hexdigest() != digest
        ):
            _issue("visible_text_chunk_invalid")
        expected_hint = (
            text.partition("\n")[0].strip()[:MAX_SECTION_HINT_CODEPOINTS].rstrip() or None
        )
        if (hint is not None and type(hint) is not str) or hint != expected_hint:
            _issue("visible_text_chunk_invalid")
        chunks.append(
            VisibleTextChunk(
                chunk_id=chunk_id,
                page=page,
                text=text,
                sha256=digest,
                section_hint=hint,
            )
        )
        page_counts[page] = number
        seen_ids.add(chunk_id)
        seen_text.add(text)
        previous_page = page
    return tuple(chunks)


def _decode_pages(
    value: object,
    *,
    chunks: tuple[VisibleTextChunk, ...],
    page_count: int,
    ocr_page_count: int,
    options: VisibleTextOptions,
) -> tuple[VisibleTextPageManifest, ...]:
    if type(value) is not list or len(value) != ocr_page_count or not value:
        _issue("visible_text_page_manifest_invalid")
    chunks_by_page: dict[int, list[VisibleTextChunk]] = {}
    for chunk in chunks:
        chunks_by_page.setdefault(chunk.page, []).append(chunk)
    pages: list[VisibleTextPageManifest] = []
    previous_page = 0
    for item in value:
        row = _exact_dict(item, _PAGE_FIELDS, "visible_text_page_manifest_invalid")
        page = _exact_int(
            row["page"],
            minimum=1,
            maximum=page_count,
            issue_code="visible_text_page_manifest_invalid",
        )
        width = _exact_int(
            row["width_px"],
            minimum=1,
            maximum=options.max_page_dimension_px,
            issue_code="visible_text_page_manifest_invalid",
        )
        height = _exact_int(
            row["height_px"],
            minimum=1,
            maximum=options.max_page_dimension_px,
            issue_code="visible_text_page_manifest_invalid",
        )
        pixel_count = _exact_int(
            row["pixel_count"],
            minimum=1,
            maximum=options.max_total_pixels,
            issue_code="visible_text_page_manifest_invalid",
        )
        raster_bytes = _exact_int(
            row["raster_bytes"],
            minimum=1,
            maximum=options.max_page_raster_bytes,
            issue_code="visible_text_page_manifest_invalid",
        )
        wall = _exact_int(
            row["wall_time_milliseconds"],
            minimum=0,
            maximum=options.max_page_wall_milliseconds,
            issue_code="visible_text_page_manifest_invalid",
        )
        words = _exact_int(
            row["word_count"],
            minimum=options.minimum_page_word_count,
            maximum=options.max_page_text_codepoints,
            issue_code="visible_text_page_manifest_invalid",
        )
        median = _finite_number(
            row["median_confidence"],
            minimum=options.minimum_median_confidence,
            maximum=100.0,
            issue_code="visible_text_page_manifest_invalid",
        )
        visible_ratio = _finite_number(
            row["visible_character_ratio"],
            minimum=options.minimum_visible_character_ratio,
            maximum=1.0,
            issue_code="visible_text_page_manifest_invalid",
        )
        raster_sha256 = _sha256(row["raster_sha256"], "visible_text_page_manifest_invalid")
        text_sha256 = _sha256(row["text_sha256"], "visible_text_page_manifest_invalid")
        page_chunks = chunks_by_page.get(page)
        chunk_ids = row["chunk_ids"]
        if (
            page <= previous_page
            or pixel_count != width * height
            or not page_chunks
            or type(chunk_ids) is not list
            or any(type(chunk_id) is not str for chunk_id in chunk_ids)
            or chunk_ids != [chunk.chunk_id for chunk in page_chunks]
        ):
            _issue("visible_text_page_manifest_invalid")
        joined_text = "\n\n".join(chunk.text for chunk in page_chunks)
        text_codepoints = _exact_int(
            row["text_codepoints"],
            minimum=1,
            maximum=options.max_page_text_codepoints,
            issue_code="visible_text_page_manifest_invalid",
        )
        if (
            text_codepoints != len(joined_text)
            or text_sha256 != hashlib.sha256(joined_text.encode("utf-8")).hexdigest()
        ):
            _issue("visible_text_page_manifest_invalid")
        pages.append(
            VisibleTextPageManifest(
                page=page,
                width_px=width,
                height_px=height,
                pixel_count=pixel_count,
                raster_bytes=raster_bytes,
                raster_sha256=raster_sha256,
                wall_time_milliseconds=wall,
                word_count=words,
                median_confidence=median,
                visible_character_ratio=visible_ratio,
                text_codepoints=text_codepoints,
                text_sha256=text_sha256,
                chunk_ids=tuple(chunk_ids),
            )
        )
        previous_page = page
    if frozenset(chunks_by_page) != frozenset(page.page for page in pages):
        _issue("visible_text_page_manifest_invalid")
    return tuple(pages)


def _validate_result(
    payload: object,
    expectations: object,
    registry: Mapping[str, VisibleTextEngineAttestation],
) -> VisibleTextResult:
    expected = _snapshot_expectations(expectations)
    row = _exact_dict(_load_json(payload), _TOP_FIELDS, "visible_text_result_shape")
    if row["schema_version"] != VISIBLE_TEXT_SCHEMA_VERSION:
        _issue("visible_text_result_shape")
    if row["profile"] != VISIBLE_TEXT_PROFILE:
        _issue("visible_text_profile_invalid")
    pdf_sha256 = hashlib.sha256(expected.pdf_bytes).hexdigest()
    if row["pdf_sha256"] != pdf_sha256:
        _issue("visible_text_pdf_binding_invalid")
    options = _options_from_json(row["options"], expected.options)
    page_count = _exact_int(
        row["page_count"],
        minimum=1,
        maximum=options.max_pages,
        issue_code="visible_text_page_manifest_invalid",
    )
    if page_count != expected.page_count:
        _issue("visible_text_page_manifest_invalid")
    ocr_page_count = _exact_int(
        row["ocr_page_count"],
        minimum=1,
        maximum=page_count,
        issue_code="visible_text_page_manifest_invalid",
    )
    engine = _snapshot_authorized_engine(row["engine"], expected.engine_id, registry)
    extractor = row["extractor"]
    if type(extractor) is not str or extractor != (
        f"{VISIBLE_TEXT_PROFILE}:{engine.rasterizer_version}+{engine.ocr_version}"
        f"+eng-{engine.language_data_sha256[:_ENGINE_HASH_PREFIX_LENGTH]}"
    ):
        _issue("visible_text_engine_invalid")
    chunks = _decode_chunks(row["chunks"], options, page_count)
    pages = _decode_pages(
        row["pages"],
        chunks=chunks,
        page_count=page_count,
        ocr_page_count=ocr_page_count,
        options=options,
    )
    total_pixels = _exact_int(
        row["total_pixels"],
        minimum=1,
        maximum=options.max_total_pixels,
        issue_code="visible_text_resource_totals_invalid",
    )
    total_wall = _exact_int(
        row["total_wall_time_milliseconds"],
        minimum=0,
        maximum=options.max_total_wall_milliseconds,
        issue_code="visible_text_resource_totals_invalid",
    )
    total_text = _exact_int(
        row["total_text_codepoints"],
        minimum=1,
        maximum=options.max_total_text_codepoints,
        issue_code="visible_text_text_totals_invalid",
    )
    if total_pixels != sum(page.pixel_count for page in pages) or total_wall != sum(
        page.wall_time_milliseconds for page in pages
    ):
        _issue("visible_text_resource_totals_invalid")
    if total_text != sum(page.text_codepoints for page in pages):
        _issue("visible_text_text_totals_invalid")
    if total_text < options.minimum_total_text_codepoints:
        _issue("visible_text_insufficient", PAPER_SLIDE_EXTRACTION_INSUFFICIENT)
    page_by_number = MappingProxyType({page.page: page for page in pages})
    return VisibleTextResult(
        schema_version=VISIBLE_TEXT_SCHEMA_VERSION,
        profile=VISIBLE_TEXT_PROFILE,
        pdf_sha256=pdf_sha256,
        page_count=page_count,
        ocr_page_count=ocr_page_count,
        extractor=extractor,
        options=options,
        engine=engine,
        pages=pages,
        chunks=chunks,
        total_pixels=total_pixels,
        total_wall_time_milliseconds=total_wall,
        total_text_codepoints=total_text,
        page_by_number=page_by_number,
    )


def _public_validate(
    payload: object,
    expectations: object,
    registry: Mapping[str, VisibleTextEngineAttestation],
) -> VisibleTextResult:
    failure: tuple[str, str] | None = None
    try:
        return _validate_result(payload, expectations, registry)
    except _VisibleTextIssueError as error:
        failure = (error.error_code, error.issue_code)
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        failure = (PAPER_SLIDE_EXTRACTION_FAILED, "visible_text_contract_internal_failure")
    assert failure is not None
    raise VisibleTextContractError(*failure) from None


def validate_visible_text_result(
    payload: bytes,
    expectations: VisibleTextExpectations,
) -> VisibleTextResult:
    """Validate worker bytes against the production authorization registry."""

    return _public_validate(payload, expectations, _PRODUCTION_ENGINE_REGISTRY)


def _validate_visible_text_result_for_test(
    payload: bytes,
    expectations: VisibleTextExpectations,
) -> VisibleTextResult:
    """Exercise the closed contract with a non-production fixture engine."""

    return _public_validate(payload, expectations, _TEST_ONLY_ENGINE_REGISTRY)


__all__ = [
    "MAX_CHUNKS",
    "MAX_PAGES",
    "MAX_PAGE_DIMENSION_PX",
    "MAX_PAGE_RASTER_BYTES",
    "MAX_PAGE_TEXT_CODEPOINTS",
    "MAX_PAGE_WALL_MILLISECONDS",
    "MAX_PDF_BYTES",
    "MAX_RENDER_DPI",
    "MAX_RESULT_BYTES",
    "MAX_TOTAL_PIXELS",
    "MAX_TOTAL_TEXT_CODEPOINTS",
    "MAX_TOTAL_WALL_MILLISECONDS",
    "TEST_ONLY_ENGINE_ATTESTATION",
    "VISIBLE_TEXT_PROFILE",
    "VISIBLE_TEXT_SCHEMA_VERSION",
    "VisibleTextChunk",
    "VisibleTextContractError",
    "VisibleTextEngineAttestation",
    "VisibleTextExpectations",
    "VisibleTextOptions",
    "VisibleTextPageManifest",
    "VisibleTextResult",
    "derive_visible_text_extractor",
    "validate_visible_text_result",
]

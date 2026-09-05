"""Closed, bounded provider-output contracts for slide generation SD2.

Provider output and every text field in it are untrusted.  The public loaders
therefore accept bytes only, perform a bounded lexical pass before JSON
decoding, and return frozen producer-side objects only after exact structural
and citation-reference validation.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, NoReturn, TypeVar, cast

from paperpilot.paper_slides.contract import (
    AUTH_VALUE_RE,
    EMAIL_SEARCH_RE,
    KNOWN_TOKEN_RE,
    PAPER_SLIDE_CITATION_INVALID,
    PAPER_SLIDE_OUTPUT_INVALID,
    PAPER_SLIDE_SECRET_DETECTED,
    PRIVATE_KEY_RE,
    SECRET_ASSIGNMENT_RE,
    SECRET_QUERY_RE,
    UNSAFE_GENERATED_TEXT_RE,
    URL_USERINFO_RE,
)

MAX_PROVIDER_PAYLOAD_BYTES = 256 * 1024
MAX_JSON_DEPTH = 16
MAX_JSON_CONTAINERS = 512
MAX_JSON_SCALAR_CODEPOINTS = 8_000
MAX_JSON_STRUCTURAL_TOKENS = 16_000
MAX_CLAIMS = 12
MAX_PROVIDER_LIMITATIONS = 8
MAX_SLIDES = 10
MIN_FULL_TEXT_SLIDES = 6
MIN_ABSTRACT_ONLY_SLIDES = 4
MAX_ABSTRACT_ONLY_SLIDES = 6
MAX_BULLETS_PER_SLIDE = 12
MAX_NOTES_PER_SLIDE = 8

CHUNK_SUMMARY_VERSION = "chunk-summary-v1"
DECK_CONTENT_VERSION = "deck-content-v1"

_CLAIM_ID_RE = re.compile(r"^k(?:0[1-9]|1[0-2])$")
_RECORD_ID_RE = re.compile(
    r"^(?:abstract|p(?:00[1-9]|0[1-9][0-9]|1[01][0-9]|12[0-8])-c(?:0[1-9]|[1-9][0-9]))$"
)
_URL_RE = re.compile(
    r"(?:\b[a-z][a-z0-9+.-]*://|\b(?:file|mailto|tel|urn|doi|s3|gs):|\bwww\.)",
    re.IGNORECASE,
)
_CLAIM_KINDS = frozenset({"problem", "method", "evidence", "limitation", "conclusion"})
_SLIDE_KINDS = frozenset(
    {"title", "problem", "method", "evidence", "limitations", "conclusion", "context"}
)
_COVERAGE_KINDS = frozenset({"full_text", "abstract_only"})
_INVISIBLE_RANGES = (
    (0x034F, 0x034F),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFFA0, 0xFFA0),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
)
_T = TypeVar("_T")
_MISSING = object()


class SlideGeneratorContractError(ValueError):
    """A stable provider-output failure containing no untrusted values."""

    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__(f"{error_code}:{issue_code}")


class _ContractIssueError(Exception):
    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__()


@dataclass(frozen=True)
class GeneratorClaim:
    claim_id: str
    claim_kind: str
    text: str = field(repr=False)
    record_ids: tuple[str, ...] = field(repr=False)


@dataclass(frozen=True)
class ChunkSummary:
    schema_version: str
    claims: tuple[GeneratorClaim, ...]


@dataclass(frozen=True)
class GeneratorStatement:
    text: str = field(repr=False)
    record_ids: tuple[str, ...] = field(repr=False)


@dataclass(frozen=True)
class GeneratorSlide:
    kind: str
    title: str = field(repr=False)
    bullets: tuple[GeneratorStatement, ...] = field(repr=False)
    speaker_notes: tuple[GeneratorStatement, ...] = field(repr=False)


@dataclass(frozen=True)
class DeckContent:
    schema_version: str
    slides: tuple[GeneratorSlide, ...] = field(repr=False)
    limitations: tuple[str, ...] = field(repr=False)


def _issue(issue_code: str, error_code: str = PAPER_SLIDE_OUTPUT_INVALID) -> NoReturn:
    raise _ContractIssueError(error_code, issue_code)


def _preflight_json(data: bytes) -> str:
    if type(data) is not bytes:
        _issue("provider_payload_type")
    if not data or len(data) > MAX_PROVIDER_PAYLOAD_BYTES:
        _issue("provider_payload_size")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        _issue("provider_payload_utf8")

    depth = 0
    containers = 0
    scalars = 0
    structural = 0
    position = 0
    length = len(text)
    while position < length:
        character = text[position]
        if character.isspace():
            position += 1
            continue
        if character in "{[":
            depth += 1
            containers += 1
            structural += 1
            if depth > MAX_JSON_DEPTH:
                _issue("provider_json_depth")
            if containers > MAX_JSON_CONTAINERS:
                _issue("provider_json_containers")
            position += 1
            continue
        if character in "}]":
            depth -= 1
            structural += 1
            if depth < 0:
                _issue("provider_json_syntax")
            position += 1
            continue
        if character in ",:":
            structural += 1
            position += 1
            continue
        if character == '"':
            scalars += 1
            position += 1
            scalar_size = 0
            closed = False
            while position < length:
                current = text[position]
                if current == '"':
                    position += 1
                    closed = True
                    break
                if ord(current) < 0x20:
                    _issue("provider_json_syntax")
                if current == "\\":
                    position += 1
                    if position >= length or text[position] not in '"\\/bfnrtu':
                        _issue("provider_json_syntax")
                    if text[position] == "u":
                        if position + 4 >= length or any(
                            digit not in "0123456789abcdefABCDEF"
                            for digit in text[position + 1 : position + 5]
                        ):
                            _issue("provider_json_syntax")
                        position += 4
                scalar_size += 1
                if scalar_size > MAX_JSON_SCALAR_CODEPOINTS:
                    _issue("provider_json_scalar")
                position += 1
            if not closed:
                _issue("provider_json_syntax")
            continue

        scalars += 1
        start = position
        while position < length and text[position] not in '{}[],:" \t\r\n':
            position += 1
            if position - start > MAX_JSON_SCALAR_CODEPOINTS:
                _issue("provider_json_scalar")
        if position == start:
            _issue("provider_json_syntax")
        if scalars > MAX_JSON_STRUCTURAL_TOKENS:
            _issue("provider_json_structural_tokens")
        if structural + scalars > MAX_JSON_STRUCTURAL_TOKENS:
            _issue("provider_json_structural_tokens")

    if depth != 0:
        _issue("provider_json_syntax")
    if structural + scalars > MAX_JSON_STRUCTURAL_TOKENS:
        _issue("provider_json_structural_tokens")
    return text


def _duplicate_key_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _ContractIssueError(PAPER_SLIDE_OUTPUT_INVALID, "provider_json_duplicate_key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> NoReturn:
    _issue("provider_json_non_finite")


def _load_json(payload: bytes) -> object:
    text = _preflight_json(payload)
    try:
        value = json.loads(
            text,
            object_pairs_hook=_duplicate_key_hook,
            parse_constant=_reject_constant,
        )
    except _ContractIssueError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError, TypeError):
        _issue("provider_json_syntax")
    return value


def _exact_object(value: object, fields: frozenset[str], issue_code: str) -> dict[str, Any]:
    if type(value) is not dict or frozenset(value) != fields:
        _issue(issue_code)
    return value


def _known_record_order(known_record_ids: object) -> dict[str, int]:
    if type(known_record_ids) is not tuple or not known_record_ids:
        _issue("known_record_set_invalid", PAPER_SLIDE_CITATION_INVALID)
    order: dict[str, int] = {}
    previous_record_id = ""
    for index, record_id in enumerate(known_record_ids):
        if (
            type(record_id) is not str
            or _RECORD_ID_RE.fullmatch(record_id) is None
            or record_id in order
            or record_id <= previous_record_id
        ):
            _issue("known_record_set_invalid", PAPER_SLIDE_CITATION_INVALID)
        order[record_id] = index
        previous_record_id = record_id
    return order


def _safe_text(value: object, *, maximum: int, allow_newlines: bool = False) -> str:
    if type(value) is not str or not value or len(value) > maximum or not value.strip():
        _issue("generated_text_shape")
    if unicodedata.normalize("NFKC", value) != value:
        _issue("generated_text_normalization")
    for character in value:
        codepoint = ord(character)
        if (
            (character in "\r\n" and not allow_newlines)
            or unicodedata.category(character).startswith("C")
            or any(start <= codepoint <= end for start, end in _INVISIBLE_RANGES)
        ):
            _issue("generated_text_normalization")
    if value != value.strip() or "  " in value:
        _issue("generated_text_normalization")
    if UNSAFE_GENERATED_TEXT_RE.search(value) or _URL_RE.search(value):
        _issue("generated_text_unsafe")
    if any(
        pattern.search(value)
        for pattern in (
            AUTH_VALUE_RE,
            URL_USERINFO_RE,
            SECRET_QUERY_RE,
            KNOWN_TOKEN_RE,
            PRIVATE_KEY_RE,
            SECRET_ASSIGNMENT_RE,
        )
    ) or EMAIL_SEARCH_RE.search(value):
        _issue("generated_text_secret", PAPER_SLIDE_SECRET_DETECTED)
    return value


def _record_ids(value: object, known_order: dict[str, int]) -> tuple[str, ...]:
    if type(value) is not list or not value:
        _issue("record_ids_shape", PAPER_SLIDE_CITATION_INVALID)
    result: list[str] = []
    previous = -1
    for record_id in value:
        if type(record_id) is not str or record_id not in known_order:
            _issue("record_id_unknown", PAPER_SLIDE_CITATION_INVALID)
        position = known_order[record_id]
        if position <= previous:
            _issue("record_ids_order", PAPER_SLIDE_CITATION_INVALID)
        previous = position
        result.append(record_id)
    return tuple(result)


def _parse_statement(
    value: object, known_order: dict[str, int], *, maximum: int
) -> GeneratorStatement:
    item = _exact_object(value, frozenset({"text", "record_ids"}), "statement_fields")
    return GeneratorStatement(
        text=_safe_text(item["text"], maximum=maximum),
        record_ids=_record_ids(item["record_ids"], known_order),
    )


def _parse_chunk_summary(payload: bytes, known_record_ids: object) -> ChunkSummary:
    known_order = _known_record_order(known_record_ids)
    root = _exact_object(
        _load_json(payload), frozenset({"schema_version", "claims"}), "chunk_summary_fields"
    )
    if type(root["schema_version"]) is not str or root["schema_version"] != CHUNK_SUMMARY_VERSION:
        _issue("chunk_summary_version")
    raw_claims = root["claims"]
    if type(raw_claims) is not list or not 1 <= len(raw_claims) <= MAX_CLAIMS:
        _issue("claims_shape")
    claims: list[GeneratorClaim] = []
    previous_claim_number = 0
    for raw_claim in raw_claims:
        claim = _exact_object(
            raw_claim,
            frozenset({"claim_id", "claim_kind", "text", "record_ids"}),
            "claim_fields",
        )
        if type(claim["claim_id"]) is not str or _CLAIM_ID_RE.fullmatch(claim["claim_id"]) is None:
            _issue("claim_id_shape")
        claim_number = int(claim["claim_id"][1:])
        if claim_number <= previous_claim_number:
            _issue("claim_id_order")
        previous_claim_number = claim_number
        if type(claim["claim_kind"]) is not str or claim["claim_kind"] not in _CLAIM_KINDS:
            _issue("claim_kind")
        claims.append(
            GeneratorClaim(
                claim_id=claim["claim_id"],
                claim_kind=claim["claim_kind"],
                text=_safe_text(claim["text"], maximum=1_000),
                record_ids=_record_ids(claim["record_ids"], known_order),
            )
        )
    return ChunkSummary(schema_version=CHUNK_SUMMARY_VERSION, claims=tuple(claims))


def _parse_deck_content(
    payload: bytes, known_record_ids: object, coverage_kind: object
) -> DeckContent:
    known_order = _known_record_order(known_record_ids)
    if type(coverage_kind) is not str or coverage_kind not in _COVERAGE_KINDS:
        _issue("coverage_kind")
    root = _exact_object(
        _load_json(payload),
        frozenset({"schema_version", "slides", "limitations"}),
        "deck_content_fields",
    )
    if type(root["schema_version"]) is not str or root["schema_version"] != DECK_CONTENT_VERSION:
        _issue("deck_content_version")
    raw_slides = root["slides"]
    minimum = MIN_FULL_TEXT_SLIDES if coverage_kind == "full_text" else MIN_ABSTRACT_ONLY_SLIDES
    maximum = MAX_SLIDES if coverage_kind == "full_text" else MAX_ABSTRACT_ONLY_SLIDES
    if type(raw_slides) is not list or not minimum <= len(raw_slides) <= maximum:
        _issue("slides_shape")
    slides: list[GeneratorSlide] = []
    for index, raw_slide in enumerate(raw_slides):
        slide = _exact_object(
            raw_slide,
            frozenset({"kind", "title", "bullets", "speaker_notes"}),
            "slide_fields",
        )
        kind = slide["kind"]
        if type(kind) is not str or kind not in _SLIDE_KINDS:
            _issue("slide_kind")
        if (index == 0) != (kind == "title"):
            _issue("title_slide_order")
        title = _safe_text(slide["title"], maximum=32)
        if title != kind:
            _issue("slide_title_not_code_label")
        raw_bullets = slide["bullets"]
        raw_notes = slide["speaker_notes"]
        if type(raw_bullets) is not list or len(raw_bullets) > MAX_BULLETS_PER_SLIDE:
            _issue("bullets_shape")
        if type(raw_notes) is not list or len(raw_notes) > MAX_NOTES_PER_SLIDE:
            _issue("speaker_notes_shape")
        if kind == "title" and (raw_bullets or raw_notes):
            _issue("title_slide_content")
        # SD0 requires at least one cited bullet on every non-title slide;
        # cited notes alone cannot make an otherwise empty slide valid.
        if kind != "title" and not raw_bullets:
            _issue("non_title_citation_required", PAPER_SLIDE_CITATION_INVALID)
        bullets = tuple(_parse_statement(item, known_order, maximum=800) for item in raw_bullets)
        notes = tuple(_parse_statement(item, known_order, maximum=1_000) for item in raw_notes)
        slides.append(GeneratorSlide(kind=kind, title=title, bullets=bullets, speaker_notes=notes))

    raw_limitations = root["limitations"]
    if type(raw_limitations) is not list or len(raw_limitations) > MAX_PROVIDER_LIMITATIONS:
        _issue("limitations_shape")
    if raw_limitations:
        # SD0 cannot attach citations to top-level limitations.  Paper-specific
        # limitations therefore belong in cited bullets/notes; only producer-
        # owned required warnings are projected to the final limitation list.
        _issue("limitations_must_be_empty")
    return DeckContent(
        schema_version=DECK_CONTENT_VERSION,
        slides=tuple(slides),
        limitations=(),
    )


def _public_call(function: Callable[..., _T], *args: object) -> _T:
    failure: tuple[str, str] | None = None
    result: object = _MISSING
    try:
        result = function(*args)
    except (KeyboardInterrupt, SystemExit):
        raise
    except _ContractIssueError as exc:
        failure = (exc.error_code, exc.issue_code)
    except Exception:
        failure = (PAPER_SLIDE_OUTPUT_INVALID, "generator_contract_internal_failure")
    if failure is not None:
        raise SlideGeneratorContractError(*failure)
    if result is _MISSING:  # Defensive only; every non-exception path assigns it.
        raise SlideGeneratorContractError(
            PAPER_SLIDE_OUTPUT_INVALID, "generator_contract_internal_failure"
        )
    return cast(_T, result)


def load_chunk_summary(payload: bytes, *, known_record_ids: tuple[str, ...]) -> ChunkSummary:
    """Load one bounded ``chunk-summary-v1`` provider response."""

    return _public_call(_parse_chunk_summary, payload, known_record_ids)


def load_deck_content(
    payload: bytes,
    *,
    known_record_ids: tuple[str, ...],
    coverage_kind: str,
) -> DeckContent:
    """Load one bounded ``deck-content-v1`` provider response."""

    return _public_call(_parse_deck_content, payload, known_record_ids, coverage_kind)


__all__ = [
    "CHUNK_SUMMARY_VERSION",
    "DECK_CONTENT_VERSION",
    "MAX_PROVIDER_PAYLOAD_BYTES",
    "ChunkSummary",
    "DeckContent",
    "GeneratorClaim",
    "GeneratorSlide",
    "GeneratorStatement",
    "SlideGeneratorContractError",
    "load_chunk_summary",
    "load_deck_content",
]

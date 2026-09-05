"""Bounded, page-aware text extraction for trusted PDF bytes.

This module is the SD1E core parser.  It deliberately does not claim to isolate
the PDF parser: process timeout, CPU/memory limits, disabled networking, and a
credential-free sandbox remain the separate SD1I gate.  Text visibility is
fail-closed: cropped pages and graphics operations whose clipping or opacity
cannot be established through pypdf's visitor API are rejected.  Since pypdf
cannot prove glyph coverage, opacity, background contrast, or later occlusion,
non-empty real-PDF text is gated until a render/OCR verifier is implemented.
"""

from __future__ import annotations

import hashlib
import inspect
import logging
import math
import unicodedata
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from io import BytesIO
from threading import RLock
from typing import Any

from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_EXTRACTION_FAILED,
    PAPER_SLIDE_EXTRACTION_INSUFFICIENT,
    PAPER_SLIDE_PDF_ENCRYPTED,
    PAPER_SLIDE_PDF_INVALID,
)

MAX_PDF_BYTES = 32 * 1024 * 1024
MAX_PAGES = 128
MAX_PAGE_CODEPOINTS = 100_000
MAX_TOTAL_CODEPOINTS = 1_500_000
MAX_CHUNKS = 64
MAX_CHUNK_CODEPOINTS = 12_000
MIN_TEXT_CODEPOINTS = 500
MAX_SECTION_HINT_CODEPOINTS = 160
MAX_CONSECUTIVE_CHARACTER_REPETITIONS = 16
MAX_CONSECUTIVE_SEQUENCE_REPETITIONS = 4
MAX_REPEATED_SEQUENCE_TOKENS = 16
MAX_REPETITION_REDUCTION_PASSES = 8
MIN_DEDUPLICATED_LINE_CODEPOINTS = 24
INVISIBLE_TEXT_RENDERING_MODES = frozenset({3, 7})
_TEXT_SHOWING_OPERATORS = frozenset({b"Tj", b"TJ", b"'", b'"'})
_AMBIGUOUS_VISIBILITY_OPERATORS = frozenset({b"W", b"W*", b"gs"})

_INVISIBLE_RANGES = (
    (0x034F, 0x034F),  # combining grapheme joiner
    (0x115F, 0x1160),  # Hangul fillers
    (0x17B4, 0x17B5),  # Khmer inherent vowels
    (0x180B, 0x180F),  # Mongolian variation/free variation selectors
    (0x3164, 0x3164),  # Hangul filler
    (0xFE00, 0xFE0F),  # variation selectors
    (0xFFA0, 0xFFA0),  # halfwidth Hangul filler
    (0x1BCA0, 0x1BCA3),  # shorthand format controls
    (0x1D173, 0x1D17A),  # musical annotation controls
    (0xE0000, 0xE0FFF),  # tags and supplementary variation selectors
)
_NEWLINE_CHARACTERS = frozenset("\n\v\f\x85\u2028\u2029")
_PYPDF_LOG_LOCK = RLock()
_ITERATION_END = object()


class PdfExtractionError(ValueError):
    """A stable, non-sensitive extraction failure."""

    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__(f"{error_code}:{issue_code}")


@dataclass(frozen=True)
class PdfExtractionOptions:
    """Effective parser limits.

    Callers may lower resource ceilings, but may not raise the SD1E hard
    ceilings or lower the extraction-sufficiency threshold.
    """

    max_pdf_bytes: int = MAX_PDF_BYTES
    max_pages: int = MAX_PAGES
    max_page_codepoints: int = MAX_PAGE_CODEPOINTS
    max_total_codepoints: int = MAX_TOTAL_CODEPOINTS
    max_chunks: int = MAX_CHUNKS
    max_chunk_codepoints: int = MAX_CHUNK_CODEPOINTS
    minimum_text_codepoints: int = MIN_TEXT_CODEPOINTS


@dataclass(frozen=True)
class PdfTextChunk:
    """One physical-page-bound normalized text chunk.

    Text and its derived hint are intentionally omitted from repr so logs and
    exception diagnostics cannot accidentally persist extracted content.
    """

    chunk_id: str
    page: int
    text: str = field(repr=False)
    sha256: str
    section_hint: str | None = field(repr=False)


@dataclass(frozen=True)
class PdfExtractionResult:
    """Successful extraction manifest plus ephemeral redacted chunks."""

    pdf_sha256: str
    page_count: int
    extracted_page_count: int
    chunks: tuple[PdfTextChunk, ...]
    extractor: str
    options: PdfExtractionOptions


def normalize_page_text(text: str) -> str:
    """Return deterministic NFKC text with controls and invisibles removed.

    Newlines are canonicalized to LF.  Horizontal whitespace becomes one ASCII
    space, and multiple blank lines become one blank line.  Other Unicode
    ``C*`` characters (including bidi controls and zero-width format controls)
    are discarded.
    """

    if not isinstance(text, str):
        raise TypeError("text must be str")

    normalized = unicodedata.normalize("NFKC", text.replace("\r\n", "\n").replace("\r", "\n"))
    cleaned: list[str] = []
    for character in normalized:
        codepoint = ord(character)
        if character in _NEWLINE_CHARACTERS:
            cleaned.append("\n")
        elif character.isspace():
            cleaned.append(" ")
        elif unicodedata.category(character).startswith("C") or any(
            start <= codepoint <= end for start, end in _INVISIBLE_RANGES
        ):
            continue
        else:
            cleaned.append(character)

    lines: list[str] = []
    previous_was_blank = False
    for raw_line in "".join(cleaned).split("\n"):
        line = " ".join(raw_line.split())
        if line:
            lines.append(line)
            previous_was_blank = False
        elif lines and not previous_was_blank:
            lines.append("")
            previous_was_blank = True
    if lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines)


def _collapse_character_runs(line: str) -> str:
    if not line:
        return line
    result = [line[0]]
    previous = line[0]
    repetitions = 1
    for character in line[1:]:
        if character == previous:
            repetitions += 1
            if repetitions <= MAX_CONSECUTIVE_CHARACTER_REPETITIONS:
                result.append(character)
        else:
            result.append(character)
            previous = character
            repetitions = 1
    return "".join(result)


def _collapse_repeated_token_sequences(tokens: list[str]) -> list[str]:
    """Bound consecutive repeated token sequences with deterministic work."""

    result: list[str] = []
    position = 0
    while position < len(tokens):
        collapsed = False
        max_sequence_length = min(
            MAX_REPEATED_SEQUENCE_TOKENS,
            (len(tokens) - position) // (MAX_CONSECUTIVE_SEQUENCE_REPETITIONS + 1),
        )
        for sequence_length in range(1, max_sequence_length + 1):
            sequence = tokens[position : position + sequence_length]
            repetitions = 1
            while (
                position + (repetitions + 1) * sequence_length <= len(tokens)
                and tokens[
                    position + repetitions * sequence_length : position
                    + (repetitions + 1) * sequence_length
                ]
                == sequence
            ):
                repetitions += 1
            if repetitions > MAX_CONSECUTIVE_SEQUENCE_REPETITIONS:
                result.extend(sequence * MAX_CONSECUTIVE_SEQUENCE_REPETITIONS)
                position += repetitions * sequence_length
                collapsed = True
                break
        if not collapsed:
            result.append(tokens[position])
            position += 1
    return result


def _remove_extreme_repetition_once(text: str) -> str:
    """Apply one bounded pass of mechanical repetition reduction."""

    lines: list[str] = []
    previous_line: str | None = None
    for raw_line in text.split("\n"):
        collapsed_characters = _collapse_character_runs(raw_line)
        line = " ".join(_collapse_repeated_token_sequences(collapsed_characters.split(" "))).strip()
        if line and line == previous_line:
            continue
        lines.append(line)
        previous_line = line if line else None
    return "\n".join(lines).strip()


def _remove_extreme_repetition(text: str) -> str:
    """Reduce repetition to a fixed point or conservatively discard the text."""

    current = text
    for _ in range(MAX_REPETITION_REDUCTION_PASSES):
        reduced = _remove_extreme_repetition_once(current)
        if reduced == current:
            return reduced
        current = reduced
    # Adversarial nesting that does not converge within the fixed work budget
    # cannot contribute to sufficiency or chunks.
    return ""


def _sanitize_page_text(text: str) -> str:
    """Return the deterministic normalized/repetition-bounded page text.

    The isolation boundary may apply this helper to untrusted worker output and
    require exact equality before it accepts page or chunk text.  Cross-page
    and cross-chunk exact duplicate removal still requires a caller-owned set.
    """

    return _remove_extreme_repetition(normalize_page_text(text))


def _deduplicate_page_lines(text: str, seen_lines: set[str]) -> str:
    """Remove previously seen substantive lines, preserving first occurrence.

    ``seen_lines`` is caller-owned document state and must be reused in physical
    page order.  The isolation boundary can use this helper on reconstructed,
    sanitized page text to enforce the same cross-page invariant.
    """

    retained_lines: list[str] = []
    for line in text.split("\n"):
        if len(line) >= MIN_DEDUPLICATED_LINE_CODEPOINTS:
            if line in seen_lines:
                continue
            seen_lines.add(line)
        retained_lines.append(line)
    return normalize_page_text("\n".join(retained_lines))


def _fail(error_code: str, issue_code: str) -> PdfExtractionError:
    return PdfExtractionError(error_code, issue_code)


def _validate_options(options: PdfExtractionOptions) -> None:
    ceilings = (
        (options.max_pdf_bytes, MAX_PDF_BYTES),
        (options.max_pages, MAX_PAGES),
        (options.max_page_codepoints, MAX_PAGE_CODEPOINTS),
        (options.max_total_codepoints, MAX_TOTAL_CODEPOINTS),
        (options.max_chunks, MAX_CHUNKS),
        (options.max_chunk_codepoints, MAX_CHUNK_CODEPOINTS),
    )
    if any(
        isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > hard_limit
        for value, hard_limit in ceilings
    ):
        raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "extractor_options_invalid")
    if (
        isinstance(options.minimum_text_codepoints, bool)
        or not isinstance(options.minimum_text_codepoints, int)
        or options.minimum_text_codepoints < MIN_TEXT_CODEPOINTS
        or options.minimum_text_codepoints > options.max_total_codepoints
    ):
        raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "extractor_options_invalid")


def _load_pypdf() -> tuple[Any, str]:
    """Load the optional parser without making it a base import dependency."""

    dependency_missing = False
    try:
        import pypdf
    except (ImportError, ModuleNotFoundError):
        dependency_missing = True
    if dependency_missing:
        raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "parser_dependency_unavailable") from None
    return pypdf.PdfReader, str(getattr(pypdf, "__version__", "unknown"))


@contextmanager
def _suppress_pypdf_logs() -> Iterator[None]:
    """Discard pypdf hierarchy logs and restore logger state on every exit."""

    with _PYPDF_LOG_LOCK:
        logger = logging.getLogger("pypdf")
        original_handlers = list(logger.handlers)
        original_propagate = logger.propagate
        logger.handlers = [logging.NullHandler()]
        logger.propagate = False
        try:
            yield
        finally:
            logger.handlers = original_handlers
            logger.propagate = original_propagate


def _supports_visitor_callbacks(extract_text: Any) -> bool:
    parameters = inspect.signature(extract_text).parameters.values()
    return any(parameter.name == "visitor_operand_before" for parameter in parameters) or any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in parameters
    )


def _blank_text_operands(operator: bytes, operands: Any) -> bool:
    """Blank one invisible text-showing operation in-place; return success."""

    try:
        if operator in {b"Tj", b"'"}:
            operands[-1] = b""
        elif operator == b'"':
            operands[2] = b""
        elif operator == b"TJ":
            text_array = operands[0]
            for index, value in enumerate(text_array):
                if isinstance(value, (bytes, str)):
                    text_array[index] = b""
    except Exception:
        return False
    return True


def _finite_matrix(value: Any) -> tuple[float, float, float, float, float, float] | None:
    """Return one finite six-number PDF matrix, rejecting coercive objects."""

    if not isinstance(value, (list, tuple)) or len(value) != 6:
        return None
    converted: list[float] = []
    for component in value:
        if isinstance(component, bool) or not isinstance(component, (int, float)):
            return None
        numeric = float(component)
        if not math.isfinite(numeric):
            return None
        converted.append(numeric)
    return (
        converted[0],
        converted[1],
        converted[2],
        converted[3],
        converted[4],
        converted[5],
    )


def _page_box(page: Any, attribute: str) -> tuple[float, float, float, float]:
    """Read a finite, non-empty page box without accepting coercive values."""

    try:
        box = getattr(page, attribute)
        values = (box.left, box.bottom, box.right, box.top)
    except Exception:
        raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "page_text_visibility_ambiguous") from None

    converted: list[float] = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "page_text_visibility_ambiguous")
        numeric = float(value)
        if not math.isfinite(numeric):
            raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "page_text_visibility_ambiguous")
        converted.append(numeric)
    left, bottom, right, top = converted
    if not left < right or not bottom < top:
        raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "page_text_visibility_ambiguous")
    return left, bottom, right, top


def _visible_page_bounds(page: Any) -> tuple[float, float, float, float]:
    """Return bounds only when crop and media visibility are unambiguous.

    A smaller crop box can hide a suffix of a glyph run even when its baseline
    begins inside the crop.  pypdf does not expose authoritative glyph bounds,
    so rejecting every cropped page is the only safe non-rendering policy.
    """

    media_box = _page_box(page, "mediabox")
    crop_box = _page_box(page, "cropbox")
    if crop_box != media_box:
        raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "page_text_visibility_ambiguous")
    return media_box


def _text_origin(
    current_transformation_matrix: Any,
    text_matrix: Any,
) -> tuple[float, float] | None:
    """Return the text origin in default user space for two valid matrices."""

    cm = _finite_matrix(current_transformation_matrix)
    tm = _finite_matrix(text_matrix)
    if cm is None or tm is None:
        return None
    x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
    y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
    if not math.isfinite(x) or not math.isfinite(y):
        return None
    return x, y


def _extract_visible_page_text(page: Any) -> object:
    """Return filtered parser text; this is not a production visibility proof."""

    extract_text = page.extract_text
    if not _supports_visitor_callbacks(extract_text):
        raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "page_text_visibility_ambiguous")

    left, bottom, right, top = _visible_page_bounds(page)

    rendering_mode = 0
    font_size: float | None = None
    rendering_mode_stack: list[tuple[int, float | None]] = []
    visitor_valid = True

    def visitor_operand_before(
        operator: Any,
        operands: Any,
        _current_transformation_matrix: Any,
        _text_matrix: Any,
    ) -> None:
        nonlocal font_size, rendering_mode, visitor_valid
        if not isinstance(operator, bytes):
            visitor_valid = False
            return
        if operator == b"Do":
            # pypdf recursively extracts Form XObjects, but the callback does
            # not provide the form's BBox, transparency group, or resources.
            # Make the lookup unresolvable so no XObject text can contribute;
            # ordinary page text already buffered by pypdf remains available.
            try:
                operands[0] = None
            except Exception:
                visitor_valid = False
            return
        if operator in _AMBIGUOUS_VISIBILITY_OPERATORS:
            visitor_valid = False
            return
        if operator == b"q":
            rendering_mode_stack.append((rendering_mode, font_size))
            return
        if operator == b"Q":
            if not rendering_mode_stack:
                visitor_valid = False
                return
            rendering_mode, font_size = rendering_mode_stack.pop()
            return
        if operator == b"Tf":
            try:
                value = operands[1]
            except Exception:
                visitor_valid = False
                return
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                visitor_valid = False
                return
            numeric_value = float(value)
            if not math.isfinite(numeric_value) or numeric_value <= 0:
                visitor_valid = False
                return
            font_size = numeric_value
            return
        if operator == b"Ts":
            try:
                value = operands[0]
            except Exception:
                visitor_valid = False
                return
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                or float(value) != 0
            ):
                visitor_valid = False
            return
        if operator == b"Tz":
            try:
                value = operands[0]
            except Exception:
                visitor_valid = False
                return
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                or float(value) <= 0
            ):
                visitor_valid = False
            return
        if operator == b"Tr":
            try:
                value = operands[0]
                numeric_value = float(value)
            except Exception:
                visitor_valid = False
                return
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(numeric_value)
                or not numeric_value.is_integer()
                or not 0 <= numeric_value <= 7
            ):
                visitor_valid = False
                return
            rendering_mode = int(numeric_value)
            return
        if operator in _TEXT_SHOWING_OPERATORS:
            if rendering_mode in INVISIBLE_TEXT_RENDERING_MODES:
                visitor_valid = _blank_text_operands(operator, operands) and visitor_valid
                return
            if font_size is None or operator in {b"'", b'"'}:
                visitor_valid = False
                return
            origin = _text_origin(_current_transformation_matrix, _text_matrix)
            if origin is None:
                visitor_valid = False
                return
            x, y = origin
            if not left <= x <= right or not bottom <= y <= top:
                visitor_valid = False

    extracted = extract_text(visitor_operand_before=visitor_operand_before)
    if not visitor_valid or rendering_mode_stack:
        raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "page_text_visibility_ambiguous")
    return extracted


def _is_page_text_visibility_verified(_page: Any, _text: str) -> bool:
    """Return whether rendered visibility has independently been verified.

    This SD1E implementation intentionally has no permissive fallback.  pypdf
    text coordinates cannot prove complete glyph coverage, meaningful rendered
    size, foreground/background contrast, transparency-group behavior, or
    later paint occlusion.  A future render/OCR verifier may replace this gate;
    tests monkeypatch it only for deterministic parser-limit coverage.
    """

    return False


def _next_page(iterator: Iterator[Any]) -> object:
    iteration_failed = False
    try:
        return next(iterator)
    except StopIteration:
        return _ITERATION_END
    except Exception:
        iteration_failed = True
    if iteration_failed:
        raise _fail(PAPER_SLIDE_PDF_INVALID, "pdf_page_iteration_failed") from None
    raise AssertionError("unreachable")


def _split_page_text(text: str, limit: int) -> list[str]:
    chunks: list[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= limit:
            chunks.append(remaining)
            break

        newline_boundary = remaining.rfind("\n", 0, limit + 1)
        space_boundary = remaining.rfind(" ", 0, limit + 1)
        boundary = max(newline_boundary, space_boundary)
        if boundary < limit // 2:
            boundary = limit

        chunk = remaining[:boundary].strip()
        remaining = remaining[boundary:].strip()
        if chunk:
            chunks.append(chunk)
    return chunks


def _section_hint(chunk_text: str) -> str | None:
    first_line = chunk_text.partition("\n")[0].strip()
    if not first_line:
        return None
    return first_line[:MAX_SECTION_HINT_CODEPOINTS].rstrip()


def _extract_pdf_suppressed(
    pdf_bytes: bytes,
    effective_options: PdfExtractionOptions,
) -> PdfExtractionResult:
    parser_error: PdfExtractionError | None = None
    try:
        reader_type, parser_version = _load_pypdf()
    except PdfExtractionError as caught:
        parser_error = caught
    except Exception:
        parser_error = _fail(PAPER_SLIDE_EXTRACTION_FAILED, "parser_load_failed")
    if parser_error is not None:
        raise parser_error from None

    reader: Any = None
    reader_failed = False
    try:
        reader = reader_type(BytesIO(pdf_bytes), strict=True)
    except Exception:
        reader_failed = True
    if reader_failed:
        raise _fail(PAPER_SLIDE_PDF_INVALID, "pdf_malformed") from None

    encryption_state: object = None
    encryption_failed = False
    try:
        encryption_state = reader.is_encrypted
    except Exception:
        encryption_failed = True
    if encryption_failed:
        raise _fail(PAPER_SLIDE_PDF_INVALID, "pdf_encryption_state_unavailable") from None
    if type(encryption_state) is not bool:
        raise _fail(PAPER_SLIDE_PDF_INVALID, "pdf_encryption_state_invalid")
    if encryption_state:
        raise _fail(PAPER_SLIDE_PDF_ENCRYPTED, "pdf_encrypted")

    pages: Any = None
    page_count_failed = False
    try:
        pages = reader.pages
        page_count = len(pages)
    except Exception:
        page_count_failed = True
        page_count = -1
    if page_count_failed:
        raise _fail(PAPER_SLIDE_PDF_INVALID, "pdf_page_count_unavailable") from None
    if type(page_count) is not int:
        raise _fail(PAPER_SLIDE_PDF_INVALID, "pdf_page_count_invalid")
    if page_count < 1:
        raise _fail(PAPER_SLIDE_PDF_INVALID, "pdf_page_count_invalid")
    if page_count > effective_options.max_pages:
        raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "pdf_page_limit_exceeded")

    iterator_failed = False
    try:
        page_iterator = iter(pages)
    except Exception:
        iterator_failed = True
        page_iterator = iter(())
    if iterator_failed:
        raise _fail(PAPER_SLIDE_PDF_INVALID, "pdf_page_iteration_failed") from None

    normalized_pages: list[tuple[int, str]] = []
    normalized_total_codepoints = 0
    raw_total_codepoints = 0
    for page_number in range(1, page_count + 1):
        page = _next_page(page_iterator)
        if page is _ITERATION_END:
            raise _fail(PAPER_SLIDE_PDF_INVALID, "pdf_page_count_mismatch")

        extracted: object = None
        extraction_error: PdfExtractionError | None = None
        try:
            extracted = _extract_visible_page_text(page)
        except PdfExtractionError as caught:
            extraction_error = caught
        except Exception:
            extraction_error = _fail(PAPER_SLIDE_EXTRACTION_FAILED, "page_extraction_failed")
        if extraction_error is not None:
            raise extraction_error from None

        if extracted is None:
            normalized = ""
        elif isinstance(extracted, str):
            if extracted and not _is_page_text_visibility_verified(page, extracted):
                raise _fail(
                    PAPER_SLIDE_EXTRACTION_FAILED,
                    "page_text_visibility_unverifiable",
                )
            raw_codepoints = len(extracted)
            if raw_codepoints > effective_options.max_page_codepoints:
                raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "page_text_limit_exceeded")
            raw_total_codepoints += raw_codepoints
            if raw_total_codepoints > effective_options.max_total_codepoints:
                raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "total_text_limit_exceeded")
            normalized = normalize_page_text(extracted)
        else:
            raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "page_text_type_invalid")

        if len(normalized) > effective_options.max_page_codepoints:
            raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "page_text_limit_exceeded")
        normalized_total_codepoints += len(normalized)
        if normalized_total_codepoints > effective_options.max_total_codepoints:
            raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "total_text_limit_exceeded")
        if normalized:
            normalized_pages.append((page_number, normalized))

    if _next_page(page_iterator) is not _ITERATION_END:
        raise _fail(PAPER_SLIDE_PDF_INVALID, "pdf_page_count_mismatch")

    candidate_chunks: list[tuple[int, str]] = []
    seen_pages: set[str] = set()
    seen_lines: set[str] = set()
    seen_chunks: set[str] = set()
    for page_number, normalized in normalized_pages:
        sanitized = _sanitize_page_text(normalized)
        if not sanitized or sanitized in seen_pages:
            continue
        seen_pages.add(sanitized)
        deduplicated = _deduplicate_page_lines(sanitized, seen_lines)
        if not deduplicated:
            continue
        for chunk_text in _split_page_text(deduplicated, effective_options.max_chunk_codepoints):
            if chunk_text in seen_chunks:
                continue
            seen_chunks.add(chunk_text)
            if len(candidate_chunks) >= effective_options.max_chunks:
                raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "chunk_limit_exceeded")
            candidate_chunks.append((page_number, chunk_text))

    retained_total_codepoints = sum(len(text) for _, text in candidate_chunks)
    if retained_total_codepoints < effective_options.minimum_text_codepoints:
        raise _fail(PAPER_SLIDE_EXTRACTION_INSUFFICIENT, "extracted_text_insufficient")

    chunks: list[PdfTextChunk] = []
    page_chunk_numbers: dict[int, int] = {}
    for page_number, chunk_text in candidate_chunks:
        chunk_number = page_chunk_numbers.get(page_number, 0) + 1
        page_chunk_numbers[page_number] = chunk_number
        chunk_sha256 = hashlib.sha256(chunk_text.encode("utf-8")).hexdigest()
        chunks.append(
            PdfTextChunk(
                chunk_id=f"p{page_number:03d}-c{chunk_number:02d}",
                page=page_number,
                text=chunk_text,
                sha256=chunk_sha256,
                section_hint=_section_hint(chunk_text),
            )
        )

    return PdfExtractionResult(
        pdf_sha256=hashlib.sha256(pdf_bytes).hexdigest(),
        page_count=page_count,
        extracted_page_count=len(page_chunk_numbers),
        chunks=tuple(chunks),
        extractor=f"pypdf:{parser_version}",
        options=effective_options,
    )


def _extract_pdf_boundary(
    pdf_bytes: bytes,
    *,
    options: PdfExtractionOptions | None = None,
) -> PdfExtractionResult:
    effective_options = options if options is not None else PdfExtractionOptions()
    if not isinstance(effective_options, PdfExtractionOptions):
        raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "extractor_options_invalid")
    _validate_options(effective_options)

    if not isinstance(pdf_bytes, bytes):
        raise _fail(PAPER_SLIDE_PDF_INVALID, "pdf_bytes_type")
    if len(pdf_bytes) > effective_options.max_pdf_bytes:
        raise _fail(PAPER_SLIDE_EXTRACTION_FAILED, "pdf_byte_limit_exceeded")
    if not pdf_bytes.startswith(b"%PDF-"):
        raise _fail(PAPER_SLIDE_PDF_INVALID, "pdf_magic_invalid")

    with _suppress_pypdf_logs():
        return _extract_pdf_suppressed(pdf_bytes, effective_options)


def extract_pdf(
    pdf_bytes: bytes,
    *,
    options: PdfExtractionOptions | None = None,
) -> PdfExtractionResult:
    """Extract normalized, bounded chunks from trusted PDF bytes.

    Only ``page.extract_text()`` contributes data to chunks.  Catalog metadata,
    document metadata, attachments, annotations, actions, and JavaScript are
    neither inspected nor included.  Every unexpected ordinary exception is
    replaced at this boundary; process-control exceptions are not masked.
    """

    failure_pair: tuple[str, str] | None = None
    try:
        return _extract_pdf_boundary(pdf_bytes, options=options)
    except PdfExtractionError as caught:
        failure_pair = (caught.error_code, caught.issue_code)
    except Exception:
        failure_pair = (PAPER_SLIDE_EXTRACTION_FAILED, "unexpected_extraction_failure")
    if failure_pair is not None:
        raise _fail(*failure_pair) from None
    raise AssertionError("unreachable")


__all__ = [
    "INVISIBLE_TEXT_RENDERING_MODES",
    "MAX_CHUNKS",
    "MAX_CHUNK_CODEPOINTS",
    "MAX_CONSECUTIVE_CHARACTER_REPETITIONS",
    "MAX_CONSECUTIVE_SEQUENCE_REPETITIONS",
    "MAX_PAGES",
    "MAX_PAGE_CODEPOINTS",
    "MAX_PDF_BYTES",
    "MAX_REPEATED_SEQUENCE_TOKENS",
    "MAX_REPETITION_REDUCTION_PASSES",
    "MAX_TOTAL_CODEPOINTS",
    "MIN_DEDUPLICATED_LINE_CODEPOINTS",
    "MIN_TEXT_CODEPOINTS",
    "PdfExtractionError",
    "PdfExtractionOptions",
    "PdfExtractionResult",
    "PdfTextChunk",
    "_deduplicate_page_lines",
    "_sanitize_page_text",
    "extract_pdf",
    "normalize_page_text",
]

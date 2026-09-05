"""Integrity binding between SD1 fetch/extraction and the SD0 deck context.

Extracted text remains untrusted content.  This module only proves that its
page/chunk hashes belong to the exact resolver identity and fetched PDF bytes,
then drops the raw PDF from the returned object.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import TypeGuard, TypeVar

from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_EXTRACTION_FAILED,
    PdfChunkReference,
)
from paperpilot.paper_slides.extract import (
    MAX_CHUNKS,
    MAX_PAGES,
    MAX_SECTION_HINT_CODEPOINTS,
    PdfExtractionOptions,
    PdfExtractionResult,
    PdfTextChunk,
    _sanitize_page_text,
    _validate_options,
)
from paperpilot.paper_slides.fetch import MAX_PDF_BYTES, PdfFetchResult
from paperpilot.paper_slides.resolver import (
    ResolvedPDFSource,
    SourceResolutionError,
    resolve_pdf_source,
)

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_CHUNK_ID_RE = re.compile(r"^p(?:00[1-9]|0[1-9][0-9]|1[01][0-9]|12[0-8])-c(?:0[1-9]|[1-9][0-9])$")
_T = TypeVar("_T")


class PdfBindingError(ValueError):
    """A stable failure at the fetch/extraction provenance boundary."""

    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__(f"{error_code}:{issue_code}")


@dataclass(frozen=True)
class BoundPdfExtraction:
    """Identity-bound extraction without retained raw PDF bytes.

    ``extraction.chunks[*].text`` is still untrusted paper content and must be
    placed inside the SD2 data delimiter.  Only the identity, hashes, physical
    pages, and anchors represented here are trusted producer metadata.
    """

    source: ResolvedPDFSource
    byte_count: int
    extraction: PdfExtractionResult
    pdf_chunks: Mapping[str, PdfChunkReference] = field(repr=False)


def _failure(issue_code: str) -> PdfBindingError:
    return PdfBindingError(PAPER_SLIDE_EXTRACTION_FAILED, issue_code)


def _is_exact_instance(value: object, expected_type: type[_T]) -> TypeGuard[_T]:
    """Narrow a hostile public value without accepting subclasses."""

    return type(value) is expected_type


def _canonical_source(source: object) -> ResolvedPDFSource:
    if not _is_exact_instance(source, ResolvedPDFSource):
        raise _failure("pdf_binding_source_invalid")
    trusted = source
    if (
        any(
            type(value) is not str
            for value in (
                trusted.paper_id,
                trusted.source,
                trusted.source_id,
                trusted.landing_url,
                trusted.pdf_url,
                trusted.access,
                trusted.license,
            )
        )
        or trusted.license_evidence_url is not None
    ):
        raise _failure("pdf_binding_source_invalid")
    row = {
        "paper_id": trusted.paper_id,
        "source": trusted.source,
        "source_id": trusted.source_id,
        "landing_url": trusted.landing_url,
        "pdf_url": trusted.pdf_url,
    }
    resolution_failed = False
    try:
        expected = resolve_pdf_source(row)
    except SourceResolutionError:
        resolution_failed = True
        expected = None
    if resolution_failed or expected != trusted:
        raise _failure("pdf_binding_source_invalid")
    return trusted


def _validated_fetch(fetch: object) -> PdfFetchResult:
    if not _is_exact_instance(fetch, PdfFetchResult):
        raise _failure("pdf_binding_fetch_invalid")
    trusted = fetch
    if (
        type(trusted.pdf_bytes) is not bytes
        or type(trusted.byte_count) is not int
        or trusted.byte_count < 5
        or trusted.byte_count > MAX_PDF_BYTES
        or trusted.byte_count != len(trusted.pdf_bytes)
        or not trusted.pdf_bytes.startswith(b"%PDF-")
        or type(trusted.sha256) is not str
        or _SHA256_RE.fullmatch(trusted.sha256) is None
        or hashlib.sha256(trusted.pdf_bytes).hexdigest() != trusted.sha256
    ):
        raise _failure("pdf_binding_fetch_invalid")
    return trusted


def _validated_extraction(
    extraction: object,
    *,
    pdf_sha256: str,
) -> PdfExtractionResult:
    if not _is_exact_instance(extraction, PdfExtractionResult):
        raise _failure("pdf_binding_extraction_invalid")
    trusted = extraction
    if (
        type(trusted.pdf_sha256) is not str
        or trusted.pdf_sha256 != pdf_sha256
        or type(trusted.page_count) is not int
        or not 1 <= trusted.page_count <= MAX_PAGES
        or type(trusted.extracted_page_count) is not int
        or not 1 <= trusted.extracted_page_count <= trusted.page_count
        or type(trusted.chunks) is not tuple
        or not 1 <= len(trusted.chunks) <= MAX_CHUNKS
        or type(trusted.extractor) is not str
        or not trusted.extractor
        or type(trusted.options) is not PdfExtractionOptions
    ):
        raise _failure("pdf_binding_extraction_invalid")
    _validate_options(trusted.options)
    return trusted


def _bind_pdf_extraction(
    source: ResolvedPDFSource,
    fetch: PdfFetchResult,
    extraction: PdfExtractionResult,
) -> BoundPdfExtraction:
    canonical_source = _canonical_source(source)
    validated_fetch = _validated_fetch(fetch)
    validated_extraction = _validated_extraction(
        extraction,
        pdf_sha256=validated_fetch.sha256,
    )

    references: dict[str, PdfChunkReference] = {}
    pages: set[int] = set()
    previous_page = 0
    page_chunk_counts: dict[int, int] = {}
    page_codepoints: dict[int, int] = {}
    seen_text: set[str] = set()
    total_codepoints = 0
    for chunk in validated_extraction.chunks:
        if type(chunk) is not PdfTextChunk:
            raise _failure("pdf_binding_chunk_invalid")
        page = chunk.page
        if (
            type(page) is not int
            or not 1 <= page <= validated_extraction.page_count
            or page < previous_page
            or type(chunk.chunk_id) is not str
            or _CHUNK_ID_RE.fullmatch(chunk.chunk_id) is None
            or type(chunk.text) is not str
            or not chunk.text
            or len(chunk.text) > validated_extraction.options.max_chunk_codepoints
            or _sanitize_page_text(chunk.text) != chunk.text
            or chunk.text in seen_text
            or type(chunk.sha256) is not str
            or _SHA256_RE.fullmatch(chunk.sha256) is None
            or hashlib.sha256(chunk.text.encode("utf-8")).hexdigest() != chunk.sha256
        ):
            raise _failure("pdf_binding_chunk_invalid")
        chunk_number = page_chunk_counts.get(page, 0) + 1
        if chunk.chunk_id != f"p{page:03d}-c{chunk_number:02d}":
            raise _failure("pdf_binding_chunk_invalid")
        if chunk.chunk_id in references:
            raise _failure("pdf_binding_chunk_invalid")
        expected_hint = chunk.text.partition("\n")[0].strip()[:MAX_SECTION_HINT_CODEPOINTS].rstrip()
        if (
            chunk.section_hint is not None and type(chunk.section_hint) is not str
        ) or chunk.section_hint != (expected_hint or None):
            raise _failure("pdf_binding_chunk_invalid")
        page_codepoints[page] = page_codepoints.get(page, 0) + len(chunk.text)
        total_codepoints += len(chunk.text)
        if (
            page_codepoints[page] > validated_extraction.options.max_page_codepoints
            or total_codepoints > validated_extraction.options.max_total_codepoints
        ):
            raise _failure("pdf_binding_chunk_invalid")
        source_anchor = f"{canonical_source.pdf_url}#page={page}"
        references[chunk.chunk_id] = PdfChunkReference(
            page=page,
            sha256=chunk.sha256,
            source_anchor=source_anchor,
            pdf_sha256=validated_fetch.sha256,
        )
        page_chunk_counts[page] = chunk_number
        pages.add(page)
        seen_text.add(chunk.text)
        previous_page = page

    if (
        len(pages) != validated_extraction.extracted_page_count
        or total_codepoints < validated_extraction.options.minimum_text_codepoints
    ):
        raise _failure("pdf_binding_extraction_invalid")

    return BoundPdfExtraction(
        source=canonical_source,
        byte_count=validated_fetch.byte_count,
        extraction=validated_extraction,
        pdf_chunks=MappingProxyType(references),
    )


def bind_pdf_extraction(
    source: ResolvedPDFSource,
    fetch: PdfFetchResult,
    extraction: PdfExtractionResult,
) -> BoundPdfExtraction:
    """Bind SD1 results and build exact page anchors for SD0 validation."""

    failure: tuple[str, str] | None = None
    try:
        return _bind_pdf_extraction(source, fetch, extraction)
    except PdfBindingError as error:
        failure = (error.error_code, error.issue_code)
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        failure = (PAPER_SLIDE_EXTRACTION_FAILED, "pdf_binding_internal_failure")
    assert failure is not None
    raise PdfBindingError(*failure)


__all__ = [
    "BoundPdfExtraction",
    "PdfBindingError",
    "bind_pdf_extraction",
]

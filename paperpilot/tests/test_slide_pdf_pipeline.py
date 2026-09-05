"""SD1-to-SD0 PDF identity/provenance binding tests (offline only)."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from dataclasses import replace
from pathlib import Path

import pytest

import paperpilot.paper_slides.pipeline as pipeline_module
from paperpilot.identity import make_paper_id
from paperpilot.paper_slides.contract import (
    FULL_TEXT_LABEL,
    SlideDeckValidationContext,
    derive_deck_id,
    trusted_envelope_sha256,
    validate_slide_deck,
)
from paperpilot.paper_slides.extract import (
    PdfExtractionOptions,
    PdfExtractionResult,
    PdfTextChunk,
)
from paperpilot.paper_slides.fetch import PdfFetchResult
from paperpilot.paper_slides.pipeline import (
    PdfBindingError,
    bind_pdf_extraction,
)
from paperpilot.paper_slides.resolver import resolve_pdf_source

FIXTURES = Path(__file__).parent / "fixtures" / "paper-slides-v1"
PDF_BYTES = b"%PDF-1.7\noffline pipeline bytes"


def _source():
    source_id = "2601.01234"
    return resolve_pdf_source(
        {
            "paper_id": make_paper_id("arxiv", source_id),
            "source": "arxiv",
            "source_id": source_id,
        }
    )


def _results():
    pdf_sha256 = hashlib.sha256(PDF_BYTES).hexdigest()
    text = " ".join(f"grounded{index:04d}" for index in range(80))
    text_sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest()
    fetch = PdfFetchResult(
        pdf_bytes=PDF_BYTES,
        sha256=pdf_sha256,
        byte_count=len(PDF_BYTES),
    )
    extraction = PdfExtractionResult(
        pdf_sha256=pdf_sha256,
        page_count=3,
        extracted_page_count=1,
        chunks=(
            PdfTextChunk(
                chunk_id="p003-c01",
                page=3,
                text=text,
                sha256=text_sha256,
                section_hint=text[:160],
            ),
        ),
        extractor="pypdf:test",
        options=PdfExtractionOptions(),
    )
    return fetch, extraction


def _assert_binding_error(function, issue_code: str) -> None:
    with pytest.raises(PdfBindingError) as caught:
        function()
    assert caught.value.issue_code == issue_code
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


def test_binding_drops_raw_pdf_and_builds_immutable_page_references() -> None:
    source = _source()
    fetch, extraction = _results()

    bound = bind_pdf_extraction(source, fetch, extraction)
    reference = bound.pdf_chunks["p003-c01"]

    assert bound.byte_count == len(PDF_BYTES)
    assert reference.page == 3
    assert reference.sha256 == extraction.chunks[0].sha256
    assert reference.pdf_sha256 == fetch.sha256
    assert reference.source_anchor == "https://arxiv.org/pdf/2601.01234#page=3"
    assert not hasattr(bound, "pdf_bytes")
    assert "grounded0000" not in repr(bound)
    with pytest.raises(TypeError):
        bound.pdf_chunks["changed"] = reference  # type: ignore[index]


def test_binding_rejects_source_pdf_and_chunk_integrity_mismatches() -> None:
    source = _source()
    fetch, extraction = _results()

    _assert_binding_error(
        lambda: bind_pdf_extraction(
            replace(source, landing_url="https://arxiv.org/abs/2601.99999"),
            fetch,
            extraction,
        ),
        "pdf_binding_source_invalid",
    )
    _assert_binding_error(
        lambda: bind_pdf_extraction(
            source,
            replace(fetch, byte_count=fetch.byte_count + 1),
            extraction,
        ),
        "pdf_binding_fetch_invalid",
    )
    _assert_binding_error(
        lambda: bind_pdf_extraction(
            source,
            fetch,
            replace(extraction, pdf_sha256="0" * 64),
        ),
        "pdf_binding_extraction_invalid",
    )
    bad_chunk = replace(extraction.chunks[0], sha256="0" * 64)
    _assert_binding_error(
        lambda: bind_pdf_extraction(
            source,
            fetch,
            replace(extraction, chunks=(bad_chunk,)),
        ),
        "pdf_binding_chunk_invalid",
    )


def test_binding_redacts_unexpected_internal_exception_chain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _source()
    fetch, extraction = _results()

    def fail_with_secret(_source: object) -> object:
        raise RuntimeError("SECRET_BINDING_INTERNAL_DETAIL")

    monkeypatch.setattr(pipeline_module, "_canonical_source", fail_with_secret)
    _assert_binding_error(
        lambda: bind_pdf_extraction(source, fetch, extraction),
        "pdf_binding_internal_failure",
    )


def test_real_bound_reference_satisfies_sd0_and_each_binding_is_checked() -> None:
    source = _source()
    fetch, extraction = _results()
    bound = bind_pdf_extraction(source, fetch, extraction)
    reference = bound.pdf_chunks["p003-c01"]
    deck = json.loads((FIXTURES / "full-text.json").read_text(encoding="utf-8"))

    deck["paper_id"] = source.paper_id
    deck["coverage"] = {
        "kind": "full_text",
        "label": FULL_TEXT_LABEL,
        "page_count": extraction.page_count,
        "extracted_page_count": extraction.extracted_page_count,
    }
    deck["source"]["landing_url"] = source.landing_url
    deck["source"]["pdf_sha256"] = extraction.pdf_sha256
    deck["generator"]["extractor"] = extraction.extractor
    deck["citations"][0].update(
        {
            "page": reference.page,
            "chunk_id": "p003-c01",
            "chunk_sha256": reference.sha256,
            "source_anchor": reference.source_anchor,
        }
    )
    deck["deck_id"] = derive_deck_id(deck)
    context = SlideDeckValidationContext(
        expected_envelope_sha256=trusted_envelope_sha256(deck),
        pdf_chunks=bound.pdf_chunks,
    )

    assert validate_slide_deck(deck, context=context) == []

    for path, value in (
        (("citations", 0, "page"), 2),
        (("citations", 0, "chunk_sha256"), "0" * 64),
        (("citations", 0, "source_anchor"), source.pdf_url + "#page=2"),
        (("source", "pdf_sha256"), "0" * 64),
    ):
        changed = deepcopy(deck)
        target = changed
        for segment in path[:-1]:
            target = target[segment]
        target[path[-1]] = value
        assert validate_slide_deck(changed, context=context)

"""SD1E bounded PDF extraction tests; no raw PDF fixture is persisted."""

from __future__ import annotations

import builtins
import hashlib
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import FrozenInstanceError
from io import BytesIO

import pytest

from paperpilot.paper_slides import extract as extraction
from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_EXTRACTION_FAILED,
    PAPER_SLIDE_EXTRACTION_INSUFFICIENT,
    PAPER_SLIDE_PDF_ENCRYPTED,
    PAPER_SLIDE_PDF_INVALID,
)
from paperpilot.paper_slides.extract import (
    MAX_CHUNK_CODEPOINTS,
    MAX_CHUNKS,
    MAX_CONSECUTIVE_CHARACTER_REPETITIONS,
    MAX_CONSECUTIVE_SEQUENCE_REPETITIONS,
    MAX_PAGE_CODEPOINTS,
    MAX_PAGES,
    MAX_PDF_BYTES,
    MAX_REPETITION_REDUCTION_PASSES,
    MAX_TOTAL_CODEPOINTS,
    MIN_DEDUPLICATED_LINE_CODEPOINTS,
    MIN_TEXT_CODEPOINTS,
    PdfExtractionError,
    PdfExtractionOptions,
    extract_pdf,
    normalize_page_text,
)

FAKE_PDF_BYTES = b"%PDF-1.7 fake-in-memory-only"


def _unique_text(prefix: str, count: int = 80) -> str:
    return " ".join(f"{prefix}{index:04d}" for index in range(count))


class _FakePage:
    def __init__(self, text: str | object | None, failure: Exception | None = None) -> None:
        self._text = text
        self._failure = failure
        self.calls = 0

    class _Box:
        left = 0
        bottom = 0
        right = 612
        top = 792

    mediabox = _Box()
    cropbox = _Box()

    def extract_text(self, **_kwargs: object) -> str | object | None:
        self.calls += 1
        if self._failure is not None:
            raise self._failure
        return self._text


def _install_fake_reader(
    monkeypatch: pytest.MonkeyPatch,
    pages: object,
    *,
    encrypted: object = False,
) -> None:
    class FakeReader:
        def __init__(self, stream: BytesIO, *, strict: bool) -> None:
            assert isinstance(stream, BytesIO)
            assert strict is True
            self.pages = pages
            self.is_encrypted = encrypted

    monkeypatch.setattr(extraction, "_load_pypdf", lambda: (FakeReader, "test-version"))
    monkeypatch.setattr(
        extraction,
        "_is_page_text_visibility_verified",
        lambda _page, _text: True,
    )


def _assert_error(
    caught: pytest.ExceptionInfo[PdfExtractionError],
    error_code: str,
    issue_code: str,
) -> None:
    assert caught.value.error_code == error_code
    assert caught.value.issue_code == issue_code
    assert caught.value.__dict__ == {
        "error_code": error_code,
        "issue_code": issue_code,
    }
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


def _pdf_with_page_text_and_untrusted_non_page_content() -> bytes:
    """Build a one-page PDF in memory using only the optional slides dependency."""

    from pypdf import PdfWriter
    from pypdf.generic import (
        ArrayObject,
        DecodedStreamObject,
        DictionaryObject,
        FloatObject,
        NameObject,
        TextStringObject,
    )

    safe_text = "Introduction " + _unique_text("visible", 70)
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_reference = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_reference})}
    )
    content = DecodedStreamObject()
    content.set_data(f"BT /F1 12 Tf 72 720 Td ({safe_text}) Tj ET".encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(content)

    annotation = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Text"),
            NameObject("/Rect"): ArrayObject([FloatObject(0)] * 4),
            NameObject("/Contents"): TextStringObject("ANNOTATION_PAYLOAD_MUST_NOT_APPEAR"),
        }
    )
    page[NameObject("/Annots")] = ArrayObject([writer._add_object(annotation)])
    writer.add_attachment("untrusted.txt", b"ATTACHMENT_PAYLOAD_MUST_NOT_APPEAR")
    writer.add_js("app.alert('JAVASCRIPT_PAYLOAD_MUST_NOT_APPEAR')")

    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def _pdf_with_invisible_rendering_modes() -> bytes:
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    visible_text = _unique_text("retained", 75)
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_reference = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_reference})}
    )
    content = DecodedStreamObject()
    content.set_data(
        (
            "BT /F1 12 Tf 72 720 Td 0 Tr "
            f"({visible_text}) Tj "
            "3 Tr (INVISIBLE_RENDER_MODE_3) Tj "
            "7 Tr (INVISIBLE_RENDER_MODE_7) Tj "
            "0 Tr (VISIBLE_TRAILER) Tj ET"
        ).encode("ascii")
    )
    page[NameObject("/Contents")] = writer._add_object(content)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def _pdf_with_visibility_hazard(
    content_bytes: bytes,
    *,
    width: int = 612,
    height: int = 792,
    crop_upper_right: tuple[int, int] | None = None,
) -> bytes:
    """Build one in-memory page containing enough text to pass sufficiency."""

    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    writer = PdfWriter()
    page = writer.add_blank_page(width=width, height=height)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_reference = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_reference})}
    )
    if crop_upper_right is not None:
        page.cropbox.upper_right = crop_upper_right
    content = DecodedStreamObject()
    content.set_data(content_bytes)
    page[NameObject("/Contents")] = writer._add_object(content)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def _pdf_with_page_and_form_xobject_text() -> bytes:
    from pypdf import PdfWriter
    from pypdf.generic import (
        ArrayObject,
        DecodedStreamObject,
        DictionaryObject,
        FloatObject,
        NameObject,
    )

    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_reference = writer._add_object(font)
    font_resources = DictionaryObject({NameObject("/F1"): font_reference})

    form = DecodedStreamObject()
    form.set_data(
        f"BT /F1 12 Tf 72 500 Td ({_unique_text('xobject-hidden', 80)}) Tj ET".encode("ascii")
    )
    form.update(
        {
            NameObject("/Type"): NameObject("/XObject"),
            NameObject("/Subtype"): NameObject("/Form"),
            NameObject("/BBox"): ArrayObject(
                [FloatObject(0), FloatObject(0), FloatObject(612), FloatObject(792)]
            ),
            NameObject("/Resources"): DictionaryObject({NameObject("/Font"): font_resources}),
        }
    )
    form_reference = writer._add_object(form)
    page[NameObject("/Resources")] = DictionaryObject(
        {
            NameObject("/Font"): font_resources,
            NameObject("/XObject"): DictionaryObject({NameObject("/Fm0"): form_reference}),
        }
    )
    page_content = DecodedStreamObject()
    page_content.set_data(
        (f"BT /F1 12 Tf 72 720 Td ({_unique_text('page-visible', 80)}) Tj ET /Fm0 Do").encode(
            "ascii"
        )
    )
    page[NameObject("/Contents")] = writer._add_object(page_content)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def _encrypted_pdf() -> bytes:
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.encrypt("not-used-by-parser")
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def _extract_filtered_real_page_text(pdf_bytes: bytes) -> str:
    """Exercise low-level filtering without treating it as visibility proof."""

    from pypdf import PdfReader

    reader = PdfReader(BytesIO(pdf_bytes), strict=True)
    extracted = extraction._extract_visible_page_text(reader.pages[0])
    assert isinstance(extracted, str)
    return extracted


def test_normalization_is_nfkc_control_free_and_deterministic() -> None:
    raw = "  Ａ\r\n B\tC\u200b\u2066\x00\u034f\ufe0f\u00a0 D\u2028\n\n E  "

    first = normalize_page_text(raw)
    second = normalize_page_text(raw)

    assert first == "A\nB C D\n\nE"
    assert second == first


def test_worker_revalidation_sanitizer_is_deterministic_and_idempotent() -> None:
    raw = "Ａ\r\n" + ("alpha beta " * 100)

    sanitized = extraction._sanitize_page_text(raw)

    assert sanitized.startswith("A\nalpha beta")
    assert len(sanitized) < 500
    assert extraction._sanitize_page_text(sanitized) == sanitized

    nested = "a a a a a b a b a b a b a b a a a a b a b a b a b a b"
    nested_sanitized = extraction._sanitize_page_text(nested)
    assert extraction._sanitize_page_text(nested_sanitized) == nested_sanitized


def test_default_options_are_the_sd1e_hard_contract() -> None:
    assert PdfExtractionOptions() == PdfExtractionOptions(
        max_pdf_bytes=32 * 1024 * 1024,
        max_pages=128,
        max_page_codepoints=100_000,
        max_total_codepoints=1_500_000,
        max_chunks=64,
        max_chunk_codepoints=12_000,
        minimum_text_codepoints=500,
    )
    assert (
        MAX_PDF_BYTES,
        MAX_PAGES,
        MAX_PAGE_CODEPOINTS,
        MAX_TOTAL_CODEPOINTS,
        MAX_CHUNKS,
        MAX_CHUNK_CODEPOINTS,
        MIN_TEXT_CODEPOINTS,
    ) == (32 * 1024 * 1024, 128, 100_000, 1_500_000, 64, 12_000, 500)
    assert MAX_CONSECUTIVE_CHARACTER_REPETITIONS == 16
    assert MAX_CONSECUTIVE_SEQUENCE_REPETITIONS == 4
    assert MAX_REPETITION_REDUCTION_PASSES == 8
    assert MIN_DEDUPLICATED_LINE_CODEPOINTS == 24


def test_real_pdf_uses_only_page_extract_text() -> None:
    pdf_bytes = _pdf_with_page_text_and_untrusted_non_page_content()

    combined = _extract_filtered_real_page_text(pdf_bytes)

    assert "Introduction" in combined
    assert "ANNOTATION_PAYLOAD_MUST_NOT_APPEAR" not in combined
    assert "ATTACHMENT_PAYLOAD_MUST_NOT_APPEAR" not in combined
    assert "JAVASCRIPT_PAYLOAD_MUST_NOT_APPEAR" not in combined


def test_real_pdf_filters_invisible_text_rendering_modes_3_and_7() -> None:
    combined = _extract_filtered_real_page_text(_pdf_with_invisible_rendering_modes())

    assert "retained0000" in combined
    assert "VISIBLE_TRAILER" in combined
    assert "INVISIBLE_RENDER_MODE_3" not in combined
    assert "INVISIBLE_RENDER_MODE_7" not in combined


def test_real_nonempty_pdf_text_is_gated_pending_render_visibility_verifier() -> None:
    pdf_bytes = _pdf_with_page_text_and_untrusted_non_page_content()

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(pdf_bytes)

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_FAILED,
        "page_text_visibility_unverifiable",
    )


@pytest.mark.parametrize(
    "content_template",
    [
        "BT /F1 12 Tf 99 50 Td ({text}) Tj ET",
        "BT /F1 0.000001 Tf 10 50 Td ({text}) Tj ET",
        "0.000001 0 0 0.000001 10 50 cm BT /F1 12 Tf 0 0 Td ({text}) Tj ET",
        "BT /F1 12 Tf 0.000001 Tz 10 50 Td ({text}) Tj ET",
        "1 g BT /F1 12 Tf 10 50 Td ({text}) Tj ET",
    ],
    ids=(
        "long-run-crosses-box",
        "tiny-font",
        "tiny-ctm",
        "tiny-horizontal-scale",
        "white-text-on-default-white-page",
    ),
)
def test_unrenderable_visibility_residuals_never_reach_chunks(
    content_template: str,
) -> None:
    hidden_text = _unique_text("hidden-prompt", 80)
    pdf_bytes = _pdf_with_visibility_hazard(
        content_template.format(text=hidden_text).encode("ascii"),
        width=100,
        height=100,
    )
    # The parser can decode these payloads, which is exactly why its output is
    # not accepted as evidence that a human-visible page contains the text.
    assert "hidden-prompt0000" in _extract_filtered_real_page_text(pdf_bytes)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(pdf_bytes)

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_FAILED,
        "page_text_visibility_unverifiable",
    )


def test_real_pdf_rejects_text_hidden_outside_crop_box() -> None:
    hidden_text = _unique_text("hidden", 80)
    pdf_bytes = _pdf_with_visibility_hazard(
        f"BT /F1 12 Tf 500 500 Td ({hidden_text}) Tj ET".encode("ascii"),
        crop_upper_right=(100, 100),
    )

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(pdf_bytes)

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_FAILED,
        "page_text_visibility_ambiguous",
    )


def test_real_pdf_rejects_text_origin_outside_media_box() -> None:
    hidden_text = _unique_text("hidden", 80)
    pdf_bytes = _pdf_with_visibility_hazard(
        f"BT /F1 12 Tf 500 500 Td ({hidden_text}) Tj ET".encode("ascii"),
        width=100,
        height=100,
    )

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(pdf_bytes)

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_FAILED,
        "page_text_visibility_ambiguous",
    )


def test_real_pdf_applies_current_transformation_to_text_origin() -> None:
    hidden_text = _unique_text("hidden", 80)
    pdf_bytes = _pdf_with_visibility_hazard(
        (f"1 0 0 1 500 500 cm BT /F1 12 Tf 0 0 Td ({hidden_text}) Tj ET").encode("ascii"),
        width=100,
        height=100,
    )

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(pdf_bytes)

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_FAILED,
        "page_text_visibility_ambiguous",
    )


@pytest.mark.parametrize(
    "prefix",
    [
        b"0 0 10 10 re W n ",
        b"/GS0 gs ",
    ],
)
def test_real_pdf_rejects_ambiguous_clip_or_graphics_state(prefix: bytes) -> None:
    visible_text = _unique_text("visible", 80)
    pdf_bytes = _pdf_with_visibility_hazard(
        prefix + f"BT /F1 12 Tf 72 720 Td ({visible_text}) Tj ET".encode("ascii")
    )

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(pdf_bytes)

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_FAILED,
        "page_text_visibility_ambiguous",
    )


def test_parser_without_visibility_callbacks_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class LegacyPage:
        mediabox = _FakePage._Box()
        cropbox = _FakePage._Box()

        def extract_text(self) -> str:
            return _unique_text("hidden", 80)

    _install_fake_reader(monkeypatch, [LegacyPage()])

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES)

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_FAILED,
        "page_text_visibility_ambiguous",
    )


def test_form_xobject_text_is_omitted_when_visibility_context_is_unavailable() -> None:
    combined = _extract_filtered_real_page_text(_pdf_with_page_and_form_xobject_text())

    assert "page-visible0000" in combined
    assert "xobject-hidden0000" not in combined


def test_chunks_are_page_bound_identified_hashed_and_redacted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page_one = _FakePage("Methods\n" + _unique_text("alpha", 48))
    empty_page = _FakePage(None)
    page_three = _FakePage("Results\n" + _unique_text("gamma", 48))
    _install_fake_reader(monkeypatch, [page_one, empty_page, page_three])
    options = PdfExtractionOptions(max_chunk_codepoints=120)

    result = extract_pdf(FAKE_PDF_BYTES, options=options)

    assert result.page_count == 3
    assert result.extracted_page_count == 2
    assert {chunk.page for chunk in result.chunks} == {1, 3}
    assert result.chunks[0].chunk_id == "p001-c01"
    assert next(chunk for chunk in result.chunks if chunk.page == 3).chunk_id == "p003-c01"
    assert all(len(chunk.text) <= 120 for chunk in result.chunks)
    assert all(
        chunk.sha256 == hashlib.sha256(chunk.text.encode("utf-8")).hexdigest()
        for chunk in result.chunks
    )
    assert result.chunks[0].section_hint == "Methods"
    assert page_one.calls == empty_page.calls == page_three.calls == 1

    rendered = repr(result)
    assert "Methods" not in rendered
    assert "alpha beta" not in rendered
    with pytest.raises(FrozenInstanceError):
        result.chunks[0].text = "changed"  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        result.page_count = 99  # type: ignore[misc]


def test_nonrepeating_text_above_minimum_is_sufficient(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    text = _unique_text("unique", 65)
    assert len(text) >= 500
    _install_fake_reader(monkeypatch, [_FakePage(text)])

    result = extract_pdf(FAKE_PDF_BYTES)

    assert len(result.chunks) == 1
    assert result.chunks[0].text == text


def test_duplicate_pages_cannot_inflate_sufficiency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    text = _unique_text("page", 35)
    assert len(text) < 500
    assert len(text) * 2 >= 500
    _install_fake_reader(monkeypatch, [_FakePage(text), _FakePage(text)])

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES)

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_INSUFFICIENT,
        "extracted_text_insufficient",
    )


def test_duplicate_chunks_cannot_inflate_sufficiency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    common = " ".join(f"common{index:02d}" for index in range(20))
    suffix_a = " ".join(f"a{index:02d}" for index in range(35))
    suffix_b = " ".join(f"b{index:02d}" for index in range(35))
    assert len(common) + len(suffix_a) + len(suffix_b) < 500
    assert len(common) * 2 + len(suffix_a) + len(suffix_b) >= 500
    _install_fake_reader(
        monkeypatch,
        [_FakePage(f"{common}\n{suffix_a}"), _FakePage(f"{common}\n{suffix_b}")],
    )

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(
            FAKE_PDF_BYTES,
            options=PdfExtractionOptions(max_chunk_codepoints=len(common)),
        )

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_INSUFFICIENT,
        "extracted_text_insufficient",
    )


def test_nonconsecutive_duplicate_line_cannot_inflate_sufficiency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    duplicate_line = _unique_text("duplicate", 22)
    unique_middle = _unique_text("middle", 14)
    unique_total = len(duplicate_line) + len(unique_middle) + 1
    duplicated_total = unique_total + len(duplicate_line) + 1
    assert unique_total < 500 <= duplicated_total
    _install_fake_reader(
        monkeypatch,
        [_FakePage(f"{duplicate_line}\n{unique_middle}\n{duplicate_line}")],
    )

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES)

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_INSUFFICIENT,
        "extracted_text_insufficient",
    )


def test_repeated_header_and_footer_across_unique_pages_are_counted_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    header = _unique_text("header", 10)
    footer = _unique_text("footer", 10)
    body_a = _unique_text("a", 20)
    body_b = _unique_text("b", 20)
    unique_total = len(header) + len(footer) + len(body_a) + len(body_b) + 4
    duplicated_total = unique_total + len(header) + len(footer) + 2
    assert unique_total < 500 <= duplicated_total
    _install_fake_reader(
        monkeypatch,
        [
            _FakePage(f"{header}\n{body_a}\n{footer}"),
            _FakePage(f"{header}\n{body_b}\n{footer}"),
        ],
    )

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES)

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_INSUFFICIENT,
        "extracted_text_insufficient",
    )

    seen_lines: set[str] = set()
    first = extraction._deduplicate_page_lines(f"{header}\n{body_a}\n{footer}", seen_lines)
    second = extraction._deduplicate_page_lines(f"{header}\n{body_b}\n{footer}", seen_lines)
    assert header in first and footer in first
    assert header not in second and footer not in second
    assert body_b in second


@pytest.mark.parametrize(
    "text",
    [
        "x" * 500,
        "alpha beta " * 100,
        ("repeated line\n" * 50),
    ],
)
def test_extreme_repetition_cannot_inflate_sufficiency(
    monkeypatch: pytest.MonkeyPatch,
    text: str,
) -> None:
    _install_fake_reader(monkeypatch, [_FakePage(text)])

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES)

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_INSUFFICIENT,
        "extracted_text_insufficient",
    )


def test_less_than_500_normalized_codepoints_is_insufficient(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_reader(monkeypatch, [_FakePage(("x " * 249) + "x")])

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES)

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_INSUFFICIENT,
        "extracted_text_insufficient",
    )


def test_input_byte_limit_is_checked_before_parser_load(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        extraction,
        "_load_pypdf",
        lambda: pytest.fail("parser must not load for oversized input"),
    )
    options = PdfExtractionOptions(max_pdf_bytes=8)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(b"%PDF-1.7X", options=options)

    _assert_error(caught, PAPER_SLIDE_EXTRACTION_FAILED, "pdf_byte_limit_exceeded")


def test_absolute_input_byte_ceiling_cannot_be_raised() -> None:
    options = PdfExtractionOptions(max_pdf_bytes=MAX_PDF_BYTES + 1)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES, options=options)

    _assert_error(caught, PAPER_SLIDE_EXTRACTION_FAILED, "extractor_options_invalid")


def test_page_count_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    pages = [_FakePage("unused")] * 3
    _install_fake_reader(monkeypatch, pages)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES, options=PdfExtractionOptions(max_pages=2))

    _assert_error(caught, PAPER_SLIDE_EXTRACTION_FAILED, "pdf_page_limit_exceeded")
    assert all(page.calls == 0 for page in pages)


def test_per_page_text_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_reader(monkeypatch, [_FakePage("x" * 101)])
    monkeypatch.setattr(
        extraction,
        "normalize_page_text",
        lambda _text: pytest.fail("raw limit must run before NFKC"),
    )
    options = PdfExtractionOptions(max_page_codepoints=100)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES, options=options)

    _assert_error(caught, PAPER_SLIDE_EXTRACTION_FAILED, "page_text_limit_exceeded")


def test_total_text_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_reader(monkeypatch, [_FakePage("x" * 350), _FakePage("y" * 351)])
    options = PdfExtractionOptions(max_total_codepoints=700)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES, options=options)

    _assert_error(caught, PAPER_SLIDE_EXTRACTION_FAILED, "total_text_limit_exceeded")


def test_chunk_count_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_reader(monkeypatch, [_FakePage(_unique_text("chunk", 70))])
    options = PdfExtractionOptions(max_chunks=2, max_chunk_codepoints=200)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES, options=options)

    _assert_error(caught, PAPER_SLIDE_EXTRACTION_FAILED, "chunk_limit_exceeded")


def test_split_limit_one_terminates_and_section_hints_stay_out_of_repr() -> None:
    assert extraction._split_page_text("abc", 1) == ["a", "b", "c"]
    chunk = extraction.PdfTextChunk(
        chunk_id="p001-c01",
        page=1,
        text="SECRET_TEXT",
        sha256="a" * 64,
        section_hint="SECRET_HINT",
    )

    long_heading = _unique_text("heading", 20)
    expected_hint = long_heading[:160].rstrip()
    assert len(long_heading) > 160
    assert extraction._section_hint(f"{long_heading}\nbody") == expected_hint
    assert len(expected_hint) <= 160
    assert "SECRET_TEXT" not in repr(chunk)
    assert "SECRET_HINT" not in repr(chunk)


def test_zero_pages_and_non_string_page_text_are_stable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_reader(monkeypatch, [])
    with pytest.raises(PdfExtractionError) as zero_pages:
        extract_pdf(FAKE_PDF_BYTES)
    _assert_error(zero_pages, PAPER_SLIDE_PDF_INVALID, "pdf_page_count_invalid")

    _install_fake_reader(monkeypatch, [_FakePage(object())])
    with pytest.raises(PdfExtractionError) as wrong_text_type:
        extract_pdf(FAKE_PDF_BYTES)
    _assert_error(
        wrong_text_type,
        PAPER_SLIDE_EXTRACTION_FAILED,
        "page_text_type_invalid",
    )


def test_encryption_state_must_be_an_exact_boolean(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_reader(monkeypatch, [_FakePage("unused")], encrypted=1)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES)

    _assert_error(caught, PAPER_SLIDE_PDF_INVALID, "pdf_encryption_state_invalid")


def test_page_iteration_failure_and_count_mismatch_are_stable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class BrokenPages:
        def __len__(self) -> int:
            return 1

        def __iter__(self) -> Iterator[_FakePage]:
            raise RuntimeError("SECRET_ITERATOR_MARKER")

    _install_fake_reader(monkeypatch, BrokenPages())
    with pytest.raises(PdfExtractionError) as iteration_failed:
        extract_pdf(FAKE_PDF_BYTES)
    _assert_error(
        iteration_failed,
        PAPER_SLIDE_PDF_INVALID,
        "pdf_page_iteration_failed",
    )
    assert "SECRET_ITERATOR_MARKER" not in repr(iteration_failed.value)

    class ShortPages:
        def __len__(self) -> int:
            return 2

        def __iter__(self) -> Iterator[_FakePage]:
            yield _FakePage(_unique_text("only", 70))

    _install_fake_reader(monkeypatch, ShortPages())
    with pytest.raises(PdfExtractionError) as count_mismatch:
        extract_pdf(FAKE_PDF_BYTES)
    _assert_error(count_mismatch, PAPER_SLIDE_PDF_INVALID, "pdf_page_count_mismatch")


def test_non_bytes_and_non_pdf_magic_fail_before_parser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        extraction,
        "_load_pypdf",
        lambda: pytest.fail("parser must not load for invalid input"),
    )

    with pytest.raises(PdfExtractionError) as wrong_type:
        extract_pdf(bytearray(b"%PDF-1.7"))  # type: ignore[arg-type]
    _assert_error(wrong_type, PAPER_SLIDE_PDF_INVALID, "pdf_bytes_type")

    with pytest.raises(PdfExtractionError) as wrong_magic:
        extract_pdf(b"not a pdf")
    _assert_error(wrong_magic, PAPER_SLIDE_PDF_INVALID, "pdf_magic_invalid")


def test_encrypted_and_malformed_pdf_have_distinct_stable_failures() -> None:
    with pytest.raises(PdfExtractionError) as encrypted:
        extract_pdf(_encrypted_pdf())
    _assert_error(encrypted, PAPER_SLIDE_PDF_ENCRYPTED, "pdf_encrypted")

    with pytest.raises(PdfExtractionError) as malformed:
        extract_pdf(b"%PDF-1.7\nmalformed-and-sensitive")
    _assert_error(malformed, PAPER_SLIDE_PDF_INVALID, "pdf_malformed")
    assert "malformed-and-sensitive" not in str(malformed.value)


def test_page_parser_exception_does_not_leak_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_reader(
        monkeypatch,
        [_FakePage(None, failure=RuntimeError("SECRET_RAW_PDF_TEXT"))],
    )

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES)

    _assert_error(caught, PAPER_SLIDE_EXTRACTION_FAILED, "page_extraction_failed")
    assert "SECRET_RAW_PDF_TEXT" not in str(caught.value)


def test_unexpected_parser_load_exception_has_no_raw_exception_chain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def broken_loader() -> object:
        raise RuntimeError("SECRET_IMPORT_MARKER")

    monkeypatch.setattr(extraction, "_load_pypdf", broken_loader)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES)

    _assert_error(caught, PAPER_SLIDE_EXTRACTION_FAILED, "parser_load_failed")
    assert "SECRET_IMPORT_MARKER" not in repr(caught.value)


def test_public_boundary_maps_unexpected_sanitizer_exception_without_chain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_reader(monkeypatch, [_FakePage(_unique_text("sanitize", 70))])

    def broken_sanitizer(_text: str) -> str:
        raise RuntimeError("SECRET_SANITIZER_MARKER")

    monkeypatch.setattr(extraction, "_sanitize_page_text", broken_sanitizer)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES)

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_FAILED,
        "unexpected_extraction_failure",
    )
    assert "SECRET_SANITIZER_MARKER" not in repr(caught.value)


def test_public_boundary_maps_unexpected_logger_exception_without_chain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    @contextmanager
    def broken_log_guard() -> Iterator[None]:
        raise RuntimeError("SECRET_LOGGER_MARKER")
        yield

    monkeypatch.setattr(extraction, "_suppress_pypdf_logs", broken_log_guard)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES)

    _assert_error(
        caught,
        PAPER_SLIDE_EXTRACTION_FAILED,
        "unexpected_extraction_failure",
    )
    assert "SECRET_LOGGER_MARKER" not in repr(caught.value)


def test_public_boundary_does_not_mask_process_control_exceptions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_reader(monkeypatch, [_FakePage(_unique_text("interrupt", 70))])

    def interrupted(_text: str) -> str:
        raise KeyboardInterrupt

    monkeypatch.setattr(extraction, "_sanitize_page_text", interrupted)

    with pytest.raises(KeyboardInterrupt):
        extract_pdf(FAKE_PDF_BYTES)


def test_pypdf_logs_are_suppressed_and_logger_state_is_restored(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    class LoggingPage(_FakePage):
        def extract_text(self, **kwargs: object) -> str | object | None:
            logging.getLogger("pypdf.audit").warning("SECRET_PYPDF_LOG_MARKER")
            return super().extract_text(**kwargs)

    pypdf_logger = logging.getLogger("pypdf")
    original_handlers = list(pypdf_logger.handlers)
    original_propagate = pypdf_logger.propagate
    _install_fake_reader(monkeypatch, [LoggingPage(_unique_text("logged", 70))])

    with caplog.at_level(logging.WARNING):
        result = extract_pdf(FAKE_PDF_BYTES)

    assert result.chunks
    assert "SECRET_PYPDF_LOG_MARKER" not in caplog.text
    assert pypdf_logger.handlers == original_handlers
    assert pypdf_logger.propagate is original_propagate


def test_missing_optional_dependency_has_stable_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_import = builtins.__import__

    def missing_pypdf(name: str, *args: object, **kwargs: object) -> object:
        if name == "pypdf":
            raise ModuleNotFoundError("environment-specific import detail")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", missing_pypdf)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf(FAKE_PDF_BYTES)

    _assert_error(caught, PAPER_SLIDE_EXTRACTION_FAILED, "parser_dependency_unavailable")
    assert "environment-specific" not in str(caught.value)

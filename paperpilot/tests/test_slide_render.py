"""SD3 deterministic and safe HTML projection tests."""

from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from pathlib import Path

import pytest

from paperpilot.paper_slides.contract import (
    FULL_TEXT_LABEL_EN,
    MACHINE_SUMMARY_LIMITATION_EN,
    PAPER_SLIDE_OUTPUT_INVALID,
    PAPER_SLIDE_REVIEW_REQUIRED,
    PAPER_SLIDES_PUBLIC_ROOT,
    REVIEW_CHECKLIST,
    PdfChunkReference,
    ReviewRecordReference,
    SlideDeckValidationContext,
    canonical_slide_deck_sha256,
    derive_candidate_sha256,
    derive_deck_id,
    public_review_record_path,
    trusted_envelope_sha256,
)
from paperpilot.paper_slides.render import (
    AssetReferences,
    SlideRenderError,
    render_slide_deck_html,
)

FIXTURES = Path(__file__).parent / "fixtures" / "paper-slides-v1"
ASSETS = AssetReferences(
    stylesheet_path=f"/automatic-paper-search/assets/paper-slides.{'a' * 64}.css",
    stylesheet_sha256="a" * 64,
    script_path=f"/automatic-paper-search/assets/paper-slides.{'b' * 64}.js",
    script_sha256="b" * 64,
)


def _deck(name: str = "full-text.json") -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _base_context(deck: dict) -> SlideDeckValidationContext:
    if deck["coverage"]["kind"] == "abstract_only":
        citation = deck["citations"][0]
        return SlideDeckValidationContext(
            expected_envelope_sha256=trusted_envelope_sha256(deck),
            abstract_sha256=citation["chunk_sha256"],
            abstract_source_anchor=citation["source_anchor"],
        )
    citation = deck["citations"][0]
    return SlideDeckValidationContext(
        expected_envelope_sha256=trusted_envelope_sha256(deck),
        pdf_chunks={
            citation["chunk_id"]: PdfChunkReference(
                page=citation["page"],
                sha256=citation["chunk_sha256"],
                source_anchor=citation["source_anchor"],
                pdf_sha256=deck["source"]["pdf_sha256"],
            )
        },
    )


def _reviewed() -> tuple[dict, SlideDeckValidationContext]:
    deck = _deck()
    base = _base_context(deck)
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
    deck["review"] = {"status": "reviewed", "review_record": review_path}
    return deck, SlideDeckValidationContext(
        expected_envelope_sha256=trusted_envelope_sha256(deck),
        pdf_chunks=base.pdf_chunks,
        review_records={review_path: record},
        review_as_of="2026-08-30T02:00:00Z",
    )


def test_preview_projection_is_deterministic_and_self_describing() -> None:
    deck = _deck()
    context = _base_context(deck)

    first = render_slide_deck_html(deck, context=context, mode="preview", assets=ASSETS)
    second = render_slide_deck_html(
        {key: deck[key] for key in reversed(deck)},
        context=context,
        mode="preview",
        assets=ASSETS,
    )

    assert first == second
    assert first.html_bytes.endswith(b"\n")
    assert b"\r" not in first.html_bytes
    assert first.deck_sha256 == canonical_slide_deck_sha256(deck, context=context)
    assert first.html_sha256 == hashlib.sha256(first.html_bytes).hexdigest()
    html = first.html_bytes.decode()
    assert '<html lang="ja">' in html
    assert 'href="#slide-deck"' in html
    assert 'class="slide-coverage"' in html
    assert "未レビュー" in html
    assert "A Fixture Paper for Grounded Slides" in html
    assert "Ada Example" in html
    assert f'href="{ASSETS.stylesheet_path}"' in html
    assert f'src="{ASSETS.script_path}"' in html
    assert 'integrity="sha256-' in html
    assert 'class="slide-app-header__home" href="/automatic-paper-search/"' in html


def test_public_projection_requires_an_exact_review_record() -> None:
    deck = _deck()
    with pytest.raises(SlideRenderError) as captured:
        render_slide_deck_html(
            deck,
            context=_base_context(deck),
            mode="public",
            assets=ASSETS,
        )
    assert captured.value.error_code == PAPER_SLIDE_REVIEW_REQUIRED
    assert captured.value.issue_code == "public_review_required"

    reviewed, context = _reviewed()
    result = render_slide_deck_html(
        reviewed,
        context=context,
        mode="public",
        assets=ASSETS,
    )
    html = result.html_bytes.decode()
    assert "未レビュー" not in html
    assert 'name="robots" content="noindex,nofollow"' not in html
    assert f'href="{reviewed["review"]["review_record"]}"' in html
    assert re.search(
        rf'href="{re.escape(PAPER_SLIDES_PUBLIC_ROOT)}/reviews/'
        rf'{re.escape(reviewed["deck_id"])}/[0-9a-f]{{64}}\.json"',
        html,
    )


def test_preview_is_noindex_and_never_embeds_private_capabilities() -> None:
    deck = _deck("abstract-only.json")
    result = render_slide_deck_html(
        deck,
        context=_base_context(deck),
        mode="preview",
        assets=ASSETS,
    )
    html = result.html_bytes.decode()
    assert '<meta name="robots" content="noindex,nofollow">' in html
    assert "要旨のみから生成" in html
    assert "request_id" not in html
    assert "capability" not in html.lower()
    assert "provider_request" not in html


def test_invalid_deck_and_context_fail_with_redacted_stable_errors() -> None:
    deck = _deck()
    deck["source"]["title"] = "PRIVATE-PAPER-TEXT"
    with pytest.raises(SlideRenderError) as captured:
        render_slide_deck_html(
            deck,
            context=_base_context(_deck()),
            mode="preview",
            assets=ASSETS,
        )
    assert captured.value.error_code == PAPER_SLIDE_OUTPUT_INVALID
    assert "PRIVATE-PAPER-TEXT" not in str(captured.value)
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None


@pytest.mark.parametrize(
    "assets",
    [
        AssetReferences("https://evil.example/x.css", "a" * 64, ASSETS.script_path, "b" * 64),
        AssetReferences("/assets/../paper-slides.css", "a" * 64, ASSETS.script_path, "b" * 64),
        AssetReferences(ASSETS.stylesheet_path, "A" * 64, ASSETS.script_path, "b" * 64),
        AssetReferences(ASSETS.stylesheet_path, "a" * 64, "//evil.example/x.js", "b" * 64),
        AssetReferences(ASSETS.stylesheet_path, "a" * 64, "/assets/other.js", "b" * 64),
        AssetReferences(
            f"/automatic-paper-search/static/paper-slides.{'a' * 64}.css",
            "a" * 64,
            ASSETS.script_path,
            "b" * 64,
        ),
        AssetReferences(ASSETS.stylesheet_path, "a" * 64, ASSETS.script_path, "0"),
    ],
)
def test_asset_references_are_closed_versioned_same_origin_paths(
    assets: AssetReferences,
) -> None:
    deck = _deck()
    with pytest.raises(SlideRenderError) as captured:
        render_slide_deck_html(
            deck,
            context=_base_context(deck),
            mode="preview",
            assets=assets,
        )
    assert captured.value.issue_code == "render_assets_invalid"


def test_catalog_text_is_escaped_as_text_not_markup() -> None:
    deck = _deck()
    deck["source"]["title"] = 'A & B "quoted" research'
    deck["source"]["authors"] = ["Ada & Bob"]
    context = _base_context(deck)

    html = render_slide_deck_html(
        deck,
        context=context,
        mode="preview",
        assets=ASSETS,
    ).html_bytes.decode()

    assert "A &amp; B &quot;quoted&quot; research" in html
    assert "Ada &amp; Bob" in html
    assert 'A & B "quoted" research' not in html


def test_root_asset_directory_keeps_home_link_root_relative() -> None:
    deck = _deck()
    assets = AssetReferences(
        stylesheet_path=f"/assets/paper-slides.{'a' * 64}.css",
        stylesheet_sha256="a" * 64,
        script_path=f"/assets/paper-slides.{'b' * 64}.js",
        script_sha256="b" * 64,
    )
    html = render_slide_deck_html(
        deck,
        context=_base_context(deck),
        mode="preview",
        assets=assets,
    ).html_bytes.decode()

    assert 'class="slide-app-header__home" href="/"' in html
    assert 'href="//"' not in html


def test_code_owned_chrome_matches_deck_language() -> None:
    deck = _deck()
    deck["language"] = "en"
    deck["coverage"]["label"] = FULL_TEXT_LABEL_EN
    deck["limitations"] = [MACHINE_SUMMARY_LIMITATION_EN]
    deck["deck_id"] = derive_deck_id(deck)
    context = _base_context(deck)

    html = render_slide_deck_html(
        deck,
        context=context,
        mode="preview",
        assets=ASSETS,
    ).html_bytes.decode()

    assert "Skip to slide content" in html
    assert "Unreviewed machine-generated draft" in html
    assert "Citations and sources" in html
    assert "Limitations and verification" in html
    assert "Previous" in html and "Next" in html
    assert "スライド本文へ移動" not in html


def test_every_citation_target_and_backlink_resolves() -> None:
    deck = _deck()
    html = render_slide_deck_html(
        deck,
        context=_base_context(deck),
        mode="preview",
        assets=ASSETS,
    ).html_bytes.decode()

    ids = set(re.findall(r'\bid="([A-Za-z0-9_-]+)"', html))
    fragments = re.findall(r'href="#([A-Za-z0-9_-]+)"', html)
    assert fragments
    assert set(fragments) <= ids
    assert html.count('id="citation-c01"') == 1
    assert 'href="#citation-c01"' in html
    assert 'class="citation-back" href="#s02"' in html


def test_unused_citation_fails_instead_of_creating_a_broken_backlink() -> None:
    deck = _deck()
    unused = deepcopy(deck["citations"][0])
    unused["citation_id"] = "c02"
    deck["citations"].append(unused)

    with pytest.raises(SlideRenderError) as captured:
        render_slide_deck_html(
            deck,
            context=_base_context(deck),
            mode="preview",
            assets=ASSETS,
        )
    assert captured.value.issue_code == "render_citation_unused"


def test_projection_contains_no_active_or_remote_content() -> None:
    deck = _deck()
    html = render_slide_deck_html(
        deck,
        context=_base_context(deck),
        mode="preview",
        assets=ASSETS,
    ).html_bytes.decode()

    assert re.search(r"<(?:style|iframe|object|embed|base)\b", html, re.I) is None
    assert re.search(r"\son[a-z]+\s*=", html, re.I) is None
    assert re.search(r"(?:javascript|data):", html, re.I) is None
    assert re.search(r'<script(?![^>]*\bsrc="/)', html, re.I) is None
    assert re.search(r'<link(?![^>]*\bhref="/)', html, re.I) is None
    assert "https://arxiv.org" in html  # trusted source links are navigation only
    assert "fetch(" not in html
    assert "innerHTML" not in html


def test_html_expansion_over_one_mebibyte_fails_without_truncation() -> None:
    deck = _deck()
    template = deepcopy(deck["slides"][1])
    slides = [deck["slides"][0]]
    for index in range(2, 13):
        slide = deepcopy(template)
        slide["slide_id"] = f"s{index:02d}"
        slide["speaker_notes"] = [{"text": "&" * 1_999, "citation_ids": ["c01"]} for _ in range(12)]
        slides.append(slide)
    deck["slides"] = slides
    context = _base_context(deck)

    with pytest.raises(SlideRenderError) as captured:
        render_slide_deck_html(
            deck,
            context=context,
            mode="preview",
            assets=ASSETS,
        )
    assert captured.value.issue_code == "render_size"


@pytest.mark.parametrize("mode", ["", "PUBLIC", True, None])
def test_render_mode_is_a_closed_exact_enum(mode: object) -> None:
    deck = _deck()
    with pytest.raises(SlideRenderError) as captured:
        render_slide_deck_html(
            deck,
            context=_base_context(deck),
            mode=mode,  # type: ignore[arg-type]
            assets=ASSETS,
        )
    assert captured.value.issue_code == "render_mode_invalid"

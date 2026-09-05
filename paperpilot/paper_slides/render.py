"""Deterministic, safe HTML projection for validated slide decks.

This module renders an already validated ``slide-deck-v1`` artifact.  It does
not generate content, fetch assets, resolve reviews, or publish anything.
Paper/model text is emitted only through HTML text escaping; asset references
remain a small trusted, same-origin configuration surface.
"""

from __future__ import annotations

import hashlib
import html
import json
import os.path
import re
from base64 import b64encode
from dataclasses import dataclass, field
from typing import NoReturn, cast

from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_OUTPUT_INVALID,
    PAPER_SLIDE_REVIEW_REQUIRED,
    SlideDeckValidationContext,
    SlideDeckValidationError,
    canonical_slide_deck_bytes,
)

MAX_RENDERED_HTML_BYTES = 1024 * 1024
_ASSET_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MISSING = object()
_COPY = {
    "ja": {
        "skip": "スライド本文へ移動",
        "preview": "未レビューの機械生成案です。公開物ではありません。",
        "source": "原論文を開く",
        "navigation": "スライド移動",
        "previous": "前へ",
        "next": "次へ",
        "notes": "発表者ノート",
        "citation": "引用",
        "citations": "引用と確認先",
        "citation_back": "参照スライドへ戻る",
        "limitations": "制約と確認事項",
        "machine_notice": "機械生成された要約です。判断には原論文を確認してください。",
        "generated": "生成",
        "generator": "生成系",
        "review": "レビュー記録",
    },
    "en": {
        "skip": "Skip to slide content",
        "preview": "Unreviewed machine-generated draft. This is not a publication.",
        "source": "Open source paper",
        "navigation": "Slide navigation",
        "previous": "Previous",
        "next": "Next",
        "notes": "Speaker notes",
        "citation": "Citation",
        "citations": "Citations and sources",
        "citation_back": "Back to referring slide",
        "limitations": "Limitations and verification",
        "machine_notice": "Machine-generated summary. Verify claims in the source paper.",
        "generated": "Generated",
        "generator": "Generator",
        "review": "Review record",
    },
}


class SlideRenderError(ValueError):
    """Stable projection failure that never includes generated deck prose."""

    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__(f"{error_code}:{issue_code}")


class _RenderIssueError(Exception):
    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__()


@dataclass(frozen=True, slots=True)
class AssetReferences:
    """Trusted, content-addressed, same-origin slide-viewer assets."""

    stylesheet_path: str
    stylesheet_sha256: str
    script_path: str
    script_sha256: str


@dataclass(frozen=True, slots=True)
class RenderedSlideDeck:
    """Canonical HTML bytes and their two publication hashes."""

    html_bytes: bytes = field(repr=False)
    deck_sha256: str
    html_sha256: str


def _issue(
    issue_code: str,
    error_code: str = PAPER_SLIDE_OUTPUT_INVALID,
) -> NoReturn:
    raise _RenderIssueError(error_code, issue_code)


def _asset_path(value: object, stem: str, suffix: str, sha256: object) -> str:
    if type(sha256) is not str or _SHA256_RE.fullmatch(sha256) is None:
        _issue("render_assets_invalid")
    filename = f"{stem}.{sha256}.{suffix}"
    if (
        type(value) is not str
        or not 1 <= len(value) <= 2048
        or not value.startswith("/")
        or value.startswith("//")
        or "\\" in value
        or "?" in value
        or "#" in value
        or "%" in value
        or os.path.normpath(value) != value
    ):
        _issue("render_assets_invalid")
    segments = value[1:].split("/")
    if (
        not segments
        or segments[-1] != filename
        or any(
            segment in {"", ".", ".."} or _ASSET_SEGMENT_RE.fullmatch(segment) is None
            for segment in segments
        )
    ):
        _issue("render_assets_invalid")
    return value


def _validated_assets(value: object) -> AssetReferences:
    if type(value) is not AssetReferences:
        _issue("render_assets_invalid")
    assets = value
    stylesheet_path = _asset_path(
        assets.stylesheet_path,
        "paper-slides",
        "css",
        assets.stylesheet_sha256,
    )
    script_path = _asset_path(
        assets.script_path,
        "paper-slides",
        "js",
        assets.script_sha256,
    )
    asset_directory = os.path.dirname(stylesheet_path)
    if (
        asset_directory != os.path.dirname(script_path)
        or os.path.basename(asset_directory) != "assets"
    ):
        _issue("render_assets_invalid")
    return AssetReferences(
        stylesheet_path=stylesheet_path,
        stylesheet_sha256=assets.stylesheet_sha256,
        script_path=script_path,
        script_sha256=assets.script_sha256,
    )


def _text(value: object) -> str:
    """Escape a field already shape-validated by the SD0 contract."""

    return html.escape(cast(str, value), quote=True)


def _attribute(value: object) -> str:
    return html.escape(cast(str, value), quote=True)


def _sri(sha256: str) -> str:
    return "sha256-" + b64encode(bytes.fromhex(sha256)).decode("ascii")


def _copy(language: str, key: str) -> str:
    return _COPY[language][key]


def _citation_back_targets(deck: dict) -> dict[str, str]:
    targets: dict[str, str] = {}
    for slide in deck["slides"]:
        slide_id = cast(str, slide["slide_id"])
        for statement in (*slide["bullets"], *slide["speaker_notes"]):
            for citation_id in statement["citation_ids"]:
                targets.setdefault(cast(str, citation_id), slide_id)
    return targets


def _source_link(anchor: str, label: str, *, class_name: str) -> str:
    return (
        f'<a class="{class_name}" href="{_attribute(anchor)}" '
        f'target="_blank" rel="noopener noreferrer">{label}</a>'
    )


def _render_statement(statement: dict, *, css_class: str, language: str) -> str:
    citation_links = " ".join(
        f'<a class="statement-citation" href="#citation-{_attribute(citation_id)}" '
        f'aria-label="{_copy(language, "citation")} {_attribute(citation_id)}">'
        f"[{_text(citation_id)}]</a>"
        for citation_id in statement["citation_ids"]
    )
    return f'<li class="{css_class}"><span>{_text(statement["text"])}</span> {citation_links}</li>'


def _render_slide_navigation(slides: list[dict], index: int, language: str) -> str:
    links: list[str] = []
    if index > 0:
        previous_id = slides[index - 1]["slide_id"]
        links.append(
            f'<a class="slide-nav__previous" href="#{_attribute(previous_id)}" rel="prev">'
            f"{_copy(language, 'previous')}</a>"
        )
    if index + 1 < len(slides):
        next_id = slides[index + 1]["slide_id"]
        links.append(
            f'<a class="slide-nav__next" href="#{_attribute(next_id)}" rel="next">'
            f"{_copy(language, 'next')}</a>"
        )
    return (
        f'<nav class="slide-nav" aria-label="{_copy(language, "navigation")}">'
        + "".join(links)
        + "</nav>"
    )


def _render_slide(deck: dict, slide: dict, index: int) -> str:
    slides = cast(list[dict], deck["slides"])
    language = cast(str, deck["language"])
    slide_id = cast(str, slide["slide_id"])
    title_id = f"{slide_id}-title"
    pieces = [
        f'<section class="paper-slide paper-slide--{_attribute(slide["kind"])}" '
        f'id="{_attribute(slide_id)}" tabindex="-1" aria-labelledby="{title_id}">',
        '<header class="paper-slide__header">',
        f'<p class="paper-slide__position">{index + 1} / {len(slides)}</p>',
        f'<h2 id="{title_id}">{_text(slide["title"])}</h2>',
        "</header>",
    ]
    if slide["kind"] == "title":
        pieces.extend(
            (
                f'<p class="paper-slide__paper-title">{_text(deck["source"]["title"])}</p>',
                '<p class="paper-slide__authors">'
                + " · ".join(_text(author) for author in deck["source"]["authors"])
                + "</p>",
            )
        )
    if slide["bullets"]:
        pieces.append('<ul class="paper-slide__bullets">')
        pieces.extend(
            _render_statement(
                statement,
                css_class="paper-slide__bullet",
                language=language,
            )
            for statement in slide["bullets"]
        )
        pieces.append("</ul>")
    visual = slide["visual"]
    if visual["kind"] == "generated_diagram":
        pieces.extend(
            (
                '<figure class="paper-slide__visual paper-slide__visual--text">',
                f"<figcaption>{_text(visual['alt'])}</figcaption>",
                f"<p>{_text(visual['spec'])}</p>",
                "</figure>",
            )
        )
    if slide["speaker_notes"]:
        pieces.extend(
            (
                '<details class="paper-slide__notes">',
                f"<summary>{_copy(language, 'notes')}</summary>",
                '<ul class="paper-slide__notes-list">',
            )
        )
        pieces.extend(
            _render_statement(
                statement,
                css_class="paper-slide__note",
                language=language,
            )
            for statement in slide["speaker_notes"]
        )
        pieces.extend(("</ul>", "</details>"))
    pieces.extend((_render_slide_navigation(slides, index, language), "</section>"))
    return "".join(pieces)


def _citation_label(citation: dict, language: str) -> str:
    if citation["source_kind"] == "pdf_page":
        return (
            f"原論文 PDF p.{citation['page']}"
            if language == "ja"
            else f"Paper PDF p.{citation['page']}"
        )
    if citation["source_kind"] == "abstract":
        return "原論文の要旨" if language == "ja" else "Paper abstract"
    return "監査済み系譜根拠" if language == "ja" else "Audited lineage evidence"


def _render_citations(deck: dict) -> str:
    language = cast(str, deck["language"])
    back_targets = _citation_back_targets(deck)
    if any(citation["citation_id"] not in back_targets for citation in deck["citations"]):
        _issue("render_citation_unused")
    pieces = [
        '<section class="slide-citations" aria-labelledby="slide-citations-title">',
        f'<h2 id="slide-citations-title">{_copy(language, "citations")}</h2>',
        '<ol class="slide-citations__list">',
    ]
    for citation in deck["citations"]:
        citation_id = cast(str, citation["citation_id"])
        back_target = back_targets[citation_id]
        label = _text(_citation_label(citation, language))
        pieces.extend(
            (
                f'<li id="citation-{_attribute(citation_id)}">',
                f'<span class="citation-id">[{_text(citation_id)}]</span> ',
                _source_link(
                    cast(str, citation["source_anchor"]),
                    label,
                    class_name="citation-source",
                ),
                f' <a class="citation-back" href="#{_attribute(back_target)}">'
                f"{_copy(language, 'citation_back')}</a>",
                "</li>",
            )
        )
    pieces.extend(("</ol>", "</section>"))
    return "".join(pieces)


def _render_document(deck: dict, mode: str, assets: AssetReferences) -> bytes:
    language = cast(str, deck["language"])
    preview = mode == "preview"
    title = _text(deck["source"]["title"])
    coverage = _text(deck["coverage"]["label"])
    site_root = os.path.dirname(os.path.dirname(assets.stylesheet_path))
    home_path = "/" if site_root == "/" else f"{site_root}/"
    head = [
        "<!doctype html>",
        f'<html lang="{language}">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        '<meta name="referrer" content="strict-origin-when-cross-origin">',
        '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; '
        "style-src 'self'; script-src 'self'; img-src 'none'; font-src 'self'; "
        "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\">",
    ]
    if preview:
        head.append('<meta name="robots" content="noindex,nofollow">')
    head.extend(
        (
            f"<title>{title} — PaperPilot Slides</title>",
            f'<link rel="stylesheet" href="{_attribute(assets.stylesheet_path)}" '
            f'integrity="{_sri(assets.stylesheet_sha256)}">',
            "</head>",
            f'<body class="paper-slides render-mode-{mode}">',
            f'<a class="skip-link" href="#slide-deck">{_copy(language, "skip")}</a>',
            '<header class="slide-app-header">',
            f'<a class="slide-app-header__home" href="{_attribute(home_path)}">PaperPilot</a>',
            "<span>Paper Slides</span>",
            "</header>",
            f'<p class="slide-coverage">{coverage}</p>',
        )
    )
    if preview:
        head.append(
            f'<aside class="slide-preview-warning" role="note">{_copy(language, "preview")}</aside>'
        )
    source_link = _source_link(
        cast(str, deck["source"]["landing_url"]),
        _copy(language, "source"),
        class_name="slide-source__link",
    )
    body = [
        '<main id="slide-deck" tabindex="-1">',
        '<header class="slide-deck-header">',
        f'<p class="slide-deck-header__eyebrow">{coverage}</p>',
        f"<h1>{title}</h1>",
        '<p class="slide-deck-header__authors">'
        + " · ".join(_text(author) for author in deck["source"]["authors"])
        + "</p>",
        source_link,
        "</header>",
        '<div class="slide-deck-sequence">',
    ]
    body.extend(_render_slide(deck, slide, index) for index, slide in enumerate(deck["slides"]))
    body.extend(("</div>", _render_citations(deck)))
    body.extend(
        (
            '<section class="slide-limitations" aria-labelledby="slide-limitations-title">',
            f'<h2 id="slide-limitations-title">{_copy(language, "limitations")}</h2>',
            "<ul>",
        )
    )
    body.extend(f"<li>{_text(item)}</li>" for item in deck["limitations"])
    body.extend(
        (
            "</ul>",
            "</section>",
            '<footer class="slide-deck-footer">',
            f'<p class="machine-notice">{_copy(language, "machine_notice")}</p>',
            f"<p>{_copy(language, 'generated')}: "
            f'<time datetime="{_attribute(deck["generated_at"])}">'
            f"{_text(deck['generated_at'])}</time></p>",
            f"<p>{_copy(language, 'generator')}: "
            f"{_text(deck['generator']['provider'])} / "
            f"{_text(deck['generator']['model'])}</p>",
        )
    )
    if mode == "public":
        review_path = cast(str, deck["review"]["review_record"])
        body.append(
            f'<p><a class="slide-review-record" href="{_attribute(review_path)}">'
            f"{_copy(language, 'review')}</a></p>"
        )
    body.extend(
        (
            "</footer>",
            "</main>",
            f'<script src="{_attribute(assets.script_path)}" '
            f'integrity="{_sri(assets.script_sha256)}" defer></script>',
            "</body>",
            "</html>",
        )
    )
    payload = "\n".join((*head, *body)).encode("utf-8") + b"\n"
    if len(payload) > MAX_RENDERED_HTML_BYTES:
        _issue("render_size")
    return payload


def _render(
    deck: object,
    *,
    context: SlideDeckValidationContext,
    mode: object,
    assets: object,
) -> RenderedSlideDeck:
    canonical_deck = canonical_slide_deck_bytes(deck, context=context)
    validated = cast(dict, json.loads(canonical_deck))
    if type(mode) is not str or mode not in {"preview", "public"}:
        _issue("render_mode_invalid")
    if mode == "public" and validated["review"]["status"] != "reviewed":
        _issue("public_review_required", PAPER_SLIDE_REVIEW_REQUIRED)
    trusted_assets = _validated_assets(assets)
    html_bytes = _render_document(validated, mode, trusted_assets)
    return RenderedSlideDeck(
        html_bytes=html_bytes,
        deck_sha256=hashlib.sha256(canonical_deck).hexdigest(),
        html_sha256=hashlib.sha256(html_bytes).hexdigest(),
    )


def render_slide_deck_html(
    deck: object,
    *,
    context: SlideDeckValidationContext,
    mode: str,
    assets: AssetReferences,
) -> RenderedSlideDeck:
    """Project one validated deck into deterministic standalone HTML."""

    failure: tuple[str, str] | None = None
    result: object = _MISSING
    try:
        result = _render(deck, context=context, mode=mode, assets=assets)
    except (KeyboardInterrupt, SystemExit):
        raise
    except SlideDeckValidationError as error:
        failure = (error.code, error.issue_code)
    except _RenderIssueError as error:
        failure = (error.error_code, error.issue_code)
    except Exception:
        failure = (PAPER_SLIDE_OUTPUT_INVALID, "render_internal_failure")
    if failure is not None:
        raise SlideRenderError(*failure)
    if result is _MISSING:
        raise SlideRenderError(PAPER_SLIDE_OUTPUT_INVALID, "render_internal_failure")
    return cast(RenderedSlideDeck, result)


__all__ = [
    "MAX_RENDERED_HTML_BYTES",
    "AssetReferences",
    "RenderedSlideDeck",
    "SlideRenderError",
    "render_slide_deck_html",
]

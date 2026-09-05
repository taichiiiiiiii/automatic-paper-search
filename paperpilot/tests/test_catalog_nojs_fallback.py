"""Contracts for the generated no-JavaScript catalog link pages."""

from __future__ import annotations

import inspect
import json
from html.parser import HTMLParser
from pathlib import Path

import pytest

from paperpilot.identity import IdentityError
from paperpilot.scripts import build_pages

PAPER_A = "a" * 40
PAPER_B = "b" * 40


def _paper(paper_id: str, title: str, url: str) -> dict[str, object]:
    return {
        "paper_id": paper_id,
        "title": title,
        "arxiv_url": url,
        "pdf_url": "",
    }


class _FallbackParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: list[str] = []
        self.links: list[dict[str, str]] = []
        self.elements: list[tuple[str, dict[str, str]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name: value or "" for name, value in attrs}
        if "id" in values:
            self.ids.append(values["id"])
        if tag == "a":
            self.links.append(values)
        self.elements.append((tag, values))


def _parse(source: str) -> _FallbackParser:
    parser = _FallbackParser()
    parser.feed(source)
    return parser


def test_fallback_is_escaped_title_sorted_and_has_stable_anchors() -> None:
    dangerous = '<script>alert("x")</script> & paper'
    first = build_pages.render_paper_links_page(
        "test-conf",
        [
            _paper(PAPER_A, "Zulu", "https://example.test/a"),
            _paper(PAPER_B, dangerous, "https://example.test/b?x=1&y=2"),
        ],
    )
    second = build_pages.render_paper_links_page(
        "test-conf",
        [
            _paper(PAPER_B, dangerous, "https://example.test/b?x=1&y=2"),
            _paper(PAPER_A, "Zulu", "https://example.test/a"),
        ],
    )

    assert first == second
    assert "<script>alert" not in first
    assert "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; paper" in first
    assert first.index(f'id="paper-{PAPER_B}"') < first.index(f'id="paper-{PAPER_A}"')
    parser = _parse(first)
    assert f"paper-{PAPER_A}" in parser.ids
    assert f"paper-{PAPER_B}" in parser.ids
    assert any(link.get("href") == "https://example.test/b?x=1&y=2" for link in parser.links)
    assert (
        '<h2 class="paper__title"><a href="https://example.test/b?x=1&amp;y=2" '
        'target="_blank" rel="noopener noreferrer">'
        "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; paper</a></h2>"
    ) in first


@pytest.mark.parametrize(
    "unsafe",
    (
        "javascript:alert(1)",
        "data:text/html,unsafe",
        "//example.test/no-scheme",
        "https://user:password@example.test/paper",
        'https://example.test/" onclick="alert(1)',
    ),
)
def test_fallback_omits_unsafe_original_urls(unsafe: str) -> None:
    source = build_pages.render_paper_links_page("test-conf", [_paper(PAPER_A, "Unsafe", unsafe)])

    parser = _parse(source)
    hrefs = {link.get("href") for link in parser.links}
    assert unsafe not in hrefs
    assert "原論文リンクを利用できません。" in source


def test_fallback_rejects_duplicate_paper_ids() -> None:
    with pytest.raises(IdentityError, match="duplicate paper_id"):
        build_pages.render_paper_links_page(
            "test-conf",
            [
                _paper(PAPER_A, "First", "https://example.test/a"),
                _paper(PAPER_A, "Duplicate", "https://example.test/b"),
            ],
        )


def test_fallback_empty_page_keeps_accessible_shell() -> None:
    source = build_pages.render_paper_links_page("empty-conf", [])
    parser = _parse(source)

    assert "掲載できる論文はありません。" in source
    assert any(tag == "html" and attrs.get("lang") == "ja" for tag, attrs in parser.elements)
    assert any(
        tag == "nav" and attrs.get("aria-label") == "グローバル" for tag, attrs in parser.elements
    )
    assert any(
        tag == "main" and attrs.get("id") == "main-content" for tag, attrs in parser.elements
    )
    assert any(link.get("href") == "#main-content" for link in parser.links)


def test_fallback_rejects_unbounded_row_or_byte_output(monkeypatch) -> None:
    papers = [
        _paper(f"{ordinal:040x}", f"Paper {ordinal}", f"https://example.test/{ordinal}")
        for ordinal in range(build_pages.NOJS_MAX_PAPERS + 1)
    ]
    with pytest.raises(ValueError, match="row limit"):
        build_pages.render_paper_links_page("test-conf", papers)

    monkeypatch.setattr(build_pages, "NOJS_MAX_RENDERED_BYTES", 100)
    with pytest.raises(ValueError, match="rendered byte limit"):
        build_pages.render_paper_links_page(
            "test-conf", [_paper(PAPER_A, "Paper", "https://example.test/a")]
        )


def test_fallback_has_no_unverified_slide_link_interface() -> None:
    assert list(inspect.signature(build_pages.render_paper_links_page).parameters) == [
        "conference",
        "papers",
    ]
    source = build_pages.render_paper_links_page(
        "test-conf", [_paper(PAPER_A, "Paper", "https://example.test/a")]
    )
    assert "paper-slides-v1/decks" not in source
    assert "レビュー済みスライド" not in source


def test_every_catalog_noscript_target_exists_and_is_accessible() -> None:
    docs = Path(__file__).resolve().parents[2] / "docs"
    catalog_indexes = sorted(
        path.parent / "index.html"
        for path in docs.glob("*/papers.json")
        if path.parent.name not in build_pages.NON_CONFERENCE
        and (path.parent / "index.html").is_file()
    )
    assert catalog_indexes

    for index in catalog_indexes:
        index_source = index.read_text(encoding="utf-8")
        assert '<a href="paper-links.html">JavaScript なしの論文リンク一覧</a>' in index_source
        fallback = index.with_name("paper-links.html")
        assert fallback.is_file(), fallback
        parser = _parse(fallback.read_text(encoding="utf-8"))
        assert "main-content" in parser.ids
        assert any(link.get("href") == "#main-content" for link in parser.links)


def test_repo_fallbacks_are_exact_and_within_current_budgets() -> None:
    """A stale checked-in fallback must fail even when the file still exists."""

    docs = Path(__file__).resolve().parents[2] / "docs"
    catalogs = sorted(
        path
        for path in docs.glob("*/papers.json")
        if path.parent.name not in build_pages.NON_CONFERENCE
        and (path.parent / "index.html").is_file()
    )
    assert catalogs
    for catalog in catalogs:
        papers = json.loads(catalog.read_text(encoding="utf-8"))
        expected = build_pages.render_paper_links_page(catalog.parent.name, papers)
        fallback = catalog.with_name("paper-links.html")
        actual = fallback.read_text(encoding="utf-8")
        assert actual == expected, f"stale no-JS fallback: {fallback}"
        assert len(papers) <= build_pages.NOJS_MAX_PAPERS
        assert len(actual.encode("utf-8")) <= build_pages.NOJS_MAX_RENDERED_BYTES

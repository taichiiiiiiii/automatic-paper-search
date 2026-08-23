"""S0 landing (docs/index.html) structural tests for the #372 redesign.

Validates that the new search-first top page ships the five required
elements: a ``[data-search]`` combobox, autofocus, a collapsible
conference list (``aria-expanded``), three example query chips, and
no reference to the retired ``conferences-index.js``.

Design spec: DESIGN-372.md §2 S0 検索トップ.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
INDEX_HTML = REPO_ROOT / "docs" / "index.html"


@pytest.fixture(scope="module")
def index_text() -> str:
    return INDEX_HTML.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# (a) data-search form — exactly one
# ---------------------------------------------------------------------------


def test_landing_has_one_data_search_form(index_text: str) -> None:
    matches = re.findall(r'<form[^>]*\bdata-search\b[^>]*>', index_text)
    assert len(matches) == 1, (
        f"expected exactly one <form data-search>, found {len(matches)}"
    )


def test_landing_search_form_has_required_children(index_text: str) -> None:
    # The combobox structure search.js depends on: input / results / status.
    assert re.search(r'class="site-search__input"', index_text)
    assert re.search(r'class="site-search__results"', index_text)
    assert re.search(r'class="site-search__status"', index_text)
    # role="combobox" on the input so screen readers expose it correctly.
    assert re.search(r'<input[^>]*role="combobox"[^>]*>', index_text)


# ---------------------------------------------------------------------------
# (b) autofocus — search box is the primary action on the landing
# ---------------------------------------------------------------------------


def test_landing_search_input_has_autofocus(index_text: str) -> None:
    # Autofocus lives on the .site-search__input, so a visitor lands and
    # can start typing without a second click.
    m = re.search(r'<input[^>]*class="site-search__input"[^>]*>', index_text)
    assert m is not None, "site-search__input <input> not found"
    assert "autofocus" in m.group(0), "site-search__input is missing autofocus"


# ---------------------------------------------------------------------------
# (c) aria-expanded collapsible for the conference list
# ---------------------------------------------------------------------------


def test_landing_has_aria_expanded_collapsible(index_text: str) -> None:
    # A <button> with aria-expanded + aria-controls is the a11y contract
    # for a collapsible. The controlled list must exist and be hidden by
    # default (既定で閉).
    m = re.search(
        r'<button[^>]*\baria-expanded=["\']false["\'][^>]*\baria-controls=["\']([^"\']+)["\']',
        index_text,
    )
    assert m is not None, "no <button aria-expanded=false aria-controls=...>"
    controlled_id = m.group(1)
    assert re.search(
        rf'<[^>]*\bid=["\']{re.escape(controlled_id)}["\'][^>]*\bhidden\b', index_text
    ), f"controlled element #{controlled_id} should start hidden"


def test_landing_collapsible_contains_conference_links(index_text: str) -> None:
    # The list is populated by inline script from conferences.json; the
    # container must carry the controlled id and the label must reference
    # "学会から探す" (the spec's wording).
    assert "学会から探す" in index_text


# ---------------------------------------------------------------------------
# (d) no reference to conferences-index.js
# ---------------------------------------------------------------------------


def test_landing_has_no_conferences_index_reference(index_text: str) -> None:
    assert "conferences-index.js" not in index_text, (
        "index.html still references the retired conferences-index.js"
    )


def test_conferences_index_js_file_removed() -> None:
    removed = REPO_ROOT / "docs" / "assets" / "conferences-index.js"
    assert not removed.exists(), (
        f"docs/assets/conferences-index.js should be deleted, found at {removed}"
    )


# ---------------------------------------------------------------------------
# (e) exactly three example query chips
# ---------------------------------------------------------------------------


def test_landing_has_three_example_chips(index_text: str) -> None:
    chips = re.findall(r'<button[^>]*class="s0__chip"[^>]*data-query="([^"]+)"', index_text)
    assert len(chips) == 3, (
        f"expected exactly 3 example chips with data-query, found {len(chips)}: {chips}"
    )
    # Every chip must carry a non-empty query string.
    assert all(c.strip() for c in chips), "example chip has empty data-query"


def test_landing_example_chips_are_real_search_hits() -> None:
    # The three chosen chips must each produce at least one hit in the
    # shipped search-index.json, otherwise the chip would be a dead link
    # into the empty state.
    import json

    index_path = REPO_ROOT / "docs" / "search-index.json"
    if not index_path.exists():
        pytest.skip("search-index.json not present in this checkout")
    data = json.loads(index_path.read_text(encoding="utf-8"))
    titles = [row[0].lower() for row in data]

    chips = re.findall(
        r'<button[^>]*class="s0__chip"[^>]*data-query="([^"]+)"',
        INDEX_HTML.read_text(encoding="utf-8"),
    )
    for q in chips:
        needle = q.lower()
        hits = sum(1 for t in titles if needle in t)
        assert hits > 0, f"example chip {q!r} has zero hits in search-index.json"


# ---------------------------------------------------------------------------
# Shell integrity — the shared site-nav / skip-link contract is preserved.
# test_site_shell.py is the source of truth for nav uniformity; these
# assertions pin the landing's own contribution to the shared contract.
# ---------------------------------------------------------------------------


def test_landing_skip_link(index_text: str) -> None:
    assert re.search(r'<a[^>]*class="skip-link"[^>]*href="#main-content"', index_text)


def test_landing_nav_has_aria_current_on_search(index_text: str) -> None:
    # Root page: the 「探す」 link carries aria-current="page" so the
    # shared shell test and this landing test agree on the contract.
    m = re.search(r'<li>\s*<a[^>]*aria-current="page"[^>]*>探す</a>\s*</li>', index_text)
    assert m is not None, "「探す」 link is missing aria-current=\"page\""


def test_landing_title_and_description_are_search_framed(index_text: str) -> None:
    # The redesign reframes PaperPilot around search, not "family tree".
    title_m = re.search(r"<title>([^<]+)</title>", index_text)
    assert title_m is not None
    title = title_m.group(1)
    assert "家系図" not in title, (
        "title still leads with the retired 家系図 framing"
    )
    # The description should mention search + conference scope.
    desc_m = re.search(r'<meta[^>]*name="description"[^>]*content="([^"]+)"', index_text)
    assert desc_m is not None
    desc = desc_m.group(1)
    assert "検索" in desc or "探す" in desc


def test_no_executable_inline_scripts() -> None:
    """CSP is `script-src 'self'` — executable inline <script> blocks are
    silently dropped by the browser (caught live on 2026-08-24: the S0
    numerals/chips/disclosure script never ran). Only inert data blocks
    (type="application/ld+json") may be inline; all behavior must live in
    external assets/ files.
    """
    import re

    html = INDEX_HTML.read_text(encoding="utf-8")
    # Strip HTML comments first — prose may mention "<script>" verbatim.
    html_no_comments = re.sub(r"<!--.*?-->", "", html, flags=re.S)
    for m in re.finditer(
        r"<script([^>]*)>(.*?)</script>", html_no_comments, flags=re.S
    ):
        attrs, body = m.group(1), m.group(2)
        if "src=" in attrs:
            assert not body.strip(), "script[src] must have an empty body"
            continue
        assert 'type="application/ld+json"' in attrs, (
            "executable inline <script> found — CSP script-src 'self' "
            "silently blocks it; move the code to docs/assets/*.js: "
            + body.strip()[:120]
        )


def test_landing_js_referenced() -> None:
    """The S0 behavior script must be loaded as an external asset."""
    html = INDEX_HTML.read_text(encoding="utf-8")
    assert 'src="assets/landing.js?v=' in html


def test_landing_js_q_permalink_sync() -> None:
    """/?q=<query> must replay the inline search on load, and typing must
    keep the URL shareable (replaceState). Pinned statically — behavior is
    verified headless (frontend has no browser in CI).
    """
    js = (REPO_ROOT / "docs" / "assets" / "landing.js").read_text(encoding="utf-8")
    assert 'URLSearchParams(window.location.search).get("q")' in js
    assert "replaceState" in js


def test_landing_js_builds_dom_safely() -> None:
    """conferences.json values must never flow through innerHTML."""
    js = (REPO_ROOT / "docs" / "assets" / "landing.js").read_text(encoding="utf-8")
    assert "innerHTML" not in js and "insertAdjacentHTML" not in js

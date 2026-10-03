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
    matches = re.findall(r"<form[^>]*\bdata-search\b[^>]*>", index_text)
    assert len(matches) == 1, f"expected exactly one <form data-search>, found {len(matches)}"


def test_landing_search_form_has_required_children(index_text: str) -> None:
    # The combobox structure search.js depends on: input / results / status.
    assert re.search(r'class="site-search__input"', index_text)
    assert re.search(r'class="site-search__results"', index_text)
    assert re.search(r'class="site-search__status"', index_text)
    # role="combobox" on the input so screen readers expose it correctly.
    assert re.search(r'<input[^>]*role="combobox"[^>]*>', index_text)


# ---------------------------------------------------------------------------
# (b) focus — search box is the primary action; focus is pointer-gated
# ---------------------------------------------------------------------------


def test_landing_search_input_focus_is_pointer_gated(index_text: str) -> None:
    """No bare `autofocus` (it opens the mobile keyboard on load);
    landing.js focuses the input only for fine-pointer devices.
    """
    assert "autofocus" not in index_text.split("<body")[1], (
        "bare autofocus attribute found — focus must stay pointer-gated"
    )
    js = (REPO_ROOT / "docs" / "assets" / "landing.js").read_text(encoding="utf-8")
    assert "(pointer: fine)" in js and "input.focus()" in js


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

    index_path = REPO_ROOT / "docs" / "search-index-v2.json"
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
    assert m is not None, '「探す」 link is missing aria-current="page"'


def test_landing_title_and_description_are_search_framed(index_text: str) -> None:
    # The redesign reframes PaperPilot around search, not "family tree".
    title_m = re.search(r"<title>([^<]+)</title>", index_text)
    assert title_m is not None
    title = title_m.group(1)
    assert "家系図" not in title, "title still leads with the retired 家系図 framing"
    # The description should mention search + conference scope.
    desc_m = re.search(r'<meta[^>]*name="description"[^>]*content="([^"]+)"', index_text)
    assert desc_m is not None
    desc = desc_m.group(1)
    assert "検索" in desc or "探す" in desc
    assert "生成" not in desc and "辿れます" not in desc


def test_landing_lineage_defaults_to_truthful_closed_state(index_text: str) -> None:
    """No-JS and failed quality loads must not advertise unpublished lineage."""
    assert "系譜データは現在公開準備中です。" in index_text
    assert "監査済みの系譜は準備中です。" in index_text
    assert "系譜を辿る" not in index_text
    core = index_text.index('src="assets/lineage-core.js?v=')
    landing = index_text.index('src="assets/landing.js?v=')
    assert core < landing


_NON_EXECUTABLE_SCRIPT_TYPES = {"application/ld+json", "application/json", "importmap"}
_ALL_DOCS_HTML = sorted((REPO_ROOT / "docs").rglob("*.html"))


@pytest.mark.parametrize(
    "html_path", _ALL_DOCS_HTML, ids=[str(p.relative_to(REPO_ROOT)) for p in _ALL_DOCS_HTML]
)
def test_no_executable_inline_scripts(html_path: Path) -> None:
    """CSP is `script-src 'self'` — executable inline <script> blocks are
    silently dropped by the browser (caught live on 2026-08-24: the S0
    numerals/chips/disclosure script never ran). Only inert data blocks
    (``type="application/ld+json"`` or another non-executable type) may be
    inline; all behavior must live in external assets/ files. Also pins
    the related CSP-equivalent sinks: inline `on*=` event handler
    attributes and `javascript:` URLs, both of which bypass `script-src`
    entirely if ever reintroduced.

    M-5c: originally scoped to docs/index.html only; extended to every
    page under docs/ so a page other than the landing page can't silently
    regress.
    """
    html = html_path.read_text(encoding="utf-8")
    # Strip HTML comments first — prose may mention "<script>" verbatim.
    html_no_comments = re.sub(r"<!--.*?-->", "", html, flags=re.S)

    for m in re.finditer(r"<script([^>]*)>(.*?)</script>", html_no_comments, flags=re.S):
        attrs, body = m.group(1), m.group(2)
        if "src=" in attrs:
            assert not body.strip(), f"{html_path}: script[src] must have an empty body"
            continue
        type_m = re.search(r'type\s*=\s*"([^"]+)"', attrs)
        type_val = type_m.group(1).strip().lower() if type_m else ""
        assert type_val in _NON_EXECUTABLE_SCRIPT_TYPES, (
            f"{html_path}: executable inline <script> found — CSP script-src 'self' "
            "silently blocks it; move the code to docs/assets/*.js: " + body.strip()[:120]
        )

    on_attr_m = re.search(r'\bon[a-zA-Z]+\s*=\s*["\']', html_no_comments)
    assert on_attr_m is None, (
        f"{html_path}: inline event handler attribute found near "
        f"{html_no_comments[max(0, on_attr_m.start() - 40): on_attr_m.end() + 10]!r} — "
        "CSP script-src 'self' silently blocks it; bind the listener from assets/*.js"
    )

    js_url_m = re.search(
        r'(?:href|src|action|formaction)\s*=\s*["\']\s*javascript:',
        html_no_comments,
        flags=re.I,
    )
    assert js_url_m is None, f"{html_path}: javascript: URL found — move behavior to assets/*.js"


def test_landing_js_referenced() -> None:
    """The S0 behavior script must be loaded as an external asset."""
    html = INDEX_HTML.read_text(encoding="utf-8")
    assert 'src="assets/landing.js?v=' in html


def test_search_js_owns_q_permalink_sync() -> None:
    """The component that owns query/paging state must also own its URL."""
    search = (REPO_ROOT / "docs" / "assets" / "search.js").read_text(encoding="utf-8")
    landing = (REPO_ROOT / "docs" / "assets" / "landing.js").read_text(encoding="utf-8")
    assert "URLSearchParams(window.location.search)" in search
    assert "replaceState" in search and "popstate" in search
    assert "URLSearchParams(window.location.search)" not in landing


def test_landing_js_builds_dom_safely() -> None:
    """conferences.json values must never flow through innerHTML."""
    js = (REPO_ROOT / "docs" / "assets" / "landing.js").read_text(encoding="utf-8")
    assert "innerHTML" not in js and "insertAdjacentHTML" not in js


def _brace_match_block(js: str, open_brace_index: int) -> str:
    """Return ``js[open_brace_index:end+1]`` where ``end`` is the index of
    the ``}`` that closes the ``{`` at ``open_brace_index``. Shared by the
    two tests below (and mirrors the extraction trick the .mjs viewer
    tests use for JS source).
    """
    depth = 0
    end = None
    for i in range(open_brace_index, len(js)):
        if js[i] == "{":
            depth += 1
        elif js[i] == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    assert end is not None, "could not find the matching closing brace"
    return js[open_brace_index : end + 1]


def _apply_unknown_counts_body(js: str) -> str:
    m = re.search(r"function applyUnknownConferenceCounts\(\) \{", js)
    assert m is not None, "applyUnknownConferenceCounts() helper not found in landing.js"
    return _brace_match_block(js, m.end() - 1)


def test_landing_numerals_degrade_on_conferences_fetch_failure() -> None:
    """L-3: the static "10" / "28,000" numerals in index.html (#s0-n /
    #s0-m) are placeholders meant to be overwritten with live counts from
    conferences.json. If that fetch fails, the .catch handler must not
    leave them untouched — a stale static number sitting where a live one
    normally renders looks like current data when it may not be.
    """
    js = (REPO_ROOT / "docs" / "assets" / "landing.js").read_text(encoding="utf-8")
    m = re.search(r"\.catch\(function \(error\) \{(.*?)\}\);", js, flags=re.S)
    assert m is not None, "conferences.json .catch(...) handler not found in landing.js"
    catch_body = m.group(1)
    assert "applyUnknownConferenceCounts()" in catch_body, (
        "conferences.json fetch failure must overwrite #s0-n / #s0-m "
        "instead of leaving the static placeholder numerals in place"
    )
    helper_body = _apply_unknown_counts_body(js)
    assert "ledeN.textContent" in helper_body and "ledeM.textContent" in helper_body, (
        "applyUnknownConferenceCounts() must actually overwrite #s0-n / #s0-m"
    )


def test_landing_numerals_degrade_on_empty_or_non_array_conferences() -> None:
    """Sibling of the fetch-failure case above: a 200 response whose body
    is not an array, or is an empty array, must not leave the static
    placeholder numerals in place either. Before this fix the ``.then``
    handler's early-return guard (``if (!Array.isArray(conferences) ||
    !conferences.length) return;``) silently kept "10" / "28,000" on
    screen even though the fetch itself succeeded — same bug as L-3, just
    reached via a different response shape.
    """
    js = (REPO_ROOT / "docs" / "assets" / "landing.js").read_text(encoding="utf-8")
    guard_m = re.search(
        r"if \(!Array\.isArray\(conferences\) \|\| !conferences\.length\) \{",
        js,
    )
    assert guard_m is not None, (
        "empty/non-array conferences.json guard clause not found in landing.js "
        "(expected an `if (...) { ... }` block, not a bare `return;`)"
    )
    guard_body = _brace_match_block(js, guard_m.end() - 1)
    assert "applyUnknownConferenceCounts()" in guard_body, (
        "a 200 response with non-array/empty conferences.json must overwrite "
        "#s0-n / #s0-m with the same 複数/多数 fallback as the catch path, "
        "instead of leaving the static placeholder numerals in place"
    )
    assert "return" in guard_body, "the guard clause must still return before processing conferences"

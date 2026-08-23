"""Common shell uniformity tests for the PaperPilot static site.

Validates that every non-stub HTML page in ``docs/`` shares an identical
site-nav component (brand + 3 links: 探す / 系譜 / 仕組み), has a skip-link,
and assigns ``aria-current="page"`` to exactly the link matching the
page's own section.

Design spec: DESIGN-372.md §1.2 (用語統一) + §2 共通シェル.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_DIR = REPO_ROOT / "docs"

# ---------------------------------------------------------------------------
# Page discovery
# ---------------------------------------------------------------------------


def _is_redirect_stub(text: str) -> bool:
    """Return True if *text* is a #372 P2 redirect-only stub.

    The stub contract (brief §Agent M) is the conjunction of two markers:
      * ``<meta name="robots" content="noindex">`` — opt out of indexing
      * ``location.replace(...)`` — the inline JS that forwards to /lineage/

    404.html also carries ``noindex`` (it's the SPA fallback, served
    with HTTP 404) but it is NOT a redirect stub — it renders a real
    page with the shared shell. The ``location.replace`` check is what
    separates the two.
    """
    has_noindex = bool(
        re.search(
            r'<meta\s+name=["\']robots["\']\s+content=["\']noindex["\']',
            text,
            re.IGNORECASE,
        )
    )
    has_replace = "location.replace(" in text
    return has_noindex and has_replace


def _discover_html_files() -> list[Path]:
    """Return all non-stub HTML files under docs/.

    See :func:`_is_redirect_stub` for the stub contract. Stubs are
    one-way doors (old URL → /lineage/), not full pages, so they
    intentionally omit the shared shell (nav / skip-link /
    aria-current) and must be excluded from the uniformity checks.
    """
    htmls: list[Path] = []
    for path in sorted(DOCS_DIR.rglob("*.html")):
        text = path.read_text(encoding="utf-8", errors="replace")
        if _is_redirect_stub(text):
            continue
        # Legacy detection for any http-equiv="refresh" stubs that may
        # still exist from before the #372 P2 refresh (defensive).
        if re.search(r'<meta\s+http-equiv=["\']refresh["\']', text, re.IGNORECASE):
            continue
        htmls.append(path)
    return htmls


def _discover_stubs() -> list[Path]:
    """Return the redirect stub HTML files under docs/.

    Flip side of :func:`_discover_html_files`. Used by the stub contract
    tests below (stubs must NOT carry nav / skip-link / aria-current).
    """
    stubs: list[Path] = []
    for path in sorted(DOCS_DIR.rglob("*.html")):
        text = path.read_text(encoding="utf-8", errors="replace")
        if _is_redirect_stub(text):
            stubs.append(path)
    return stubs


# ---------------------------------------------------------------------------
# Mapping: each page → which nav link should carry aria-current
# ---------------------------------------------------------------------------

# "探す" link href patterns (varies by page depth)
# "系譜" link href patterns
# "仕組み" link href patterns
#
# Root page (docs/index.html) uses "./" / "themes/" / "how-it-works/"
# Sub-pages use "../" / "../themes/" / "../how-it-works/"
# 404 uses absolute "/automatic-paper-search/" etc.


def _expected_current(rel_path: str) -> str | None:
    """Return the nav label that should carry aria-current for *rel_path*.

    Returns None for pages where no nav link is current (e.g. 404).
    """
    # /lineage/ → 「系譜」(unified viewer — the canonical section since #372 P2).
    if rel_path in ("lineage/index.html", "lineage/"):
        return "系譜"
    # /how-it-works/ → 「仕組み」
    if rel_path in ("how-it-works/index.html", "how-it-works/"):
        return "仕組み"
    # 404 is an error page — no nav link is current
    if rel_path == "404.html":
        return None
    # Everything else (root, conference catalogs) → 「探す」
    return "探す"


# ---------------------------------------------------------------------------
# Nav parsing helpers
# ---------------------------------------------------------------------------

_NAV_LINK_RE = re.compile(
    r'<a\s[^>]*href="(?P<href>[^"]*)"[^>]*>(?P<label>[^<]*)</a>',
    re.IGNORECASE,
)

_ARIA_CURRENT_RE = re.compile(
    r'aria-current\s*=\s*"page"',
    re.IGNORECASE,
)


def _extract_nav_block(html: str) -> str | None:
    """Return the contents of the first ``<nav class="site-nav" ...>`` block."""
    m = re.search(
        r'<nav\s+class="site-nav"[^>]*>(?P<body>.*?)</nav>',
        html,
        re.DOTALL | re.IGNORECASE,
    )
    return m.group("body") if m else None


def _extract_nav_links(nav_block: str) -> list[tuple[str, str, bool]]:
    """Return list of (href, label, has_aria_current) from a nav block.

    Only considers links inside ``<ul class="site-nav__links">``.
    """
    links_match = re.search(
        r'<ul\s+class="site-nav__links"[^>]*>(.*?)</ul>',
        nav_block,
        re.DOTALL | re.IGNORECASE,
    )
    if not links_match:
        return []
    ul_body = links_match.group(1)
    results: list[tuple[str, str, bool]] = []
    for m in _NAV_LINK_RE.finditer(ul_body):
        href = m.group("href")
        label = m.group("label").strip()
        # Check if aria-current is on this specific <a> tag
        # We need to find the original <a ...> tag for this match
        start = m.start()
        tag_end = ul_body.find(">", start)
        tag_str = ul_body[start : tag_end + 1] if tag_end >= 0 else ""
        has_aria = bool(_ARIA_CURRENT_RE.search(tag_str))
        results.append((href, label, has_aria))
    return results


def _has_brand_link(nav_block: str) -> bool:
    """Check for the brand link in the nav block."""
    return bool(
        re.search(
            r'<a\s+class="site-nav__brand"',
            nav_block,
            re.IGNORECASE,
        )
    )


def _has_skip_link(html: str) -> bool:
    """Check for a skip-link in the page."""
    return bool(
        re.search(r'class="skip-link"', html, re.IGNORECASE)
        or re.search(r'<a\s+[^>]*href="#main"', html, re.IGNORECASE)
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

ALL_HTML = _discover_html_files()
STUB_HTML = _discover_stubs()

# Sanity: after excluding redirect stubs, we expect 14 full pages.
# (4 redirect stubs — themes/index.html, iclr-2026/lineage.html,
# eccv-2024/lineage.html, iclr-2026/deep.html — are deliberately
# shell-less and covered by the stub contract tests below.)
assert len(ALL_HTML) == 14, (
    f"Expected 14 non-stub HTML pages in docs/, got {len(ALL_HTML)}: "
    f"{[str(p.relative_to(DOCS_DIR)) for p in ALL_HTML]}"
)
# And the four stubs should all be discovered as stubs.
assert len(STUB_HTML) == 4, (
    f"Expected 4 redirect stubs in docs/, got {len(STUB_HTML)}: "
    f"{[str(p.relative_to(DOCS_DIR)) for p in STUB_HTML]}"
)


@pytest.mark.parametrize("html_path", ALL_HTML, ids=lambda p: str(p.relative_to(DOCS_DIR)))
def test_site_nav_present(html_path: Path) -> None:
    """Every non-stub HTML page has a ``<nav class="site-nav">``."""
    html = html_path.read_text(encoding="utf-8")
    nav = _extract_nav_block(html)
    assert nav is not None, f"{html_path.name}: missing <nav class=\"site-nav\">"


@pytest.mark.parametrize("html_path", ALL_HTML, ids=lambda p: str(p.relative_to(DOCS_DIR)))
def test_nav_links_identical(html_path: Path) -> None:
    """Each page's nav has brand + 3 links: 探す / 系譜 / 仕組み."""
    html = html_path.read_text(encoding="utf-8")
    nav = _extract_nav_block(html)
    assert nav is not None

    assert _has_brand_link(nav), f"{html_path.name}: missing brand link"

    links = _extract_nav_links(nav)
    assert len(links) == 3, (
        f"{html_path.name}: expected 3 nav links, got {len(links)}: "
        f"{[(lbl, h) for h, lbl, _ in links]}"
    )

    labels = [label for _, label, _ in links]
    assert labels == ["探す", "系譜", "仕組み"], (
        f"{html_path.name}: nav labels are {labels}, expected ['探す', '系譜', '仕組み']"
    )


@pytest.mark.parametrize("html_path", ALL_HTML, ids=lambda p: str(p.relative_to(DOCS_DIR)))
def test_aria_current_page(html_path: Path) -> None:
    """Each page has aria-current='page' on exactly the correct nav link."""
    html = html_path.read_text(encoding="utf-8")
    nav = _extract_nav_block(html)
    assert nav is not None

    rel = str(html_path.relative_to(DOCS_DIR))
    expected_label = _expected_current(rel)

    links = _extract_nav_links(nav)
    aria_links = [(label, href) for href, label, has_aria in links if has_aria]

    if expected_label is None:
        # 404 and similar pages should have no aria-current
        assert len(aria_links) == 0, (
            f"{rel}: expected no aria-current, but found on {aria_links}"
        )
    else:
        assert len(aria_links) == 1, (
            f"{rel}: expected exactly 1 aria-current, got {len(aria_links)}: {aria_links}"
        )
        actual_label = aria_links[0][0]
        assert actual_label == expected_label, (
            f"{rel}: aria-current on '{actual_label}', expected '{expected_label}'"
        )


@pytest.mark.parametrize("html_path", ALL_HTML, ids=lambda p: str(p.relative_to(DOCS_DIR)))
def test_skip_link_present(html_path: Path) -> None:
    """Every page has a skip-link."""
    html = html_path.read_text(encoding="utf-8")
    assert _has_skip_link(html), f"{html_path.name}: missing skip-link"


# ---------------------------------------------------------------------------
# Redirect stubs — the opposite contract
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("html_path", STUB_HTML, ids=lambda p: str(p.relative_to(DOCS_DIR)))
def test_stub_has_no_nav(html_path: Path) -> None:
    """Redirect stubs must NOT carry the shared shell.

    Stubs are one-way doors to /lineage/ and intentionally omit the
    nav / skip-link / aria-current of the real shell. Loading the
    bundle would be wasted work on a page the user spends <1s on, and
    any nav on a stub would be wrong (it would claim to be the current
    section of a page that is actually just a forwarding notice).
    """
    html = html_path.read_text(encoding="utf-8")
    assert _extract_nav_block(html) is None, (
        f"{html_path.relative_to(DOCS_DIR)}: stub must not contain <nav class=\"site-nav\">"
    )


@pytest.mark.parametrize("html_path", STUB_HTML, ids=lambda p: str(p.relative_to(DOCS_DIR)))
def test_stub_has_no_skip_link(html_path: Path) -> None:
    """No skip-link on stubs — there is no main content to skip to."""
    html = html_path.read_text(encoding="utf-8")
    assert not _has_skip_link(html), (
        f"{html_path.relative_to(DOCS_DIR)}: stub must not contain a skip-link"
    )

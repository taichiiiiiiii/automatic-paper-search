"""Pin the Content-Security-Policy `<meta>` tag every published `docs/`
page carries.

GH Pages strips `_headers`, so CSP here is delivered exclusively via
`<meta http-equiv="Content-Security-Policy">` (see
`paperpilot/tests/test_theme_csp_api_host.py` for the `connect-src`
pinning on `docs/themes/index.html`). This test pins the two properties
that matter for script execution and plugin content across every page,
not just one:

  - exactly one CSP `<meta>` tag per page
  - the policy that actually governs script execution (the explicit
    `script-src` directive, or — for pages that don't declare one and so
    fall back to CSP's own `default-src` inheritance rule — `default-src`)
    allows `'self'` and never `'unsafe-inline'` / `'unsafe-eval'`
  - `object-src 'none'` is present (true of every page in this checkout
    today; if a future page ever omits it, this test should fail loudly
    rather than silently accepting a narrower guarantee)

Whether a page is allowed to rely on the `default-src` fallback instead
of declaring an explicit `script-src` is governed by a *rule*, not a
hardcoded list of today's known pages: a page may rely on the fallback
only if it declares no `<script>` tag at all. Any page with a `<script>`
tag must declare `script-src` explicitly (with `'self'` and no
`'unsafe-*'`). This means the first promotion of a brand-new conference's
`paper-links.html` (which has no `<script>` tags, same as every other
`paper-links.html` template) passes automatically, without this test
needing to be updated by name for every new conference — see
`check_csp_fallback_rule()` and its synthetic-tree tests below.

CSP `<meta>` tags are parsed with `html.parser.HTMLParser` (stdlib)
rather than a regex, so detection is immune to attribute order
(`content="..." http-equiv="..."` vs. the reverse) and quote style
(single vs. double quotes) — a plain `re.compile` anchored on one fixed
attribute order would silently miss any page that declares the tag the
other way around.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_DIR = REPO_ROOT / "docs"

# docs/design and docs/research are markdown source trees (design docs /
# market research), not published site pages, and carry no CSP contract.
_EXCLUDED_DIR_NAMES = {"design", "research"}


class _PageScanner(HTMLParser):
    """Collect every CSP `<meta>` tag's `content` value and whether the
    page declares any `<script>` tag.

    HTMLParser normalizes attribute names to lowercase and already
    strips the surrounding quote (single or double) before handing the
    value to ``handle_starttag``, which is what makes this detection
    immune to attribute order and quote style — unlike a regex anchored
    on one fixed `http-equiv="..." content="..."` token order.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.csp_contents: list[str] = []
        self.has_script = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "script":
            self.has_script = True
            return
        if tag != "meta":
            return
        attr_map = {name: value for name, value in attrs}
        http_equiv = attr_map.get("http-equiv")
        if http_equiv is not None and http_equiv.strip().lower() == "content-security-policy":
            content = attr_map.get("content")
            if content is not None:
                self.csp_contents.append(content)


def _scan_page(html_text: str) -> _PageScanner:
    scanner = _PageScanner()
    scanner.feed(html_text)
    scanner.close()
    return scanner


def _is_excluded(root: Path, path: Path) -> bool:
    rel_parts = path.relative_to(root).parts
    return bool(rel_parts) and rel_parts[0] in _EXCLUDED_DIR_NAMES


def _is_redirect_stub(html: str) -> bool:
    return re.search(r'<meta\s+http-equiv=["\']refresh["\']', html, re.IGNORECASE) is not None


def _discover_pages(root: Path) -> list[Path]:
    pages: list[Path] = []
    for path in sorted(root.rglob("*.html")):
        if _is_excluded(root, path):
            continue
        html = path.read_text(encoding="utf-8", errors="replace")
        if _is_redirect_stub(html):
            continue
        pages.append(path)
    return pages


_ALL_PAGES = _discover_pages(DOCS_DIR)


def _rel(path: Path) -> str:
    return str(path.relative_to(REPO_ROOT))


def _parse_directives(csp_content: str) -> dict[str, list[str]]:
    directives: dict[str, list[str]] = {}
    for clause in csp_content.split(";"):
        tokens = clause.split()
        if not tokens:
            continue
        name, values = tokens[0].lower(), tokens[1:]
        directives[name] = values
    return directives


def _csp_content(html: str, path: Path) -> str:
    scanner = _scan_page(html)
    assert len(scanner.csp_contents) == 1, (
        f"{_rel(path)}: expected exactly one CSP <meta> tag, found {len(scanner.csp_contents)}"
    )
    return scanner.csp_contents[0]


# Guard against the discovery glob silently finding nothing (e.g. a repo
# layout change moving docs/ elsewhere) and every parametrized test below
# vacuously "passing" with zero cases.
assert len(_ALL_PAGES) >= 20, (
    f"expected at least 20 published docs/ pages, found {len(_ALL_PAGES)} — "
    "check _discover_pages()/DOCS_DIR before trusting the tests below"
)


@pytest.mark.parametrize("html_path", _ALL_PAGES, ids=[_rel(p) for p in _ALL_PAGES])
def test_exactly_one_csp_meta_tag(html_path: Path) -> None:
    html = html_path.read_text(encoding="utf-8")
    _csp_content(html, html_path)  # raises via assert if count != 1


@pytest.mark.parametrize("html_path", _ALL_PAGES, ids=[_rel(p) for p in _ALL_PAGES])
def test_effective_script_src_is_self_only(html_path: Path) -> None:
    """The directive that actually governs script execution — the
    explicit `script-src` if the page declares one, otherwise
    `default-src` per the CSP fallback rule — must include `'self'` and
    must not include `'unsafe-inline'` or `'unsafe-eval'`.
    """
    html = html_path.read_text(encoding="utf-8")
    directives = _parse_directives(_csp_content(html, html_path))

    if "script-src" in directives:
        effective = directives["script-src"]
        source = "script-src"
    else:
        assert "default-src" in directives, (
            f"{_rel(html_path)}: CSP has neither script-src nor default-src — "
            "script execution would be ungoverned"
        )
        effective = directives["default-src"]
        source = "default-src (no explicit script-src)"

    assert "'self'" in effective, (
        f"{_rel(html_path)}: effective script policy ({source}) does not include 'self': {effective}"
    )
    assert "'unsafe-inline'" not in effective, (
        f"{_rel(html_path)}: effective script policy ({source}) allows 'unsafe-inline': {effective}"
    )
    assert "'unsafe-eval'" not in effective, (
        f"{_rel(html_path)}: effective script policy ({source}) allows 'unsafe-eval': {effective}"
    )


@pytest.mark.parametrize("html_path", _ALL_PAGES, ids=[_rel(p) for p in _ALL_PAGES])
def test_object_src_none(html_path: Path) -> None:
    """Every page in this checkout declares `object-src 'none'` today
    (checked by inspection, not assumed) — pin it so a new page template
    can't silently drop plugin-content lockdown.
    """
    html = html_path.read_text(encoding="utf-8")
    directives = _parse_directives(_csp_content(html, html_path))
    assert directives.get("object-src") == ["'none'"], (
        f"{_rel(html_path)}: expected object-src 'none', got {directives.get('object-src')!r}"
    )


def check_csp_fallback_rule(root: Path) -> list[str]:
    """Check every discovered page under ``root`` against the
    script-src/default-src fallback rule and return a list of violation
    strings (empty = all pages comply).

    Rule: a page may rely on the `default-src` fallback (no explicit
    `script-src`) only if it declares no `<script>` tag at all. Any page
    with a `<script>` tag must declare `script-src` explicitly, and
    whichever directive actually governs script execution must allow
    `'self'` and no `'unsafe-*'` keyword.
    """
    violations: list[str] = []
    for path in _discover_pages(root):
        html = path.read_text(encoding="utf-8", errors="replace")
        scanner = _scan_page(html)
        if len(scanner.csp_contents) != 1:
            violations.append(
                f"{path}: expected exactly one CSP <meta> tag, found {len(scanner.csp_contents)}"
            )
            continue
        directives = _parse_directives(scanner.csp_contents[0])
        has_script_src = "script-src" in directives

        if scanner.has_script and not has_script_src:
            violations.append(
                f"{path}: page declares <script> tag(s) but CSP has no explicit script-src"
            )
            continue

        effective = directives.get("script-src")
        source = "script-src"
        if effective is None:
            effective = directives.get("default-src")
            source = "default-src (no explicit script-src)"
        if effective is None:
            violations.append(f"{path}: CSP has neither script-src nor default-src")
            continue

        if "'self'" not in effective:
            violations.append(
                f"{path}: effective script policy ({source}) does not include 'self': {effective}"
            )
        unsafe = [v for v in effective if v.startswith("'unsafe-")]
        if unsafe:
            violations.append(
                f"{path}: effective script policy ({source}) allows {unsafe}: {effective}"
            )
    return violations


def test_script_src_fallback_rule_on_real_docs_tree() -> None:
    """Every page in the real `docs/` tree must comply with the
    fallback rule — this replaces a hardcoded list of today's known
    `*/paper-links.html` paths (which broke the first time a new
    conference's `paper-links.html` was promoted) with a rule that
    generalizes to any future page sharing the same no-`<script>`-tags
    shape.
    """
    violations = check_csp_fallback_rule(DOCS_DIR)
    assert violations == [], "\n".join(violations)


def _write_page(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def test_new_conference_page_without_scripts_passes_on_fallback(tmp_path: Path) -> None:
    """A brand-new conference's `paper-links.html`, with no explicit
    `script-src` and no `<script>` tags at all (the real template
    shape), must pass — this is the exact case the old hardcoded-list
    test broke on."""
    docs = tmp_path / "docs"
    _write_page(
        docs / "newconf-2027" / "paper-links.html",
        "<!doctype html><html><head>"
        '<meta http-equiv="Content-Security-Policy" '
        "content=\"default-src 'self'; object-src 'none'\">"
        "</head><body><p>no scripts on this page</p></body></html>",
    )
    assert check_csp_fallback_rule(docs) == []


def test_page_with_script_tag_but_no_script_src_fails(tmp_path: Path) -> None:
    """A page that declares a `<script>` tag but relies on the
    `default-src` fallback instead of an explicit `script-src` must be
    rejected — the fallback is only for script-free pages."""
    docs = tmp_path / "docs"
    _write_page(
        docs / "badconf" / "index.html",
        "<!doctype html><html><head>"
        '<meta http-equiv="Content-Security-Policy" '
        "content=\"default-src 'self'; object-src 'none'\">"
        '</head><body><script src="/assets/app.js"></script></body></html>',
    )
    violations = check_csp_fallback_rule(docs)
    assert len(violations) == 1
    assert "no explicit script-src" in violations[0]


def test_attribute_order_and_single_quotes_are_detected(tmp_path: Path) -> None:
    """`content` before `http-equiv`, and a single-quoted attribute
    delimiter, must still be detected — the previous regex anchored on
    a fixed `http-equiv="..." content="..."` double-quoted order and
    would have silently found zero CSP tags here (and the real page
    would have failed `test_exactly_one_csp_meta_tag` with count=0
    while actually carrying a valid, compliant policy)."""
    docs = tmp_path / "docs"
    _write_page(
        docs / "reversed" / "index.html",
        "<!doctype html><html><head>"
        "<meta content=\"script-src 'self'; object-src 'none'\" "
        "http-equiv='Content-Security-Policy'>"
        "</head><body><script src='/assets/app.js'></script></body></html>",
    )
    assert check_csp_fallback_rule(docs) == []

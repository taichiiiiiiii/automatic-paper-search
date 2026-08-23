"""Structural tests for the unified lineage viewer page (docs/lineage/index.html).

Validates that the #372 P2 page ships the required elements:

    (a) ``<meta name="data-root">`` with a trailing-slash value so that
        ``PP.dataRoot()`` prefixes fetch paths correctly regardless of
        page depth.
    (b) ``<meta name="paperpilot-api-base">`` so the theme-request form
        knows where the CF Worker lives.
    (c) Zero inline scripts (CSP ``script-src 'self'`` — ld+json is the
        one exception, and only with ``type="application/ld+json"``).
    (d) Versioned ``?v=`` references to the three viewer scripts:
        ``lineage-shell.js``, ``theme.js``, ``theme-request.js``.
    (e) Nav ``aria-current="page"`` is on the "系譜" link — the shell
        uniformity test in test_site_shell.py also asserts this, but
        we keep a local pin for this page's structure.
    (f) Three ``data-viewer`` mounts (selector / theme / tree) exist —
        the shell router toggles visibility via body-class modes.
    (g) No ``innerHTML`` or ``outerHTML`` assignment in the shell JS
        files (DOM built via textContent / createElement only).

Design spec: DESIGN-372.md §2 S2 (統一系譜ビューア).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
LINEAGE_HTML = REPO_ROOT / "docs" / "lineage" / "index.html"
ASSETS_DIR = REPO_ROOT / "docs" / "assets"


@pytest.fixture(scope="module")
def lineage_text() -> str:
    return LINEAGE_HTML.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# (a) data-root meta
# ---------------------------------------------------------------------------


def test_lineage_has_data_root_meta(lineage_text: str) -> None:
    m = re.search(
        r'<meta\s+name=["\']data-root["\'][^>]*content=["\']([^"\']+)["\']',
        lineage_text,
        re.IGNORECASE,
    )
    assert m is not None, "missing <meta name='data-root' content=...>"
    value = m.group(1)
    assert value.endswith("/"), (
        f"data-root must end with '/' so callers can concat paths, got {value!r}"
    )


def test_lineage_data_root_value_is_parent(lineage_text: str) -> None:
    # /lineage/index.html is one level deep — data-root must be "../"
    m = re.search(
        r'<meta\s+name=["\']data-root["\'][^>]*content=["\']([^"\']+)["\']',
        lineage_text,
        re.IGNORECASE,
    )
    assert m is not None
    assert m.group(1) == "../", (
        f"expected data-root '../' for /lineage/index.html, got {m.group(1)!r}"
    )


# ---------------------------------------------------------------------------
# (b) api-base meta
# ---------------------------------------------------------------------------


def test_lineage_has_api_base_meta(lineage_text: str) -> None:
    m = re.search(
        r'<meta\s+name=["\']paperpilot-api-base["\'][^>]*content=["\']([^"\']+)["\']',
        lineage_text,
        re.IGNORECASE,
    )
    assert m is not None, "missing <meta name='paperpilot-api-base' content=...>"
    value = m.group(1)
    assert value.startswith("https://"), (
        f"api-base must be an absolute https URL, got {value!r}"
    )
    assert "workers.dev" in value, (
        f"api-base should point at the CF Worker workers.dev URL, got {value!r}"
    )


# ---------------------------------------------------------------------------
# (c) CSP — no inline scripts
# ---------------------------------------------------------------------------

_INLINE_SCRIPT_RE = re.compile(
    r'<script(?![^>]*\bsrc=)[^>]*>',
    re.IGNORECASE,
)


def test_lineage_no_inline_scripts(lineage_text: str) -> None:
    """CSP ``script-src 'self'`` forbids inline scripts (ld+json only
    exception, and only when the script has no ``src`` AND is
    ``type="application/ld+json"``).
    """
    # Find all <script ...> tags that lack a src attribute.
    inline_scripts = _INLINE_SCRIPT_RE.findall(lineage_text)
    # Filter out the ld+json exception — allowed by CSP.
    violations = [
        s for s in inline_scripts
        if 'application/ld+json' not in s
    ]
    assert not violations, (
        f"found {len(violations)} inline script(s) violating CSP "
        f"script-src 'self': {violations[:3]}"
    )


def test_lineage_csp_meta_has_script_src_self(lineage_text: str) -> None:
    """The page must declare a CSP that includes ``script-src 'self'``."""
    m = re.search(
        r'<meta\s+http-equiv=["\']Content-Security-Policy["\'][^>]*content="([^"]+)"',
        lineage_text,
        re.IGNORECASE,
    )
    assert m is not None, "missing CSP meta tag"
    csp = m.group(1)
    assert "script-src 'self'" in csp, (
        f"CSP must include \"script-src 'self'\", got: {csp}"
    )


# ---------------------------------------------------------------------------
# (d) versioned asset references
# ---------------------------------------------------------------------------


def _versioned_ref(text: str, filename: str) -> str | None:
    m = re.search(
        rf'src=["\'][^"\']*/{re.escape(filename)}\?v=(\d+)["\']',
        text,
        re.IGNORECASE,
    )
    return m.group(1) if m else None


def test_lineage_has_versioned_lineage_shell(lineage_text: str) -> None:
    v = _versioned_ref(lineage_text, "lineage-shell.js")
    assert v is not None, "missing ?v=NN reference to lineage-shell.js"
    assert int(v) >= 1, f"lineage-shell.js version must be >= 1, got {v}"


def test_lineage_has_versioned_theme_js(lineage_text: str) -> None:
    v = _versioned_ref(lineage_text, "theme.js")
    assert v is not None, "missing ?v=NN reference to theme.js"
    assert int(v) >= 1, f"theme.js version must be >= 1, got {v}"


def test_lineage_has_versioned_theme_request_js(lineage_text: str) -> None:
    v = _versioned_ref(lineage_text, "theme-request.js")
    assert v is not None, "missing ?v=NN reference to theme-request.js"
    assert int(v) >= 1, f"theme-request.js version must be >= 1, got {v}"


# ---------------------------------------------------------------------------
# (e) nav aria-current on "系譜"
# ---------------------------------------------------------------------------


def test_lineage_nav_aria_current_on_keifu(lineage_text: str) -> None:
    nav_m = re.search(
        r'<nav\s+class="site-nav"[^>]*>(?P<body>.*?)</nav>',
        lineage_text,
        re.DOTALL | re.IGNORECASE,
    )
    assert nav_m is not None, "missing <nav class='site-nav'>"
    nav_body = nav_m.group("body")

    # Find the "系譜" link
    keifu_m = re.search(
        r'<a\s[^>]*>([^<]*系譜[^<]*)</a>',
        nav_body,
    )
    assert keifu_m is not None, "nav missing link with label '系譜'"
    # The <a> tag containing "系譜" must carry aria-current="page"
    # The regex match starts at the <a tag itself, so extract from there
    start = keifu_m.start()
    tag_end = nav_body.find(">", start)
    tag_str = nav_body[start : tag_end + 1]
    assert re.search(r'aria-current\s*=\s*"page"', tag_str, re.IGNORECASE), (
        f"aria-current='page' missing on the '系譜' nav link. Tag: {tag_str}"
    )


# ---------------------------------------------------------------------------
# (f) data-viewer mounts
# ---------------------------------------------------------------------------


def test_lineage_has_three_viewer_mounts(lineage_text: str) -> None:
    for mode in ("selector", "theme", "tree"):
        assert re.search(
            rf'data-viewer=["\']{re.escape(mode)}["\']',
            lineage_text,
            re.IGNORECASE,
        ), f"missing data-viewer=\"{mode}\" mount"


def test_lineage_theme_mount_wraps_canvas_and_svg(lineage_text: str) -> None:
    """theme.js's init() looks for canvas/svg inside the [data-viewer=theme]
    subtree. Both must live inside that subtree for the activation gate
    to find them.
    """
    # The data-viewer="theme" div opens before #canvas and encloses it.
    # We just check that the marker comes before the canvas id in the
    # document order, and that they're both present.
    theme_mount = lineage_text.find('data-viewer="theme"')
    canvas_id = lineage_text.find('id="canvas"')
    svg_id = lineage_text.find('id="lineage-svg"')
    assert theme_mount >= 0, "missing data-viewer='theme' mount"
    assert canvas_id >= 0, "missing #canvas id"
    assert svg_id >= 0, "missing #lineage-svg id"
    assert theme_mount < canvas_id < svg_id, (
        "data-viewer='theme' must precede #canvas, which must precede #lineage-svg"
    )


# ---------------------------------------------------------------------------
# (g) no innerHTML / outerHTML in shell JS
# ---------------------------------------------------------------------------


def test_shell_js_has_no_innerhtml_assignment() -> None:
    """lineage-shell.js builds DOM via textContent/createElement only —
    innerHTML / outerHTML assignments would violate the CSP
    ``script-src 'self'`` defence-in-depth (CSP does not forbid JS-side
    innerHTML per se, but our project rule is no innerHTML for DOM
    built from untrusted data).
    """
    js = (ASSETS_DIR / "lineage-shell.js").read_text(encoding="utf-8")
    # Match ``.innerHTML =`` / ``.innerHTML=`` / ``.outerHTML =``.
    bad = re.findall(r"\.(?:inner|outer)HTML\s*=", js)
    assert not bad, (
        f"lineage-shell.js uses innerHTML/outerHTML assignment {len(bad)} time(s) "
        f"— build DOM via textContent / createElement instead"
    )


def test_shell_handles_empty_stub_and_fetch_failure() -> None:
    """The shell must (a) detect empty-stub lineage data (meta.source ==
    "none" first, nodes.length second — design v3 §2 S2) and say
    "まだ生成されていません" instead of mounting the tree viewer, and
    (b) actually append its hint message to the mount (a missing
    appendChild made the failure path render as silent blank space,
    caught headless on 2026-08-24).
    """
    js = (REPO_ROOT / "docs" / "assets" / "lineage-shell.js").read_text(encoding="utf-8")
    assert 'data.meta.source === "none"' in js
    assert "nodes.length === 0" in js
    assert "まだ生成されていません" in js
    assert "mount.appendChild(msg)" in js


def test_selector_conferences_are_manifest_driven() -> None:
    """The selector must iterate docs/lineage-manifest.json, never a
    hardcoded conference list (a hallucinated hardcoded map shipped three
    nonexistent year variants and dropped three real conferences —
    caught headless 2026-08-24). Only acronym CASING may be mapped.
    """
    import json
    import re

    js = (REPO_ROOT / "docs" / "assets" / "lineage-shell.js").read_text(encoding="utf-8")
    manifest = json.loads(
        (REPO_ROOT / "docs" / "lineage-manifest.json").read_text(encoding="utf-8")
    )
    real_slugs = set(manifest["conferences"])
    # Any conference-year slug literal in the JS must be a real one.
    for slug in re.findall(r'"([a-z]+-\d{4})"', js):
        assert slug in real_slugs, f"hardcoded unknown conference slug: {slug}"
    assert "Object.keys(confs)" in js, "selector must iterate the manifest"


def test_shell_renders_legend_in_every_mode() -> None:
    """The shared 6-type legend must render in every mode, not only the
    selector (design §1.2: identical legend on all surfaces).
    """
    js = (REPO_ROOT / "docs" / "assets" / "lineage-shell.js").read_text(encoding="utf-8")
    assert '"hero-legend"' in js and '"theme-relation-legend"' in js
    assert "PP.renderRelationLegend" in js

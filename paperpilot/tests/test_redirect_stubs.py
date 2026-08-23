"""Redirect stubs must forward old URLs to the unified /lineage/ viewer.

Issue #372 P2: the old `/themes/`, `/<conf>/lineage.html`, and
`/iclr-2026/deep.html` URLs are replaced with redirect-only stubs that
forward to `/lineage/` while preserving query params and the hash. The
map lives in `docs/assets/redirects.json`; this test verifies each
stub matches the spec (noindex + canonical + no assets + location.replace
+ the per-stub parameter mapping).

The brief also forbids loading any CSS/JS asset from the stubs — they
are temporary waystations for stale external links and must not pull
in the viewer's bundle. The `sync_asset_versions.py` walker would
update `?v=` on any `src=` / `href=` it found, which is exactly what
we do NOT want here.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_ROOT = REPO_ROOT / "docs"
REDIRECTS_PATH = DOCS_ROOT / "assets" / "redirects.json"
LINEAGE_INDEX = DOCS_ROOT / "lineage" / "index.html"


def _load_redirects() -> list[dict]:
    return json.loads(REDIRECTS_PATH.read_text(encoding="utf-8"))


def _stub_path(entry: dict) -> Path:
    """`redirects.json` stores stub paths relative to the repo root."""
    # We keep a sibling "stub" field for the repo-root-relative path so
    # this test does not have to reconstruct it from `from`.
    return REPO_ROOT / entry["stub"]


def test_redirects_json_is_well_formed() -> None:
    data = _load_redirects()
    assert isinstance(data, list)
    assert len(data) >= 4, "expected at least the 4 stubs documented in the brief"
    for entry in data:
        assert "from" in entry and "to" in entry and "params" in entry
        assert "stub" in entry
        # `from` always starts with / and `to` always starts with /
        assert entry["from"].startswith("/")
        assert entry["to"].startswith("/")


def test_every_redirect_has_a_matching_stub_file() -> None:
    for entry in _load_redirects():
        stub = _stub_path(entry)
        assert stub.exists(), f"stub missing: {stub}"
        assert stub.is_file()


def test_stub_noindex_meta() -> None:
    """Every stub must opt out of indexing — these are one-way doors."""
    noindex_re = re.compile(
        r'<meta\s+name=["\']robots["\']\s+content=["\']noindex["\']',
        re.IGNORECASE,
    )
    for entry in _load_redirects():
        body = _stub_path(entry).read_text(encoding="utf-8")
        assert noindex_re.search(body), (
            f"{entry['stub']}: missing <meta name='robots' content='noindex'>"
        )


def test_stub_canonical_matches_target() -> None:
    """The canonical URL of each stub must be the new /lineage/ URL.

    For stubs that pin a `conf=` parameter the canonical has to include
    that parameter so search engines see the right destination. The
    bare `/themes/` stub canonicalises to plain `/lineage/` because it
    passes query params through dynamically.
    """
    for entry in _load_redirects():
        body = _stub_path(entry).read_text(encoding="utf-8")
        params = entry["params"]
        # Build the expected canonical URL.
        if params == "passthrough":
            expected_canonical = (
                f"https://taichiiiiiiii.github.io"
                f"/automatic-paper-search{entry['to']}"
            )
        elif isinstance(params, dict) and "set" in params:
            # The fixed "set" params are always present in the destination.
            set_params = params["set"]
            query = "&".join(f"{k}={v}" for k, v in sorted(set_params.items()))
            expected_canonical = (
                f"https://taichiiiiiiii.github.io"
                f"/automatic-paper-search{entry['to']}?{query}"
            )
        elif isinstance(params, dict) and "rename" in params:
            # The deep stub's canonical is bare /lineage/ — the arxiv→deep
            # rename happens conditionally in JS (only if the legacy URL
            # actually carried an `arxiv` value).
            expected_canonical = (
                f"https://taichiiiiiiii.github.io"
                f"/automatic-paper-search{entry['to']}"
            )
        else:  # pragma: no cover — defensive; the brief only defines these
            pytest.fail(f"unrecognised params shape in {entry['stub']}: {params}")

        canonical_re = re.compile(
            r'<link\s+rel=["\']canonical["\']\s+href=["\']([^"\']+)["\']',
            re.IGNORECASE,
        )
        match = canonical_re.search(body)
        assert match, f"{entry['stub']}: missing <link rel='canonical'>"
        assert match.group(1) == expected_canonical, (
            f"{entry['stub']}: canonical={match.group(1)} expected={expected_canonical}"
        )


def test_stub_loads_no_assets() -> None:
    """The brief forbids `<link rel=stylesheet>` and `<script src=...>` in stubs.

    Stubs are transient redirect-only pages; pulling in the viewer's
    bundle would slow the redirect, break the no-CSP meta rule (the
    brief explicitly says stubs carry no CSP meta), and drag the stub
    into `sync_asset_versions.py`'s `?v=` rotation.
    """
    stylesheet_re = re.compile(r'<link\b[^>]*rel=["\']stylesheet["\']', re.IGNORECASE)
    external_script_re = re.compile(r'<script\b[^>]*\bsrc=', re.IGNORECASE)
    for entry in _load_redirects():
        body = _stub_path(entry).read_text(encoding="utf-8")
        assert not stylesheet_re.search(body), (
            f"{entry['stub']}: stub must not load any stylesheet"
        )
        assert not external_script_re.search(body), (
            f"{entry['stub']}: stub must not load any external script"
        )


def test_stub_performs_location_replace() -> None:
    """The redirect must use `location.replace`, not `location.href = ...`.

    `replace` avoids polluting the back-button history — the stub is a
    one-way door and should not appear as a separate step the user has
    to back through.
    """
    for entry in _load_redirects():
        body = _stub_path(entry).read_text(encoding="utf-8")
        assert "location.replace(" in body, (
            f"{entry['stub']}: expected location.replace(...)"
        )


def test_stub_parameter_mapping() -> None:
    """Each stub's inline JS must contain the mapping the brief requires."""
    for entry in _load_redirects():
        body = _stub_path(entry).read_text(encoding="utf-8")
        params = entry["params"]
        if params == "passthrough":
            # /themes/ stub: forward query string verbatim, no fixed key.
            # The JS must build the target from location.search but must
            # NOT call `q.set(` with any of the reserved keys below.
            assert "URLSearchParams(location.search)" in body
            assert "q.set(" not in body, (
                f"{entry['stub']}: passthrough stub must not set any fixed param"
            )
        elif isinstance(params, dict) and "set" in params:
            # /<conf>/lineage.html stubs: always set conf=<conf>.
            for key, value in params["set"].items():
                # Accept either `q.set("conf","<conf>")` or `q.set('conf','<conf>')`.
                pattern = re.compile(
                    rf"""q\.set\(\s*['\"]{re.escape(key)}['\"]\s*,"""
                    rf"""\s*['\"]{re.escape(value)}['\"]"""
                )
                assert pattern.search(body), (
                    f"{entry['stub']}: missing q.set('{key}','{value}')"
                )
        elif isinstance(params, dict) and "rename" in params:
            # /iclr-2026/deep.html stub: rename arxiv→deep.
            for old_name, new_name in params["rename"].items():
                # Must delete the old name and set the new one with the same value.
                assert f'q.get("{old_name}")' in body or f"q.get('{old_name}')" in body
                assert f'q.delete("{old_name}")' in body or f"q.delete('{old_name}')" in body
                assert f'q.set("{new_name}"' in body or f"q.set('{new_name}'" in body


def test_lineage_index_exists() -> None:
    """The unified viewer page the stubs all redirect to must exist."""
    assert LINEAGE_INDEX.exists(), (
        "docs/lineage/index.html is missing — all redirect stubs point at it"
    )

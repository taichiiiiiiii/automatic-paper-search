"""Pytest wrappers for the docs/assets/theme.js front-end test scripts.

Both wrappers spawn ``node`` as a subprocess so the JS tests run inside
the regular ``uv run pytest`` flow. Skipped (not failed) when ``node`` is
not on PATH so contributors who only work on the Python pipeline aren't
blocked by a missing optional toolchain.

Two scripts are exercised here:

1. ``test_theme_xaxis_layout.mjs`` — pure-logic regression for the X-axis
   encoding modes (added to theme.js for the timeline viewer).
2. ``test_theme_init_callees.mjs`` — static-analysis guard against the
   PR #229 / PR #243 class of bug, where ``init()`` calls a function that
   was deleted elsewhere in the file. The bug shipped to production for
   ~5 days because the layout test never invokes init().

The P2T migration (docs/design/16-theme-lineage-migration.md) adds the
``test_theme_lineage_contract.mjs`` Node suite plus pure-Python static
checks for the same fail-closed contract, so the guard survives even on
machines without node.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

VIEWER_DIR = Path(__file__).parent
XAXIS_SCRIPT = VIEWER_DIR / "test_theme_xaxis_layout.mjs"
INIT_CALLEES_SCRIPT = VIEWER_DIR / "test_theme_init_callees.mjs"
CLS_RESERVATION_SCRIPT = VIEWER_DIR / "test_theme_gallery_cls_reservation.mjs"
TYPOGRAPHY_TOKENS_SCRIPT = VIEWER_DIR / "test_theme_typography_tokens.mjs"
REQUEST_PROGRESS_SCRIPT = VIEWER_DIR / "test_theme_request_progress.mjs"
THEME_LINEAGE_CONTRACT_SCRIPT = VIEWER_DIR / "test_theme_lineage_contract.mjs"
REPO_ROOT = VIEWER_DIR.parents[2]
THEME_JS = REPO_ROOT / "docs" / "assets" / "theme.js"
THEMES_INDEX_HTML = REPO_ROOT / "docs" / "themes" / "index.html"


def _run_node(script: Path, *, min_ok_lines: int) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed; skipping theme.js front-end tests")
    result = subprocess.run(
        [node, str(script)],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    output = result.stdout + "\n" + result.stderr
    assert result.returncode == 0, f"{script.name} failed (exit={result.returncode}):\n{output}"
    # Sanity check: each `ok ...` line corresponds to one passing test.
    # We require a non-trivial number so an empty / silently-bypassed
    # script can't appear to pass.
    assert "passed, 0 failed" in output, output
    assert output.count("\n  ok  ") >= min_ok_lines, (
        f"expected at least {min_ok_lines} passing assertions, got:\n{output}"
    )


def test_theme_xaxis_layout_js_passes() -> None:
    _run_node(XAXIS_SCRIPT, min_ok_lines=10)


def test_theme_init_callees_defined() -> None:
    # PR #229 → PR #243 postmortem: init() called populateThemeDatalist()
    # whose definition was deleted, throwing on every page load. This
    # static-analysis test asserts every identifier called inside init()
    # is defined somewhere in theme.js (or is a JS/DOM builtin from the
    # script's allowlist).
    _run_node(INIT_CALLEES_SCRIPT, min_ok_lines=30)


def test_theme_gallery_cls_reservation() -> None:
    # Issue #258 follow-up: post-#260 the gallery is site-request-only
    # and currently holds < 10 themes, so the wrap-row reservation
    # collapses to the 1-card-row floor (calc(68px + 0.6rem)). This
    # test pins that contract + asserts no over-reservation steps
    # have been re-added at wider viewports, and FAILS if the manifest
    # grows past 10 themes (forces us to revisit the reservation).
    _run_node(CLS_RESERVATION_SCRIPT, min_ok_lines=8)


def test_theme_typography_tokens() -> None:
    # Issue #257: pins the four typography tokens (--text-caption,
    # --text-body-sm, --text-card-title, --text-edge-label) and asserts
    # the 14 callsites listed in the issue use them instead of raw
    # rem literals. Scope-excluded variants (.node-card--theme
    # .node-card__title at 0.9rem) are explicitly left untouched —
    # the follow-up issue extends adoption.
    _run_node(TYPOGRAPHY_TOKENS_SCRIPT, min_ok_lines=50)


def test_theme_lineage_contract_js_passes() -> None:
    # P2T consumer contract: quality-gated fetch/render with strict
    # lineage-artifact-v1 parsing, canonical relation/confidence fields,
    # and no first-focus fallback (see test_theme_lineage_contract.mjs).
    _run_node(THEME_LINEAGE_CONTRACT_SCRIPT, min_ok_lines=20)


def test_theme_index_loads_lineage_core_before_theme_js() -> None:
    # theme.js reads window.PaperPilotLineageCore at module load, so the
    # shared reader must be wired first in themes/index.html.
    html = THEMES_INDEX_HTML.read_text(encoding="utf-8")
    core = html.find("assets/lineage-core.js")
    theme = html.find("assets/theme.js")
    assert core >= 0 and theme >= 0 and core < theme, (
        "themes/index.html must load lineage-core.js before theme.js"
    )


def test_theme_js_quality_gate_static_contract() -> None:
    # Node-free mirror of the static section in
    # test_theme_lineage_contract.mjs: the consumer must go through the
    # shared strict reader and must not reintroduce legacy edge-field
    # consumers or the first-focus fallback.
    source = THEME_JS.read_text(encoding="utf-8")
    assert 'fetchJsonWithSha256(\n      "../lineage-quality-v1.json"' in source
    assert "LineageCore.parseQualityManifest" in source
    assert "LineageCore.resolveQualityCollection" in source
    assert re.search(r'kind:\s*"theme"', source)
    assert "LineageCore.qualityRowIsEligible" in source
    assert "LineageCore.qualityRowIsPublishable" in source
    assert "lineageCoreIsAvailable()" in source
    assert "expectedSha256: qualityRow.input_sha256" in source
    assert 'LineageCore.parseArtifact(loaded.data, { kind: "theme" })' in source
    assert "LineageCore.resolveFocus(state.data, requestedNode)" in source
    assert not re.search(r"(\be|edge)\.rel\b|(\be|edge)\.conf\b", source), (
        "legacy .rel/.conf artifact consumers must stay removed"
    )
    assert not re.search(r"\.find\??\.\(\(?[a-z]\)?\s*=>\s*[a-z]\.is_focus\)", source)
    assert "focusNodeFromLocation" not in source


def test_theme_request_progress() -> None:
    # Issue #365: this suite shipped with 31 assertions but nothing ran
    # it — the same gap #364 fixed for worker/*.test.mjs, still open in
    # this directory. It pins how the theme-request UI maps a workflow
    # run's status/conclusion onto the progress display, including the
    # "unknown conclusion → null" case that stops fake failures being
    # surfaced to the user.
    _run_node(REQUEST_PROGRESS_SCRIPT, min_ok_lines=31)

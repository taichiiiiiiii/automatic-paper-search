"""Static tests for the unified tree controller (docs/assets/lineage-tree.js).

The tree controller unifies the conf and deep viewers from the legacy
``docs/assets/lineage.js`` + ``docs/assets/deep.js`` into one module
launched from ``lineage-shell.js`` via ``PPLineageTree.init({source,
data, mount})``.

These tests statically verify the module's invariants:

    (a) References ``PP.edgeStyle`` for the backbone/branch hierarchy so
        the edge visual vocabulary is shared with theme.js + the legacy
        viewers (no hardcoded opacity/width per relation).
    (b) innerHTML is used only for card markup where every interpolated
        value is wrapped with ``PP.escapeHtml`` (aliased as ``e(...)``
        inside the module). This is the established pattern in the
        legacy lineage.js / deep.js files — the brief permits it on the
        condition that all inputs flow through the escape helper.
    (c) The module holds no ``fetch`` calls — data is passed in by the
        shell, which keeps lineage-tree.js side-effect free w.r.t. the
        network and lets it be invoked from contexts where the data has
        already been cached or pre-processed.
    (d) The ``PPLineageTree`` global is exported and exposes ``init``.

Design spec: DESIGN-372.md §2 S2; brief §Agent V2.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TREE_JS = REPO_ROOT / "docs" / "assets" / "lineage-tree.js"


@pytest.fixture(scope="module")
def tree_text() -> str:
    assert TREE_JS.exists(), f"missing lineage-tree.js at {TREE_JS}"
    return TREE_JS.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# (a) Uses PP.edgeStyle
# ---------------------------------------------------------------------------


def test_tree_references_pp_edge_style(tree_text: str) -> None:
    # Direct call form: PP.edgeStyle(...)
    assert re.search(r"PP\.edgeStyle\s*\(", tree_text), (
        "lineage-tree.js must route edge styling through PP.edgeStyle()"
    )


# ---------------------------------------------------------------------------
# (b) innerHTML is only used with PP.escapeHtml-wrapped interpolation
# ---------------------------------------------------------------------------


def test_tree_no_raw_inner_html_of_user_input(tree_text: str) -> None:
    """Every innerHTML assignment must have every interpolated `${…}`
    segment wrapped in the local escape helper ``e(…)`` (aliased from
    ``PP.escapeHtml`` at the top of the module).

    The check is intentionally coarse — it's a static safety net, not a
    full XSS audit. For each ``…innerHTML = `…``` template literal we
    verify that every template expression contains ``e(`` (the escape
    helper) or is a known-safe static tag (``trending`` which is either
    the empty string or a static literal).
    """
    # Module must alias PP.escapeHtml to `e` for readability (and the
    # audit below depends on the alias being present).
    assert re.search(r"const\s+e\s*=\s*PP\.escapeHtml", tree_text), (
        "lineage-tree.js must alias PP.escapeHtml to a local `e` helper"
    )

    # Find every template-literal innerHTML assignment.
    for m in re.finditer(r"innerHTML\s*=\s*`([^`]*)`", tree_text):
        template = m.group(1)
        # Locate all ${…} expressions in the template.
        for expr in re.findall(r"\$\{([^}]+)\}", template):
            # Empty / whitespace — fine.
            if not expr.strip():
                continue
            # Static literal fragment (trending / kinds / stars / cits)
            # — these are either the empty string or a hard-coded HTML
            # string built from escape-helper-escaped values elsewhere
            # in the same template. They never interpolate user input
            # directly.
            if expr.strip() in {"trending", "kinds", "stars", "cits"}:
                continue
            # Otherwise the expression must flow through `e(`.
            assert re.search(r"\be\s*\(", expr), (
                f"innerHTML template expression `{expr}` is not escaped via `e(...)`"
            )


# ---------------------------------------------------------------------------
# (c) No fetch calls
# ---------------------------------------------------------------------------


def test_tree_has_no_fetch(tree_text: str) -> None:
    assert not re.search(r"(?<![A-Za-z0-9_.])fetch\s*\(", tree_text), (
        "lineage-tree.js must not call fetch() — data is passed in by "
        "lineage-shell.js"
    )


# ---------------------------------------------------------------------------
# (d) PPLineageTree export
# ---------------------------------------------------------------------------


def test_tree_exports_init(tree_text: str) -> None:
    assert re.search(r"root\.PPLineageTree\s*=\s*\{\s*init\s*\}", tree_text), (
        "lineage-tree.js must export PPLineageTree = { init }"
    )


def test_tree_init_signature(tree_text: str) -> None:
    # init({ source, data, mount }) destructured parameter.
    assert re.search(r"function\s+init\s*\(\s*\{\s*source\s*,\s*data\s*,\s*mount\s*\}", tree_text), (
        "init() must accept {source, data, mount}"
    )


def test_tree_escape_fails_loudly_without_utils() -> None:
    """The escape helper must never fall back to identity — if utils.js
    is missing the module must throw, not silently disable escaping.
    """
    assert "throw new Error" in TREE_JS.read_text(encoding="utf-8").split(
        "const e = PP.escapeHtml"
    )[0].rsplit("if (typeof PP.escapeHtml", 1)[-1]


def test_tree_filter_chips_take_container_parameter() -> None:
    """renderFilterChips must receive its container as a parameter — it is
    called from buildShell() before `els` is assigned, so reading
    els.filterBar silently rendered zero chips (review 2026-08-24).
    """
    js = TREE_JS.read_text(encoding="utf-8")
    assert "function renderFilterChips(bar)" in js
    assert "renderFilterChips(filterBar)" in js


def test_tree_relation_labels_are_japanese() -> None:
    """Filter chips and tooltips use the unified Japanese terms
    (置換/後継/拡張/成分分析/比較/対立) — no English label split,
    and ablation is 成分分析 everywhere (matches utils.js legend and
    how-it-works).
    """
    js = TREE_JS.read_text(encoding="utf-8")
    assert "成分分析" in js
    assert '"Supersedes"' not in js and '"Ablation"' not in js

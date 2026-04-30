"""Pytest wrapper for the X-axis layout JS unit tests.

The actual assertions live in ``test_theme_xaxis_layout.mjs``. This wrapper
spawns ``node`` as a subprocess so the JS tests run as part of the regular
``uv run pytest`` flow — keeping a single test command for both Python and
front-end logic.

Skipped (not failed) when ``node`` is not on PATH so contributors who only
work on the Python pipeline aren't blocked by a missing optional toolchain.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent / "test_theme_xaxis_layout.mjs"


def test_theme_xaxis_layout_js_passes() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed; skipping theme.js layout tests")
    result = subprocess.run(
        [node, str(SCRIPT)],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    output = result.stdout + "\n" + result.stderr
    assert result.returncode == 0, (
        f"theme.js layout tests failed (exit={result.returncode}):\n{output}"
    )
    # Sanity check: each `ok ...` line corresponds to one passing test. We
    # require a non-trivial number so an empty test file can't silently
    # appear to pass.
    assert "passed, 0 failed" in output, output
    assert output.count("\n  ok  ") >= 10, (
        f"expected at least 10 passing assertions, got:\n{output}"
    )

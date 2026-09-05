"""Pytest wrapper for the docs/assets/search.js front-end guard.

Spawns ``node`` as a subprocess so the JS check runs inside the regular
``uv run pytest`` flow. Skipped (not failed) when ``node`` is not on PATH,
matching test_theme_viewer_smoke.py, so contributors who only work on the
Python pipeline are not blocked by a missing optional toolchain.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

VIEWER_DIR = Path(__file__).parent
UNTRUSTED_TEXT_SCRIPT = VIEWER_DIR / "test_search_untrusted_text.mjs"
SEARCH_V2_SCRIPT = VIEWER_DIR / "test_search_v2.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_search_never_builds_html_from_untrusted_text() -> None:
    # search.js renders paper titles scraped from conference sites. It once
    # assembled rows with innerHTML behind an escapeHtml helper looked up as
    # `window.PP.escapeHtml || ((s) => String(s))` — if utils.js failed to
    # load, the fallback silently became the identity function and the
    # escaping vanished with no error. Five real titles in the catalog
    # already contain angle brackets, so this was reachable. The fix was to
    # stop producing HTML strings at all; this guard keeps it that way.
    result = subprocess.run(
        ["node", str(UNTRUSTED_TEXT_SCRIPT)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_search_v2_core_contract() -> None:
    result = subprocess.run(
        ["node", str(SEARCH_V2_SCRIPT)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr

"""Node and CSS contract wrapper for the SD3 slide viewer assets."""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = Path(__file__).with_name("test_paper_slides_viewer.mjs")
CSS = ROOT / "docs" / "assets" / "paper-slides.css"
JS = ROOT / "docs" / "assets" / "paper-slides.js"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_paper_slide_navigation_contract() -> None:
    result = subprocess.run(
        ["node", str(SCRIPT)],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "paper slide viewer contract passed" in result.stdout


def test_slide_assets_are_local_bounded_and_accessible() -> None:
    css = CSS.read_text(encoding="utf-8")
    script = JS.read_text(encoding="utf-8")

    assert len(css.encode()) <= 64 * 1024
    assert len(script.encode()) <= 32 * 1024
    assert "@media (prefers-reduced-motion: reduce)" in css
    assert "@media print" in css
    assert "@media (max-width: 600px)" in css
    assert ":focus-visible" in css
    assert ".paper-slides-enhanced .paper-slide[hidden]" in css
    assert re.search(r"@media print\s*\{[\s\S]*?\.paper-slide\[hidden\]", css)
    assert "overflow-wrap: anywhere" in css
    assert "min-height: 44px" in css
    assert re.search(r"url\(\s*['\"]?https?://", css, re.I) is None
    assert "@import" not in css
    assert "document.createElement" not in script


def test_no_js_rule_does_not_hide_the_document_sequence() -> None:
    css = CSS.read_text(encoding="utf-8")
    hiding_rules = re.findall(r"([^{}]+)\{[^{}]*display:\s*none", css)
    assert hiding_rules
    assert all(
        "paper-slides-enhanced" in selector or "[hidden]" in selector for selector in hiding_rules
    )

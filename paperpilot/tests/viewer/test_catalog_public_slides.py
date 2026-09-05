"""Node wrapper for reviewed public-slide trust and selected-card lookup."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPTS = (
    Path(__file__).parent / "test_catalog_public_slides.mjs",
    Path(__file__).parent / "test_catalog_public_slides_app.mjs",
    Path(__file__).parent / "test_catalog_full_abstract_app.mjs",
)


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_catalog_public_slides_core() -> None:
    for script in SCRIPTS:
        result = subprocess.run(
            ["node", str(script)],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        assert result.returncode == 0, result.stdout + result.stderr

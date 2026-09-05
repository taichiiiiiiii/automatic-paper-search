"""Node wrapper for canonical catalog paper-link behavior."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent / "test_catalog_paper_link.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_catalog_paper_link_core() -> None:
    result = subprocess.run(
        ["node", str(SCRIPT)],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr

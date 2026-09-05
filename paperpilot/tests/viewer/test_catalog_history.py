"""Node wrapper for catalog selection history restoration."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).with_name("test_catalog_history.mjs")


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_catalog_history_contract() -> None:
    result = subprocess.run(
        ["node", str(SCRIPT)],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "catalog history contract passed" in result.stdout

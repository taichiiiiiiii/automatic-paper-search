"""Run the standalone browser lineage v2 core contract under Node."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_lineage_v2_browser_core_contract() -> None:
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ["node", str(root / "paperpilot" / "tests" / "viewer" / "test_lineage_v2_core.mjs")],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr

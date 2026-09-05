"""Run the P2 lineage browser contract suites through pytest."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

VIEWER_DIR = Path(__file__).parent / "viewer"
SUITES = [
    ("test_lineage_core.mjs", 19),
    ("test_lineage_publication_gate.mjs", 6),
    ("test_deep_publication_gate.mjs", 8),
    ("test_lineage_viewer_contract.mjs", 22),
]


@pytest.mark.parametrize(("name", "minimum"), SUITES)
def test_lineage_node_suite(name: str, minimum: int) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed; skipping lineage browser contracts")
    result = subprocess.run(
        [node, name],
        cwd=VIEWER_DIR,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    output = result.stdout + "\n" + result.stderr
    assert result.returncode == 0, output
    assert "passed, 0 failed" in output, output
    assert output.count("  ok  ") >= minimum, output

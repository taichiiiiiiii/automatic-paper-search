"""Node wrapper for the selected-card Paper Slide request/status contract."""

from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = (
    Path(__file__).with_name("test_catalog_slide_request.mjs"),
    Path(__file__).with_name("test_catalog_slide_request_app.mjs"),
)


def test_catalog_slide_request_contract() -> None:
    outputs = []
    for script in SCRIPTS:
        result = subprocess.run(
            ["node", str(script)],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        outputs.append(result.stdout)
    assert "catalog slide request/status core contract passed" in outputs[0]
    assert "catalog slide request/status app contract passed" in outputs[1]

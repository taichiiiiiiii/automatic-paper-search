"""Run the Cloudflare Worker's node test suites from pytest.

`worker/*.test.mjs` held 54 passing assertions that **nothing executed**
(#364): the pytest suite only wrapped the five `.mjs` files under
`tests/viewer/`, the repo has no `package.json`, and no workflow runs
tests at all (#358). pytest is therefore the only gate, so anything not
wired into it is dead — including the tests guarding the live theme-request
Worker.

Contract matches `tests/viewer/test_theme_viewer_smoke.py::_run_node`:
exit 0, a `passed, 0 failed` summary, and at least the known number of
`  ok  ` lines so a silently-bypassed script cannot look green.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

WORKER_DIR = Path(__file__).resolve().parents[2] / "worker"

# (script, minimum passing assertions). The floors are the counts last verified
# on 2026-09-05 — a suite that quietly stops asserting will trip them.
SUITES = [
    ("entrypoint.test.mjs", 17),
    ("index.test.mjs", 14),
    ("paper-slide-api.test.mjs", 31),
    ("paper-slide-catalog.test.mjs", 18),
    ("paper-slide-contract.test.mjs", 19),
    ("paper-slide-coordinator.test.mjs", 16),
    ("paper-slide-dispatch.test.mjs", 12),
    ("paper-slide-durable-coordinator.test.mjs", 33),
    ("paper-slide-request-plane.integration.test.mjs", 6),
    ("paper-slide-runtime.test.mjs", 10),
    ("paper-slide-workflow-api.test.mjs", 17),
    ("request-id.test.mjs", 12),
    ("response.test.mjs", 23),
    ("run-match.test.mjs", 11),
    ("validate-input.test.mjs", 10),
]


def _run_node_suite(script: Path, *, min_ok_lines: int) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed; skipping worker test suites")
    result = subprocess.run(
        [node, script.name],
        cwd=script.parent,  # the suites import siblings by bare name
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    output = result.stdout + "\n" + result.stderr
    assert result.returncode == 0, f"{script.name} failed (exit={result.returncode}):\n{output}"
    assert "passed, 0 failed" in output, output
    assert output.count("\n  ok  ") + output.startswith("  ok  ") >= min_ok_lines, (
        f"expected at least {min_ok_lines} passing assertions in {script.name}, got:\n{output}"
    )


@pytest.mark.parametrize(("name", "min_ok"), SUITES)
def test_worker_node_suite_passes(name: str, min_ok: int) -> None:
    _run_node_suite(WORKER_DIR / name, min_ok_lines=min_ok)


def test_every_worker_test_file_is_wired_up() -> None:
    """A new worker/*.test.mjs must be added to SUITES, not silently ignored.

    This is the guard that would have caught #364 in the first place: the
    suites existed on disk but no test referenced them.
    """
    on_disk = {p.name for p in WORKER_DIR.glob("*.test.mjs")}
    wired = {name for name, _ in SUITES}
    missing = sorted(on_disk - wired)
    assert not missing, (
        f"these worker test suites exist but are not run by pytest: {missing}. Add them to SUITES."
    )
    stale = sorted(wired - on_disk)
    assert not stale, f"SUITES references files that no longer exist: {stale}"


def test_production_worker_keeps_paper_slide_adapter_dormant() -> None:
    """The deployed entrypoint must opt in only after real adapters exist."""
    source = (WORKER_DIR / "index.ts").read_text(encoding="utf-8")
    assert 'from "./entrypoint.js"' in source
    for module in (
        "paper-slide-api",
        "paper-slide-catalog",
        "paper-slide-coordinator",
        "paper-slide-dispatch",
        "paper-slide-durable-coordinator",
        "paper-slide-durable-object",
        "paper-slide-runtime",
        "paper-slide-workflow-api",
    ):
        assert f'from "./{module}.js"' not in source
        assert f'from "./{module}.ts"' not in source

    production_wiring = source.split("const handler: ExportedHandler<Env> =", maxsplit=1)[1]
    assert "createPaperPilotWorker({" in production_wiring
    assert "paperSlideApi" not in production_wiring
    assert "paperSlideWorkflowApi" not in production_wiring

    wrangler = (WORKER_DIR.parent / "wrangler.jsonc").read_text(encoding="utf-8")
    assert "PAPER_SLIDE_COORDINATOR" not in wrangler
    assert "PaperSlideDurableCoordinator" not in wrangler

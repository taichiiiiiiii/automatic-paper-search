"""Contract tests for .github/workflows/collect-daily-watch.yml's commit step.

The collector runs with ``--fail-on-errors``, so a degraded daily run (e.g. one
arXiv keyword 503) exits 1. The runner (paperpilot/pipeline/runner.py) has by
then already exported the hits and stamped ``seen_ids.daily.json`` (it skips the
stamp only when every enabled exporter failed). A commit step that is skipped on
failure therefore lost the stamp and re-sent the same hits next run; one that
committed only seen_ids would mark CSV-only hits seen that nobody can read. The
contract: a single commit step that runs unless cancelled and stages exactly the
daily output, seen_ids and the daily run history — never a ``.corrupt-*``
quarantine file.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "collect-daily-watch.yml"


def _load_workflow() -> dict[str, Any]:
    data = yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def _steps() -> list[dict[str, Any]]:
    workflow = _load_workflow()
    steps = workflow["jobs"]["watch"]["steps"]
    assert isinstance(steps, list)
    return steps


def _find_step(steps: list[dict[str, Any]], *, name_contains: str) -> dict[str, Any]:
    matches = [s for s in steps if name_contains in (s.get("name") or "")]
    assert len(matches) == 1, (
        f"expected exactly one step with '{name_contains}' in its name, "
        f"found {len(matches)}: {[s.get('name') for s in steps]}"
    )
    return matches[0]


def test_collector_step_passes_fail_on_errors() -> None:
    steps = _steps()
    collect_step = _find_step(steps, name_contains="Run PaperPilot")
    run = collect_step.get("run") or ""
    assert "--fail-on-errors" in run


def _commit_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [s for s in steps if "commit-and-push.sh" in (s.get("run") or "")]


def test_single_commit_step_runs_unless_cancelled() -> None:
    commits = _commit_steps(_steps())
    assert len(commits) == 1, [s.get("name") for s in commits]
    assert commits[0].get("if") == "${{ !cancelled() }}"


def test_commit_step_stages_exactly_output_seen_ids_and_history() -> None:
    run = _commit_steps(_steps())[0]["run"]
    assert "corrupt-" not in run
    # Parse the arguments actually passed to commit-and-push.sh, so a comment
    # mentioning a path cannot satisfy the check.
    call_text = run[run.index("commit-and-push.sh") :]
    staged_paths = {
        token.rstrip("\\")
        for token in call_text.replace("\n", " ").split()
        if token.rstrip("\\").startswith("paperpilot/")
    }
    assert staged_paths == {
        "paperpilot/output/daily",
        "paperpilot/data/seen_ids.daily.json",
        "paperpilot/data/run_history.daily.jsonl",
    }

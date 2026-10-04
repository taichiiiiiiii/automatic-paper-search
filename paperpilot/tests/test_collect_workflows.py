"""Contract tests for the collector steps of collect-daily-watch.yml and
collect-weekly.yml.

The collector runs with ``--fail-on-errors`` in both workflows, so a degraded
run (e.g. one arXiv keyword 503) exits 1 instead of silently publishing a
thinner result as if it were complete.

For collect-daily-watch.yml specifically: the runner
(paperpilot/pipeline/runner.py) has by then already exported the hits and
stamped ``seen_ids.daily.json`` (it skips the stamp only when every enabled
exporter failed). A commit step that is skipped on failure therefore lost the
stamp and re-sent the same hits next run; one that committed only seen_ids
would mark CSV-only hits seen that nobody can read. The contract: a single
commit step that runs unless cancelled and stages exactly the daily output,
seen_ids and the daily run history — never a ``.corrupt-*`` quarantine file.

For collect-weekly.yml: there is no equivalent commit step (its generated
files move through promote-generated.sh instead), but the collector step's
``--fail-on-errors`` guard and its ``id: collector`` (which the later
"Check whether this attempt wrote its own run history" step keys off of)
are still a contract worth pinning.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "collect-daily-watch.yml"
WEEKLY_WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "collect-weekly.yml"


def _load_workflow(path: Path = WORKFLOW_PATH) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def _steps(path: Path = WORKFLOW_PATH, *, job: str = "watch") -> list[dict[str, Any]]:
    workflow = _load_workflow(path)
    steps = workflow["jobs"][job]["steps"]
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


def test_weekly_collector_step_passes_fail_on_errors() -> None:
    steps = _steps(WEEKLY_WORKFLOW_PATH, job="generate")
    collect_step = _find_step(steps, name_contains="Run PaperPilot")
    run = collect_step.get("run") or ""
    assert "--fail-on-errors" in run
    # The "Check whether this attempt wrote its own run history" step
    # downstream gates on `steps.collector.outcome`, so the id must not
    # drift out from under it.
    assert collect_step.get("id") == "collector"


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

"""Contract tests for .github/workflows/ts-ci.yml.

ts-ci.yml is the new TypeScript-migration CI gate (docs/design/
39-typescript-cloudflare-migration.md §4.3, §7.3): it lints/typechecks/
tests/builds the pnpm workspace (apps/**, packages/**) on feat/ts-migration,
in parallel with the existing Python-only tests.yml, until the P5 cutover.

Per the design doc's §4.3 "認証情報" and §7.3 safety rule, this workflow must
stay credential-free for as long as it runs on a feat branch: no
CLOUDFLARE_* secret, no `wrangler` invocation, no deploy step. Those pin
exactly the properties a later, careless edit (e.g. someone adding a
"deploy preview" step to this file) would most easily violate.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "ts-ci.yml"

EXPECTED_PATHS = {
    "apps/**",
    "packages/**",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "biome.json",
    ".github/workflows/ts-ci.yml",
}


def _load() -> dict[str, Any]:
    assert WORKFLOW_PATH.is_file(), f"missing workflow: {WORKFLOW_PATH}"
    data = yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def _raw_text() -> str:
    return WORKFLOW_PATH.read_text(encoding="utf-8")


def _strip_comment_lines(text: str) -> str:
    """Drop full-line `#` comments so prose explaining *why* this workflow
    avoids secrets/wrangler (which necessarily names them) doesn't trip the
    substring checks below. Mirrors test_collect_workflows.py's
    _strip_block_comments."""
    return "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("#")
    )


def _on(data: dict[str, Any]) -> Any:
    # PyYAML 1.1 treats the unquoted key `on` as boolean true (see
    # test_pages_release_workflow.py's identical helper).
    return data.get("on", data.get(True))


def _all_steps(data: dict[str, Any]) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []
    for job in data["jobs"].values():
        steps.extend(job.get("steps", []))
    return steps


def test_workflow_yaml_parses() -> None:
    import yaml as _yaml

    with open(WORKFLOW_PATH, encoding="utf-8") as fp:
        _yaml.safe_load(fp)


def test_permissions_are_contents_read_only() -> None:
    data = _load()
    assert data.get("permissions") == {"contents": "read"}


def test_no_secrets_referenced_anywhere() -> None:
    # No step should need any secret at all (let alone CLOUDFLARE_*): this
    # job only lints/typechecks/tests/builds, it never deploys.
    text = _strip_comment_lines(_raw_text())
    assert "secrets." not in text, (
        "ts-ci.yml must stay credential-free (no secrets. reference); "
        "deploy steps belong in the develop-only release pipeline (§4.3)"
    )
    assert "CLOUDFLARE_" not in text


def test_no_wrangler_or_pages_deploy() -> None:
    text = _strip_comment_lines(_raw_text()).lower()
    assert "wrangler" not in text
    assert "pages deploy" not in text
    assert "pages publish" not in text


def test_push_trigger_targets_feat_branch_with_paths_filter() -> None:
    data = _load()
    trigger = _on(data)
    assert isinstance(trigger, dict)
    assert "push" in trigger
    push = trigger["push"]
    assert push["branches"] == ["feat/ts-migration"]
    assert set(push["paths"]) == EXPECTED_PATHS


def test_pull_request_trigger_has_same_paths_filter() -> None:
    data = _load()
    trigger = _on(data)
    assert "pull_request" in trigger
    pr = trigger["pull_request"]
    assert set(pr["paths"]) == EXPECTED_PATHS


def test_workflow_dispatch_trigger_present() -> None:
    data = _load()
    trigger = _on(data)
    assert "workflow_dispatch" in trigger


def test_concurrency_group_is_per_ref_and_cancels_in_progress() -> None:
    data = _load()
    concurrency = data.get("concurrency")
    assert isinstance(concurrency, dict)
    assert concurrency.get("group") == "ts-ci-${{ github.ref }}"
    assert concurrency.get("cancel-in-progress") is True


def test_install_step_uses_frozen_lockfile() -> None:
    data = _load()
    steps = _all_steps(data)
    install_runs = [s.get("run") or "" for s in steps if "pnpm install" in (s.get("run") or "")]
    assert install_runs, "expected a pnpm install step"
    assert all("--frozen-lockfile" in run for run in install_runs)


def test_no_pnpm_install_without_frozen_lockfile() -> None:
    # Belt-and-braces: a bare `pnpm install` anywhere (even outside the
    # named install step) would silently drop the lockfile guarantee. Every
    # `pnpm install` occurrence must carry --frozen-lockfile on the same
    # line.
    text = _raw_text()
    for line in text.splitlines():
        if "pnpm install" in line:
            assert "--frozen-lockfile" in line, line


def test_setup_node_version_is_22() -> None:
    data = _load()
    steps = _all_steps(data)
    node_steps = [s for s in steps if "setup-node" in (s.get("uses") or "")]
    assert len(node_steps) == 1
    assert node_steps[0]["with"]["node-version"] == "22"


def test_checks_biome_typecheck_and_test_all_present() -> None:
    data = _load()
    steps = _all_steps(data)
    runs = " \n".join(s.get("run") or "" for s in steps)
    assert "biome check" in runs
    assert "pnpm -r --if-present typecheck" in runs
    assert "pnpm -r --if-present test" in runs


def test_web_build_step_is_guarded_and_filtered() -> None:
    data = _load()
    steps = _all_steps(data)
    build_steps = [s for s in steps if "@paperpilot/web build" in (s.get("run") or "")]
    assert len(build_steps) == 1
    run = build_steps[0]["run"]
    assert "pnpm --filter @paperpilot/web build" in run
    # Guarded: must not unconditionally invoke the build (an `if` branch or
    # shell conditional around it), so a future package without a build
    # script does not hard-fail this workflow.
    assert "if " in run


def test_no_deploy_or_release_job() -> None:
    data = _load()
    job_names = set(data["jobs"].keys())
    assert job_names == {"test"}

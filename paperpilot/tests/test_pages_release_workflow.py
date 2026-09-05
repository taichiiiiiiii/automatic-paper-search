"""Contract tests for the single exact-SHA GitHub Pages release path."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = REPO_ROOT / ".github" / "workflows"
SCRIPTS = REPO_ROOT / ".github" / "scripts"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
BOT_WORKFLOWS = (
    "theme-on-demand.yml",
    "regen-themes.yml",
    "conference-on-demand.yml",
    "collect-weekly.yml",
)


def _load(name: str) -> dict[str, Any]:
    path = WORKFLOWS / name
    assert path.is_file(), f"missing workflow: {path}"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def _on(data: dict[str, Any]) -> Any:
    # PyYAML 1.1 treats the unquoted key `on` as boolean true.
    return data.get("on", data.get(True))


def _all_uses(data: Any) -> list[str]:
    found: list[str] = []
    if isinstance(data, dict):
        for key, value in data.items():
            if key == "uses" and isinstance(value, str):
                found.append(value)
            found.extend(_all_uses(value))
    elif isinstance(data, list):
        for value in data:
            found.extend(_all_uses(value))
    return found


def test_reusable_release_is_call_only_and_exact_sha() -> None:
    data = _load("pages-release.yml")
    trigger = _on(data)

    assert isinstance(trigger, dict)
    assert set(trigger) == {"workflow_call"}
    inputs = trigger["workflow_call"]["inputs"]
    assert inputs["source_sha"]["required"] is True
    assert inputs["release_kind"]["required"] is True
    assert data.get("permissions") == {}

    text = (WORKFLOWS / "pages-release.yml").read_text(encoding="utf-8")
    assert "^[0-9a-f]{40}$" in text
    assert "ref: ${{ inputs.source_sha }}" in text
    assert "git rev-parse HEAD" in text
    assert "_paperpilot-deployment.json" in text
    assert "--extra dev --extra unarxive" in text


def test_reusable_release_has_one_ordered_deploy_path() -> None:
    data = _load("pages-release.yml")
    jobs = data["jobs"]

    assert set(jobs) == {"validate", "build", "admit", "deploy", "smoke"}
    assert jobs["build"]["needs"] == "validate"
    assert jobs["admit"]["needs"] == "build"
    assert jobs["deploy"]["needs"] == ["build", "admit"]
    assert jobs["smoke"]["needs"] == ["admit", "deploy"]
    assert jobs["validate"]["permissions"] == {"contents": "read"}
    assert jobs["build"]["permissions"] == {"contents": "read"}
    assert jobs["admit"]["permissions"] == {"contents": "read"}
    assert jobs["deploy"]["permissions"] == {
        "contents": "read",
        "pages": "write",
        "id-token": "write",
    }
    assert jobs["smoke"]["permissions"] == {"contents": "read"}

    uses = _all_uses(data)
    assert sum("upload-pages-artifact" in use for use in uses) == 1
    assert sum("deploy-pages" in use for use in uses) == 1
    assert all(
        use.startswith("./") or ("@" in use and SHA_RE.fullmatch(use.rsplit("@", 1)[1]))
        for use in uses
    ), uses


def test_release_queue_and_stale_docs_gate_are_fail_closed() -> None:
    data = _load("pages-release.yml")
    assert data["concurrency"] == {
        "group": "paperpilot-pages-production",
        "cancel-in-progress": False,
        "queue": "max",
    }

    jobs = data["jobs"]
    assert jobs["deploy"]["if"] == "needs.admit.outputs.deployable == 'true'"
    assert jobs["smoke"]["if"] == (
        "needs.admit.outputs.deployable == 'true' && needs.deploy.result == 'success'"
    )
    text = (WORKFLOWS / "pages-release.yml").read_text(encoding="utf-8")
    admit = text.split("  admit:", 1)[1].split("\n  deploy:", 1)[0]
    assert "git merge-base --is-ancestor" in admit
    assert 'git diff --quiet "$SOURCE_SHA" "$tip" -- docs' in admit
    assert "skipping stale Pages artifact" in admit
    assert "rollback bypasses" in admit


def test_push_wrapper_has_no_manual_or_parallel_deploy() -> None:
    data = _load("pages.yml")
    trigger = _on(data)

    assert isinstance(trigger, dict)
    assert set(trigger) == {"push"}
    assert trigger["push"]["branches"] == ["develop"]
    assert set(data["jobs"]) == {"release"}
    release = data["jobs"]["release"]
    assert release["uses"] == "./.github/workflows/pages-release.yml"
    assert release["with"]["source_sha"] == "${{ github.sha }}"
    assert release["with"]["release_kind"] == "normal"


def test_rollback_validates_target_before_current_release_workflow() -> None:
    data = _load("pages-rollback.yml")
    trigger = _on(data)

    assert isinstance(trigger, dict)
    assert set(trigger) == {"workflow_dispatch"}
    inputs = trigger["workflow_dispatch"]["inputs"]
    assert inputs["target_sha"]["required"] is True
    assert inputs["confirm"]["required"] is True

    jobs = data["jobs"]
    assert set(jobs) == {"validate_target", "release"}
    assert jobs["release"]["needs"] == "validate_target"
    assert jobs["release"]["uses"] == "./.github/workflows/pages-release.yml"
    assert jobs["release"]["with"]["source_sha"] == "${{ inputs.target_sha }}"
    assert jobs["release"]["with"]["release_kind"] == "rollback"

    text = (WORKFLOWS / "pages-rollback.yml").read_text(encoding="utf-8")
    assert "merge-base --is-ancestor" in text
    assert "deployments" in text
    assert "ROLLBACK" in text


def test_release_validation_script_is_bounded_and_read_only() -> None:
    path = SCRIPTS / "validate-pages-release.sh"
    assert path.is_file()
    text = path.read_text(encoding="utf-8")

    assert "set -euo pipefail" in text
    assert "curl" in text
    assert "--max-time" in text
    assert "conferences.json" in text
    assert "search-index-v2.json" in text
    assert "_paperpilot-deployment.json" in text
    assert "urllib.request" not in text
    assert 'fetch "$url"' in text
    assert not re.search(r"\b(?:git push|gh workflow run|rm -rf)\b", text)


def test_release_smoke_success_cleans_its_scoped_temp_directory(tmp_path: Path) -> None:
    """The EXIT trap must not reference a function-local variable after return."""

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_curl = fake_bin / "curl"
    fake_curl.write_text(
        """#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
output = Path(args[args.index("--output") + 1])
url = args[-1]
sha = os.environ.get("FAKE_DEPLOYMENT_SHA", "a" * 40)
if url.endswith("/_paperpilot-deployment.json"):
    payload = json.dumps({"source_sha": sha})
elif url.endswith("/conferences.json"):
    payload = json.dumps([{"name": "iclr-2026"}])
elif url.endswith("/search-index-v2.json"):
    payload = json.dumps([{"paper_id": "b" * 40}])
elif url.endswith("/lineage-quality-v1.json"):
    payload = json.dumps({"collections": []})
else:
    payload = "<!doctype html><title>fixture</title>"
output.write_text(payload, encoding="utf-8")
""",
        encoding="utf-8",
    )
    fake_curl.chmod(0o755)
    temp_root = tmp_path / "tmp"
    temp_root.mkdir()
    env = {
        **os.environ,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "TMPDIR": str(temp_root),
    }

    completed = subprocess.run(
        [
            "bash",
            str(SCRIPTS / "validate-pages-release.sh"),
            "smoke",
            "https://example.invalid/paperpilot/",
            "a" * 40,
        ],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )

    assert completed.returncode == 0, completed.stderr
    assert list(temp_root.glob("paperpilot-pages-smoke.*")) == []

    mismatched = subprocess.run(
        [
            "bash",
            str(SCRIPTS / "validate-pages-release.sh"),
            "smoke",
            "https://example.invalid/paperpilot/",
            "a" * 40,
        ],
        cwd=REPO_ROOT,
        env={**env, "FAKE_DEPLOYMENT_SHA": "b" * 40},
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )

    assert mismatched.returncode != 0
    assert "deployed marker does not match requested source SHA" in mismatched.stderr
    assert list(temp_root.glob("paperpilot-pages-smoke.*")) == []


def test_bot_workflows_promote_then_call_same_run_release() -> None:
    for name in BOT_WORKFLOWS:
        data = _load(name)
        jobs = data["jobs"]
        assert {"generate", "promote", "release"} <= set(jobs), name
        assert jobs["promote"]["needs"] == "generate", name
        assert jobs["promote"]["permissions"] == {"contents": "write"}, name
        assert jobs["release"]["needs"] == "promote", name
        assert jobs["release"]["uses"] == "./.github/workflows/pages-release.yml", name
        assert jobs["release"]["with"]["source_sha"] == (
            "${{ needs.promote.outputs.source_sha }}"
        ), name
        assert jobs["generate"]["outputs"]["base_sha"] == (
            "${{ steps.candidate.outputs.base_sha }}"
        ), name

        text = (WORKFLOWS / name).read_text(encoding="utf-8")
        assert "promote-generated.sh" in text, name
        assert "PROMOTE_BASE_SHA" in text, name
        assert "GH_PAT" not in text, name
        assert "actions: write" not in text, name
        assert "gh workflow run" not in text, name
        assert "commit-and-push.sh" not in text, name


def test_weekly_generation_packages_only_changed_inputs() -> None:
    text = (WORKFLOWS / "collect-weekly.yml").read_text(encoding="utf-8")
    assert re.search(r"build_pages\.py \\\s*--conference", text)
    assert "package-generated-candidate.sh" in text
    assert "GITHUB_STEP_SUMMARY" in text
    assert "previous artifact retained" in text
    assert "continue-on-error" not in text
    assert "SLACK" not in text


def test_pypi_workflow_is_build_only() -> None:
    data = _load("publish.yml")
    trigger = _on(data)
    assert isinstance(trigger, dict)
    assert set(trigger) == {"pull_request", "workflow_dispatch"}
    assert data.get("permissions") == {"contents": "read"}
    assert set(data["jobs"]) == {"build"}
    text = (WORKFLOWS / "publish.yml").read_text(encoding="utf-8")
    assert "twine check" in text
    assert "Verify wheel package boundary" in text
    assert 'name.startswith("paperpilot/tests/")' in text
    assert '"paperpilot/collector.py"' in text
    assert '"paperpilot/config.yaml"' in text
    assert '"paperpilot/identity/source_ids.py"' in text
    assert '"paperpilot/replay/artifacts.py"' in text
    assert '"paperpilot/replay/canonical.py"' in text
    assert '"paperpilot/replay/manifest.py"' in text
    assert '"paperpilot/scripts/_lineage_contract.py"' in text
    assert '"paperpilot/scripts/build_pages.py"' in text
    assert '"paperpilot/scripts/build_lineage_quality.py"' in text
    assert '"paperpilot/scripts/generate_deep_manifest.py"' in text
    assert '"paperpilot/scripts/replay_run.py"' in text
    assert 'pip" install --require-hashes' in text
    assert 'pip" install --no-deps dist/*.whl' in text
    assert 'python" -m paperpilot.scripts.replay_run --help' in text
    assert "uv export --frozen --no-dev --no-emit-project" in text
    assert "uv sync --frozen --extra release" in text
    assert "python -m build --no-isolation" in text
    assert "pip install --upgrade build twine" not in text
    assert "upload-artifact" in text
    assert "pypi-publish" not in text
    assert "id-token: write" not in text
    assert "environment: pypi" not in text


def test_python_package_uses_pep639_and_excludes_internal_tests() -> None:
    text = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    release_extra = text.split("release = [", 1)[1].split("]", 1)[0]

    assert 'requires = ["setuptools>=77", "wheel"]' in text
    assert '"setuptools>=77"' in release_extra
    assert '"wheel>=0.45,<1"' in release_extra
    assert 'license = "MIT"' in text
    assert "License :: OSI Approved :: MIT License" not in text
    assert "include-package-data = false" in text
    assert "paperpilot = [" in text
    assert '"config.yaml",' in text
    assert '"data/lineage-quality-policy-v1.json",' in text
    assert '"data/paper_repos.json",' in text
    assert 'exclude = ["paperpilot.tests*"]' in text


def test_generation_workflows_use_locked_unarxive_runtime() -> None:
    for name in ("theme-on-demand.yml", "regen-themes.yml"):
        text = (WORKFLOWS / name).read_text(encoding="utf-8")
        assert "uv sync --frozen --extra dev --extra unarxive" in text, name
        assert "uv pip install duckdb" not in text, name

    for name in BOT_WORKFLOWS:
        text = (WORKFLOWS / name).read_text(encoding="utf-8")
        assert "uv sync --frozen --extra dev --extra unarxive" in text, name


def test_on_demand_theme_candidate_is_scoped_to_one_slug() -> None:
    data = _load("theme-on-demand.yml")
    generate = data["jobs"]["generate"]
    assert generate["outputs"]["primary_path"] == ("${{ steps.candidate.outputs.primary_path }}")
    upload = next(
        step for step in generate["steps"] if step.get("name") == "Upload generated candidate"
    )
    assert upload["with"]["path"] == "${{ runner.temp }}/candidate"

    text = (WORKFLOWS / "theme-on-demand.yml").read_text(encoding="utf-8")
    assert "Package exact theme candidate" in text
    assert 'PAPERPILOT_PACKAGE_INCLUDE_UNCHANGED: "1"' in text
    assert '"$RUNNER_TEMP/candidate" "$msg" "$PRIMARY_PATH"' in text
    assert "paperpilot/data/lineage-cache/classifications.json" not in text
    assert re.search(r"^\s+docs/themes(?:\s|$)", text, re.MULTILINE) is None

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


def _workflow_run_script(name: str, step_name: str) -> str:
    """The ``run`` body of the single step of ``name`` called ``step_name``."""
    data = _load(name)
    scripts = [
        step["run"]
        for job in data["jobs"].values()
        for step in job.get("steps", [])
        if isinstance(step, dict) and step.get("name") == step_name
    ]
    assert len(scripts) == 1, f"{name}: expected one {step_name!r} run step, got {len(scripts)}"
    return scripts[0]


def _run_workflow_step_script(
    tmp_path: Path, name: str, step_name: str, env: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    """Execute one workflow step's own ``run`` body with bash, offline, in ``tmp_path``.

    The script is taken from the YAML rather than copied here, so the test judges the gate
    that really runs on the runner instead of a snapshot of it.
    """
    path = tmp_path / f"{step_name.lower().replace(' ', '-')}.sh"
    path.write_text(_workflow_run_script(name, step_name), encoding="utf-8")
    return subprocess.run(
        ["bash", str(path)],
        cwd=tmp_path,
        env={**os.environ, **env},
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_shrink_override_is_an_operator_input_and_never_shell_text() -> None:
    """``build_pages`` only loosens its content-loss gate on an explicit slug list.

    No workflow could pass ``--allow-shrink-for`` before, so an operator who
    checked a smaller catalog by hand had no way to publish it. The input reaches
    the script through the environment only, and every entry is validated against
    the conference slug shape in the script before it becomes an argument.
    """
    for name in ("collect-weekly.yml", "conference-on-demand.yml"):
        data = _load(name)
        inputs = _on(data)["workflow_dispatch"]["inputs"]
        allow = inputs["allow_shrink_for"]
        assert allow["required"] is False, name
        assert allow["default"] == "", name
        assert allow["type"] == "string", name
        assert "comma-separated" in allow["description"].lower(), name

        text = (WORKFLOWS / name).read_text(encoding="utf-8")
        # Passed exactly the way the other inputs are: as an env value.
        carriers = [line for line in text.splitlines() if "inputs.allow_shrink_for" in line]
        assert carriers, name
        assert all(line.strip().startswith("ALLOW_SHRINK_FOR:") for line in carriers), name
        # Never interpolated into a run: script, where it could carry shell text.
        assert all(
            "inputs.allow_shrink_for" not in step["run"]
            for job in data["jobs"].values()
            for step in job.get("steps", [])
            if isinstance(step, dict) and isinstance(step.get("run"), str)
        ), name
        # ...and the validated list is what build_pages is finally given.
        assert "'^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'" in text, name
        assert "--allow-shrink-for" in text, name
        assert "shrink_args+=(--allow-shrink-for" in text, name


def _allow_shrink_loop(name: str) -> str:
    """The ``allow_shrink_for`` -> argument loop of ``name``'s run script.

    Cut from ``shrink_args=()`` to the ``done`` that closes it, so the test can execute the
    real snippet instead of re-deriving what it is expected to do.
    """
    data = _load(name)
    for job in data["jobs"].values():
        for step in job.get("steps", []):
            run = step.get("run") if isinstance(step, dict) else None
            if isinstance(run, str) and "shrink_args=()" in run:
                lines = run.splitlines()
                start = next(i for i, line in enumerate(lines) if line.strip() == "shrink_args=()")
                end = next(
                    i for i, line in enumerate(lines) if i > start and line.strip() == "done"
                )
                return "\n".join(lines[start : end + 1])
    raise AssertionError(f"{name}: no allow_shrink_for loop")


def _run_allow_shrink_loop(
    tmp_path: Path, name: str, value: str
) -> subprocess.CompletedProcess[str]:
    """Run the extracted loop with ``ALLOW_SHRINK_FOR=value`` and echo the resulting args.

    The trailer guards the array expansion the way the workflow's own build line does, so
    an empty list works on bash < 4.4, where ``"${shrink_args[@]}"`` under ``set -u`` is
    an unbound variable error rather than no arguments.
    """
    script = tmp_path / "allow-shrink-loop.sh"
    script.write_text(
        "set -euo pipefail\n"
        + _allow_shrink_loop(name)
        + "\nprintf '%s\\n' ${shrink_args[@]+\"${shrink_args[@]}\"}\n",
        encoding="utf-8",
    )
    return subprocess.run(
        ["bash", str(script)],
        cwd=tmp_path,
        env={**os.environ, "ALLOW_SHRINK_FOR": value},
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_shrink_override_loop_emits_validated_arguments_only(
    tmp_path: Path,
) -> None:
    """The operator's comma list becomes one validated arg pair per slug — nothing else.

    Run with bash and no network, this is the proof the dispatch input cannot reach a
    shell: shell syntax is refused before it becomes an argument, a value carrying a
    newline is refused as a whole before ``IFS=',' read -a <<<`` would have kept only its
    first line and dropped the rest, and the per-slug pattern (2-64 lowercase letters,
    digits, hyphens) is what decides an otherwise valid shape. A double hyphen stays an
    accepted slug for ``build_pages``' stricter validator to judge, and an empty input
    yields no arguments at all instead of failing the expansion.
    """
    for name in ("collect-weekly.yml", "conference-on-demand.yml"):
        empty = _run_allow_shrink_loop(tmp_path, name, "")
        assert empty.returncode == 0, name + empty.stdout + empty.stderr
        # printf with no arguments still emits its format once, i.e. one newline.
        assert empty.stdout.strip() == "", name

        looped = _run_allow_shrink_loop(tmp_path, name, "iclr-2026, neurips-2026")
        assert looped.returncode == 0, name + looped.stdout + looped.stderr
        assert looped.stdout.splitlines() == [
            "--allow-shrink-for",
            "iclr-2026",
            "--allow-shrink-for",
            "neurips-2026",
        ], name

        double_hyphen = _run_allow_shrink_loop(tmp_path, name, "a--b")
        assert double_hyphen.returncode == 0, name + double_hyphen.stdout
        assert double_hyphen.stdout.splitlines() == ["--allow-shrink-for", "a--b"], name

        for payload in ("x;rm", "x\ny", "neurips-2026\niclr-2026", "iclr-2026\nx;rm"):
            rejected = _run_allow_shrink_loop(tmp_path, name, payload)
            assert rejected.returncode != 0, (name, repr(payload))
            # Refused on the way in, so the payload never became an argument either.
            assert "--allow-shrink-for" not in rejected.stdout, (name, repr(payload))
            assert "::error::" in rejected.stdout + rejected.stderr, (name, repr(payload))

        # Two pattern-valid slugs on two lines: the guard is what refuses it here, because
        # the old line-by-line reading would have accepted the first and lost the second.
        dropped = _run_allow_shrink_loop(tmp_path, name, "neurips-2026\niclr-2026")
        assert "must be a single comma-separated line" in dropped.stdout + dropped.stderr, name

        # The payload is never evaluated: this semicolon form would have left a file behind.
        attack = _run_allow_shrink_loop(tmp_path, name, "x;touch pwned")
        assert attack.returncode != 0, name
        assert not (tmp_path / "pwned").exists(), name


def _seed_conference_dir(tmp_path: Path, conf: str, *, with_collection: bool = True) -> None:
    """Create ``paperpilot/output/<conf>/`` (+ a dated collection file) under ``tmp_path``."""
    conf_dir = tmp_path / "paperpilot" / "output" / conf
    conf_dir.mkdir(parents=True, exist_ok=True)
    if with_collection:
        (conf_dir / "papers_2026-09-26.csv").write_text("title\nPaper\n", encoding="utf-8")


def _run_rebuild_projections_step(
    tmp_path: Path, allow_shrink_for: str
) -> subprocess.CompletedProcess[str]:
    """Run collect-weekly's whole "Rebuild conference-local projections" step, offline.

    ``uv`` is a shell function that only echoes its arguments, so the step is judged on
    the command line it really builds without a network or a runner environment.
    """
    step = tmp_path / "rebuild-conference-local-projections.sh"
    step.write_text(
        _workflow_run_script("collect-weekly.yml", "Rebuild conference-local projections"),
        encoding="utf-8",
    )
    harness = tmp_path / "rebuild-projections-harness.sh"
    harness.write_text(
        'uv() { echo "uv $*"; }\n' + f"source ./{step.name}\n",
        encoding="utf-8",
    )
    return subprocess.run(
        ["bash", str(harness)],
        cwd=tmp_path,
        env={**os.environ, "ALLOW_SHRINK_FOR": allow_shrink_for},
        capture_output=True,
        text=True,
        timeout=30,
    )


def _build_pages_calls(stdout: str) -> list[str]:
    """The ``build_pages`` command lines the stubbed step echoed, in build order."""
    return [line for line in stdout.splitlines() if "build_pages.py" in line]


def _stub_uv_calls(stdout: str) -> list[str]:
    """Every command line the stubbed ``uv`` echoed, in build order."""
    return [line for line in stdout.splitlines() if line.startswith("uv ")]


def _pages_command(conf: str, *, acknowledged: bool = False) -> str:
    flag = f" --allow-shrink-for {conf}" if acknowledged else ""
    return f"uv run --frozen python paperpilot/scripts/build_pages.py --conference {conf}{flag}"


def test_weekly_rebuild_gives_each_conference_only_its_own_acknowledgement(
    tmp_path: Path,
) -> None:
    """A scoped ``build_pages`` run may only be loosened for the conference it rebuilds.

    The whole step runs under bash with ``uv`` stubbed: an unacknowledged conference keeps
    its content-loss gate, one operator slug is never handed to another conference's run, no
    echoed command line at all — ``build_pages`` or ``build_summary_csv`` — ever mentions
    ``daily``, and a slug that matched no rebuilt conference fails the job instead of
    quietly publishing with the gate still on.
    """
    _seed_conference_dir(tmp_path, "iclr-2026")
    _seed_conference_dir(tmp_path, "neurips-2026")
    _seed_conference_dir(tmp_path, "daily")

    plain = _run_rebuild_projections_step(tmp_path, "")
    assert plain.returncode == 0, plain.stdout + plain.stderr
    assert _build_pages_calls(plain.stdout) == [
        _pages_command("iclr-2026"),
        _pages_command("neurips-2026"),
    ]
    assert "rebuilt 2 conference-local projection(s)" in plain.stdout

    one = _run_rebuild_projections_step(tmp_path, "iclr-2026")
    assert one.returncode == 0, one.stdout + one.stderr
    assert _build_pages_calls(one.stdout) == [
        _pages_command("iclr-2026", acknowledged=True),
        _pages_command("neurips-2026"),
    ]

    both = _run_rebuild_projections_step(tmp_path, "neurips-2026, iclr-2026")
    assert both.returncode == 0, both.stdout + both.stderr
    assert _build_pages_calls(both.stdout) == [
        _pages_command("iclr-2026", acknowledged=True),
        _pages_command("neurips-2026", acknowledged=True),
    ]
    # The acknowledgement belongs to build_pages only; the summary CSV build is never
    # given a flag it does not parse.
    assert all(
        "--allow-shrink-for" not in line
        for line in both.stdout.splitlines()
        if "build_summary_csv.py" in line
    )

    # A slug for a conference directory that holds no collection this run, ...
    _seed_conference_dir(tmp_path, "cvpr-2026", with_collection=False)
    stale = _run_rebuild_projections_step(tmp_path, "cvpr-2026")
    assert stale.returncode != 0, stale.stdout
    assert "cvpr-2026, which this run did not rebuild" in stale.stdout
    assert _build_pages_calls(stale.stdout) == [
        _pages_command("iclr-2026"),
        _pages_command("neurips-2026"),
    ]

    # ... and a slug that names no directory at all, both fail the same way.
    missing = _run_rebuild_projections_step(tmp_path, "does-not-exist")
    assert missing.returncode != 0, missing.stdout
    assert "does-not-exist, which this run did not rebuild" in missing.stdout
    assert _build_pages_calls(missing.stdout) == [
        _pages_command("iclr-2026"),
        _pages_command("neurips-2026"),
    ]

    # The reserved daily path is skipped before any build, so it must be absent from
    # every command the step assembles — build_summary_csv.py included, which has no
    # content-loss gate of its own to catch a daily projection.
    for run in (plain, one, both, stale, missing):
        assert all("daily" not in line for line in _stub_uv_calls(run.stdout)), run.stdout


def test_on_demand_input_gate_matches_whole_strings_not_lines(
    tmp_path: Path,
) -> None:
    """A ``printf | grep`` check validates one line at a time, so a newline used to pass.

    "iclr-2026\\nx" satisfied the slug pattern on its first line and reached the rest of the
    job as a two-line value. The step now matches each input as one whole string and
    rejects a slug carrying a newline before the reserved-path case, so the same value
    fails — while a normal dispatch keeps passing, which is what makes the gate usable.
    """
    name = "conference-on-demand.yml"
    data = _load(name)
    step = next(
        candidate
        for candidate in data["jobs"]["generate"]["steps"]
        if candidate.get("name") == "Validate inputs early"
    )
    assert "grep -Eq" not in step["run"], "the input gate must not match line by line"

    base_env = {"CONF": "iclr-2026", "VENUE": "ICLR", "MAXN": "800"}

    def run(**overrides: str) -> subprocess.CompletedProcess[str]:
        return _run_workflow_step_script(
            tmp_path, name, "Validate inputs early", {**base_env, **overrides}
        )

    valid = run()
    assert valid.returncode == 0, valid.stdout + valid.stderr

    for values in (
        {"CONF": "iclr-2026\nx"},
        {"CONF": "iclr-2026\n"},
        {"CONF": "iclr-2026x\n"},  # pattern-valid on its own line
        {"VENUE": "ICLR\nx"},
        {"MAXN": "800\n0"},
    ):
        rejected = run(**values)
        assert rejected.returncode != 0, values
        assert "::error::" in rejected.stdout, values

    # The reserved public paths keep being refused, newline check or not.
    reserved = run(CONF="themes")
    assert reserved.returncode != 0
    assert "reserved public path" in reserved.stdout


def test_weekly_generation_packages_only_changed_inputs() -> None:
    text = (WORKFLOWS / "collect-weekly.yml").read_text(encoding="utf-8")
    assert re.search(r"build_pages\.py \\\s*--conference", text)
    assert "package-generated-candidate.sh" in text
    assert "GITHUB_STEP_SUMMARY" in text
    assert "previous artifact retained" in text
    assert "continue-on-error" not in text
    assert "SLACK" not in text


def test_weekly_candidate_allows_changed_conference_catalogs() -> None:
    text = (WORKFLOWS / "collect-weekly.yml").read_text(encoding="utf-8")

    package_step = text.split("- name: Package changed generated files", 1)[1].split(
        "- name: Upload generated candidate", 1
    )[0]
    assert "for papers in docs/*/papers.json; do" in package_step
    assert 'includes+=("$papers")' in package_step
    # build_pages.py publishes the no-JS fallback next to the catalog, so a changed
    # catalog is a changed fallback; packaging one without the other leaves the
    # promotion rebuild with a tracked change outside the allowlist.
    assert "for fallback in docs/*/paper-links.html; do" in package_step
    assert 'includes+=("$fallback")' in package_step

    promote_step = text.split("- name: Validate and promote from the latest develop tip", 1)[1]
    assert '-name papers.json -type f -print0' in promote_step
    assert 'allowed+=("${papers#"$CANDIDATE_DIR/"}")' in promote_step
    assert '-name paper-links.html -type f -print0' in promote_step
    assert 'allowed+=("${fallback#"$CANDIDATE_DIR/"}")' in promote_step


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
    assert '"paperpilot/lineage_pilot/__init__.py"' in text
    assert '"paperpilot/lineage_pilot/bundle.py"' in text
    assert '"paperpilot/lineage_pilot/review_prep.py"' in text
    assert '"paperpilot/lineage_pilot/review_io.py"' in text
    assert '"paperpilot/lineage_pilot/review_intake.py"' in text
    assert '"paperpilot/conference_watch/candidate.py"' in text
    assert '"paperpilot/conference_watch/dry_run.py"' in text
    assert '"paperpilot/scripts/prepare_lineage_review.py"' in text
    assert '"paperpilot/scripts/ingest_lineage_review.py"' in text
    assert '"paperpilot/scripts/_lineage_contract.py"' in text
    assert '"paperpilot/scripts/_lineage_contract_v2.py"' in text
    assert '"paperpilot/scripts/build_pages.py"' in text
    assert '"paperpilot/scripts/build_lineage_quality.py"' in text
    assert '"paperpilot/scripts/generate_deep_manifest.py"' in text
    assert '"paperpilot/scripts/replay_run.py"' in text
    assert '"paperpilot/paper_slides/sol_provider.py"' in text
    assert '"paperpilot/paper_slides/sol_local.py"' in text
    assert '"paperpilot/paper_slides/service.py"' in text
    assert '"paperpilot/scripts/generate_paper_slides.py"' in text
    assert '"paperpilot/data/sol-abstract-local-v1.json"' in text
    assert 'pip" install --require-hashes' in text
    assert 'pip" install --no-deps dist/*.whl' in text
    assert 'python" -m paperpilot.scripts.replay_run --help' in text
    assert 'python" -m paperpilot.scripts.generate_paper_slides --help' in text
    assert 'python" -m paperpilot.scripts.prepare_lineage_review --help' in text
    assert 'python" -m paperpilot.scripts.ingest_lineage_review --help' in text
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

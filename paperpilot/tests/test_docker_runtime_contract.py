"""Static contract for PaperPilot's Docker-first phase-one runtime.

These tests intentionally do not build or pull images.  Release automation must
still approve every OCI digest supplied through the documented build arguments.
"""

from __future__ import annotations

import re
import subprocess
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = ROOT / "Dockerfile"
COMPOSE = ROOT / "docker-compose.yml"
DOCKERIGNORE = ROOT / ".dockerignore"
RUNBOOK = ROOT / "docker" / "README.md"
WRAPPER = ROOT / "docker" / "paperpilot-compose"
WRAPPER_MODULE = ROOT / "docker" / "paperpilot_compose.py"
NODE_DOCKERFILE = ROOT / "docker" / "node-test.Dockerfile"
NODE_RUNNER = ROOT / "docker" / "run-node-tests.mjs"
DOCKER_ENV_EXAMPLE = ROOT / "docker" / "docker-env.example"

PYTHON_REF = "docker.io/library/python@sha256:" + "a" * 64
UV_REF = "ghcr.io/astral-sh/uv@sha256:" + "b" * 64
NODE_REF = "docker.io/library/node@sha256:" + "c" * 64


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _stage(text: str, name: str) -> str:
    marker = re.search(rf"(?m)^FROM\s+\S+\s+AS\s+{re.escape(name)}\s*$", text)
    assert marker is not None, f"missing Docker stage: {name}"
    following = re.search(r"(?m)^FROM\s+", text[marker.end() :])
    end = marker.end() + following.start() if following is not None else len(text)
    return text[marker.start() : end]


def _wrapper_module() -> ModuleType:
    spec = spec_from_file_location("paperpilot_docker_compose", WRAPPER_MODULE)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _approved_environment() -> dict[str, str]:
    return {
        "PAPERPILOT_PYTHON_BASE": PYTHON_REF,
        "PAPERPILOT_UV_BASE": UV_REF,
        "PAPERPILOT_NODE_BASE": NODE_REF,
        "PAPERPILOT_PLATFORM": "linux/arm64/v8",
    }


def _fake_docker(
    *,
    missing_ref: str | None = None,
    architecture: str = "arm64",
    variant: str = "v8",
    python_version: str = "Python 3.12.11\n",
    node_version: str = "v20.20.2\n",
    uv_version: str = "uv 0.12.7 (fake build)\n",
    python_layout_ok: bool = True,
):
    calls: list[tuple[str, ...]] = []

    def run(arguments: list[str]) -> subprocess.CompletedProcess[str]:
        argv = tuple(arguments)
        calls.append(argv)
        if argv[1:3] == ("image", "inspect"):
            ref = argv[3]
            if ref == missing_ref:
                return subprocess.CompletedProcess(arguments, 1, "", "not present")
            repository_digest = ref.replace(":1.7@sha256:", "@sha256:")
            payload = (
                '[{"RepoDigests":["'
                + repository_digest
                + '"],"Os":"linux","Architecture":"'
                + architecture
                + '","Variant":"'
                + variant
                + '"}]'
            )
            return subprocess.CompletedProcess(arguments, 0, payload, "")
        if "--entrypoint" in argv:
            entrypoint = argv[argv.index("--entrypoint") + 1]
            if entrypoint == "/bin/sh":
                return subprocess.CompletedProcess(
                    arguments,
                    0 if python_layout_ok else 1,
                    "",
                    "" if python_layout_ok else "missing apt-get",
                )
            output = {
                "python": python_version,
                "node": node_version,
                "/uv": uv_version,
            }[entrypoint]
            return subprocess.CompletedProcess(arguments, 0, output, "")
        raise AssertionError(f"unexpected fake docker call: {argv}")

    return calls, run


def test_dockerfile_requires_digest_selected_build_inputs() -> None:
    text = _text(DOCKERFILE)
    first = text.splitlines()[0]
    assert re.fullmatch(r"# syntax=docker/dockerfile:1\.7@sha256:[0-9a-f]{64}", first)
    for argument in ("PYTHON_BASE", "UV_BASE"):
        assert re.search(rf"(?m)^ARG {argument}$", text)
        assert not re.search(rf"(?m)^ARG {argument}=", text)
        assert re.search(rf"(?m)^FROM \$\{{{argument}\}} AS ", text)
    assert "ARG NODE_BASE" not in text
    assert not re.search(r"(?mi)^FROM\s+[^$\s]+:[^\s]+", text)


def test_uv_consumes_the_committed_lock_only_in_build_stages() -> None:
    text = _text(DOCKERFILE)
    assert "COPY pyproject.toml uv.lock README.md" in text
    sync_lines = [line.strip() for line in text.splitlines() if "uv sync " in line]
    assert len(sync_lines) == 2
    assert all("--frozen" in line and "--no-editable" in line for line in sync_lines)
    assert all("pip install" not in line for line in text.splitlines())

    collector = _stage(text, "collector")
    test_runtime = _stage(text, "test")
    for runtime in (collector, test_runtime):
        assert "--from=uv-bin" not in runtime
        assert "uv sync" not in runtime
        assert "/usr/local/bin/uv" not in runtime


def test_collector_runtime_is_installed_nonroot_and_source_free() -> None:
    collector = _stage(_text(DOCKERFILE), "collector")
    assert "COPY --from=collector-build" in collector
    assert "COPY paperpilot" not in collector
    assert "COPY ." not in collector
    assert "paperpilot/tests" not in collector
    assert re.search(r"(?m)^USER 65532:65532$", collector)
    assert 'ENTRYPOINT ["/opt/paperpilot/bin/python", "-I", "-m", ' in collector
    assert '"paperpilot.collector"]' in collector
    assert "PYTHONDONTWRITEBYTECODE=1" in collector
    assert "PIP_NO_INDEX=1" in collector
    assert "! command -v uv" in collector
    assert "! command -v pip" in collector
    assert "-m pip" in collector
    assert "-m ensurepip" in collector
    assert "RUN --network=none" in collector


def test_test_ops_and_preview_targets_are_explicit_and_nonroot() -> None:
    text = _text(DOCKERFILE)
    test_runtime = _stage(text, "test")
    ops_build = _stage(text, "ops-build")
    ops = _stage(text, "ops")
    preview = _stage(text, "site-preview")

    assert "COPY --from=test-build" in test_runtime
    assert "COPY --from=node-bin" not in test_runtime
    assert "/usr/local/bin/node" not in test_runtime
    assert re.search(r"(?m)^USER 65532:65532$", test_runtime)
    assert "ruff check paperpilot/" in test_runtime
    assert "pytest paperpilot/tests -q -rs" in test_runtime
    assert "! command -v uv" in test_runtime
    assert "RUN --network=none" in test_runtime

    assert "COPY --from=ops-build" in ops
    assert "schemas/ /workspace/schemas/" in ops
    assert "paperpilot/tests" not in ops
    for excluded in (
        "/build/paperpilot/tests",
        "/build/paperpilot/output",
        "/build/paperpilot/logs",
        "/build/paperpilot/.env",
    ):
        assert excluded in ops_build
    assert "/workspace/paperpilot/output" in ops
    assert "chown 65532:65532" in ops
    assert "-name '.env.*'" in ops
    assert re.search(r"(?m)^USER 65532:65532$", ops)
    assert "build_search_index" in ops and "--help" in ops
    assert "RUN --network=none" in ops

    assert re.search(r"(?m)^USER 65532:65532$", preview)
    assert '"http.server"' in preview
    assert "/site/automatic-paper-search" in preview
    assert "COPY docs" not in preview
    assert "production" not in preview.lower()
    assert "! command -v pip" in preview


def test_node_tests_use_a_dedicated_node_base_and_dynamic_inventory() -> None:
    dockerfile = _text(NODE_DOCKERFILE)
    runner = _text(NODE_RUNNER)
    assert re.search(r"(?m)^ARG NODE_BASE$", dockerfile)
    assert re.search(r"(?m)^FROM \$\{NODE_BASE\} AS node-test$", dockerfile)
    assert re.search(r"(?m)^USER 65532:65532$", dockerfile)
    assert "worker/ /workspace/worker/" in dockerfile
    assert "docs/ /workspace/docs/" in dockerfile
    assert "paperpilot/tests/viewer/ /workspace/paperpilot/tests/viewer/" in dockerfile
    assert "node:assert" in dockerfile
    assert "20" in dockerfile
    assert "readdirSync" in runner
    assert 'endsWith(".test.mjs")' in runner
    assert 'startsWith("test_")' in runner
    assert "spawnSync" in runner and '"--test"' in runner
    assert "expected at least one" in runner.lower()


def _compose() -> dict[str, object]:
    parsed = yaml.safe_load(_text(COMPOSE))
    assert isinstance(parsed, dict)
    return parsed


def _service(name: str) -> dict[str, object]:
    services = _compose().get("services")
    assert isinstance(services, dict)
    service = services.get(name)
    assert isinstance(service, dict)
    return service


def _assert_runtime_hardening(service: dict[str, object]) -> None:
    assert service.get("read_only") is True
    assert service.get("cap_drop") == ["ALL"]
    assert service.get("security_opt") == ["no-new-privileges:true"]
    assert isinstance(service.get("pids_limit"), int)
    assert isinstance(service.get("mem_limit"), str)
    assert isinstance(service.get("cpus"), float)
    tmpfs = service.get("tmpfs")
    assert isinstance(tmpfs, list)
    assert any("/tmp:" in entry and "size=" in entry for entry in tmpfs)


def test_compose_uses_explicit_targets_and_service_scoped_digest_args() -> None:
    expected_targets = {
        "collector": "collector",
        "test": "test",
        "ops": "ops",
        "site-preview": "site-preview",
        "node-test": "node-test",
    }
    for service_name, target in expected_targets.items():
        service = _service(service_name)
        build = service.get("build")
        assert isinstance(build, dict)
        assert build.get("target") == target
        args = build.get("args")
        assert isinstance(args, dict)
        expected_arguments = (
            ("NODE_BASE",) if service_name == "node-test" else ("PYTHON_BASE", "UV_BASE")
        )
        assert set(args) == set(expected_arguments)
        for argument in expected_arguments:
            value = args.get(argument)
            assert isinstance(value, str)
            assert value.startswith("${PAPERPILOT_")
            assert ":?" in value
        assert service.get("pull_policy") == "never"


def test_compose_collector_has_only_explicit_writable_state() -> None:
    collector = _service("collector")
    _assert_runtime_hardening(collector)
    assert collector.get("user") == "65532:65532"
    assert "ports" not in collector
    assert collector.get("restart") == "no"

    mounts = collector.get("volumes")
    assert isinstance(mounts, list)
    assert set(mounts) == {
        "paperpilot-output:/workspace/paperpilot/output",
        "paperpilot-data:/workspace/paperpilot/data",
        "paperpilot-logs:/workspace/paperpilot/logs",
        "./paperpilot/config.yaml:/etc/paperpilot/config.yaml:ro",
    }
    assert "docker.sock" not in _text(COMPOSE)
    assert "privileged:" not in _text(COMPOSE)


def test_compose_test_is_offline_and_preview_is_local_read_only() -> None:
    test = _service("test")
    _assert_runtime_hardening(test)
    assert test.get("network_mode") == "none"
    assert "volumes" not in test
    assert test.get("user") == "65532:65532"
    test_tmpfs = test.get("tmpfs")
    assert isinstance(test_tmpfs, list)
    assert any(
        "/tmp:" in entry and "exec" in entry and "noexec" not in entry for entry in test_tmpfs
    )

    node_test = _service("node-test")
    _assert_runtime_hardening(node_test)
    assert node_test.get("network_mode") == "none"
    assert node_test.get("user") == "65532:65532"
    assert "volumes" not in node_test

    ops = _service("ops")
    _assert_runtime_hardening(ops)
    assert ops.get("network_mode") == "none"
    assert ops.get("user") == "65532:65532"
    assert ops.get("volumes") == [
        "./docs:/workspace/docs",
        "./paperpilot/data:/workspace/paperpilot/data",
        "paperpilot-output:/workspace/paperpilot/output:rw",
    ]

    preview = _service("site-preview")
    _assert_runtime_hardening(preview)
    assert preview.get("volumes") == ["./docs:/site/automatic-paper-search:ro"]
    ports = preview.get("ports")
    assert isinstance(ports, list) and len(ports) == 1
    assert ports[0].startswith("127.0.0.1:")


def test_build_context_is_an_allowlist_without_state_or_secrets() -> None:
    lines = _text(DOCKERIGNORE).splitlines()
    assert lines[0] == "**"
    for required in (
        "!Dockerfile",
        "!pyproject.toml",
        "!uv.lock",
        "!paperpilot/",
        "!paperpilot/**",
        "!docs/",
        "!docs/**",
        "!worker/",
        "!worker/**",
        "!schemas/",
        "!schemas/**",
        "!.github/",
        "!.github/**",
        "!containers/",
        "!containers/**",
        "!docker/README.md",
        "!docker/**",
        "!paperpilot/.env.example",
    ):
        assert required in lines
    for excluded in (
        ".git/",
        "**/.env",
        "**/.env.*",
        "paperpilot/output/**",
        "paperpilot/logs/**",
        "paperpilot/data/lineage-cache/**",
        "paperpilot/data/unarxive/**",
        "**/*.pem",
        "**/*.key",
        "**/*.p12",
        "**/*.pfx",
        "**/*credential*",
        "**/*secret*",
        "**/*.zip",
        "**/*.tar",
        "**/*.tar.gz",
    ):
        assert excluded in lines
    for required_fixture in (
        "!paperpilot/output/iclr-2026/summary.csv",
        "!paperpilot/data/lineage-cache/classifications.json",
    ):
        assert required_fixture in lines


def test_runbook_is_honest_about_digest_approval_and_phase_one_network() -> None:
    text = _text(RUNBOOK)
    for variable in (
        "PAPERPILOT_PYTHON_BASE",
        "PAPERPILOT_UV_BASE",
        "PAPERPILOT_NODE_BASE",
    ):
        assert variable in text
    assert "repository@sha256:<64 lowercase hex>" in text
    assert "phase 1" in text.lower()
    assert "network" in text.lower()
    assert "offline" in text.lower()
    assert "GitHub Pages" in text
    assert "production hosting" in text
    assert "Docker socket" in text
    assert "docker/paperpilot-compose" in text
    assert "docker compose " not in text
    assert "unrestricted outbound" in text
    assert "65532" in text and "Linux" in text
    assert "source-suite" in text
    assert "http://127.0.0.1:8137/automatic-paper-search/" in text
    assert "docker/docker-env.example" in text
    example = _text(DOCKER_ENV_EXAMPLE)
    assert "<64-lowercase-hex>" in example
    assert "API_KEY" not in example and "PASSWORD" not in example


def test_compose_wrapper_rejects_mutable_or_unapproved_references_before_docker() -> None:
    module = _wrapper_module()
    for variable, bad in (
        ("PAPERPILOT_PYTHON_BASE", "python:3.12-slim"),
        ("PAPERPILOT_PYTHON_BASE", "evil.example/python@sha256:" + "a" * 64),
        ("PAPERPILOT_UV_BASE", "ghcr.io/astral-sh/uv@sha256:" + "B" * 64),
        ("PAPERPILOT_NODE_BASE", "docker.io/library/node@sha256:short"),
    ):
        environment = _approved_environment()
        environment[variable] = bad
        calls, run = _fake_docker()
        with pytest.raises(module.PreflightError):
            module.preflight(environment, run=run, docker_bin="/fake/docker")
        assert calls == []


@pytest.mark.parametrize("platform", ["linux/386", "darwin/arm64", "linux/arm64", ""])
def test_compose_wrapper_rejects_noncanonical_platform(platform: str) -> None:
    module = _wrapper_module()
    environment = _approved_environment()
    environment["PAPERPILOT_PLATFORM"] = platform
    calls, run = _fake_docker()
    with pytest.raises(module.PreflightError):
        module.preflight(environment, run=run, docker_bin="/fake/docker")
    assert calls == []


def test_compose_wrapper_requires_local_matching_images_and_offline_versions() -> None:
    module = _wrapper_module()
    environment = _approved_environment()

    calls, run = _fake_docker()
    result = module.preflight(environment, run=run, docker_bin="/fake/docker")
    assert result.platform == "linux/arm64/v8"
    assert len([call for call in calls if call[1:3] == ("image", "inspect")]) == 4
    probes = [call for call in calls if "--entrypoint" in call]
    assert len(probes) == 4
    assert all("--pull=never" in call and "--network=none" in call for call in probes)

    _, missing = _fake_docker(missing_ref=NODE_REF)
    with pytest.raises(module.PreflightError, match="locally present"):
        module.preflight(environment, run=missing, docker_bin="/fake/docker")

    _, wrong_arch = _fake_docker(architecture="amd64", variant="")
    with pytest.raises(module.PreflightError, match="platform"):
        module.preflight(environment, run=wrong_arch, docker_bin="/fake/docker")

    _, wrong_python = _fake_docker(python_version="Python 3.11.9\n")
    with pytest.raises(module.PreflightError, match=r"Python 3\.12"):
        module.preflight(environment, run=wrong_python, docker_bin="/fake/docker")

    _, wrong_python_layout = _fake_docker(python_layout_ok=False)
    with pytest.raises(module.PreflightError, match="offline base probe"):
        module.preflight(environment, run=wrong_python_layout, docker_bin="/fake/docker")

    _, wrong_node = _fake_docker(node_version="v22.1.0\n")
    with pytest.raises(module.PreflightError, match="Node 20"):
        module.preflight(environment, run=wrong_node, docker_bin="/fake/docker")

    _, wrong_uv = _fake_docker(uv_version="uv 0.12.6\n")
    with pytest.raises(module.PreflightError, match=r"uv 0\.12\.7"):
        module.preflight(environment, run=wrong_uv, docker_bin="/fake/docker")


def test_compose_wrapper_context_guard_covers_root_inputs_and_subtrees(tmp_path: Path) -> None:
    module = _wrapper_module()
    assert "AGENTS.md" not in module._CONTEXT_FILES
    assert "PAPERPILOT_PROFILE.md" not in module._CONTEXT_FILES
    for relative_file in module._CONTEXT_FILES:
        target = tmp_path / relative_file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("fixture\n", encoding="utf-8")
    for relative_root in module._CONTEXT_ROOTS:
        (tmp_path / relative_root).mkdir(parents=True, exist_ok=True)
    module._validate_context(tmp_path)

    lock = tmp_path / "uv.lock"
    lock.unlink()
    lock.symlink_to(tmp_path / "pyproject.toml")
    with pytest.raises(module.PreflightError, match="regular file"):
        module._validate_context(tmp_path)

    lock.unlink()
    lock.write_text("fixture\n", encoding="utf-8")
    (tmp_path / "docs" / "escape").symlink_to(tmp_path / "README.md")
    with pytest.raises(module.PreflightError, match="special file"):
        module._validate_context(tmp_path)

    (tmp_path / "docs" / "escape").unlink()
    (tmp_path / "docs").rmdir()
    (tmp_path / "docs").symlink_to(tmp_path / "paperpilot", target_is_directory=True)
    with pytest.raises(module.PreflightError, match="regular directory"):
        module._validate_context(tmp_path)


def test_compose_wrapper_executes_only_no_pull_canonical_commands() -> None:
    module = _wrapper_module()
    environment = _approved_environment()
    _, run = _fake_docker()
    executed: list[tuple[list[str], dict[str, str]]] = []

    def execute(arguments: list[str], child_environment: dict[str, str]) -> int:
        executed.append((arguments, child_environment))
        return 0

    assert (
        module.main(
            ["build", "collector"],
            environment=environment,
            run=run,
            execute=execute,
            docker_bin="/fake/docker",
        )
        == 0
    )
    command, child_environment = executed.pop()
    assert command[:2] == ["/fake/docker", "compose"]
    assert "--pull=false" in command
    assert command[-2:] == ["--pull=false", "collector"]
    assert child_environment["PAPERPILOT_PLATFORM"] == "linux/arm64/v8"
    assert module._canonical_compose_arguments(
        [
            "run",
            "--rm",
            "--env",
            "PAPERPILOT_GITHUB_TOKEN",
            "collector",
            "--skip-llm",
        ]
    ) == [
        "run",
        "--rm",
        "--env",
        "PAPERPILOT_GITHUB_TOKEN",
        "collector",
        "--skip-llm",
    ]

    for forbidden in (["pull"], ["up", "--build"], ["build", "--pull"]):
        with pytest.raises(module.PreflightError):
            module.main(
                forbidden,
                environment=environment,
                run=run,
                execute=execute,
                docker_bin="/fake/docker",
            )


@pytest.mark.parametrize(
    "arguments",
    [
        ["run", "--volume", "/:/host", "collector"],
        ["run", "--privileged", "collector"],
        ["run", "--entrypoint", "/bin/sh", "collector"],
        ["run", "--user", "0", "collector"],
        ["run", "--env-file", "paperpilot/.env", "collector"],
        ["run", "--env", "LD_PRELOAD", "collector"],
        ["up", "collector"],
        ["up", "site-preview"],
        ["-f", "/tmp/evil.yml", "config"],
    ],
)
def test_compose_wrapper_rejects_runtime_policy_injection(arguments: list[str]) -> None:
    module = _wrapper_module()
    with pytest.raises(module.PreflightError):
        module._canonical_compose_arguments(arguments)


def test_canonical_wrapper_launcher_is_small_and_fixed() -> None:
    launcher = _text(WRAPPER)
    assert "paperpilot_compose.py" in launcher
    assert "exec" in launcher
    assert "docker compose" not in launcher

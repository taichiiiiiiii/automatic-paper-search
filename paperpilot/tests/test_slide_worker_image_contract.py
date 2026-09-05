from __future__ import annotations

import ast
import copy
import hashlib
import importlib.util
import json
import os
import re
import sys
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]
IMAGE_DIR = ROOT / "containers" / "paper-slide-worker"
DOCKERFILE = IMAGE_DIR / "Dockerfile"
README = IMAGE_DIR / "README.md"
VERIFIER = IMAGE_DIR / "verify_wheels.py"
INSPECTOR = IMAGE_DIR / "inspect_candidate.py"
BASE_INSPECTOR = IMAGE_DIR / "inspect_base.py"
DOCKERIGNORE = IMAGE_DIR / ".dockerignore"
ISOLATE = ROOT / "paperpilot" / "paper_slides" / "isolate.py"


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _local_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    original = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = original
    return module


def _verifier_module() -> ModuleType:
    return _local_module("paper_slide_verify_wheels", VERIFIER)


def _inspector_module() -> ModuleType:
    return _local_module("paper_slide_inspect_candidate", INSPECTOR)


def _base_inspector_module() -> ModuleType:
    return _local_module("paper_slide_inspect_base", BASE_INSPECTOR)


def test_base_has_no_mutable_default_and_both_stages_use_the_digest_argument() -> None:
    dockerfile = _text(DOCKERFILE)
    assert re.fullmatch(
        r"# syntax=docker/dockerfile:1\.7@sha256:[0-9a-f]{64}",
        dockerfile.splitlines()[0],
    )
    assert re.search(r"(?m)^ARG PYTHON_BASE$", dockerfile)
    assert dockerfile.count("FROM ${PYTHON_BASE}") == 2
    assert not re.search(r"(?mi)^\s*FROM\s+[^$\s]+:[^\s]+", dockerfile)
    assert "repository@sha256:<64 lowercase hex>" in dockerfile


@pytest.mark.parametrize(
    "reference",
    [
        "python:3.12",
        "python:3.12@sha256:" + "a" * 64,
        "registry.example/team/python:3.12@sha256:" + "a" * 64,
        "registry.example/team/python@sha256:" + "A" * 64,
        "https://registry.example/team/python@sha256:" + "a" * 64,
        "registry.example/team/python@sha256:short",
    ],
)
def test_verifier_rejects_mutable_or_noncanonical_base_references(reference: str) -> None:
    with pytest.raises(ValueError):
        _verifier_module()._validate_base_reference(reference)


def test_verifier_accepts_digest_only_repository_references() -> None:
    verifier = _verifier_module()
    verifier._validate_base_reference("registry.example:5000/team/python@sha256:" + "0" * 64)


@pytest.mark.parametrize(
    "reference",
    [
        "python@sha256:" + "a" * 64,
        "registry/team/python@sha256:" + "a" * 64,
        "registry.example:00080/team/python@sha256:" + "a" * 64,
        "registry..example/team/python@sha256:" + "a" * 64,
    ],
)
def test_verifier_rejects_ambiguous_or_noncanonical_registries(reference: str) -> None:
    with pytest.raises(ValueError):
        _verifier_module()._validate_base_reference(reference)


def test_wheel_inputs_are_exact_hash_checked_before_offline_install() -> None:
    dockerfile = _text(DOCKERFILE)
    verify_offset = dockerfile.index("paper-slide-verify-wheels.py")
    install_offset = dockerfile.index("python -m pip install")
    assert verify_offset < install_offset
    assert "source=wheelhouse,target=/wheelhouse,readonly" in dockerfile
    assert "--no-index --no-deps --no-cache-dir --no-compile" in dockerfile
    assert "--staging-directory /verified-wheelhouse" in dockerfile
    assert '"/verified-wheelhouse/${PAPERPILOT_WHEEL}"' in dockerfile
    assert '"/verified-wheelhouse/${PYPDF_WHEEL}"' in dockerfile
    for argument in (
        "PAPERPILOT_WHEEL",
        "PAPERPILOT_WHEEL_SHA256",
        "PYPDF_WHEEL",
        "PYPDF_WHEEL_SHA256",
    ):
        assert re.search(rf"(?m)^ARG {argument}$", dockerfile)


def test_every_run_has_an_instruction_level_network_none() -> None:
    logical_dockerfile = _text(DOCKERFILE).replace("\\\n", " ")
    run_instructions = re.findall(r"(?m)^RUN\s+.+$", logical_dockerfile)
    assert len(run_instructions) == 2
    assert all(instruction.startswith("RUN --network=none ") for instruction in run_instructions)


def test_verifier_checks_exact_names_and_sha256(tmp_path: Path) -> None:
    verifier = _verifier_module()
    contents = b"reviewed wheel bytes"
    filename = "paperpilot-0.1.0-py3-none-any.whl"
    wheel = tmp_path / filename
    wheel.write_bytes(contents)
    digest = hashlib.sha256(contents).hexdigest()
    assert (
        verifier._verified_wheel(
            tmp_path,
            filename,
            digest,
            verifier._PAPERPILOT_WHEEL,
        )
        == wheel
    )
    with pytest.raises(ValueError):
        verifier._verified_wheel(
            tmp_path,
            filename,
            "0" * 64,
            verifier._PAPERPILOT_WHEEL,
        )
    with pytest.raises(ValueError):
        verifier._verified_wheel(
            tmp_path,
            "../paperpilot-0.1.0-py3-none-any.whl",
            digest,
            verifier._PAPERPILOT_WHEEL,
        )


def test_verifier_uses_descriptor_relative_nofollow_opens(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    verifier = _verifier_module()
    source = _text(VERIFIER)
    filename = "paperpilot-0.1.0-py3-none-any.whl"
    contents = b"reviewed wheel bytes"
    (tmp_path / filename).write_bytes(contents)

    def forbidden_path_open(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("wheel verification must not reopen a pathname")

    monkeypatch.setattr(verifier.Path, "open", forbidden_path_open)
    assert (
        verifier._verified_wheel(
            tmp_path,
            filename,
            hashlib.sha256(contents).hexdigest(),
            verifier._PAPERPILOT_WHEEL,
        )
        == tmp_path / filename
    )
    assert "dir_fd=" in source
    assert '"O_NOFOLLOW"' in source
    assert source.count("os.fstat(") >= 2


@pytest.mark.parametrize(
    "filename,pattern_name",
    [
        ("paperpilot.whl", "_PAPERPILOT_WHEEL"),
        ("paperpilot-0.1.0-py2-none-any.whl", "_PAPERPILOT_WHEEL"),
        ("pypdf-7.0.0-py3-none-any.whl", "_PYPDF_WHEEL"),
        ("pypdf-6.16.2-cp312-cp312-manylinux.whl", "_PYPDF_WHEEL"),
    ],
)
def test_verifier_rejects_unapproved_wheel_names(
    tmp_path: Path, filename: str, pattern_name: str
) -> None:
    verifier = _verifier_module()
    wheel = tmp_path / filename
    wheel.write_bytes(b"wheel")
    with pytest.raises(ValueError):
        verifier._verified_wheel(
            tmp_path,
            filename,
            hashlib.sha256(b"wheel").hexdigest(),
            getattr(verifier, pattern_name),
        )


def _closed_wheelhouse(tmp_path: Path) -> tuple[str, str]:
    filenames = (
        "paperpilot-0.1.0-py3-none-any.whl",
        "pypdf-6.16.2-py3-none-any.whl",
    )
    for filename in filenames:
        (tmp_path / filename).write_bytes(b"wheel")
    return filenames


def test_verifier_requires_exactly_the_two_expected_wheelhouse_entries(tmp_path: Path) -> None:
    verifier = _verifier_module()
    filenames = _closed_wheelhouse(tmp_path)
    verifier._validate_closed_wheelhouse(tmp_path, filenames)
    (tmp_path / "unreviewed-1.0-py3-none-any.whl").write_bytes(b"extra")
    with pytest.raises(ValueError):
        verifier._validate_closed_wheelhouse(tmp_path, filenames)


@pytest.mark.parametrize("entry_kind", ["directory", "fifo", "symlink"])
def test_verifier_rejects_special_expected_wheelhouse_entries(
    tmp_path: Path, entry_kind: str
) -> None:
    verifier = _verifier_module()
    paperpilot_name = "paperpilot-0.1.0-py3-none-any.whl"
    pypdf_name = "pypdf-6.16.2-py3-none-any.whl"
    (tmp_path / paperpilot_name).write_bytes(b"wheel")
    second = tmp_path / pypdf_name
    if entry_kind == "directory":
        second.mkdir()
    elif entry_kind == "fifo":
        os.mkfifo(second)
    else:
        second.symlink_to(tmp_path / paperpilot_name)
    with pytest.raises(ValueError):
        verifier._validate_closed_wheelhouse(tmp_path, (paperpilot_name, pypdf_name))


def test_no_network_package_manager_or_repository_copy_is_permitted() -> None:
    dockerfile = _text(DOCKERFILE)
    assert not re.search(
        r"(?i)(?:^|[\s;&|])(?:apt(?:-get)?|apk|curl|dnf|microdnf|wget|yum)(?:[\s;&|]|$)",
        dockerfile,
    )
    assert "git clone" not in dockerfile.lower()
    assert dockerfile.count("python -m pip install") == 1
    assert "COPY ." not in dockerfile
    assert "COPY paperpilot" not in dockerfile
    assert "COPY docs" not in dockerfile
    copy_lines = [line.strip() for line in dockerfile.splitlines() if line.startswith("COPY ")]
    assert copy_lines == [
        "COPY verify_wheels.py /usr/local/libexec/paper-slide-verify-wheels.py",
        "COPY --from=build --chown=65532:65532 /opt/paper-slide-worker /opt/paper-slide-worker",
    ]


def test_final_image_is_non_root_fixed_entrypoint_and_has_no_storage_contract() -> None:
    dockerfile = _text(DOCKERFILE)
    assert "WORKDIR /tmp" in dockerfile
    assert re.findall(r"(?m)^USER\s+(.+)$", dockerfile) == ["65532:65532"]
    assert (
        'ENTRYPOINT ["/opt/paper-slide-worker/bin/python", "-I", "-m", '
        '"paperpilot.paper_slides.extract_worker"]' in dockerfile
    )
    assert 'io.paperpilot.worker.contract="paper-slide-worker-v1"' in dockerfile
    assert 'io.paperpilot.worker.module="paperpilot.paper_slides.extract_worker"' in dockerfile
    assert not re.search(r"(?mi)^\s*(?:ADD|VOLUME)\b", dockerfile)
    assert "PYTHONDONTWRITEBYTECODE=1" in dockerfile
    assert "PYTHONHASHSEED=0" in dockerfile
    assert "PYTHONPATH" not in dockerfile


def test_final_import_and_packaging_verification_runs_as_the_runtime_uid() -> None:
    dockerfile = _text(DOCKERFILE)
    user_offset = dockerfile.index("USER 65532:65532")
    final_run_offset = dockerfile.rindex("RUN --network=none")
    entrypoint_offset = dockerfile.index("ENTRYPOINT")
    assert user_offset < final_run_offset < entrypoint_offset
    final_run = dockerfile[final_run_offset:entrypoint_offset]
    assert "import pypdf" in final_run
    assert "extract_worker" in final_run
    assert 'find_spec("pip") is None' in final_run


def test_fixed_entrypoint_matches_the_isolation_runtime_api() -> None:
    dockerfile = _text(DOCKERFILE)
    match = re.search(r"(?m)^ENTRYPOINT (\[.+\])$", dockerfile)
    assert match is not None
    entrypoint = json.loads(match.group(1))
    tree = ast.parse(_text(ISOLATE))
    container_python = None
    for node in tree.body:
        if (
            isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id == "CONTAINER_PYTHON"
                for target in node.targets
            )
            and isinstance(node.value, ast.Constant)
        ):
            container_python = node.value.value
    assert container_python == "/opt/paper-slide-worker/bin/python"
    assert entrypoint == [
        container_python,
        "-I",
        "-m",
        "paperpilot.paper_slides.extract_worker",
    ]


def test_build_arguments_are_not_secret_shaped() -> None:
    dockerfile = _text(DOCKERFILE)
    arguments = re.findall(r"(?m)^ARG\s+([A-Z0-9_]+)(?:=.*)?$", dockerfile)
    assert arguments
    assert not any(
        marker in argument
        for argument in arguments
        for marker in ("CREDENTIAL", "PASSWORD", "SECRET", "TOKEN", "PRIVATE_KEY")
    )


def test_readme_keeps_build_and_runtime_security_gates_explicit() -> None:
    readme = _text(README)
    for required in (
        "docker build --pull=false --network=none",
        "cannot validate `PYTHON_BASE` before",
        "air-gapped",
        "Config.Volumes",
        "65532:65532",
        "pypdf reports major version 6",
        "sitecustomize",
        "--network=none --ipc=none --read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "digest allowlisting",
        "external gates",
        "--pids-limit=32",
        "size=64m",
        "inherited `Config.Env`",
        "inspect_candidate.py",
        "inspect_base.py",
        "original, unfiltered",
        "Pre-build base-image preflight",
        "Post-build candidate inspection",
        "Filesystem and provenance gates",
        "cannot detect `ONBUILD` instructions that were already consumed",
        "base runtime filesystem is pip-free",
        "not verified locally",
        "--expected-environment-sha256",
        "--expected-labels-sha256",
        "--expected-platform linux/arm64/v8",
        "candidate inspect JSON cannot reveal",
        "consumed `ONBUILD`",
    ):
        assert required in readme
    assert "--platform=linux/arm64/v8" in readme
    assert "linux/amd64" not in readme


def test_dockerignore_is_a_minimal_build_context_allowlist() -> None:
    assert _text(DOCKERIGNORE).splitlines() == [
        "**",
        "!Dockerfile",
        "!verify_wheels.py",
        "!wheelhouse/",
        "!wheelhouse/*.whl",
    ]
    assert "!inspect_candidate.py" not in _text(DOCKERIGNORE)
    assert "!README.md" not in _text(DOCKERIGNORE)


def _candidate_inspect_fixture(
    inspector: ModuleType,
) -> tuple[list[dict[str, object]], dict[str, str]]:
    digest = "a" * 64
    base_digest = "b" * 64
    environment = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "PIP_NO_INDEX": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONHASHSEED": "0",
        "PYTHONUNBUFFERED": "1",
    }
    expected = {
        "image": f"registry.example/paper-slide-worker@sha256:{digest}",
        "base": f"registry.example/python@sha256:{base_digest}",
        "environment_sha256": inspector._environment_sha256(environment),
    }
    labels = {
        "io.paperpilot.worker.base": expected["base"],
        "io.paperpilot.worker.contract": "paper-slide-worker-v1",
        "io.paperpilot.worker.module": "paperpilot.paper_slides.extract_worker",
        "org.opencontainers.image.description": (
            "Credential-free isolated parser for the paper-slide-worker-v1 contract"
        ),
        "org.opencontainers.image.source": (
            "https://github.com/taichiiiiiiii/automatic-paper-search"
        ),
        "org.opencontainers.image.title": "PaperPilot PDF extraction worker",
    }
    expected["labels_sha256"] = inspector._labels_sha256(labels)
    document: list[dict[str, object]] = [
        {
            "Architecture": "arm64",
            "Os": "linux",
            "Variant": "v8",
            "RepoDigests": [expected["image"]],
            "Config": {
                "Cmd": None,
                "Entrypoint": [
                    "/opt/paper-slide-worker/bin/python",
                    "-I",
                    "-m",
                    "paperpilot.paper_slides.extract_worker",
                ],
                "Env": [f"{key}={value}" for key, value in environment.items()],
                "Labels": labels,
                "User": "65532:65532",
                "Volumes": None,
                "WorkingDir": "/tmp",
                "Healthcheck": None,
                "OnBuild": None,
            },
        }
    ]
    return document, expected


def _validate_candidate(inspector: ModuleType, document: object, expected: dict[str, str]) -> None:
    inspector.validate_candidate_inspect(
        document,
        expected_image=expected["image"],
        expected_base=expected["base"],
        expected_platform="linux/arm64/v8",
        expected_environment_sha256=expected["environment_sha256"],
        expected_labels_sha256=expected["labels_sha256"],
    )


def test_offline_candidate_inspector_accepts_only_the_expected_closed_security_fields() -> None:
    inspector = _inspector_module()
    document, expected = _candidate_inspect_fixture(inspector)
    _validate_candidate(inspector, document, expected)


@pytest.mark.parametrize(
    "mutation",
    [
        "root_user",
        "volume",
        "entrypoint",
        "command",
        "workdir",
        "worker_label",
        "base_label",
        "extra_label",
        "secret_label",
        "proxy_environment",
        "environment_drift",
        "healthcheck",
        "onbuild",
        "platform",
        "platform_variant",
        "repo_digest",
    ],
)
def test_offline_candidate_inspector_rejects_security_regressions(mutation: str) -> None:
    inspector = _inspector_module()
    original, expected = _candidate_inspect_fixture(inspector)
    document = copy.deepcopy(original)
    image = document[0]
    config = image["Config"]
    assert isinstance(config, dict)
    labels = config["Labels"]
    assert isinstance(labels, dict)
    environment = config["Env"]
    assert isinstance(environment, list)
    if mutation == "root_user":
        config["User"] = "0:0"
    elif mutation == "volume":
        config["Volumes"] = {"/data": {}}
    elif mutation == "entrypoint":
        config["Entrypoint"] = ["python"]
    elif mutation == "command":
        config["Cmd"] = ["sh"]
    elif mutation == "workdir":
        config["WorkingDir"] = "/app"
    elif mutation == "worker_label":
        labels["io.paperpilot.worker.contract"] = "unknown"
    elif mutation == "base_label":
        labels["io.paperpilot.worker.base"] = "python@sha256:" + "c" * 64
    elif mutation == "extra_label":
        labels["org.example.unreviewed"] = "value"
    elif mutation == "secret_label":
        labels["org.opencontainers.image.description"] = "contains TOKEN material"
    elif mutation == "proxy_environment":
        environment.append("HTTPS_PROXY=http://proxy.invalid")
    elif mutation == "environment_drift":
        environment.append("UNREVIEWED=value")
    elif mutation == "healthcheck":
        config["Healthcheck"] = {"Test": ["CMD", "sh"]}
    elif mutation == "onbuild":
        config["OnBuild"] = ["RUN sh"]
    elif mutation == "platform":
        image["Architecture"] = "amd64"
    elif mutation == "platform_variant":
        image["Variant"] = "v7"
    else:
        image["RepoDigests"] = ["registry.example/other@sha256:" + "d" * 64]
    with pytest.raises(inspector.CandidateInspectionError):
        _validate_candidate(inspector, document, expected)


def test_offline_candidate_inspector_rejects_duplicate_json_keys() -> None:
    inspector = _inspector_module()
    with pytest.raises(inspector.CandidateInspectionError):
        inspector._parse_inspect_bytes(b'[{"Config":{},"Config":{}}]')


@pytest.mark.parametrize(
    "payload",
    [
        b"[" + b"9" * 1024 + b"]",
        b"[1." + b"0" * 1024 + b"]",
        b"[1e" + b"9" * 1024 + b"]",
        b"[1e999]",
        b"[NaN]",
    ],
)
def test_inspect_json_rejects_unbounded_or_nonfinite_numeric_lexemes(payload: bytes) -> None:
    inspector = _inspector_module()
    with pytest.raises(inspector.CandidateInspectionError):
        inspector._parse_inspect_bytes(payload)


def test_candidate_json_is_opened_once_nofollow_and_read_with_a_hard_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    inspector = _inspector_module()
    document, expected = _candidate_inspect_fixture(inspector)
    inspect_path = tmp_path / "candidate.json"
    inspect_path.write_text(json.dumps(document), encoding="utf-8")

    def forbidden_read_bytes(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("candidate inspector must use its secured descriptor")

    monkeypatch.setattr(inspector.Path, "read_bytes", forbidden_read_bytes)
    payload = inspector._read_bounded_regular_file(inspect_path)
    _validate_candidate(inspector, inspector._parse_inspect_bytes(payload), expected)
    source = _text(INSPECTOR)
    assert "os.open(" in source
    assert '"O_NOFOLLOW"' in source
    assert "MAX_INSPECT_BYTES + 1" in source
    assert source.count("os.fstat(") >= 2


@pytest.mark.parametrize("entry_kind", ["symlink", "fifo"])
def test_candidate_json_secure_open_rejects_links_and_special_files_without_blocking(
    tmp_path: Path, entry_kind: str
) -> None:
    inspector = _inspector_module()
    target = tmp_path / "target.json"
    target.write_bytes(b"[]")
    candidate = tmp_path / "candidate.json"
    if entry_kind == "symlink":
        candidate.symlink_to(target)
    else:
        os.mkfifo(candidate)
    with pytest.raises(inspector.CandidateInspectionError):
        inspector._read_bounded_regular_file(candidate)


@pytest.mark.parametrize(
    "reference",
    [
        "python@sha256:" + "a" * 64,
        "registry/team/python@sha256:" + "a" * 64,
        "registry.example/team/python:tag@sha256:" + "a" * 64,
        "registry.example:00080/team/python@sha256:" + "a" * 64,
        "registry..example/team/python@sha256:" + "a" * 64,
        "registry.example/team//python@sha256:" + "a" * 64,
    ],
)
def test_candidate_inspector_rejects_noncanonical_digest_references(reference: str) -> None:
    inspector = _inspector_module()
    document, expected = _candidate_inspect_fixture(inspector)
    expected["image"] = reference
    with pytest.raises(inspector.CandidateInspectionError):
        _validate_candidate(inspector, document, expected)


def _base_inspect_fixture(
    inspector: ModuleType,
    *,
    platform: str = "linux/amd64",
) -> tuple[list[dict[str, object]], dict[str, str]]:
    reference = "registry.example/team/python@sha256:" + "c" * 64
    environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
    labels = {"org.opencontainers.image.title": "Approved Python runtime base"}
    architecture = "arm64" if platform == "linux/arm64/v8" else "amd64"
    variant = "v8" if architecture == "arm64" else ""
    expected = {
        "base": reference,
        "environment_sha256": inspector._string_map_sha256(environment),
        "labels_sha256": inspector._string_map_sha256(labels),
        "platform": platform,
    }
    return (
        [
            {
                "Architecture": architecture,
                "Os": "linux",
                "Variant": variant,
                "RepoDigests": [reference],
                "Config": {
                    "Cmd": None,
                    "Entrypoint": None,
                    "Env": [f"{key}={value}" for key, value in environment.items()],
                    "Healthcheck": None,
                    "Labels": labels,
                    "OnBuild": None,
                    "Shell": ["/bin/sh", "-c"],
                    "StopSignal": "",
                    "User": "",
                    "Volumes": None,
                    "WorkingDir": "",
                },
            }
        ],
        expected,
    )


def _validate_base(inspector: ModuleType, document: object, expected: dict[str, str]) -> None:
    inspector.validate_base_inspect(
        document,
        expected_base=expected["base"],
        expected_platform=expected["platform"],
        expected_environment_sha256=expected["environment_sha256"],
        expected_labels_sha256=expected["labels_sha256"],
    )


@pytest.mark.parametrize("platform", ["linux/amd64", "linux/arm64/v8"])
def test_distinct_prebuild_base_inspector_accepts_exact_approved_config(platform: str) -> None:
    inspector = _base_inspector_module()
    document, expected = _base_inspect_fixture(inspector, platform=platform)
    _validate_base(inspector, document, expected)


@pytest.mark.parametrize(
    "mutation",
    [
        "onbuild",
        "shell",
        "environment",
        "volume",
        "user",
        "entrypoint",
        "command",
        "healthcheck",
        "stop_signal",
        "label",
        "secret_label",
        "variant",
        "digest",
    ],
)
def test_prebuild_base_inspector_rejects_unapproved_config(mutation: str) -> None:
    inspector = _base_inspector_module()
    original, expected = _base_inspect_fixture(inspector, platform="linux/arm64/v8")
    document = copy.deepcopy(original)
    image = document[0]
    config = image["Config"]
    assert isinstance(config, dict)
    if mutation == "onbuild":
        config["OnBuild"] = ["RUN hidden-trigger"]
    elif mutation == "shell":
        config["Shell"] = ["/bin/bash", "-c"]
    elif mutation == "environment":
        config["Env"] = ["PATH=/bin", "TOKEN=secret"]
    elif mutation == "volume":
        config["Volumes"] = {"/data": {}}
    elif mutation == "user":
        config["User"] = "1000:1000"
    elif mutation == "entrypoint":
        config["Entrypoint"] = ["python"]
    elif mutation == "command":
        config["Cmd"] = ["python"]
    elif mutation == "healthcheck":
        config["Healthcheck"] = {"Test": ["CMD", "true"]}
    elif mutation == "stop_signal":
        config["StopSignal"] = "SIGKILL"
    elif mutation == "label":
        labels = config["Labels"]
        assert isinstance(labels, dict)
        labels["org.example.extra"] = "value"
    elif mutation == "secret_label":
        config["Labels"] = {"org.example.token": "secret"}
    elif mutation == "variant":
        image["Variant"] = "v7"
    else:
        image["RepoDigests"] = ["registry.example/team/python@sha256:" + "d" * 64]
    with pytest.raises(inspector.BaseInspectionError):
        _validate_base(inspector, document, expected)


@pytest.mark.parametrize(
    "payload",
    [
        b"[" + b"9" * 1024 + b"]",
        b"[1." + b"0" * 1024 + b"]",
        b"[1e" + b"9" * 1024 + b"]",
        b"[1e999]",
        b"[NaN]",
    ],
)
def test_base_inspect_json_rejects_unbounded_or_nonfinite_numeric_lexemes(
    payload: bytes,
) -> None:
    inspector = _base_inspector_module()
    with pytest.raises(inspector.BaseInspectionError):
        inspector._parse_inspect_bytes(payload)


def test_base_json_is_opened_once_nofollow_and_read_with_a_hard_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    inspector = _base_inspector_module()
    document, expected = _base_inspect_fixture(inspector, platform="linux/arm64/v8")
    inspect_path = tmp_path / "base.json"
    inspect_path.write_text(json.dumps(document), encoding="utf-8")

    def forbidden_read_bytes(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("base inspector must use its secured descriptor")

    monkeypatch.setattr(inspector.Path, "read_bytes", forbidden_read_bytes)
    payload = inspector._read_bounded_regular_file(inspect_path)
    _validate_base(inspector, inspector._parse_inspect_bytes(payload), expected)
    source = _text(BASE_INSPECTOR)
    assert "os.open(" in source
    assert '"O_NOFOLLOW"' in source
    assert "MAX_INSPECT_BYTES + 1" in source
    assert source.count("os.fstat(") >= 2


def test_base_json_bounded_read_rejects_oversized_regular_file(tmp_path: Path) -> None:
    inspector = _base_inspector_module()
    inspect_path = tmp_path / "base.json"
    inspect_path.write_bytes(b" " * (inspector.MAX_INSPECT_BYTES + 1))
    with pytest.raises(inspector.BaseInspectionError):
        inspector._read_bounded_regular_file(inspect_path)


@pytest.mark.parametrize("entry_kind", ["symlink", "fifo"])
def test_base_json_secure_open_rejects_links_and_special_files_without_blocking(
    tmp_path: Path, entry_kind: str
) -> None:
    inspector = _base_inspector_module()
    target = tmp_path / "target.json"
    target.write_bytes(b"[]")
    candidate = tmp_path / "base.json"
    if entry_kind == "symlink":
        candidate.symlink_to(target)
    else:
        os.mkfifo(candidate)
    with pytest.raises(inspector.BaseInspectionError):
        inspector._read_bounded_regular_file(candidate)

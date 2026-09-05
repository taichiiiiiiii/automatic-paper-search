#!/usr/bin/env python3
"""Fail-closed, offline preflight for PaperPilot's canonical Compose entrypoint."""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import NamedTuple

ROOT = Path(__file__).resolve().parent.parent
COMPOSE_FILE = ROOT / "docker-compose.yml"

APPROVED_REPOSITORIES = {
    "PAPERPILOT_PYTHON_BASE": "docker.io/library/python",
    "PAPERPILOT_UV_BASE": "ghcr.io/astral-sh/uv",
    "PAPERPILOT_NODE_BASE": "docker.io/library/node",
}
APPROVED_UV_VERSION = "0.12.7"
APPROVED_PLATFORMS = {
    "linux/amd64": ("amd64", ""),
    "linux/arm64/v8": ("arm64", "v8"),
}
FRONTEND_REF = (
    "docker.io/docker/dockerfile:1.7@sha256:"
    "a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e"
)
_REF_RE = re.compile(r"^(?P<repository>[a-z0-9][a-z0-9._/-]*)@sha256:(?P<digest>[0-9a-f]{64})$")
_CONTEXT_ROOTS = (
    ".github",
    "containers",
    "docs",
    "docker",
    "paperpilot",
    "schemas",
    "scripts",
    "worker",
)
_CONTEXT_FILES = (
    ".dockerignore",
    ".lighthouserc.json",
    "CLAUDE.md",
    "Dockerfile",
    "README.md",
    "docker-compose.yml",
    "pyproject.toml",
    "uv.lock",
    "wrangler.jsonc",
)
_SENSITIVE_SUFFIXES = (".key", ".p12", ".pem", ".pfx", ".tar", ".tar.gz", ".tgz", ".whl", ".zip")

Run = Callable[[list[str]], subprocess.CompletedProcess[str]]
Execute = Callable[[list[str], dict[str, str]], int]


class PreflightError(RuntimeError):
    """A stable, non-secret preflight rejection."""


class PreflightResult(NamedTuple):
    platform: str
    python_ref: str
    uv_ref: str
    node_ref: str


def _default_run(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )


def _default_execute(arguments: list[str], environment: dict[str, str]) -> int:
    os.execvpe(arguments[0], arguments, environment)
    raise AssertionError("execvpe returned unexpectedly")


def _docker_binary() -> str:
    candidate = shutil.which("docker")
    if candidate is None:
        raise PreflightError("docker CLI is not installed")
    return str(Path(candidate).resolve())


def _validate_ref(variable: str, value: str | None) -> str:
    expected_repository = APPROVED_REPOSITORIES[variable]
    match = _REF_RE.fullmatch(value or "")
    if match is None or match.group("repository") != expected_repository:
        raise PreflightError(f"{variable} must be {expected_repository}@sha256:<64 lowercase hex>")
    return value or ""


def _validate_context(root: Path = ROOT) -> None:
    for relative_file in _CONTEXT_FILES:
        path = root / relative_file
        try:
            metadata = path.lstat()
        except FileNotFoundError as error:
            raise PreflightError(
                f"required build-context file is missing: {relative_file}"
            ) from error
        if not stat.S_ISREG(metadata.st_mode):
            raise PreflightError("required build-context input is not a regular file")
    for relative_root in _CONTEXT_ROOTS:
        directory = root / relative_root
        try:
            metadata = directory.lstat()
        except FileNotFoundError as error:
            raise PreflightError(
                f"required build-context directory is missing: {relative_root}"
            ) from error
        if not stat.S_ISDIR(metadata.st_mode):
            raise PreflightError(
                f"required build-context directory is not a regular directory: {relative_root}"
            )
        for path in directory.rglob("*"):
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not (
                stat.S_ISREG(metadata.st_mode) or stat.S_ISDIR(metadata.st_mode)
            ):
                raise PreflightError("build context contains a link or special file")
            lowered = path.name.lower()
            if (
                "credential" in lowered
                or "secret" in lowered
                or lowered.endswith(_SENSITIVE_SUFFIXES)
            ):
                raise PreflightError("build context contains a denied sensitive or archive path")


def _digest_only_reference(reference: str) -> str:
    repository_with_tag, digest = reference.split("@", 1)
    final_component = repository_with_tag.rsplit("/", 1)[-1]
    if ":" in final_component:
        repository_with_tag = repository_with_tag.rsplit(":", 1)[0]
    return f"{repository_with_tag}@{digest}"


def _inspect_local_image(
    reference: str,
    *,
    platform: str,
    run: Run,
    docker_bin: str,
) -> None:
    completed = run([docker_bin, "image", "inspect", reference])
    if completed.returncode != 0:
        raise PreflightError(f"approved image is not locally present: {reference.split('@')[0]}")
    try:
        payload = json.loads(completed.stdout)
        image = payload[0]
        repo_digests = image["RepoDigests"]
        os_name = image["Os"]
        architecture = image["Architecture"]
        variant = image.get("Variant", "")
    except (IndexError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise PreflightError("docker image inspect returned an invalid document") from error

    expected_digest = _digest_only_reference(reference)
    if expected_digest not in repo_digests:
        raise PreflightError("local image does not attest the requested repository digest")
    expected_architecture, expected_variant = APPROVED_PLATFORMS[platform]
    variant_matches = expected_variant == "" or variant in ("", expected_variant)
    if os_name != "linux" or architecture != expected_architecture or not variant_matches:
        raise PreflightError(f"local image platform does not match {platform}")


def _offline_probe(
    reference: str,
    entrypoint: str,
    arguments: Sequence[str],
    *,
    run: Run,
    docker_bin: str,
) -> str:
    command = [
        docker_bin,
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges=true",
        "--entrypoint",
        entrypoint,
        reference,
        *arguments,
    ]
    completed = run(command)
    if completed.returncode != 0:
        raise PreflightError(f"offline base probe failed: {entrypoint}")
    return (completed.stdout + completed.stderr).strip()


def preflight(
    environment: Mapping[str, str],
    *,
    run: Run = _default_run,
    docker_bin: str | None = None,
) -> PreflightResult:
    platform = environment.get("PAPERPILOT_PLATFORM", "")
    if platform not in APPROVED_PLATFORMS:
        raise PreflightError("PAPERPILOT_PLATFORM must be exactly linux/amd64 or linux/arm64/v8")

    python_ref = _validate_ref("PAPERPILOT_PYTHON_BASE", environment.get("PAPERPILOT_PYTHON_BASE"))
    uv_ref = _validate_ref("PAPERPILOT_UV_BASE", environment.get("PAPERPILOT_UV_BASE"))
    node_ref = _validate_ref("PAPERPILOT_NODE_BASE", environment.get("PAPERPILOT_NODE_BASE"))
    _validate_context()
    resolved_docker = docker_bin or _docker_binary()

    for reference in (FRONTEND_REF, python_ref, uv_ref, node_ref):
        _inspect_local_image(
            reference,
            platform=platform,
            run=run,
            docker_bin=resolved_docker,
        )

    python_output = _offline_probe(
        python_ref,
        "python",
        ("--version",),
        run=run,
        docker_bin=resolved_docker,
    )
    if re.fullmatch(r"Python 3\.12(?:\.[0-9]+)?", python_output) is None:
        raise PreflightError("Python 3.12 base is required")
    _offline_probe(
        python_ref,
        "/bin/sh",
        ("-c", "test -x /usr/bin/apt-get && test -f /etc/debian_version"),
        run=run,
        docker_bin=resolved_docker,
    )

    node_output = _offline_probe(
        node_ref,
        "node",
        ("--version",),
        run=run,
        docker_bin=resolved_docker,
    )
    if re.fullmatch(r"v20\.[0-9]+\.[0-9]+", node_output) is None:
        raise PreflightError("Node 20 base is required")

    uv_output = _offline_probe(
        uv_ref,
        "/uv",
        ("--version",),
        run=run,
        docker_bin=resolved_docker,
    )
    if re.match(rf"^uv {re.escape(APPROVED_UV_VERSION)}(?:\s|$)", uv_output) is None:
        raise PreflightError(f"uv {APPROVED_UV_VERSION} base is required")

    return PreflightResult(platform, python_ref, uv_ref, node_ref)


_SERVICES = {"collector", "node-test", "ops", "site-preview", "test"}
_RUN_SERVICES = {"collector", "node-test", "ops", "test"}
_RUNTIME_ENVIRONMENT = {
    "PAPERPILOT_CLAUDE_API_KEY",
    "PAPERPILOT_EMAIL_TO",
    "PAPERPILOT_GEMINI_API_KEY",
    "PAPERPILOT_GITHUB_TOKEN",
    "PAPERPILOT_GROQ_API_KEY",
    "PAPERPILOT_OPENALEX_EMAIL",
    "PAPERPILOT_S2_API_KEY",
    "PAPERPILOT_SLACK_WEBHOOK_URL",
    "PAPERPILOT_SMTP_PASSWORD",
    "PAPERPILOT_SMTP_PORT",
    "PAPERPILOT_SMTP_SERVER",
    "PAPERPILOT_SMTP_USE_TLS",
    "PAPERPILOT_SMTP_USER",
}


def _canonical_compose_arguments(arguments: Sequence[str]) -> list[str]:
    if not arguments:
        raise PreflightError("a Compose command is required")
    remaining = list(arguments)
    prefix: list[str] = []
    if remaining[:1] == ["--profile"]:
        if len(remaining) < 3 or remaining[1] not in {"ops", "preview", "test"}:
            raise PreflightError("only the ops, preview, and test profiles are supported")
        prefix = remaining[:2]
        remaining = remaining[2:]

    command = remaining.pop(0)
    if command == "build":
        if not remaining or any(value not in _SERVICES for value in remaining):
            raise PreflightError("build accepts only explicit PaperPilot service names")
        return [*prefix, "build", "--pull=false", *remaining]

    if command == "config":
        if any(value != "--quiet" for value in remaining) or len(remaining) > 1:
            raise PreflightError("config accepts only --quiet")
        return [*prefix, "config", *remaining]

    if command == "up":
        if remaining != ["--no-build", "site-preview"]:
            raise PreflightError("up is restricted to the prebuilt site-preview service")
        return [*prefix, "up", *remaining]

    if command == "run":
        output = [*prefix, "run"]
        while remaining and remaining[0].startswith("-"):
            option = remaining.pop(0)
            if option in {"--rm", "--no-deps"}:
                output.append(option)
                continue
            if option == "--env" and remaining and remaining[0] in _RUNTIME_ENVIRONMENT:
                output.extend((option, remaining.pop(0)))
                continue
            raise PreflightError("run option is outside the closed PaperPilot allowlist")
        if not remaining or remaining[0] not in _RUN_SERVICES:
            raise PreflightError(
                "run requires an explicit collector, ops, test, or node-test service"
            )
        output.extend(remaining)
        return output

    raise PreflightError("only build, config, run, and preview up are canonical")


def main(
    arguments: Sequence[str] | None = None,
    *,
    environment: Mapping[str, str] | None = None,
    run: Run = _default_run,
    execute: Execute = _default_execute,
    docker_bin: str | None = None,
) -> int:
    argv = list(sys.argv[1:] if arguments is None else arguments)
    child_environment = dict(os.environ if environment is None else environment)
    compose_arguments = _canonical_compose_arguments(argv)
    resolved_docker = docker_bin or _docker_binary()
    preflight(child_environment, run=run, docker_bin=resolved_docker)
    command = [
        resolved_docker,
        "compose",
        "--project-directory",
        str(ROOT),
        "--file",
        str(COMPOSE_FILE),
        *compose_arguments,
    ]
    return execute(command, child_environment)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (PreflightError, subprocess.TimeoutExpired) as error:
        print(f"paperpilot-compose: {error}", file=sys.stderr)
        raise SystemExit(2) from None

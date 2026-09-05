"""Validate security-relevant fields from read-only ``docker image inspect`` JSON.

This helper never invokes a container runtime. A trusted release job supplies a
bounded inspect document and independently approved expected values.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import math
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any

MAX_INSPECT_BYTES = 1024 * 1024
MAX_NUMERIC_LEXEME_BYTES = 128
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_REGISTRY = re.compile(
    r"(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+"
    r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?\Z"
)
_REPOSITORY_COMPONENT = re.compile(r"[a-z0-9]+(?:[._-][a-z0-9]+)*\Z")
_ENVIRONMENT_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
_EXPECTED_ENTRYPOINT = (
    "/opt/paper-slide-worker/bin/python",
    "-I",
    "-m",
    "paperpilot.paper_slides.extract_worker",
)
_REQUIRED_ENVIRONMENT = {
    "PIP_DISABLE_PIP_VERSION_CHECK": "1",
    "PIP_NO_INDEX": "1",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONHASHSEED": "0",
    "PYTHONUNBUFFERED": "1",
}
_DENIED_ENVIRONMENT_MARKERS = (
    "API_KEY",
    "AWS_",
    "AZURE_",
    "BASH_ENV",
    "CREDENTIAL",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "NETRC",
    "PASSWORD",
    "PRIVATE_KEY",
    "PROXY",
    "PYTHONHOME",
    "PYTHONPATH",
    "SECRET",
    "TOKEN",
)
_REQUIRED_LABELS = {
    "io.paperpilot.worker.contract": "paper-slide-worker-v1",
    "io.paperpilot.worker.module": "paperpilot.paper_slides.extract_worker",
}
_FIXED_OCI_LABELS = {
    "org.opencontainers.image.description": (
        "Credential-free isolated parser for the paper-slide-worker-v1 contract"
    ),
    "org.opencontainers.image.source": ("https://github.com/taichiiiiiiii/automatic-paper-search"),
    "org.opencontainers.image.title": "PaperPilot PDF extraction worker",
}
_ALLOWED_LABEL_NAMES = frozenset(
    (*_REQUIRED_LABELS, *_FIXED_OCI_LABELS, "io.paperpilot.worker.base")
)


class CandidateInspectionError(ValueError):
    """Stable, value-free candidate rejection."""

    def __init__(self) -> None:
        super().__init__("candidate image inspection failed")


def _reject() -> CandidateInspectionError:
    return CandidateInspectionError()


def _closed_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _reject()
        result[key] = value
    return result


def _validate_image_reference(value: object) -> str:
    """Return one canonical, explicitly hosted OCI repository digest reference."""

    if not isinstance(value, str) or len(value) > 512 or value.count("@") != 1:
        raise _reject()
    repository, digest = value.split("@", 1)
    if not digest.startswith("sha256:") or _SHA256.fullmatch(digest[7:]) is None:
        raise _reject()
    components = repository.split("/")
    if len(components) < 2 or any(not component for component in components):
        raise _reject()
    registry_match = _REGISTRY.fullmatch(components[0])
    if registry_match is None:
        raise _reject()
    port = registry_match.group(1)
    if port is not None and int(port) > 65535:
        raise _reject()
    if any(_REPOSITORY_COMPONENT.fullmatch(component) is None for component in components[1:]):
        raise _reject()
    return value


def _bounded_int(lexeme: str) -> int:
    if len(lexeme) > MAX_NUMERIC_LEXEME_BYTES:
        raise _reject()
    return int(lexeme)


def _bounded_float(lexeme: str) -> float:
    if len(lexeme) > MAX_NUMERIC_LEXEME_BYTES:
        raise _reject()
    value = float(lexeme)
    if not math.isfinite(value):
        raise _reject()
    return value


def _bounded_shape(value: object, *, depth: int = 0, containers: list[int] | None = None) -> None:
    if depth > 16:
        raise _reject()
    if containers is None:
        containers = [0]
    if isinstance(value, dict):
        containers[0] += 1
        if containers[0] > 1024 or len(value) > 256:
            raise _reject()
        for key, item in value.items():
            if not isinstance(key, str) or len(key) > 256:
                raise _reject()
            _bounded_shape(item, depth=depth + 1, containers=containers)
    elif isinstance(value, list):
        containers[0] += 1
        if containers[0] > 1024 or len(value) > 1024:
            raise _reject()
        for item in value:
            _bounded_shape(item, depth=depth + 1, containers=containers)
    elif isinstance(value, str):
        if len(value) > 16_384 or any(ord(character) < 0x20 for character in value):
            raise _reject()
    elif value is not None:
        if not isinstance(value, (bool, int, float)):
            raise _reject()
        if isinstance(value, float) and not math.isfinite(value):
            raise _reject()


def _parse_inspect_bytes(payload: bytes) -> object:
    if not 1 <= len(payload) <= MAX_INSPECT_BYTES:
        raise _reject()
    try:
        text = payload.decode("utf-8")
        value = json.loads(
            text,
            object_pairs_hook=_closed_json_object,
            parse_int=_bounded_int,
            parse_float=_bounded_float,
            parse_constant=lambda _value: (_ for _ in ()).throw(_reject()),
        )
    except CandidateInspectionError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError, TypeError):
        raise _reject() from None
    _bounded_shape(value)
    return value


def _read_bounded_regular_file(path: Path) -> bytes:
    """Read one stable regular file without following its final path component."""

    nofollow = getattr(os, "O_NOFOLLOW", 0)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
    if nofollow:
        flags |= nofollow
    try:
        before_path = os.lstat(path)
        if not stat.S_ISREG(before_path.st_mode):
            raise _reject()
        descriptor = os.open(path, flags)
    except CandidateInspectionError:
        raise
    except OSError:
        raise _reject() from None
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or not 1 <= before.st_size <= MAX_INSPECT_BYTES
            or (before.st_dev, before.st_ino) != (before_path.st_dev, before_path.st_ino)
        ):
            raise _reject()
        chunks: list[bytes] = []
        remaining = MAX_INSPECT_BYTES + 1
        while remaining:
            block = os.read(descriptor, min(64 * 1024, remaining))
            if not block:
                break
            chunks.append(block)
            remaining -= len(block)
        payload = b"".join(chunks)
        after = os.fstat(descriptor)
        stable_before = (
            before.st_dev,
            before.st_ino,
            before.st_mode,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
        stable_after = (
            after.st_dev,
            after.st_ino,
            after.st_mode,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        )
        if stable_before != stable_after or len(payload) != before.st_size:
            raise _reject()
        return payload
    except CandidateInspectionError:
        raise
    except OSError:
        raise _reject() from None
    finally:
        os.close(descriptor)


def _environment(config: dict[str, object]) -> dict[str, str]:
    raw_environment = config.get("Env")
    if not isinstance(raw_environment, list) or not raw_environment:
        raise _reject()
    environment: dict[str, str] = {}
    for entry in raw_environment:
        if not isinstance(entry, str) or "=" not in entry:
            raise _reject()
        name, value = entry.split("=", 1)
        upper_name = name.upper()
        if (
            _ENVIRONMENT_NAME.fullmatch(name) is None
            or name in environment
            or any(marker in upper_name for marker in _DENIED_ENVIRONMENT_MARKERS)
            or len(value) > 4096
            or any(ord(character) < 0x20 for character in value)
        ):
            raise _reject()
        environment[name] = value
    if any(environment.get(name) != expected for name, expected in _REQUIRED_ENVIRONMENT.items()):
        raise _reject()
    return environment


def _environment_sha256(environment: dict[str, str]) -> str:
    encoded = json.dumps(
        environment,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")
    return hashlib.sha256(encoded).hexdigest()


def _labels_sha256(labels: dict[str, str]) -> str:
    return _environment_sha256(labels)


def _validate_platform(image: dict[str, object], expected_platform: str) -> None:
    expected = {
        "linux/amd64": ("amd64", ""),
        "linux/arm64/v8": ("arm64", "v8"),
    }.get(expected_platform)
    if expected is None:
        raise _reject()
    actual_variant = image.get("Variant", "")
    if (
        image.get("Os") != "linux"
        or image.get("Architecture") != expected[0]
        or actual_variant != expected[1]
    ):
        raise _reject()


def validate_candidate_inspect(
    document: object,
    *,
    expected_image: str,
    expected_base: str,
    expected_platform: str,
    expected_environment_sha256: str,
    expected_labels_sha256: str,
) -> None:
    """Validate the exact candidate configuration selected by release policy."""

    if (
        _SHA256.fullmatch(expected_environment_sha256) is None
        or _SHA256.fullmatch(expected_labels_sha256) is None
        or not isinstance(document, list)
        or len(document) != 1
        or not isinstance(document[0], dict)
    ):
        raise _reject()
    _validate_image_reference(expected_image)
    _validate_image_reference(expected_base)
    image = document[0]
    _validate_platform(image, expected_platform)
    repo_digests = image.get("RepoDigests")
    if not isinstance(repo_digests, list) or repo_digests != [expected_image]:
        raise _reject()
    config = image.get("Config")
    if not isinstance(config, dict):
        raise _reject()
    if (
        config.get("User") != "65532:65532"
        or config.get("WorkingDir") != "/tmp"
        or config.get("Volumes") not in (None, {})
        or config.get("Cmd") not in (None, [])
        or config.get("Entrypoint") != list(_EXPECTED_ENTRYPOINT)
        or config.get("Healthcheck") not in (None, {})
        or config.get("OnBuild") not in (None, [])
        or config.get("Shell") not in (None, [])
        or config.get("StopSignal") not in (None, "")
    ):
        raise _reject()
    labels = config.get("Labels")
    if not isinstance(labels, dict) or any(
        not isinstance(key, str) or not isinstance(value, str) for key, value in labels.items()
    ):
        raise _reject()
    if (
        set(labels) != _ALLOWED_LABEL_NAMES
        or any(labels.get(key) != value for key, value in _REQUIRED_LABELS.items())
        or any(labels.get(key) != value for key, value in _FIXED_OCI_LABELS.items())
        or any(
            marker in f"{key}={value}".upper()
            for key, value in labels.items()
            if key not in _FIXED_OCI_LABELS
            for marker in _DENIED_ENVIRONMENT_MARKERS
        )
    ):
        raise _reject()
    if labels.get("io.paperpilot.worker.base") != expected_base:
        raise _reject()
    if not hmac.compare_digest(_labels_sha256(labels), expected_labels_sha256):
        raise _reject()
    environment = _environment(config)
    if not hmac.compare_digest(_environment_sha256(environment), expected_environment_sha256):
        raise _reject()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inspect-json", required=True, type=Path)
    parser.add_argument("--expected-image", required=True)
    parser.add_argument("--expected-base", required=True)
    parser.add_argument(
        "--expected-platform", required=True, choices=("linux/amd64", "linux/arm64/v8")
    )
    parser.add_argument("--expected-environment-sha256", required=True)
    parser.add_argument("--expected-labels-sha256", required=True)
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    try:
        document = _parse_inspect_bytes(_read_bounded_regular_file(arguments.inspect_json))
        validate_candidate_inspect(
            document,
            expected_image=arguments.expected_image,
            expected_base=arguments.expected_base,
            expected_platform=arguments.expected_platform,
            expected_environment_sha256=arguments.expected_environment_sha256,
            expected_labels_sha256=arguments.expected_labels_sha256,
        )
    except CandidateInspectionError:
        print("candidate image inspection failed", file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError):
        print("candidate image inspection failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

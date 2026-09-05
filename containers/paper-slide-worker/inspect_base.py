"""Fail-closed pre-build validation for an approved local Python base image.

The helper consumes a bounded ``docker image inspect`` export. It does not
invoke Docker, pull an image, or claim to inspect the image filesystem.
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
_DENIED_MARKERS = (
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
_APPROVED_SHELL = ["/bin/sh", "-c"]


class BaseInspectionError(ValueError):
    """Stable, value-free base image rejection."""

    def __init__(self) -> None:
        super().__init__("base image inspection failed")


def _reject() -> BaseInspectionError:
    return BaseInspectionError()


def _closed_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _reject()
        result[key] = value
    return result


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
        value = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=_closed_json_object,
            parse_int=_bounded_int,
            parse_float=_bounded_float,
            parse_constant=lambda _value: (_ for _ in ()).throw(_reject()),
        )
    except BaseInspectionError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError, TypeError):
        raise _reject() from None
    _bounded_shape(value)
    return value


def _read_bounded_regular_file(path: Path) -> bytes:
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
    if nofollow:
        flags |= nofollow
    try:
        path_stat = os.lstat(path)
        if not stat.S_ISREG(path_stat.st_mode):
            raise _reject()
        descriptor = os.open(path, flags)
    except BaseInspectionError:
        raise
    except OSError:
        raise _reject() from None
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or not 1 <= before.st_size <= MAX_INSPECT_BYTES
            or (before.st_dev, before.st_ino) != (path_stat.st_dev, path_stat.st_ino)
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
        before_identity = (
            before.st_dev,
            before.st_ino,
            before.st_mode,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
        after_identity = (
            after.st_dev,
            after.st_ino,
            after.st_mode,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        )
        if before_identity != after_identity or len(payload) != before.st_size:
            raise _reject()
        return payload
    except BaseInspectionError:
        raise
    except OSError:
        raise _reject() from None
    finally:
        os.close(descriptor)


def _validate_image_reference(value: object) -> str:
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


def _closed_environment(config: dict[str, object]) -> dict[str, str]:
    raw = config.get("Env")
    if not isinstance(raw, list) or not raw:
        raise _reject()
    environment: dict[str, str] = {}
    for entry in raw:
        if not isinstance(entry, str) or "=" not in entry:
            raise _reject()
        name, value = entry.split("=", 1)
        if (
            _ENVIRONMENT_NAME.fullmatch(name) is None
            or name in environment
            or len(value) > 4096
            or any(ord(character) < 0x20 for character in value)
            or any(marker in name.upper() for marker in _DENIED_MARKERS)
        ):
            raise _reject()
        environment[name] = value
    return environment


def _string_map_sha256(values: dict[str, str]) -> str:
    encoded = json.dumps(values, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode(
        "ascii"
    )
    return hashlib.sha256(encoded).hexdigest()


def _closed_labels(config: dict[str, object]) -> dict[str, str]:
    raw = config.get("Labels")
    if not isinstance(raw, dict):
        raise _reject()
    labels: dict[str, str] = {}
    for key, value in raw.items():
        if (
            not isinstance(key, str)
            or not isinstance(value, str)
            or key in labels
            or not key
            or len(key) > 256
            or len(value) > 4096
            or any(marker in f"{key}={value}".upper() for marker in _DENIED_MARKERS)
        ):
            raise _reject()
        labels[key] = value
    return labels


def _validate_platform(image: dict[str, object], expected_platform: str) -> None:
    expected = {
        "linux/amd64": ("amd64", ""),
        "linux/arm64/v8": ("arm64", "v8"),
    }.get(expected_platform)
    if expected is None:
        raise _reject()
    if (
        image.get("Os") != "linux"
        or image.get("Architecture") != expected[0]
        or image.get("Variant", "") != expected[1]
    ):
        raise _reject()


def validate_base_inspect(
    document: object,
    *,
    expected_base: str,
    expected_platform: str,
    expected_environment_sha256: str,
    expected_labels_sha256: str,
) -> None:
    """Validate config that must be approved before Docker evaluates ``FROM``."""

    if (
        _SHA256.fullmatch(expected_environment_sha256) is None
        or _SHA256.fullmatch(expected_labels_sha256) is None
        or not isinstance(document, list)
        or len(document) != 1
        or not isinstance(document[0], dict)
    ):
        raise _reject()
    _validate_image_reference(expected_base)
    image = document[0]
    _validate_platform(image, expected_platform)
    if image.get("RepoDigests") != [expected_base]:
        raise _reject()
    config = image.get("Config")
    if not isinstance(config, dict):
        raise _reject()
    if (
        config.get("OnBuild") not in (None, [])
        or config.get("Shell") not in (None, [], _APPROVED_SHELL)
        or config.get("Volumes") not in (None, {})
        or config.get("User") not in (None, "", "0", "0:0")
        or config.get("Entrypoint") not in (None, [])
        or config.get("Cmd") not in (None, [])
        or config.get("Healthcheck") not in (None, {})
        or config.get("StopSignal") not in (None, "")
        or config.get("WorkingDir") not in (None, "")
    ):
        raise _reject()
    environment = _closed_environment(config)
    labels = _closed_labels(config)
    if not hmac.compare_digest(_string_map_sha256(environment), expected_environment_sha256):
        raise _reject()
    if not hmac.compare_digest(_string_map_sha256(labels), expected_labels_sha256):
        raise _reject()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inspect-json", required=True, type=Path)
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
        validate_base_inspect(
            document,
            expected_base=arguments.expected_base,
            expected_platform=arguments.expected_platform,
            expected_environment_sha256=arguments.expected_environment_sha256,
            expected_labels_sha256=arguments.expected_labels_sha256,
        )
    except (BaseInspectionError, OSError, ValueError, TypeError):
        print("base image inspection failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

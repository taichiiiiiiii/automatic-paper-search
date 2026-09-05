"""Closed, dependency-free validation for Replay Lite run manifests.

The runtime validator deliberately does not load the repository JSON Schema.
That schema is for CI and non-Python consumers; an installed PaperPilot wheel
must be able to reject an unsafe manifest with only the standard library.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any

MANIFEST_VERSION = "run-manifest-v1"

# Replay manifests and bundles are short-retention verification inputs, not an
# unbounded transport format.  Keep these limits mirrored in the JSON Schema
# where JSON Schema can express them.
MAX_MANIFEST_BYTES = 1 * 1024 * 1024
MAX_REFERENCES = 128
MAX_PRODUCERS = 128
MAX_FAILURES = 128
MAX_COUNTS = 256
MAX_STORED_BYTES = 64 * 1024 * 1024
MAX_CONTENT_BYTES = 256 * 1024 * 1024
MAX_TOTAL_STORED_BYTES = 256 * 1024 * 1024
MAX_TOTAL_CONTENT_BYTES = 512 * 1024 * 1024
MAX_JSON_NESTING = 64

REPLAY_MANIFEST_INVALID = "REPLAY_MANIFEST_INVALID"
REPLAY_SECRET_DETECTED = "REPLAY_SECRET_DETECTED"
REPLAY_PATH_INVALID = "REPLAY_PATH_INVALID"
REPLAY_STATUS_NOT_REPLAYABLE = "REPLAY_STATUS_NOT_REPLAYABLE"
REPLAY_DEPENDENCY_MISMATCH = "REPLAY_DEPENDENCY_MISMATCH"
REPLAY_ARTIFACT_EXPIRED = "REPLAY_ARTIFACT_EXPIRED"
REPLAY_ARTIFACT_MISSING = "REPLAY_ARTIFACT_MISSING"
REPLAY_ARTIFACT_HASH_MISMATCH = "REPLAY_ARTIFACT_HASH_MISMATCH"
REPLAY_ARTIFACT_SIZE_MISMATCH = "REPLAY_ARTIFACT_SIZE_MISMATCH"
REPLAY_OUTPUT_HASH_MISMATCH = "REPLAY_OUTPUT_HASH_MISMATCH"
REPLAY_NETWORK_DISABLED = "REPLAY_NETWORK_DISABLED"

_TOP_LEVEL_KEYS = {
    "schema_version",
    "run_id",
    "pipeline",
    "status",
    "as_of",
    "code",
    "invocation",
    "dependencies",
    "inputs",
    "artifacts",
    "outputs",
    "producers",
    "counts",
    "failures",
}
_CODE_KEYS = {"repository", "commit_sha", "dirty"}
_INVOCATION_KEYS = {"projector", "config_input_id", "parameters"}
_DEPENDENCY_KEYS = {
    "manager",
    "lock_path",
    "lock_sha256",
    "python",
    "environment_sha256",
}
_FILE_REFERENCE_KEYS = {
    "id",
    "role",
    "storage",
    "path",
    "media_type",
    "compression",
    "stored_size_bytes",
    "content_size_bytes",
    "sha256",
    "expires_at",
}
_PRODUCER_KEYS = {
    "name",
    "version",
    "provider",
    "model",
    "prompt_version",
    "schema_version",
}
_FAILURE_KEYS = {"code", "stage", "count", "detail"}

_RUN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_PIPELINE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_ROLE_RE = re.compile(r"^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$")
_COUNT_KEY_RE = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")
_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PYTHON_RE = re.compile(r"^[0-9]+\.[0-9]+$")
_MEDIA_TYPE_RE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$")
_TIMESTAMP_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$")
_DANGEROUS_PARAMETER_KEY_RE = re.compile(
    r"(?:argv|callable|cmd|command|executable|module|python_?path)$", re.IGNORECASE
)

_SECRET_KEY_RE = re.compile(
    r"(?:authorization|api_?key|access_?token|refresh_?token|client_?secret|password|private_?key)$",
    re.IGNORECASE,
)
_SAFE_FAILURE_DETAIL_RE = re.compile(r"^[a-z0-9][a-z0-9 ._-]{0,511}$")
_AUTH_VALUE_RE = re.compile(r"\b(?:Bearer|Basic)\s+\S+", re.IGNORECASE)
_URL_USERINFO_RE = re.compile(r"[a-z][a-z0-9+.-]*://[^\s/@]+@", re.IGNORECASE)
_SECRET_QUERY_RE = re.compile(r"[?&][^\s&#=]*(?:token|key|signature)=[^\s&#]+", re.IGNORECASE)
_KNOWN_TOKEN_RE = re.compile(
    r"(?:\bAKIA[0-9A-Z]{12,}|\bAIza[0-9A-Za-z_-]{16,}|\bgithub_pat_[0-9A-Za-z_]{8,}|"
    r"\bgh[pousr]_[0-9A-Za-z]{8,}|\bgsk_[0-9A-Za-z]{8,}|\bglpat-[0-9A-Za-z_-]{8,}|\bhf_[0-9A-Za-z]{8,}|"
    r"\bsk-[0-9A-Za-z_-]{8,}|\bxox[baprs]-[0-9A-Za-z-]{8,})"
)
_PRIVATE_KEY_RE = re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")


class ReplayValidationError(ValueError):
    """A stable Replay error code and non-sensitive JSON pointer."""

    def __init__(self, code: str, pointer: str = "") -> None:
        self.code = code
        self.pointer = _sanitize_pointer(pointer)
        super().__init__(f"{code}:{self.pointer}" if self.pointer else code)


ReplayError = ReplayValidationError


def _raise_invalid(pointer: str) -> None:
    raise ReplayValidationError(REPLAY_MANIFEST_INVALID, pointer)


def _sanitize_pointer(pointer: str) -> str:
    """Keep error pointers single-line and safe for direct CLI logging."""

    return "".join(
        f"\\u{ord(character):04x}" if ord(character) < 32 or ord(character) == 127 else character
        for character in pointer
    )


def _pointer(parent: str, part: object) -> str:
    escaped = str(part).replace("~", "~0").replace("/", "~1")
    return _sanitize_pointer(f"{parent}/{escaped}")


def _normalize_key(key: object) -> str:
    """Normalize snake, kebab, camel and acronym-style keys consistently."""

    text = str(key)
    text = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", text)
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", text)
    return re.sub(r"[^a-zA-Z0-9]+", "_", text).strip("_").lower()


def _object(
    value: object, pointer: str, keys: set[str], *, required: set[str] | None = None
) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        _raise_invalid(pointer)
    allowed = keys
    required = keys if required is None else required
    for key in value:
        if key not in allowed:
            _raise_invalid(_pointer(pointer, key))
    for key in sorted(required):
        if key not in value:
            _raise_invalid(_pointer(pointer, key))
    return value


def _string(value: object, pointer: str, *, nonempty: bool = True) -> str:
    if not isinstance(value, str) or (nonempty and not value):
        _raise_invalid(pointer)
    return value


def _pattern(value: object, pointer: str, pattern: re.Pattern[str]) -> str:
    text = _string(value, pointer)
    if pattern.fullmatch(text) is None:
        _raise_invalid(pointer)
    return text


def parse_timestamp(value: object, pointer: str) -> datetime:
    """Parse the contract's canonical UTC RFC 3339 representation."""

    text = _pattern(value, pointer, _TIMESTAMP_RE)
    try:
        parsed = datetime.fromisoformat(text[:-1] + "+00:00")
    except ValueError:
        _raise_invalid(pointer)
    if parsed.utcoffset() is None:
        _raise_invalid(pointer)
    return parsed


def validate_relative_path(value: object, pointer: str = "") -> PurePosixPath:
    """Validate a lexical POSIX path without touching the filesystem."""

    if not isinstance(value, str) or not value:
        raise ReplayValidationError(REPLAY_PATH_INVALID, pointer)
    if (
        value.startswith("/")
        or "\\" in value
        or re.match(r"^[A-Za-z]:", value)
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ReplayValidationError(REPLAY_PATH_INVALID, pointer)
    segments = value.split("/")
    if any(segment in {"", ".", ".."} or segment.lower() == ".git" for segment in segments):
        raise ReplayValidationError(REPLAY_PATH_INVALID, pointer)
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value:
        raise ReplayValidationError(REPLAY_PATH_INVALID, pointer)
    return path


def _validate_json_value(value: object, pointer: str, *, parameters: bool = False) -> None:
    stack: list[tuple[object, str, int]] = [(value, pointer, 0)]
    while stack:
        item, item_pointer, depth = stack.pop()
        if depth > MAX_JSON_NESTING:
            _raise_invalid(item_pointer)
        if item is None or isinstance(item, (str, bool)):
            continue
        if isinstance(item, int):
            continue
        if isinstance(item, float):
            if not math.isfinite(item):
                _raise_invalid(item_pointer)
            continue
        if isinstance(item, list):
            stack.extend(
                (child, _pointer(item_pointer, index), depth + 1)
                for index, child in reversed(list(enumerate(item)))
            )
            continue
        if isinstance(item, dict) and all(isinstance(key, str) for key in item):
            children: list[tuple[object, str, int]] = []
            for key, child in item.items():
                child_pointer = _pointer(item_pointer, key)
                if parameters and _DANGEROUS_PARAMETER_KEY_RE.search(_normalize_key(key)):
                    _raise_invalid(child_pointer)
                children.append((child, child_pointer, depth + 1))
            stack.extend(reversed(children))
            continue
        _raise_invalid(item_pointer)


def _validate_file_ref(ref: object, pointer: str, category: str) -> dict[str, Any]:
    data = _object(ref, pointer, _FILE_REFERENCE_KEYS)
    _pattern(data["id"], f"{pointer}/id", _NAME_RE)
    _pattern(data["role"], f"{pointer}/role", _ROLE_RE)
    _string(data["path"], f"{pointer}/path", nonempty=False)
    _pattern(data["media_type"], f"{pointer}/media_type", _MEDIA_TYPE_RE)
    if data["compression"] not in {"none", "gzip"}:
        _raise_invalid(f"{pointer}/compression")

    expected_storage = {
        "inputs": {"repository", "bundle"},
        "artifacts": {"bundle"},
        "outputs": {"replay-output"},
    }[category]
    if data["storage"] not in expected_storage:
        _raise_invalid(f"{pointer}/storage")

    for field in ("stored_size_bytes", "content_size_bytes"):
        size = data[field]
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            _raise_invalid(f"{pointer}/{field}")
    if data["stored_size_bytes"] > MAX_STORED_BYTES:
        _raise_invalid(f"{pointer}/stored_size_bytes")
    if data["content_size_bytes"] > MAX_CONTENT_BYTES:
        _raise_invalid(f"{pointer}/content_size_bytes")
    if data["compression"] == "none" and data["stored_size_bytes"] != data["content_size_bytes"]:
        _raise_invalid(f"{pointer}/content_size_bytes")
    _pattern(data["sha256"], f"{pointer}/sha256", _SHA256_RE)

    expiry = data["expires_at"]
    if category == "artifacts":
        parse_timestamp(expiry, f"{pointer}/expires_at")
    elif category == "outputs":
        if expiry is not None:
            _raise_invalid(f"{pointer}/expires_at")
    elif expiry is not None:
        parse_timestamp(expiry, f"{pointer}/expires_at")
    return data


def _validate_manifest_structure(manifest: object) -> dict[str, Any]:
    data = _object(manifest, "", _TOP_LEVEL_KEYS)
    if data["schema_version"] != MANIFEST_VERSION:
        _raise_invalid("/schema_version")
    _pattern(data["run_id"], "/run_id", _RUN_ID_RE)
    _pattern(data["pipeline"], "/pipeline", _PIPELINE_RE)
    if data["status"] not in {"succeeded", "partial", "failed"}:
        _raise_invalid("/status")
    parse_timestamp(data["as_of"], "/as_of")

    code = _object(data["code"], "/code", _CODE_KEYS)
    repository = _string(code["repository"], "/code/repository")
    repository_parts = repository.split("/")
    if len(repository_parts) != 2 or not all(repository_parts) or repository.startswith("."):
        _raise_invalid("/code/repository")
    _pattern(code["commit_sha"], "/code/commit_sha", _COMMIT_RE)
    if not isinstance(code["dirty"], bool):
        _raise_invalid("/code/dirty")

    invocation = _object(data["invocation"], "/invocation", _INVOCATION_KEYS)
    _pattern(invocation["projector"], "/invocation/projector", _NAME_RE)
    _pattern(invocation["config_input_id"], "/invocation/config_input_id", _NAME_RE)
    if not isinstance(invocation["parameters"], dict):
        _raise_invalid("/invocation/parameters")
    _validate_json_value(invocation["parameters"], "/invocation/parameters", parameters=True)

    dependencies = _object(data["dependencies"], "/dependencies", _DEPENDENCY_KEYS)
    if dependencies["manager"] != "uv":
        _raise_invalid("/dependencies/manager")
    _string(dependencies["lock_path"], "/dependencies/lock_path", nonempty=False)
    _pattern(dependencies["lock_sha256"], "/dependencies/lock_sha256", _SHA256_RE)
    _pattern(dependencies["python"], "/dependencies/python", _PYTHON_RE)
    environment_sha = dependencies["environment_sha256"]
    if environment_sha is not None:
        _pattern(environment_sha, "/dependencies/environment_sha256", _SHA256_RE)

    seen_ids: set[str] = set()
    refs_by_category: dict[str, list[dict[str, Any]]] = {}
    total_reference_count = 0
    total_stored_bytes = 0
    total_content_bytes = 0
    for category in ("inputs", "artifacts", "outputs"):
        refs = data[category]
        if not isinstance(refs, list):
            _raise_invalid(f"/{category}")
        if len(refs) > MAX_REFERENCES:
            _raise_invalid(f"/{category}")
        validated: list[dict[str, Any]] = []
        for index, ref in enumerate(refs):
            pointer = f"/{category}/{index}"
            item = _validate_file_ref(ref, pointer, category)
            if item["id"] in seen_ids:
                _raise_invalid(f"{pointer}/id")
            seen_ids.add(item["id"])
            total_reference_count += 1
            total_stored_bytes += item["stored_size_bytes"]
            total_content_bytes += item["content_size_bytes"]
            validated.append(item)
        refs_by_category[category] = validated
    if total_reference_count > MAX_REFERENCES:
        _raise_invalid("/inputs")
    if total_stored_bytes > MAX_TOTAL_STORED_BYTES:
        _raise_invalid("/inputs")
    if total_content_bytes > MAX_TOTAL_CONTENT_BYTES:
        _raise_invalid("/inputs")

    config_id = invocation["config_input_id"]
    config_matches = [
        ref
        for ref in refs_by_category["inputs"]
        if ref["id"] == config_id and ref["role"] == "config"
    ]
    if len(config_matches) != 1:
        _raise_invalid("/invocation/config_input_id")

    producers = data["producers"]
    if not isinstance(producers, list):
        _raise_invalid("/producers")
    if len(producers) > MAX_PRODUCERS:
        _raise_invalid("/producers")
    for index, producer_value in enumerate(producers):
        pointer = f"/producers/{index}"
        producer = _object(producer_value, pointer, _PRODUCER_KEYS)
        for field in ("name", "version", "schema_version"):
            _string(producer[field], f"{pointer}/{field}")
        llm_fields = [producer[field] for field in ("provider", "model", "prompt_version")]
        if all(value is None for value in llm_fields):
            continue
        for field, value in zip(("provider", "model", "prompt_version"), llm_fields, strict=True):
            _string(value, f"{pointer}/{field}")

    counts = data["counts"]
    if not isinstance(counts, dict) or not all(isinstance(key, str) for key in counts):
        _raise_invalid("/counts")
    if len(counts) > MAX_COUNTS:
        _raise_invalid("/counts")
    for key, count in counts.items():
        pointer = _pointer("/counts", key)
        if _COUNT_KEY_RE.fullmatch(key) is None:
            _raise_invalid(pointer)
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            _raise_invalid(pointer)

    failures = data["failures"]
    if not isinstance(failures, list):
        _raise_invalid("/failures")
    if len(failures) > MAX_FAILURES:
        _raise_invalid("/failures")
    for index, failure_value in enumerate(failures):
        pointer = f"/failures/{index}"
        failure = _object(failure_value, pointer, _FAILURE_KEYS)
        _pattern(failure["code"], f"{pointer}/code", _ROLE_RE)
        _pattern(failure["stage"], f"{pointer}/stage", _ROLE_RE)
        count = failure["count"]
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            _raise_invalid(f"{pointer}/count")
        detail = _string(failure["detail"], f"{pointer}/detail")
        if _SAFE_FAILURE_DETAIL_RE.fullmatch(detail) is None:
            _raise_invalid(f"{pointer}/detail")
    return data


def _has_secret_value(value: str) -> bool:
    return any(
        pattern.search(value) is not None
        for pattern in (
            _AUTH_VALUE_RE,
            _URL_USERINFO_RE,
            _SECRET_QUERY_RE,
            _KNOWN_TOKEN_RE,
            _PRIVATE_KEY_RE,
        )
    )


def scan_for_secrets(value: object, pointer: str = "") -> None:
    """Recursively reject secret-shaped keys and values without echoing them."""

    stack: list[tuple[object, str, int]] = [(value, pointer, 0)]
    while stack:
        item, item_pointer, depth = stack.pop()
        if depth > MAX_JSON_NESTING:
            _raise_invalid(item_pointer)
        if isinstance(item, dict):
            children: list[tuple[object, str, int]] = []
            for key, child_value in item.items():
                child_pointer = _pointer(item_pointer, key)
                nonempty = child_value is not None and child_value != ""
                if nonempty and _SECRET_KEY_RE.search(_normalize_key(key)):
                    raise ReplayValidationError(REPLAY_SECRET_DETECTED, child_pointer)
                children.append((child_value, child_pointer, depth + 1))
            stack.extend(reversed(children))
        elif isinstance(item, list):
            stack.extend(
                (child, _pointer(item_pointer, index), depth + 1)
                for index, child in reversed(list(enumerate(item)))
            )
        elif isinstance(item, str) and item and _has_secret_value(item):
            raise ReplayValidationError(REPLAY_SECRET_DETECTED, item_pointer)


def validate_manifest(manifest: object, *, check_paths: bool = True) -> dict[str, Any]:
    """Validate one closed run manifest and return the original dictionary.

    Replay status is intentionally not enforced here: ``partial`` and ``failed``
    are valid records, although :func:`artifacts.validate_preflight` will not
    replay them.
    """

    data = _validate_manifest_structure(manifest)
    scan_for_secrets(data)
    if check_paths:
        validate_relative_path(data["dependencies"]["lock_path"], "/dependencies/lock_path")
        for category in ("inputs", "artifacts", "outputs"):
            for index, ref in enumerate(data[category]):
                validate_relative_path(ref["path"], f"/{category}/{index}/path")
    return data


class _DuplicateKeyError(ValueError):
    pass


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKeyError
        result[key] = value
    return result


def _reject_constant(_value: str) -> object:
    raise ValueError


def loads_manifest(payload: str | bytes, *, check_paths: bool = False) -> dict[str, Any]:
    """Parse and validate manifest JSON, rejecting duplicates and NaN values."""

    if isinstance(payload, bytes):
        payload_size = len(payload)
    elif isinstance(payload, str):
        payload_size = len(payload.encode("utf-8"))
    else:
        raise ReplayValidationError(REPLAY_MANIFEST_INVALID)
    if payload_size > MAX_MANIFEST_BYTES:
        raise ReplayValidationError(REPLAY_MANIFEST_INVALID)
    try:
        parsed = json.loads(
            payload,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        _DuplicateKeyError,
        RecursionError,
        ValueError,
        TypeError,
    ):
        raise ReplayValidationError(REPLAY_MANIFEST_INVALID) from None
    return validate_manifest(parsed, check_paths=check_paths)


def load_manifest(path: str | Path, *, check_paths: bool = False) -> dict[str, Any]:
    """Read a manifest with path checks deferred for ordered preflight by default."""

    try:
        with Path(path).open("rb") as stream:
            payload = stream.read(MAX_MANIFEST_BYTES + 1)
    except OSError:
        raise ReplayValidationError(REPLAY_MANIFEST_INVALID) from None
    return loads_manifest(payload, check_paths=check_paths)

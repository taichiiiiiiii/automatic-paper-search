"""Canonical byte helpers for Replay Lite artifacts.

This contract is deliberately separate from lineage hashing, whose JSON bytes do
not include the trailing line feed required here.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import math
from collections.abc import Iterable
from typing import Any


def _validate_json_value(value: object, active_containers: set[int] | None = None) -> None:
    """Reject values that ``json.dumps`` would otherwise coerce implicitly."""

    if value is None or type(value) in (bool, int, str):
        return
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError("non-finite floats are not valid canonical JSON")
        return

    if active_containers is None:
        active_containers = set()

    if type(value) is list:
        container_id = id(value)
        if container_id in active_containers:
            raise ValueError("circular references are not valid canonical JSON")
        active_containers.add(container_id)
        try:
            for item in value:
                _validate_json_value(item, active_containers)
        finally:
            active_containers.remove(container_id)
        return

    if type(value) is dict:
        container_id = id(value)
        if container_id in active_containers:
            raise ValueError("circular references are not valid canonical JSON")
        active_containers.add(container_id)
        try:
            for key, item in value.items():
                if type(key) is not str:
                    raise TypeError("canonical JSON object keys must be strings")
                _validate_json_value(item, active_containers)
        finally:
            active_containers.remove(container_id)
        return

    raise TypeError(f"value of type {type(value).__name__} is not valid canonical JSON")


def canonical_json_bytes(value: object) -> bytes:
    """Serialize a JSON value to stable UTF-8 bytes with exactly one trailing LF."""

    _validate_json_value(value)
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return encoded + b"\n"


def sha256_bytes(data: bytes | bytearray | memoryview) -> str:
    """Return the lowercase SHA-256 hex digest of the supplied bytes."""

    return hashlib.sha256(data).hexdigest()


def canonical_json_sha256(value: object) -> str:
    """Return the SHA-256 digest of :func:`canonical_json_bytes`."""

    return sha256_bytes(canonical_json_bytes(value))


def canonical_jsonl_bytes(records: Iterable[object]) -> bytes:
    """Serialize records as canonical JSON Lines, or empty bytes for no records."""

    return b"".join(canonical_json_bytes(record) for record in records)


def deterministic_gzip_bytes(data: bytes) -> bytes:
    """Compress bytes with the fixed Replay Lite gzip header and level 9."""

    output = io.BytesIO()
    with gzip.GzipFile(
        filename="",
        mode="wb",
        compresslevel=9,
        fileobj=output,
        mtime=0,
    ) as gzip_file:
        gzip_file.write(data)

    compressed = bytearray(output.getvalue())
    # GzipFile currently emits 255 on every platform, but make the contract
    # explicit rather than relying on the interpreter's host OS choice.
    compressed[9] = 255
    return bytes(compressed)


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key: {key!r}")
        result[key] = value
    return result


def _reject_non_finite_number(token: str) -> None:
    raise ValueError(f"non-finite JSON number: {token}")


def strict_json_loads(data: str | bytes | bytearray) -> object:
    """Parse JSON while rejecting duplicate keys and non-finite numbers."""

    return json.loads(
        data,
        object_pairs_hook=_reject_duplicate_keys,
        parse_constant=_reject_non_finite_number,
    )

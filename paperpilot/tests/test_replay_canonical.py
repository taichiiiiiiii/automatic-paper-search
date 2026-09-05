"""Tests for Replay Lite's canonical byte contract."""

from __future__ import annotations

import gzip
import math
import subprocess
import sys

import pytest

from paperpilot.replay import (
    canonical_json_bytes,
    canonical_json_sha256,
    canonical_jsonl_bytes,
    deterministic_gzip_bytes,
    sha256_bytes,
    strict_json_loads,
)

GOLDEN_JSON = b'{"a":"\xe3\x81\x82","b":1}\n'
GOLDEN_JSON_SHA256 = "58968931db66c950c32a1c8e1c1bf41c7e86a3deae3bb09990c242c3d1886b87"
GOLDEN_GZIP = bytes.fromhex(
    "1f8b08000000000002ffab564a54b2527adcd8a4a4a394a4646558cb0500dec5bcbb12000000"
)
GOLDEN_GZIP_SHA256 = "04a4d04727b05a82652903adc0359324426c36d845a5804143e007123ef7b065"


def test_canonical_json_matches_golden_bytes_and_hash() -> None:
    value = {"b": 1, "a": "あ"}

    assert canonical_json_bytes(value) == GOLDEN_JSON
    assert canonical_json_sha256(value) == GOLDEN_JSON_SHA256
    assert sha256_bytes(GOLDEN_JSON) == GOLDEN_JSON_SHA256


def test_canonical_json_is_independent_of_insertion_order() -> None:
    first = {"outer": {"z": 3, "a": 1}, "items": [{"b": 2, "a": 1}]}
    second = {"items": [{"a": 1, "b": 2}], "outer": {"a": 1, "z": 3}}

    assert canonical_json_bytes(first) == canonical_json_bytes(second)


@pytest.mark.parametrize(
    "value",
    [
        {"bad": object()},
        {"bad": (1, 2)},
        {1: "non-string key"},
        {"bad": math.nan},
        {"bad": math.inf},
        {"bad": -math.inf},
    ],
)
def test_canonical_json_rejects_non_json_values(value: object) -> None:
    with pytest.raises((TypeError, ValueError)):
        canonical_json_bytes(value)


def test_strict_json_loader_rejects_duplicate_keys_and_non_finite_numbers() -> None:
    with pytest.raises(ValueError, match="duplicate JSON object key"):
        strict_json_loads('{"a":1,"a":2}')

    for token in ("NaN", "Infinity", "-Infinity"):
        with pytest.raises(ValueError, match="non-finite JSON number"):
            strict_json_loads(f'{{"value":{token}}}')


def test_strict_json_loader_accepts_utf8_bytes() -> None:
    assert strict_json_loads(GOLDEN_JSON) == {"a": "あ", "b": 1}


def test_jsonl_uses_one_canonical_line_per_record() -> None:
    records = ({"b": 1, "a": "あ"}, {"z": [2, 1]})

    assert canonical_jsonl_bytes(records) == GOLDEN_JSON + b'{"z":[2,1]}\n'
    assert canonical_jsonl_bytes(iter(())) == b""


def test_deterministic_gzip_matches_golden_header_bytes_and_hash() -> None:
    compressed = deterministic_gzip_bytes(GOLDEN_JSON)

    assert compressed == GOLDEN_GZIP
    assert sha256_bytes(compressed) == GOLDEN_GZIP_SHA256
    assert compressed[:10] == bytes.fromhex("1f8b08000000000002ff")
    assert gzip.decompress(compressed) == GOLDEN_JSON


def test_deterministic_gzip_is_repeatable() -> None:
    first = deterministic_gzip_bytes(GOLDEN_JSON)
    second = deterministic_gzip_bytes(GOLDEN_JSON)

    assert first == second


def test_deterministic_gzip_is_identical_across_processes() -> None:
    script = (
        "from paperpilot.replay import canonical_json_bytes, deterministic_gzip_bytes; "
        "import sys; "
        "sys.stdout.buffer.write(deterministic_gzip_bytes("
        "canonical_json_bytes({'b': 1, 'a': 'あ'})))"
    )

    first = subprocess.run([sys.executable, "-c", script], check=True, capture_output=True).stdout
    second = subprocess.run([sys.executable, "-c", script], check=True, capture_output=True).stdout

    assert first == GOLDEN_GZIP
    assert second == GOLDEN_GZIP

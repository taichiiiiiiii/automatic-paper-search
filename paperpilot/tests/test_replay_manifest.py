"""Runtime and JSON Schema tests for the Replay Lite run manifest."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

import pytest

from paperpilot.replay import artifacts as replay_artifacts
from paperpilot.replay.artifacts import validate_output_paths, validate_preflight
from paperpilot.replay.manifest import (
    MAX_CONTENT_BYTES,
    MAX_JSON_NESTING,
    MAX_MANIFEST_BYTES,
    MAX_REFERENCES,
    MAX_STORED_BYTES,
    ReplayValidationError,
    load_manifest,
    scan_for_secrets,
    validate_manifest,
)

NOW = datetime(2026, 8, 30, tzinfo=timezone.utc)


def _sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _ref(
    ref_id: str,
    role: str,
    storage: str,
    path: str,
    payload: bytes,
    *,
    compression: str = "none",
    content: bytes | None = None,
    expires_at: str | None = "2099-01-01T00:00:00Z",
) -> dict[str, object]:
    content = payload if content is None else content
    return {
        "id": ref_id,
        "role": role,
        "storage": storage,
        "path": path,
        "media_type": "application/json",
        "compression": compression,
        "stored_size_bytes": len(payload),
        "content_size_bytes": len(content),
        "sha256": _sha(payload),
        "expires_at": expires_at,
    }


def _manifest(lock_payload: bytes = b"lock\n") -> dict[str, object]:
    config = b'{"conference":"iclr-2026"}\n'
    artifact_content = b'{"papers":[]}\n'
    artifact = gzip.compress(artifact_content, compresslevel=9, mtime=0)
    output = b'{"aliases":[]}\n'
    return {
        "schema_version": "run-manifest-v1",
        "run_id": "r0-fixture-20260830",
        "pipeline": "identity-lite",
        "status": "succeeded",
        "as_of": "2026-08-30T00:00:00Z",
        "code": {
            "repository": "taichiiiiiiii/automatic-paper-search",
            "commit_sha": "a" * 40,
            "dirty": False,
        },
        "invocation": {
            "projector": "identity-lite-v1",
            "config_input_id": "config",
            "parameters": {},
        },
        "dependencies": {
            "manager": "uv",
            "lock_path": "uv.lock",
            "lock_sha256": _sha(lock_payload),
            "python": "3.12",
            "environment_sha256": None,
        },
        "inputs": [
            _ref("config", "config", "repository", "config.json", config),
        ],
        "artifacts": [
            _ref(
                "catalog",
                "normalized_snapshot",
                "bundle",
                "catalog.json.gz",
                artifact,
                compression="gzip",
                content=artifact_content,
            )
        ],
        "outputs": [
            _ref(
                "aliases",
                "identity_aliases",
                "replay-output",
                "aliases.json",
                output,
                expires_at=None,
            )
        ],
        "producers": [
            {
                "name": "identity-projector",
                "version": "1",
                "provider": None,
                "model": None,
                "prompt_version": None,
                "schema_version": "identity-aliases-v1",
            }
        ],
        "counts": {"input_count": 1, "output_count": 1},
        "failures": [],
    }


def _write_fixture(tmp_path: Path) -> tuple[dict[str, object], Path, Path]:
    repository = tmp_path / "repository"
    bundle = tmp_path / "bundle"
    repository.mkdir()
    bundle.mkdir()
    (repository / "uv.lock").write_bytes(b"lock\n")
    (repository / "config.json").write_bytes(b'{"conference":"iclr-2026"}\n')
    content = b'{"papers":[]}\n'
    (bundle / "catalog.json.gz").write_bytes(gzip.compress(content, compresslevel=9, mtime=0))
    return _manifest(), repository, bundle


def _code(exc: pytest.ExceptionInfo[ReplayValidationError]) -> str:
    return exc.value.code


def test_valid_manifest_passes_runtime_and_schema() -> None:
    manifest = _manifest()
    assert validate_manifest(manifest) is manifest

    jsonschema = pytest.importorskip("jsonschema")
    schema_path = Path(__file__).resolve().parents[2] / "schemas" / "run-manifest-v1.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator(schema).validate(manifest)


def test_closed_failure_record_passes_runtime() -> None:
    manifest = _manifest()
    manifest["failures"] = [
        {
            "code": "parse-error",
            "stage": "normalize_input",
            "count": 2,
            "detail": "sanitized classification",
        }
    ]
    validate_manifest(manifest)

    manifest["failures"][0]["message"] = "raw exception"
    with pytest.raises(ReplayValidationError) as exc:
        validate_manifest(manifest)
    assert _code(exc) == "REPLAY_MANIFEST_INVALID"
    assert exc.value.pointer == "/failures/0/message"


@pytest.mark.parametrize(
    ("mutate", "pointer"),
    [
        (lambda value: value.update({"unexpected": True}), "/unexpected"),
        (lambda value: value["code"].update({"branch": "develop"}), "/code/branch"),
        (
            lambda value: value["inputs"][0].update({"url": "https://example.invalid"}),
            "/inputs/0/url",
        ),
        (lambda value: value["counts"].update({"Bad-Key": 1}), "/counts/Bad-Key"),
        (
            lambda value: value["invocation"].update({"command": "python -m surprise"}),
            "/invocation/command",
        ),
    ],
)
def test_runtime_objects_are_closed(mutate, pointer: str) -> None:
    manifest = _manifest()
    mutate(manifest)
    with pytest.raises(ReplayValidationError) as exc:
        validate_manifest(manifest)
    assert _code(exc) == "REPLAY_MANIFEST_INVALID"
    assert exc.value.pointer == pointer


def test_schema_is_closed_at_top_and_nested_levels() -> None:
    jsonschema = pytest.importorskip("jsonschema")
    schema_path = Path(__file__).resolve().parents[2] / "schemas" / "run-manifest-v1.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema)

    for pointer, mutate in (
        ("top", lambda value: value.update({"unexpected": True})),
        ("nested", lambda value: value["dependencies"].update({"requirements": "x"})),
        ("ref", lambda value: value["outputs"][0].update({"bucket": "x"})),
    ):
        manifest = _manifest()
        mutate(manifest)
        assert list(validator.iter_errors(manifest)), pointer


@pytest.mark.parametrize(
    "path",
    [
        "",
        "/absolute.json",
        "../escape.json",
        "a/../escape.json",
        "a\\windows.json",
        "C:drive.json",
        ".git/config",
        "a\u0000b",
    ],
)
def test_runtime_and_schema_reject_unsafe_posix_paths(path: str) -> None:
    manifest = _manifest()
    manifest["outputs"][0]["path"] = path
    with pytest.raises(ReplayValidationError) as exc:
        validate_manifest(manifest)
    assert _code(exc) == "REPLAY_PATH_INVALID"

    jsonschema = pytest.importorskip("jsonschema")
    schema_path = Path(__file__).resolve().parents[2] / "schemas" / "run-manifest-v1.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    assert list(jsonschema.Draft202012Validator(schema).iter_errors(manifest))


@pytest.mark.parametrize(
    ("value", "pointer"),
    [
        ({"nested": [{"client_secret": "do-not-print"}]}, "/nested/0/client_secret"),
        ({"service_apikey": "do-not-print"}, "/service_apikey"),
        ({"accessToken": "do-not-print"}, "/accessToken"),
        ({"serviceClientSecret": "do-not-print"}, "/serviceClientSecret"),
        ({"privateKey": "do-not-print"}, "/privateKey"),
        ({"header": "Bearer do-not-print"}, "/header"),
        ({"endpoint": "https://user:do-not-print@example.invalid/x"}, "/endpoint"),
        ({"endpoint": "https://do-not-print@example.invalid/x"}, "/endpoint"),
        ({"endpoint": "https://example.invalid/x?signature=do-not-print"}, "/endpoint"),
        ({"private": "-----BEGIN PRIVATE KEY-----\ndo-not-print"}, "/private"),
        ({"credential": "gsk_1234567890abcdef"}, "/credential"),
    ],
)
def test_secret_scan_reports_only_stable_code_and_pointer(value: object, pointer: str) -> None:
    with pytest.raises(ReplayValidationError) as exc:
        scan_for_secrets(value)
    assert _code(exc) == "REPLAY_SECRET_DETECTED"
    assert exc.value.pointer == pointer
    assert "do-not-print" not in str(exc.value)


def test_secret_scan_allows_empty_and_token_metrics_and_normal_paper_text() -> None:
    scan_for_secrets(
        {
            "api_key": "",
            "access_token": None,
            "max_tokens": 500,
            "token_count": 20,
            "abstract": "A token representation improves retrieval.",
        }
    )


def test_load_manifest_rejects_duplicate_keys(tmp_path: Path) -> None:
    path = tmp_path / "manifest.json"
    path.write_text('{"schema_version":"run-manifest-v1","schema_version":"other"}')
    with pytest.raises(ReplayValidationError) as exc:
        load_manifest(path)
    assert _code(exc) == "REPLAY_MANIFEST_INVALID"


def test_load_manifest_rejects_oversized_payload_before_json_parse(tmp_path: Path) -> None:
    path = tmp_path / "manifest.json"
    path.write_bytes(b" " * (MAX_MANIFEST_BYTES + 1))
    with pytest.raises(ReplayValidationError) as exc:
        load_manifest(path)
    assert _code(exc) == "REPLAY_MANIFEST_INVALID"


def test_manifest_limits_sizes_reference_count_and_parameter_depth() -> None:
    for field, maximum in (
        ("stored_size_bytes", MAX_STORED_BYTES),
        ("content_size_bytes", MAX_CONTENT_BYTES),
    ):
        manifest = _manifest()
        manifest["artifacts"][0][field] = maximum + 1
        with pytest.raises(ReplayValidationError) as exc:
            validate_manifest(manifest)
        assert _code(exc) == "REPLAY_MANIFEST_INVALID"
        assert exc.value.pointer == f"/artifacts/0/{field}"

    manifest = _manifest()
    manifest["outputs"] = []
    base = manifest["artifacts"][0]
    manifest["artifacts"] = [
        {**base, "id": f"artifact-{index}", "path": f"artifact-{index}.json.gz"}
        for index in range(MAX_REFERENCES + 1)
    ]
    with pytest.raises(ReplayValidationError) as refs:
        validate_manifest(manifest)
    assert _code(refs) == "REPLAY_MANIFEST_INVALID"
    assert refs.value.pointer == "/artifacts"

    nested: object = "leaf"
    for _ in range(MAX_JSON_NESTING + 1):
        nested = {"nested": nested}
    manifest = _manifest()
    manifest["invocation"]["parameters"] = {"value": nested}
    with pytest.raises(ReplayValidationError) as depth:
        validate_manifest(manifest)
    assert _code(depth) == "REPLAY_MANIFEST_INVALID"


def test_preflight_returns_verified_decompressed_content(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    content = validate_preflight(
        manifest,
        repository_root=repository,
        artifact_root=bundle,
        now=NOW,
    )
    assert content == {
        "config": b'{"conference":"iclr-2026"}\n',
        "catalog": b'{"papers":[]}\n',
    }


def test_expiry_is_inclusive_at_now(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    manifest["artifacts"][0]["expires_at"] = "2026-08-30T00:00:00Z"
    with pytest.raises(ReplayValidationError) as exc:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(exc) == "REPLAY_ARTIFACT_EXPIRED"


def test_preflight_error_taxonomy_and_global_order(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    (repository / "uv.lock").write_bytes(b"changed\n")
    manifest["artifacts"][0]["expires_at"] = "2020-01-01T00:00:00Z"
    (bundle / "catalog.json.gz").unlink()

    with pytest.raises(ReplayValidationError) as dependency:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(dependency) == "REPLAY_DEPENDENCY_MISMATCH"

    manifest["dependencies"]["lock_sha256"] = _sha(b"changed\n")
    with pytest.raises(ReplayValidationError) as expired:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(expired) == "REPLAY_ARTIFACT_EXPIRED"

    manifest["artifacts"][0]["expires_at"] = "2099-01-01T00:00:00Z"
    with pytest.raises(ReplayValidationError) as missing:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(missing) == "REPLAY_ARTIFACT_MISSING"


def test_preflight_secret_precedes_status(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    manifest["invocation"]["parameters"] = {"password": "do-not-print"}
    manifest["status"] = "failed"
    with pytest.raises(ReplayValidationError) as exc:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(exc) == "REPLAY_SECRET_DETECTED"
    assert "do-not-print" not in str(exc.value)


def test_preflight_expiry_precedes_filesystem_path(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    manifest["artifacts"][0]["expires_at"] = "2020-01-01T00:00:00Z"
    external = tmp_path / "external"
    external.mkdir()
    (bundle / "catalog.json.gz").unlink()
    (bundle / "catalog.json.gz").symlink_to(external / "payload")
    with pytest.raises(ReplayValidationError) as exc:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(exc) == "REPLAY_ARTIFACT_EXPIRED"


def test_preflight_path_precedes_missing(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    (repository / "config.json").unlink()
    external = tmp_path / "external"
    external.mkdir()
    (bundle / "catalog.json.gz").unlink()
    (bundle / "catalog.json.gz").symlink_to(external / "payload")
    with pytest.raises(ReplayValidationError) as exc:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(exc) == "REPLAY_PATH_INVALID"


def test_preflight_output_lexical_path_precedes_missing(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    (repository / "config.json").unlink()
    manifest["outputs"][0]["path"] = "../escape"
    with pytest.raises(ReplayValidationError) as exc:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(exc) == "REPLAY_PATH_INVALID"


def test_preflight_all_sizes_precede_any_hash(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    config_path = repository / "config.json"
    config_path.write_bytes(config_path.read_bytes().replace(b"iclr", b"cvpr"))
    artifact_path = bundle / "catalog.json.gz"
    artifact_path.write_bytes(artifact_path.read_bytes() + b"x")
    with pytest.raises(ReplayValidationError) as exc:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(exc) == "REPLAY_ARTIFACT_SIZE_MISMATCH"


def test_loaded_manifest_defers_path_until_ordered_preflight(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    manifest["artifacts"][0]["path"] = "../escape"
    manifest["dependencies"]["lock_sha256"] = "0" * 64
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    loaded = load_manifest(path)

    with pytest.raises(ReplayValidationError) as exc:
        validate_preflight(loaded, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(exc) == "REPLAY_DEPENDENCY_MISMATCH"


def test_preflight_distinguishes_stored_size_and_hash(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    path = bundle / "catalog.json.gz"
    payload = path.read_bytes()
    path.write_bytes(payload + b"x")
    with pytest.raises(ReplayValidationError) as size:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(size) == "REPLAY_ARTIFACT_SIZE_MISMATCH"

    changed = bytes([payload[0] ^ 1]) + payload[1:]
    path.write_bytes(changed)
    with pytest.raises(ReplayValidationError) as digest:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(digest) == "REPLAY_ARTIFACT_HASH_MISMATCH"


def test_gzip_expansion_is_bounded_by_declared_content_size(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    expanded = b"x" * 1_000_000
    stored = gzip.compress(expanded, compresslevel=9, mtime=0)
    (bundle / "catalog.json.gz").write_bytes(stored)
    ref = manifest["artifacts"][0]
    ref["stored_size_bytes"] = len(stored)
    ref["content_size_bytes"] = 4
    ref["sha256"] = _sha(stored)

    with pytest.raises(ReplayValidationError) as exc:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(exc) == "REPLAY_ARTIFACT_SIZE_MISMATCH"


@pytest.mark.parametrize(
    ("media_type", "content"),
    [
        ("application/json", b'{"papers":[],"papers":[]}\n'),
        ("application/json", b'{"value":NaN}\n'),
        ("application/jsonl", b'{"paper":1,"paper":2}\n'),
        ("application/x-ndjson", b'{"value":Infinity}\n'),
    ],
)
def test_all_frozen_json_rejects_duplicate_keys_and_nonfinite_numbers(
    tmp_path: Path, media_type: str, content: bytes
) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    stored = gzip.compress(content, compresslevel=9, mtime=0)
    (bundle / "catalog.json.gz").write_bytes(stored)
    ref = manifest["artifacts"][0]
    ref["media_type"] = media_type
    ref["stored_size_bytes"] = len(stored)
    ref["content_size_bytes"] = len(content)
    ref["sha256"] = _sha(stored)

    with pytest.raises(ReplayValidationError) as exc:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(exc) == "REPLAY_MANIFEST_INVALID"
    assert exc.value.pointer == "/artifacts/0/content"


@pytest.mark.skipif(os.name != "posix", reason="descriptor traversal uses POSIX dir_fd")
def test_open_descriptor_pins_payload_against_post_open_symlink_swap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    config_path = repository / "config.json"
    external = tmp_path / "external.json"
    external.write_bytes(b'{"password":"do-not-read"}\n')
    original_validate_sizes = replay_artifacts._validate_stored_sizes

    def swap_after_open(candidates, streams) -> None:
        moved = repository / "config.original.json"
        config_path.rename(moved)
        config_path.symlink_to(external)
        original_validate_sizes(candidates, streams)

    monkeypatch.setattr(replay_artifacts, "_validate_stored_sizes", swap_after_open)
    content = validate_preflight(
        manifest,
        repository_root=repository,
        artifact_root=bundle,
        now=NOW,
    )
    assert content["config"] == b'{"conference":"iclr-2026"}\n'


def test_preflight_rejects_symlink_and_symlink_ancestor(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    external = tmp_path / "external"
    external.mkdir()
    (external / "catalog.json.gz").write_bytes((bundle / "catalog.json.gz").read_bytes())
    (bundle / "catalog.json.gz").unlink()
    (bundle / "catalog.json.gz").symlink_to(external / "catalog.json.gz")

    with pytest.raises(ReplayValidationError) as direct:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(direct) == "REPLAY_PATH_INVALID"

    (bundle / "catalog.json.gz").unlink()
    (bundle / "nested").symlink_to(external, target_is_directory=True)
    manifest["artifacts"][0]["path"] = "nested/catalog.json.gz"
    with pytest.raises(ReplayValidationError) as ancestor:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(ancestor) == "REPLAY_PATH_INVALID"


def test_preflight_rejects_symlink_ancestor_of_root(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    linked_parent = tmp_path / "linked-parent"
    linked_parent.symlink_to(tmp_path, target_is_directory=True)
    linked_bundle = linked_parent / bundle.name

    with pytest.raises(ReplayValidationError) as exc:
        validate_preflight(
            manifest,
            repository_root=repository,
            artifact_root=linked_bundle,
            now=NOW,
        )
    assert _code(exc) == "REPLAY_PATH_INVALID"


def test_output_paths_are_checked_without_creating_files(tmp_path: Path) -> None:
    manifest = _manifest()
    output_root = tmp_path / "output"
    output_root.mkdir()
    paths = validate_output_paths(manifest, output_root)
    assert paths == {"aliases": output_root / "aliases.json"}
    assert list(output_root.iterdir()) == []

    external = tmp_path / "external"
    external.mkdir()
    (output_root / "link").symlink_to(external, target_is_directory=True)
    manifest["outputs"][0]["path"] = "link/aliases.json"
    with pytest.raises(ReplayValidationError) as exc:
        validate_output_paths(manifest, output_root)
    assert _code(exc) == "REPLAY_PATH_INVALID"


def test_output_paths_require_existing_real_staging_root(tmp_path: Path) -> None:
    with pytest.raises(ReplayValidationError) as exc:
        validate_output_paths(_manifest(), tmp_path / "not-created")
    assert _code(exc) == "REPLAY_PATH_INVALID"


def test_protected_artifact_secret_is_never_echoed(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    secret = b'{"nested":{"password":"do-not-print"}}\n'
    (repository / "config.json").write_bytes(secret)
    ref = manifest["inputs"][0]
    ref["stored_size_bytes"] = len(secret)
    ref["content_size_bytes"] = len(secret)
    ref["sha256"] = _sha(secret)

    with pytest.raises(ReplayValidationError) as exc:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(exc) == "REPLAY_SECRET_DETECTED"
    assert exc.value.pointer == "/inputs/0/content/nested/password"
    assert "do-not-print" not in str(exc.value)


@pytest.mark.parametrize("env_value", [None, {}, ""])
def test_config_snapshot_always_rejects_top_level_env(tmp_path: Path, env_value: object) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    payload = json.dumps({"conference": "iclr-2026", "env": env_value}).encode() + b"\n"
    (repository / "config.json").write_bytes(payload)
    ref = manifest["inputs"][0]
    ref["stored_size_bytes"] = len(payload)
    ref["content_size_bytes"] = len(payload)
    ref["sha256"] = _sha(payload)

    with pytest.raises(ReplayValidationError) as exc:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(exc) == "REPLAY_SECRET_DETECTED"
    assert exc.value.pointer == "/inputs/0/content/env"


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlinks unavailable")
def test_non_regular_file_is_path_invalid(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    (bundle / "catalog.json.gz").unlink()
    (bundle / "catalog.json.gz").mkdir()
    with pytest.raises(ReplayValidationError) as exc:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(exc) == "REPLAY_PATH_INVALID"


def test_status_precedes_dependency_and_artifact_checks(tmp_path: Path) -> None:
    manifest, repository, bundle = _write_fixture(tmp_path)
    manifest["status"] = "partial"
    (repository / "uv.lock").unlink()
    with pytest.raises(ReplayValidationError) as exc:
        validate_preflight(manifest, repository_root=repository, artifact_root=bundle, now=NOW)
    assert _code(exc) == "REPLAY_STATUS_NOT_REPLAYABLE"


def test_manifest_semantics_require_unique_config_reference() -> None:
    manifest = deepcopy(_manifest())
    manifest["invocation"]["config_input_id"] = "catalog"
    with pytest.raises(ReplayValidationError) as exc:
        validate_manifest(manifest)
    assert _code(exc) == "REPLAY_MANIFEST_INVALID"
    assert exc.value.pointer == "/invocation/config_input_id"


def test_same_relative_path_is_allowed_for_distinct_storage_roots() -> None:
    manifest = _manifest()
    manifest["outputs"][0]["path"] = manifest["inputs"][0]["path"]
    validate_manifest(manifest)

    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads(
        (
            Path(__file__).resolve().parents[2] / "schemas" / "run-manifest-v1.schema.json"
        ).read_text()
    )
    jsonschema.Draft202012Validator(schema).validate(manifest)


def test_schema_runtime_negative_corpus_for_expressible_constraints() -> None:
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads(
        (
            Path(__file__).resolve().parents[2] / "schemas" / "run-manifest-v1.schema.json"
        ).read_text()
    )
    validator = jsonschema.Draft202012Validator(schema)

    cases = []
    dangerous = _manifest()
    dangerous["invocation"]["parameters"] = {"my-command": "noop"}
    cases.append(dangerous)
    oversized_stored = _manifest()
    oversized_stored["artifacts"][0]["stored_size_bytes"] = MAX_STORED_BYTES + 1
    cases.append(oversized_stored)
    oversized_content = _manifest()
    oversized_content["artifacts"][0]["content_size_bytes"] = MAX_CONTENT_BYTES + 1
    cases.append(oversized_content)
    unsafe_detail = _manifest()
    unsafe_detail["failures"] = [
        {
            "code": "request_error",
            "stage": "fetch",
            "count": 1,
            "detail": "Authorization: do-not-print",
        }
    ]
    cases.append(unsafe_detail)

    for manifest in cases:
        with pytest.raises(ReplayValidationError):
            validate_manifest(manifest)
        assert list(validator.iter_errors(manifest))

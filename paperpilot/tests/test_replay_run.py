"""End-to-end tests for the network-free Replay Lite runner."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import shutil
import socket
import subprocess
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from types import MappingProxyType

import pytest

from paperpilot.replay.canonical import deterministic_gzip_bytes
from paperpilot.replay.manifest import ReplayValidationError
from paperpilot.scripts import replay_run

FIXTURE = Path(__file__).parent / "fixtures" / "replay-lite-r0"
NOW = datetime(2026, 8, 30, 12, tzinfo=timezone.utc)


def _fixture_copy(tmp_path: Path) -> Path:
    target = tmp_path / "fixture"
    shutil.copytree(FIXTURE, target)
    return target


def _snapshot(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _manifest(root: Path) -> dict[str, object]:
    return json.loads((root / "manifest.json").read_text(encoding="utf-8"))


def _write_manifest(root: Path, manifest: dict[str, object]) -> None:
    (root / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _run(root: Path, output: Path) -> Path:
    return replay_run.run_replay(
        manifest_path=root / "manifest.json",
        repository_root=root / "repository",
        artifact_root=root / "bundle",
        output_dir=output,
        now=NOW,
    )


def test_fixture_replay_succeeds_when_network_primitives_raise(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _fixture_copy(tmp_path)

    def forbidden(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("network primitive was called")

    for owner, name in (
        (socket.socket, "connect"),
        (socket.socket, "connect_ex"),
        (socket, "create_connection"),
        (socket, "getaddrinfo"),
        (socket, "gethostbyname"),
        (socket, "gethostbyname_ex"),
        (socket, "gethostbyaddr"),
    ):
        monkeypatch.setattr(owner, name, forbidden)

    output = _run(root, tmp_path / "output")
    manifest = _manifest(root)
    assert output.is_dir()
    for ref in manifest["outputs"]:
        payload = (output / ref["path"]).read_bytes()
        assert len(payload) == ref["stored_size_bytes"]
        assert hashlib.sha256(payload).hexdigest() == ref["sha256"]


def test_two_replays_to_different_directories_are_byte_identical(tmp_path: Path) -> None:
    root = _fixture_copy(tmp_path)
    first = _run(root, tmp_path / "first")
    second_output = tmp_path / "second"
    second_output.mkdir()
    second = _run(root, second_output)

    assert _snapshot(first) == _snapshot(second)


def test_preflight_failure_happens_before_projector_and_changes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _fixture_copy(tmp_path)
    (root / "repository" / "uv.lock").write_bytes(b"wrong lock\n")
    before = _snapshot(root)
    called = False

    def forbidden_projector(*_args: object, **_kwargs: object) -> None:
        nonlocal called
        called = True
        raise AssertionError("projector must not run")

    monkeypatch.setattr(replay_run, "project_catalogs", forbidden_projector)
    output = tmp_path / "output"
    with pytest.raises(ReplayValidationError) as exc:
        _run(root, output)

    assert exc.value.code == "REPLAY_DEPENDENCY_MISMATCH"
    assert called is False
    assert not output.exists()
    assert _snapshot(root) == before


def test_output_hash_mismatch_does_not_publish(tmp_path: Path) -> None:
    root = _fixture_copy(tmp_path)
    manifest = _manifest(root)
    manifest["outputs"][0]["sha256"] = "0" * 64
    _write_manifest(root, manifest)
    before = _snapshot(root)
    output = tmp_path / "output"

    with pytest.raises(ReplayValidationError) as exc:
        _run(root, output)

    assert exc.value.code == "REPLAY_OUTPUT_HASH_MISMATCH"
    assert not output.exists()
    assert _snapshot(root) == before
    assert not list(tmp_path.glob(".output.replay-tmp-*"))


def test_gzip_output_validates_content_and_stored_bytes(tmp_path: Path) -> None:
    root = _fixture_copy(tmp_path)
    manifest = _manifest(root)
    ref = manifest["outputs"][1]
    content = b'[["arxiv","2401.00001","c3bf9d1b4d28118e5fc41b99ef777a37960442e7"]]\n'
    stored = deterministic_gzip_bytes(content)
    ref["compression"] = "gzip"
    ref["stored_size_bytes"] = len(stored)
    ref["sha256"] = hashlib.sha256(stored).hexdigest()
    _write_manifest(root, manifest)

    output = _run(root, tmp_path / "output")

    assert (output / ref["path"]).read_bytes() == stored
    assert gzip.decompress(stored) == content


def test_success_does_not_change_inputs_or_state_files(tmp_path: Path) -> None:
    root = _fixture_copy(tmp_path)
    for relative in ("seen_ids.json", "history/run.json", "cache/value.json"):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"unchanged\n")
    before = _snapshot(root)

    _run(root, tmp_path / "output")

    assert _snapshot(root) == before


def test_configured_conference_cannot_escape_temporary_input_root(tmp_path: Path) -> None:
    root = _fixture_copy(tmp_path)
    payload = b'{"catalog_inputs":{"../escaped":"catalog"}}\n'
    config_path = root / "repository" / "config.json"
    config_path.write_bytes(payload)
    manifest = _manifest(root)
    ref = manifest["inputs"][0]
    ref["stored_size_bytes"] = len(payload)
    ref["content_size_bytes"] = len(payload)
    ref["sha256"] = hashlib.sha256(payload).hexdigest()
    _write_manifest(root, manifest)

    with pytest.raises(ReplayValidationError) as exc:
        _run(root, tmp_path / "output")

    assert exc.value.code == "REPLAY_PATH_INVALID"
    assert not (tmp_path / "escaped").exists()
    assert not (tmp_path / "output").exists()


def test_socket_attempt_is_reported_with_stable_network_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _fixture_copy(tmp_path)

    def network_projector(
        _manifest: dict[str, object], _content: dict[str, bytes]
    ) -> dict[PurePosixPath, bytes]:
        socket.create_connection(("example.invalid", 443))
        return {}

    monkeypatch.setattr(
        replay_run,
        "PROJECTOR_REGISTRY",
        MappingProxyType({"identity-lite-v1": network_projector}),
    )
    with pytest.raises(ReplayValidationError) as exc:
        _run(root, tmp_path / "output")

    assert exc.value.code == "REPLAY_NETWORK_DISABLED"
    assert not (tmp_path / "output").exists()


def test_subprocess_attempt_is_blocked_by_offline_guard(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _fixture_copy(tmp_path)

    def process_projector(
        _manifest: dict[str, object], _content: dict[str, bytes]
    ) -> dict[PurePosixPath, bytes]:
        subprocess.run(["definitely-not-executed"], check=False)
        return {}

    monkeypatch.setattr(
        replay_run,
        "PROJECTOR_REGISTRY",
        MappingProxyType({"identity-lite-v1": process_projector}),
    )
    with pytest.raises(ReplayValidationError) as exc:
        _run(root, tmp_path / "output")

    assert exc.value.code == "REPLAY_NETWORK_DISABLED"
    assert not (tmp_path / "output").exists()


@pytest.mark.parametrize("primitive", ["environment", "system", "sendto"])
def test_offline_guard_blocks_environment_process_and_datagram_primitives(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    primitive: str,
) -> None:
    root = _fixture_copy(tmp_path)

    # Safe sentinels make the regression test non-destructive even if a guard
    # target is accidentally removed in a future change.
    monkeypatch.setattr(os, "system", lambda _command: 0)
    monkeypatch.setattr(socket.socket, "sendto", lambda *_args, **_kwargs: 0)

    def side_effect_projector(
        _manifest: dict[str, object], _content: dict[str, bytes]
    ) -> dict[PurePosixPath, bytes]:
        if primitive == "environment":
            os.getenv("PAPERPILOT_REPLAY_FORBIDDEN")
        elif primitive == "system":
            os.system("definitely-not-executed")
        else:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as channel:
                channel.sendto(b"forbidden", ("127.0.0.1", 9))
        return {}

    monkeypatch.setattr(
        replay_run,
        "PROJECTOR_REGISTRY",
        MappingProxyType({"identity-lite-v1": side_effect_projector}),
    )
    with pytest.raises(ReplayValidationError) as exc:
        _run(root, tmp_path / "output")
    assert exc.value.code == "REPLAY_NETWORK_DISABLED"
    assert not (tmp_path / "output").exists()


def test_unexpected_projector_exception_is_sanitized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _fixture_copy(tmp_path)

    def broken_projector(
        _manifest: dict[str, object], _content: dict[str, bytes]
    ) -> dict[PurePosixPath, bytes]:
        raise RuntimeError("do-not-print")

    monkeypatch.setattr(
        replay_run,
        "PROJECTOR_REGISTRY",
        MappingProxyType({"identity-lite-v1": broken_projector}),
    )
    with pytest.raises(ReplayValidationError) as exc:
        _run(root, tmp_path / "output")
    assert exc.value.code == "REPLAY_MANIFEST_INVALID"
    assert exc.value.pointer == "/invocation/projector"
    assert "do-not-print" not in str(exc.value)


def test_registry_rejects_arbitrary_projector_before_output(tmp_path: Path) -> None:
    root = _fixture_copy(tmp_path)
    manifest = _manifest(root)
    manifest["invocation"]["projector"] = "os.system"
    _write_manifest(root, manifest)

    with pytest.raises(ReplayValidationError) as exc:
        _run(root, tmp_path / "output")

    assert exc.value.code == "REPLAY_MANIFEST_INVALID"
    assert exc.value.pointer == "/invocation/projector"
    assert not (tmp_path / "output").exists()


def test_config_key_cannot_inject_newline_into_error_pointer(tmp_path: Path) -> None:
    root = _fixture_copy(tmp_path)
    payload = b'{"catalog_inputs":{"evil\\nINJECT":"catalog"}}\n'
    config_path = root / "repository" / "config.json"
    config_path.write_bytes(payload)
    manifest = _manifest(root)
    ref = manifest["inputs"][0]
    ref["stored_size_bytes"] = len(payload)
    ref["content_size_bytes"] = len(payload)
    ref["sha256"] = hashlib.sha256(payload).hexdigest()
    _write_manifest(root, manifest)

    with pytest.raises(ReplayValidationError) as exc:
        _run(root, tmp_path / "output")
    assert exc.value.code == "REPLAY_PATH_INVALID"
    assert "\n" not in str(exc.value)
    assert "\\u000aINJECT" in exc.value.pointer


def test_preflight_taxonomy_precedes_unknown_projector(tmp_path: Path) -> None:
    root = _fixture_copy(tmp_path)
    manifest = _manifest(root)
    manifest["invocation"]["projector"] = "os.system"
    _write_manifest(root, manifest)
    (root / "repository" / "uv.lock").write_bytes(b"wrong lock\n")

    with pytest.raises(ReplayValidationError) as exc:
        _run(root, tmp_path / "output")

    assert exc.value.code == "REPLAY_DEPENDENCY_MISMATCH"


def test_output_root_is_checked_before_projector(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _fixture_copy(tmp_path)
    output = tmp_path / "output"
    output.mkdir()
    (output / "existing").write_bytes(b"preserve\n")
    called = False

    def forbidden_projector(*_args: object, **_kwargs: object) -> None:
        nonlocal called
        called = True
        raise AssertionError("projector must not run")

    monkeypatch.setattr(replay_run, "project_catalogs", forbidden_projector)
    with pytest.raises(ReplayValidationError) as exc:
        _run(root, output)

    assert exc.value.code == "REPLAY_PATH_INVALID"
    assert called is False
    assert (output / "existing").read_bytes() == b"preserve\n"


def test_output_path_taxonomy_precedes_unknown_projector(tmp_path: Path) -> None:
    root = _fixture_copy(tmp_path)
    manifest = _manifest(root)
    manifest["invocation"]["projector"] = "os.system"
    _write_manifest(root, manifest)
    output = tmp_path / "output"
    output.mkdir()
    (output / "existing").write_bytes(b"preserve\n")

    with pytest.raises(ReplayValidationError) as exc:
        _run(root, output)

    assert exc.value.code == "REPLAY_PATH_INVALID"
    assert (output / "existing").read_bytes() == b"preserve\n"


def test_output_dir_rejects_symlink_ancestor(tmp_path: Path) -> None:
    root = _fixture_copy(tmp_path)
    real = tmp_path / "real"
    (real / "child").mkdir(parents=True)
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)

    with pytest.raises(ReplayValidationError) as exc:
        _run(root, link / "child" / "output")

    assert exc.value.code == "REPLAY_PATH_INVALID"
    assert not (real / "child" / "output").exists()


def test_duplicate_output_path_is_rejected_before_projector(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _fixture_copy(tmp_path)
    manifest = _manifest(root)
    manifest["outputs"][1]["path"] = manifest["outputs"][0]["path"]
    _write_manifest(root, manifest)
    called = False

    def forbidden_projector(*_args: object, **_kwargs: object) -> None:
        nonlocal called
        called = True
        raise AssertionError("projector must not run")

    monkeypatch.setattr(replay_run, "project_catalogs", forbidden_projector)
    with pytest.raises(ReplayValidationError) as exc:
        _run(root, tmp_path / "output")

    assert exc.value.code == "REPLAY_MANIFEST_INVALID"
    assert called is False
    assert not (tmp_path / "output").exists()


def test_cli_failure_returns_stable_nonzero_code(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _fixture_copy(tmp_path)
    manifest = _manifest(root)
    manifest["outputs"][0]["stored_size_bytes"] += 1
    manifest["outputs"][0]["content_size_bytes"] += 1
    _write_manifest(root, manifest)

    code = replay_run.main(
        [
            "--manifest",
            str(root / "manifest.json"),
            "--repo-root",
            str(root / "repository"),
            "--artifact-root",
            str(root / "bundle"),
            "--output-dir",
            str(tmp_path / "output"),
            "--now",
            "2026-08-30T12:00:00Z",
        ]
    )

    assert code == 2
    assert capsys.readouterr().err.startswith("REPLAY_OUTPUT_HASH_MISMATCH")
    assert not (tmp_path / "output").exists()

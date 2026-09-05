"""Run one verified Replay Lite manifest without network access."""

from __future__ import annotations

import argparse
import copy
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterator, Mapping
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Any
from unittest.mock import patch

from paperpilot.identity.projector import project_catalogs
from paperpilot.replay.artifacts import validate_output_paths, validate_preflight
from paperpilot.replay.canonical import (
    canonical_json_bytes,
    deterministic_gzip_bytes,
    sha256_bytes,
    strict_json_loads,
)
from paperpilot.replay.manifest import (
    REPLAY_MANIFEST_INVALID,
    REPLAY_NETWORK_DISABLED,
    REPLAY_OUTPUT_HASH_MISMATCH,
    REPLAY_PATH_INVALID,
    ReplayValidationError,
    _pointer,
    load_manifest,
    parse_timestamp,
    validate_relative_path,
)

Projector = Callable[[dict[str, Any], Mapping[str, bytes]], dict[PurePosixPath, bytes]]


class _DeniedEnvironment(Mapping[str, str]):
    """Mapping that turns every process-environment access into a stable error."""

    def __getitem__(self, _key: str) -> str:
        _network_disabled()
        raise AssertionError("unreachable")

    def __iter__(self) -> Iterator[str]:
        _network_disabled()
        raise AssertionError("unreachable")

    def __len__(self) -> int:
        _network_disabled()
        raise AssertionError("unreachable")


def _invalid(pointer: str) -> ReplayValidationError:
    return ReplayValidationError(REPLAY_MANIFEST_INVALID, pointer)


def _identity_lite_projector(
    manifest: dict[str, Any], verified_content: Mapping[str, bytes]
) -> dict[PurePosixPath, bytes]:
    """Adapt verified frozen catalogs to the existing pure Identity projector."""

    invocation = manifest["invocation"]
    if invocation["parameters"]:
        raise _invalid("/invocation/parameters")

    config_id = invocation["config_input_id"]
    try:
        config = strict_json_loads(verified_content[config_id])
    except (KeyError, TypeError, ValueError, UnicodeDecodeError):
        raise _invalid(f"/inputs/{config_id}/content") from None
    if not isinstance(config, dict) or set(config) != {"catalog_inputs"}:
        raise _invalid(f"/inputs/{config_id}/content")

    catalog_inputs = config["catalog_inputs"]
    if not isinstance(catalog_inputs, dict) or not catalog_inputs:
        raise _invalid(f"/inputs/{config_id}/content/catalog_inputs")
    if not all(
        isinstance(key, str) and isinstance(value, str) for key, value in catalog_inputs.items()
    ):
        raise _invalid(f"/inputs/{config_id}/content/catalog_inputs")

    conference_names = sorted(catalog_inputs)
    if len(set(catalog_inputs.values())) != len(catalog_inputs):
        raise _invalid(f"/inputs/{config_id}/content/catalog_inputs")
    for conference in conference_names:
        conference_pointer = _pointer(f"/inputs/{config_id}/content/catalog_inputs", conference)
        path = validate_relative_path(
            conference,
            conference_pointer,
        )
        if len(path.parts) != 1:
            raise ReplayValidationError(
                REPLAY_PATH_INVALID,
                conference_pointer,
            )
        if catalog_inputs[conference] not in verified_content:
            raise _invalid(conference_pointer)

    try:
        with tempfile.TemporaryDirectory(prefix="paperpilot-replay-input-") as temporary:
            docs_root = Path(temporary)
            for conference in conference_names:
                conference_root = docs_root / conference
                conference_root.mkdir()
                conference_root.joinpath("papers.json").write_bytes(
                    verified_content[catalog_inputs[conference]]
                )
            projection = project_catalogs(
                docs_root,
                conference_names,
                as_of=manifest["as_of"],
            )
    except ReplayValidationError:
        raise
    except (OSError, TypeError, ValueError):
        raise _invalid("/invocation/projector") from None

    if not projection.valid:
        raise _invalid("/invocation/projector")

    projected: dict[PurePosixPath, bytes] = {
        PurePosixPath("identity-aliases-v1.json"): canonical_json_bytes(projection.aliases),
        PurePosixPath("identity-coverage-v1.json"): canonical_json_bytes(projection.coverage),
    }
    for conference, rows in projection.catalogs.items():
        projected[PurePosixPath(conference, "papers.json")] = canonical_json_bytes(rows)
    return projected


PROJECTOR_REGISTRY: Mapping[str, Projector] = MappingProxyType(
    {"identity-lite-v1": _identity_lite_projector}
)


def _network_disabled(*_args: object, **_kwargs: object) -> None:
    raise ReplayValidationError(REPLAY_NETWORK_DISABLED)


@contextmanager
def _offline_socket_guard() -> Iterator[None]:
    """Fail fast if a registered projector attempts network or process I/O."""

    targets = [
        patch.object(socket.socket, "connect", _network_disabled),
        patch.object(socket.socket, "connect_ex", _network_disabled),
        patch.object(socket.socket, "bind", _network_disabled),
        patch.object(socket.socket, "listen", _network_disabled),
        patch.object(socket.socket, "send", _network_disabled),
        patch.object(socket.socket, "sendall", _network_disabled),
        patch.object(socket.socket, "sendto", _network_disabled),
        patch.object(socket, "create_connection", _network_disabled),
        patch.object(socket, "socketpair", _network_disabled),
        patch.object(socket, "getaddrinfo", _network_disabled),
        patch.object(socket, "gethostbyname", _network_disabled),
        patch.object(socket, "gethostbyname_ex", _network_disabled),
        patch.object(socket, "gethostbyaddr", _network_disabled),
        patch.object(subprocess, "Popen", _network_disabled),
        patch.object(os, "environ", _DeniedEnvironment()),
        # Enter this after the class-method patches above so aliases such as
        # SocketType are guarded too, while every ordinary constructor fails.
        patch.object(socket, "socket", _network_disabled),
    ]
    if hasattr(os, "environb"):
        targets.append(patch.object(os, "environb", _DeniedEnvironment()))
    for name in (
        "system",
        "fork",
        "forkpty",
        "posix_spawn",
        "posix_spawnp",
        "execl",
        "execle",
        "execlp",
        "execlpe",
        "execv",
        "execve",
        "execvp",
        "execvpe",
        "spawnl",
        "spawnle",
        "spawnlp",
        "spawnlpe",
        "spawnv",
        "spawnve",
        "spawnvp",
        "spawnvpe",
        "getenv",
        "getenvb",
        "putenv",
        "unsetenv",
    ):
        if hasattr(os, name):
            targets.append(patch.object(os, name, _network_disabled))
    if hasattr(socket.socket, "sendmsg"):
        targets.append(patch.object(socket.socket, "sendmsg", _network_disabled))
    with ExitStack() as stack:
        for target in targets:
            stack.enter_context(target)
        yield


def _checked_projector(manifest: dict[str, Any]) -> Projector:
    name = manifest["invocation"]["projector"]
    try:
        return PROJECTOR_REGISTRY[name]
    except KeyError:
        raise _invalid("/invocation/projector") from None


def _validate_output_payloads(
    manifest: dict[str, Any], projected: Mapping[PurePosixPath, bytes]
) -> dict[str, bytes]:
    expected_by_path = {ref["path"]: ref for ref in manifest["outputs"]}
    if len(expected_by_path) != len(manifest["outputs"]):
        raise _invalid("/outputs")

    actual_by_path: dict[str, bytes] = {}
    for path, payload in projected.items():
        if not isinstance(path, PurePosixPath) or not isinstance(payload, bytes):
            raise ReplayValidationError(REPLAY_OUTPUT_HASH_MISMATCH, "/outputs")
        normalized = validate_relative_path(str(path), "/outputs")
        actual_by_path[str(normalized)] = payload

    if set(actual_by_path) != set(expected_by_path):
        raise ReplayValidationError(REPLAY_OUTPUT_HASH_MISMATCH, "/outputs")

    checked: dict[str, bytes] = {}
    for path, ref in expected_by_path.items():
        content = actual_by_path[path]
        if len(content) != ref["content_size_bytes"]:
            raise ReplayValidationError(REPLAY_OUTPUT_HASH_MISMATCH, f"/outputs/{ref['id']}")
        stored = deterministic_gzip_bytes(content) if ref["compression"] == "gzip" else content
        if len(stored) != ref["stored_size_bytes"]:
            raise ReplayValidationError(REPLAY_OUTPUT_HASH_MISMATCH, f"/outputs/{ref['id']}")
        if sha256_bytes(stored) != ref["sha256"]:
            raise ReplayValidationError(REPLAY_OUTPUT_HASH_MISMATCH, f"/outputs/{ref['id']}")
        checked[ref["id"]] = stored
    return checked


def _reject_duplicate_output_paths(manifest: dict[str, Any]) -> None:
    seen: set[str] = set()
    for index, ref in enumerate(manifest["outputs"]):
        path = ref["path"]
        if path in seen:
            raise _invalid(f"/outputs/{index}/path")
        seen.add(path)


def _validate_output_root(output_dir: Path) -> None:
    absolute = output_dir.absolute()
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current /= part
        try:
            if current.is_symlink():
                raise ReplayValidationError(REPLAY_PATH_INVALID, "/output-dir")
        except OSError:
            raise ReplayValidationError(REPLAY_PATH_INVALID, "/output-dir") from None
    try:
        info = output_dir.lstat()
    except FileNotFoundError:
        info = None
    except OSError:
        raise ReplayValidationError(REPLAY_PATH_INVALID, "/output-dir") from None
    if info is not None:
        if output_dir.is_symlink() or not output_dir.is_dir():
            raise ReplayValidationError(REPLAY_PATH_INVALID, "/output-dir")
        try:
            if any(output_dir.iterdir()):
                raise ReplayValidationError(REPLAY_PATH_INVALID, "/output-dir")
        except OSError:
            raise ReplayValidationError(REPLAY_PATH_INVALID, "/output-dir") from None
    if not output_dir.parent.is_dir() or output_dir.parent.is_symlink():
        raise ReplayValidationError(REPLAY_PATH_INVALID, "/output-dir")


def run_replay(
    *,
    manifest_path: str | Path,
    repository_root: str | Path,
    artifact_root: str | Path,
    output_dir: str | Path,
    now: datetime | None = None,
) -> Path:
    """Verify, project, and atomically publish one Replay Lite output tree."""

    manifest = load_manifest(manifest_path)
    verified_content = validate_preflight(
        manifest,
        repository_root=repository_root,
        artifact_root=artifact_root,
        now=datetime.now(timezone.utc) if now is None else now,
    )
    destination = Path(output_dir)
    _validate_output_root(destination)
    _reject_duplicate_output_paths(manifest)

    try:
        temporary = Path(
            tempfile.mkdtemp(prefix=f".{destination.name}.replay-tmp-", dir=destination.parent)
        )
    except OSError:
        raise ReplayValidationError(REPLAY_PATH_INVALID, "/output-dir") from None
    published = False
    try:
        output_paths = validate_output_paths(manifest, temporary)
        projector = _checked_projector(manifest)
        try:
            with _offline_socket_guard():
                projected = projector(
                    copy.deepcopy(manifest),
                    MappingProxyType(dict(verified_content)),
                )
        except ReplayValidationError:
            raise
        except Exception:
            raise _invalid("/invocation/projector") from None
        checked = _validate_output_payloads(manifest, projected)
        for output_id, path in output_paths.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(checked[output_id])
        os.replace(temporary, destination)
        published = True
    except ReplayValidationError:
        raise
    except OSError:
        raise ReplayValidationError(REPLAY_PATH_INVALID, "/output-dir") from None
    finally:
        if not published:
            shutil.rmtree(temporary, ignore_errors=True)
    return destination


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument(
        "--repo-root",
        "--repository-root",
        dest="repository_root",
        type=Path,
        required=True,
    )
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--now", help="fixed Replay time as RFC 3339 UTC ending in Z")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        now = None if args.now is None else parse_timestamp(args.now, "/now")
        run_replay(
            manifest_path=args.manifest,
            repository_root=args.repository_root,
            artifact_root=args.artifact_root,
            output_dir=args.output_dir,
            now=now,
        )
    except ReplayValidationError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

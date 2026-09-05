"""Ordered filesystem preflight for Replay Lite inputs and artifacts."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import stat
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

from .manifest import (
    MAX_CONTENT_BYTES,
    MAX_STORED_BYTES,
    REPLAY_ARTIFACT_EXPIRED,
    REPLAY_ARTIFACT_HASH_MISMATCH,
    REPLAY_ARTIFACT_MISSING,
    REPLAY_ARTIFACT_SIZE_MISMATCH,
    REPLAY_DEPENDENCY_MISMATCH,
    REPLAY_MANIFEST_INVALID,
    REPLAY_PATH_INVALID,
    REPLAY_SECRET_DETECTED,
    REPLAY_STATUS_NOT_REPLAYABLE,
    ReplayValidationError,
    _reject_constant,
    _unique_object,
    _validate_json_value,
    _validate_manifest_structure,
    parse_timestamp,
    scan_for_secrets,
    validate_manifest,
    validate_relative_path,
)

_SECRET_PAYLOAD_ROLES = {"config", "request", "llm_response"}
_JSON_MEDIA_TYPES = {"application/json"}
_JSONL_MEDIA_TYPES = {"application/jsonl", "application/x-ndjson"}
_IO_CHUNK_BYTES = 64 * 1024
_MAX_LOCK_BYTES = 16 * 1024 * 1024


@dataclass(frozen=True)
class _Candidate:
    ref: dict[str, Any]
    pointer: str
    path: Path
    root: Path
    relative: PurePosixPath


def _safe_filesystem_path(
    root_value: str | Path,
    relative_value: object,
    pointer: str,
) -> Path:
    """Resolve a contract path while rejecting every existing symlink segment."""

    relative = validate_relative_path(relative_value, pointer)
    root = Path(root_value).absolute()
    current_root = Path(root.anchor)
    for part in root.parts[1:]:
        current_root /= part
        try:
            ancestor_info = current_root.lstat()
        except OSError:
            raise ReplayValidationError(REPLAY_PATH_INVALID, pointer) from None
        if stat.S_ISLNK(ancestor_info.st_mode):
            raise ReplayValidationError(REPLAY_PATH_INVALID, pointer)
    try:
        root_info = root.lstat()
    except OSError:
        raise ReplayValidationError(REPLAY_PATH_INVALID, pointer) from None
    if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
        raise ReplayValidationError(REPLAY_PATH_INVALID, pointer)

    try:
        resolved_root = root.resolve(strict=True)
    except OSError:
        raise ReplayValidationError(REPLAY_PATH_INVALID, pointer) from None

    candidate = root.joinpath(*relative.parts)
    current = root
    for part in relative.parts:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            break
        except OSError:
            raise ReplayValidationError(REPLAY_PATH_INVALID, pointer) from None
        if stat.S_ISLNK(info.st_mode):
            raise ReplayValidationError(REPLAY_PATH_INVALID, pointer)

    try:
        resolved_candidate = candidate.resolve(strict=False)
    except (OSError, RuntimeError):
        raise ReplayValidationError(REPLAY_PATH_INVALID, pointer) from None
    if not resolved_candidate.is_relative_to(resolved_root):
        raise ReplayValidationError(REPLAY_PATH_INVALID, pointer)

    try:
        final_info = candidate.lstat()
    except FileNotFoundError:
        return candidate
    except OSError:
        raise ReplayValidationError(REPLAY_PATH_INVALID, pointer) from None
    if not stat.S_ISREG(final_info.st_mode):
        raise ReplayValidationError(REPLAY_PATH_INVALID, pointer)
    return candidate


def _raise_open_error(error: OSError, pointer: str, missing_code: str) -> None:
    if isinstance(error, FileNotFoundError):
        raise ReplayValidationError(missing_code, pointer) from None
    raise ReplayValidationError(REPLAY_PATH_INVALID, pointer) from None


def _open_regular_nofollow(
    root_value: str | Path,
    relative_value: object,
    pointer: str,
    *,
    missing_code: str,
) -> BinaryIO:
    """Open one regular file while pinning every POSIX path segment by fd.

    `dir_fd`/`O_NOFOLLOW` are unavailable on some platforms.  The fallback
    retains the lexical/lstat checks, while POSIX gets race-resistant ancestor
    traversal and a final descriptor that is used for size, hash and content.
    """

    relative = validate_relative_path(relative_value, pointer)
    root = Path(root_value).absolute()
    _safe_filesystem_path(root, relative_value, pointer)
    if os.name != "posix" or not hasattr(os, "O_NOFOLLOW"):
        path = root.joinpath(*relative.parts)
        try:
            stream = path.open("rb")
            info = os.fstat(stream.fileno())
        except OSError as error:
            _raise_open_error(error, pointer, missing_code)
        if not stat.S_ISREG(info.st_mode):
            stream.close()
            raise ReplayValidationError(REPLAY_PATH_INVALID, pointer)
        return stream

    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    file_flags = os.O_RDONLY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        directory_flags |= os.O_CLOEXEC
        file_flags |= os.O_CLOEXEC

    directory_fd = -1
    file_fd = -1
    try:
        directory_fd = os.open(root.anchor, directory_flags)
        for part in (*root.parts[1:], *relative.parts[:-1]):
            next_fd = os.open(part, directory_flags, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = next_fd
        file_fd = os.open(relative.parts[-1], file_flags, dir_fd=directory_fd)
        info = os.fstat(file_fd)
        if not stat.S_ISREG(info.st_mode):
            raise ReplayValidationError(REPLAY_PATH_INVALID, pointer)
        stream = os.fdopen(file_fd, "rb", closefd=True)
        file_fd = -1
        return stream
    except ReplayValidationError:
        raise
    except OSError as error:
        _raise_open_error(error, pointer, missing_code)
    finally:
        if file_fd >= 0:
            os.close(file_fd)
        if directory_fd >= 0:
            os.close(directory_fd)


def _read_bounded(
    stream: BinaryIO,
    limit: int,
    pointer: str,
    *,
    mismatch_code: str,
) -> tuple[bytes, str]:
    payload = bytearray()
    digest = hashlib.sha256()
    while len(payload) <= limit:
        chunk = stream.read(min(_IO_CHUNK_BYTES, limit + 1 - len(payload)))
        if not chunk:
            break
        payload.extend(chunk)
        digest.update(chunk)
    if len(payload) > limit:
        raise ReplayValidationError(mismatch_code, pointer)
    return bytes(payload), digest.hexdigest()


def _manifest_core(manifest: object) -> dict[str, Any]:
    """Apply manifest/semantic and secret phases, but defer path checks."""

    data = _validate_manifest_structure(manifest)
    scan_for_secrets(data)
    return data


def ensure_replayable(manifest: dict[str, Any]) -> None:
    if manifest["status"] != "succeeded":
        raise ReplayValidationError(REPLAY_STATUS_NOT_REPLAYABLE, "/status")


def validate_dependency(manifest: dict[str, Any], repository_root: str | Path) -> None:
    """Verify the actual uv lock bytes against the manifest digest."""

    dependency = manifest["dependencies"]
    pointer = "/dependencies/lock_path"
    try:
        with _open_regular_nofollow(
            repository_root,
            dependency["lock_path"],
            pointer,
            missing_code=REPLAY_DEPENDENCY_MISMATCH,
        ) as stream:
            _payload, digest = _read_bounded(
                stream,
                _MAX_LOCK_BYTES,
                pointer,
                mismatch_code=REPLAY_DEPENDENCY_MISMATCH,
            )
    except ReplayValidationError as error:
        if error.code == REPLAY_PATH_INVALID:
            raise
        raise ReplayValidationError(REPLAY_DEPENDENCY_MISMATCH, pointer) from None
    if digest != dependency["lock_sha256"]:
        raise ReplayValidationError(REPLAY_DEPENDENCY_MISMATCH, "/dependencies/lock_sha256")


def _validate_expiry(manifest: dict[str, Any], now: datetime) -> None:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ReplayValidationError(REPLAY_MANIFEST_INVALID, "/now")
    utc_now = now.astimezone(timezone.utc)
    for category in ("inputs", "artifacts"):
        for index, ref in enumerate(manifest[category]):
            expires_at = ref["expires_at"]
            if expires_at is None:
                continue
            pointer = f"/{category}/{index}/expires_at"
            if utc_now >= parse_timestamp(expires_at, pointer):
                raise ReplayValidationError(REPLAY_ARTIFACT_EXPIRED, pointer)


def _candidates(
    manifest: dict[str, Any],
    repository_root: str | Path,
    artifact_root: str | Path,
) -> list[_Candidate]:
    candidates: list[_Candidate] = []
    for category in ("inputs", "artifacts"):
        for index, ref in enumerate(manifest[category]):
            pointer = f"/{category}/{index}/path"
            root = repository_root if ref["storage"] == "repository" else artifact_root
            candidates.append(
                _Candidate(
                    ref=ref,
                    pointer=f"/{category}/{index}",
                    path=_safe_filesystem_path(root, ref["path"], pointer),
                    root=Path(root).absolute(),
                    relative=validate_relative_path(ref["path"], pointer),
                )
            )
    return candidates


def _open_all_candidates(stack: ExitStack, candidates: list[_Candidate]) -> list[BinaryIO]:
    streams: list[BinaryIO] = []
    for candidate in candidates:
        streams.append(
            stack.enter_context(
                _open_regular_nofollow(
                    candidate.root,
                    candidate.relative.as_posix(),
                    f"{candidate.pointer}/path",
                    missing_code=REPLAY_ARTIFACT_MISSING,
                )
            )
        )
    return streams


def _validate_stored_sizes(candidates: list[_Candidate], streams: list[BinaryIO]) -> None:
    for candidate, stream in zip(candidates, streams, strict=True):
        try:
            actual_size = os.fstat(stream.fileno()).st_size
        except OSError:
            raise ReplayValidationError(
                REPLAY_ARTIFACT_MISSING, f"{candidate.pointer}/path"
            ) from None
        if actual_size != candidate.ref["stored_size_bytes"]:
            raise ReplayValidationError(
                REPLAY_ARTIFACT_SIZE_MISMATCH,
                f"{candidate.pointer}/stored_size_bytes",
            )


def _read_and_validate_hashes(candidates: list[_Candidate], streams: list[BinaryIO]) -> list[bytes]:
    stored_payloads: list[bytes] = []
    for candidate, stream in zip(candidates, streams, strict=True):
        try:
            payload, digest = _read_bounded(
                stream,
                min(candidate.ref["stored_size_bytes"], MAX_STORED_BYTES),
                f"{candidate.pointer}/stored_size_bytes",
                mismatch_code=REPLAY_ARTIFACT_SIZE_MISMATCH,
            )
        except OSError:
            raise ReplayValidationError(
                REPLAY_ARTIFACT_MISSING, f"{candidate.pointer}/path"
            ) from None
        if len(payload) != candidate.ref["stored_size_bytes"]:
            raise ReplayValidationError(
                REPLAY_ARTIFACT_SIZE_MISMATCH,
                f"{candidate.pointer}/stored_size_bytes",
            )
        if digest != candidate.ref["sha256"]:
            raise ReplayValidationError(
                REPLAY_ARTIFACT_HASH_MISMATCH,
                f"{candidate.pointer}/sha256",
            )
        stored_payloads.append(payload)
    return stored_payloads


def _content_bytes(candidate: _Candidate, stored: bytes) -> bytes:
    if candidate.ref["compression"] == "gzip":
        try:
            expected_size = min(candidate.ref["content_size_bytes"], MAX_CONTENT_BYTES)
            with gzip.GzipFile(fileobj=io.BytesIO(stored), mode="rb") as stream:
                chunks: list[bytes] = []
                content_size = 0
                while content_size <= expected_size:
                    chunk = stream.read(min(_IO_CHUNK_BYTES, expected_size + 1 - content_size))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    content_size += len(chunk)
                content = b"".join(chunks)
        except (gzip.BadGzipFile, EOFError, OSError, OverflowError):
            raise ReplayValidationError(
                REPLAY_ARTIFACT_SIZE_MISMATCH,
                f"{candidate.pointer}/content_size_bytes",
            ) from None
    else:
        content = stored
    if len(content) != candidate.ref["content_size_bytes"]:
        raise ReplayValidationError(
            REPLAY_ARTIFACT_SIZE_MISMATCH,
            f"{candidate.pointer}/content_size_bytes",
        )
    return content


def _validate_json_and_secrets(candidate: _Candidate, content: bytes) -> None:
    pointer = f"{candidate.pointer}/content"
    try:
        media_type = candidate.ref["media_type"]
        protected = candidate.ref["role"] in _SECRET_PAYLOAD_ROLES
        if media_type in _JSON_MEDIA_TYPES or media_type.endswith("+json"):
            value = json.loads(
                content,
                object_pairs_hook=_unique_object,
                parse_constant=_reject_constant,
            )
            _validate_json_value(value, pointer)
            if (
                protected
                and candidate.ref["role"] == "config"
                and isinstance(value, dict)
                and "env" in value
            ):
                raise ReplayValidationError(REPLAY_SECRET_DETECTED, f"{pointer}/env")
            if protected:
                scan_for_secrets(value, pointer)
            return
        if media_type in _JSONL_MEDIA_TYPES:
            for index, line in enumerate(content.splitlines()):
                if not line.strip():
                    raise ValueError
                value = json.loads(
                    line,
                    object_pairs_hook=_unique_object,
                    parse_constant=_reject_constant,
                )
                value_pointer = f"{pointer}/{index}"
                _validate_json_value(value, value_pointer)
                if (
                    protected
                    and candidate.ref["role"] == "config"
                    and isinstance(value, dict)
                    and "env" in value
                ):
                    raise ReplayValidationError(REPLAY_SECRET_DETECTED, f"{pointer}/{index}/env")
                if protected:
                    scan_for_secrets(value, value_pointer)
            return
        if protected:
            scan_for_secrets(content.decode("utf-8"), pointer)
    except ReplayValidationError:
        raise
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        RecursionError,
        ValueError,
        TypeError,
    ):
        raise ReplayValidationError(REPLAY_MANIFEST_INVALID, pointer) from None


def validate_preflight(
    manifest: object,
    *,
    repository_root: str | Path,
    artifact_root: str | Path,
    now: datetime,
) -> dict[str, bytes]:
    """Validate Replay inputs in the contract order and return content bytes.

    No files are created or modified. The returned mapping contains inputs then
    artifacts in manifest order, keyed by their globally unique reference ID.
    """

    data = _manifest_core(manifest)
    ensure_replayable(data)
    validate_dependency(data, repository_root)
    _validate_expiry(data, now)
    candidates = _candidates(data, repository_root, artifact_root)
    for index, ref in enumerate(data["outputs"]):
        validate_relative_path(ref["path"], f"/outputs/{index}/path")
    with ExitStack() as stack:
        streams = _open_all_candidates(stack, candidates)
        _validate_stored_sizes(candidates, streams)
        stored_payloads = _read_and_validate_hashes(candidates, streams)

    verified_content: list[bytes] = []
    for candidate, stored in zip(candidates, stored_payloads, strict=True):
        verified_content.append(_content_bytes(candidate, stored))

    result: dict[str, bytes] = {}
    for candidate, content in zip(candidates, verified_content, strict=True):
        _validate_json_and_secrets(candidate, content)
        result[candidate.ref["id"]] = content
    return result


def validate_output_paths(
    manifest: object,
    output_root: str | Path,
) -> dict[str, Path]:
    """Validate destinations under an existing, real staging directory.

    The runner owns final ``--output-dir`` emptiness/nonexistence checks and
    passes its already-created sibling staging directory here. This helper is
    intentionally non-writing.
    """

    data = validate_manifest(manifest)
    result: dict[str, Path] = {}
    for index, ref in enumerate(data["outputs"]):
        pointer = f"/outputs/{index}/path"
        result[ref["id"]] = _safe_filesystem_path(output_root, ref["path"], pointer)
    return result

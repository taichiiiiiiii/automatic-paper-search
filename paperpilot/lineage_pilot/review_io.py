"""Secure local file boundaries for pending private lineage review bundles."""

from __future__ import annotations

import ctypes
import errno
import os
import secrets
import stat
import sys
from collections.abc import Callable, Mapping
from contextlib import suppress
from pathlib import Path
from types import MappingProxyType
from typing import NoReturn

from paperpilot.lineage_pilot.review_intake import (
    MAX_ANSWER_BYTES,
    PrivateReviewIntake,
    ingest_blind_review_answers,
)
from paperpilot.lineage_pilot.review_prep import (
    MAX_BLIND_PACK_BYTES,
    MAX_COORDINATOR_BYTES,
    MAX_SOURCE_SNAPSHOT_BYTES,
    MAX_SOURCE_SNAPSHOTS,
    MAX_TOTAL_SOURCE_BYTES,
    PrivateReviewBundle,
    PrivateReviewError,
    validated_private_review_files,
)

_REQUIRED_FLAG_NAMES = ("O_CLOEXEC", "O_DIRECTORY", "O_NOFOLLOW", "O_NONBLOCK")
_FILESYSTEM_SUPPORTED = (
    (sys.platform.startswith("linux") or sys.platform == "darwin")
    and all(hasattr(os, name) for name in _REQUIRED_FLAG_NAMES)
    and hasattr(os, "geteuid")
)
_DIRECTORY_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
_INPUT_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NONBLOCK", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
_OUTPUT_NAMES = ("coordinator.json", "reviewer-a.json", "reviewer-b.json")


class ReviewIOError(ValueError):
    """A stable, non-sensitive failure at the private local I/O boundary."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _fail(code: str) -> NoReturn:
    raise ReviewIOError(code) from None


def _require_supported_filesystem() -> None:
    if not _FILESYSTEM_SUPPORTED:
        _fail("filesystem_platform_unsupported")


def _open_error(error: OSError, *, missing_code: str) -> NoReturn:
    if error.errno in {errno.ELOOP, errno.EISDIR, errno.ENXIO}:
        _fail("input_not_regular")
    if error.errno in {errno.ENOENT, errno.ENOTDIR}:
        _fail(missing_code)
    _fail("input_unreadable")


def _open_input_without_symlinks(path: Path) -> int:
    """Open a final input using directory descriptors for every path component."""

    try:
        raw = os.fspath(path)
        if not raw or "\x00" in raw:
            _fail("input_path_invalid")
        parsed = Path(raw)
        parts = parsed.parts
        if not parts or parsed.name in {"", ".", ".."}:
            _fail("input_not_regular")
        if parsed.is_absolute():
            directory_fd = os.open(parsed.anchor, _DIRECTORY_FLAGS)
            parent_parts = parts[1:-1]
        else:
            directory_fd = os.open(".", _DIRECTORY_FLAGS)
            parent_parts = parts[:-1]
    except ReviewIOError:
        raise
    except (OSError, TypeError, ValueError) as error:
        if isinstance(error, OSError):
            _open_error(error, missing_code="input_missing")
        _fail("input_path_invalid")

    try:
        for part in parent_parts:
            if part == ".":
                continue
            try:
                next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=directory_fd)
            except OSError as error:
                _open_error(error, missing_code="input_missing")
            os.close(directory_fd)
            directory_fd = next_fd
        try:
            return os.open(parsed.name, _INPUT_FLAGS, dir_fd=directory_fd)
        except OSError as error:
            _open_error(error, missing_code="input_missing")
    finally:
        os.close(directory_fd)


def _unchanged(before: os.stat_result, after: os.stat_result, payload_size: int) -> bool:
    fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    return (
        all(getattr(before, field) == getattr(after, field) for field in fields)
        and after.st_size == payload_size
    )


def read_bounded_regular_file(path: Path, maximum: int) -> bytes:
    """Read one immutable regular-file snapshot, bounded to ``maximum + 1`` bytes."""

    _require_supported_filesystem()
    if type(maximum) is not int or maximum < 0:
        _fail("input_limit_invalid")
    descriptor = _open_input_without_symlinks(path)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            _fail("input_not_regular")
        if before.st_size > maximum:
            _fail("input_too_large")
        remaining = maximum + 1
        chunks: list[bytes] = []
        while remaining:
            chunk = os.read(descriptor, min(remaining, 1024 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        if len(payload) > maximum:
            _fail("input_too_large")
        after = os.fstat(descriptor)
        if not _unchanged(before, after, len(payload)):
            _fail("input_changed")
        return payload
    except ReviewIOError:
        raise
    except OSError:
        _fail("input_read_failed")
    finally:
        os.close(descriptor)


def read_source_snapshots(specifications: list[str]) -> MappingProxyType[str, bytes]:
    """Parse and read repeatable ``REF=PATH`` source snapshot arguments."""

    _require_supported_filesystem()
    if len(specifications) > MAX_SOURCE_SNAPSHOTS:
        _fail("source_count_invalid")
    parsed: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for specification in specifications:
        if type(specification) is not str or "=" not in specification:
            _fail("source_ref_invalid")
        reference, raw_path = specification.split("=", 1)
        if not reference or not raw_path or "\x00" in reference:
            _fail("source_ref_invalid")
        if reference in seen:
            _fail("source_ref_duplicate")
        seen.add(reference)
        parsed.append((reference, Path(raw_path)))

    total = 0
    snapshots: dict[str, bytes] = {}
    for reference, path in parsed:
        payload = read_bounded_regular_file(path, MAX_SOURCE_SNAPSHOT_BYTES)
        total += len(payload)
        if total > MAX_TOTAL_SOURCE_BYTES:
            _fail("source_inputs_too_large")
        snapshots[reference] = payload
    return MappingProxyType(snapshots)


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _has_git_marker(directory_fd: int) -> bool:
    try:
        os.stat(".git", dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    except OSError:
        _fail("output_path_invalid")
    return True


def _open_private_review_directory(path: Path, *, invalid_code: str) -> tuple[Path, int]:
    """Open a private directory; caller owns returned descriptor."""
    _require_supported_filesystem()
    try:
        raw = os.fspath(path)
        if type(raw) is not str or not raw or "\x00" in raw:
            _fail(invalid_code)
        parsed = Path(raw)
        if not parsed.is_absolute():
            _fail(invalid_code)
        if ".." in parsed.parts:
            _fail(invalid_code)
        normalized = Path(os.path.abspath(parsed))
    except ReviewIOError:
        raise
    except (OSError, TypeError, ValueError):
        _fail(invalid_code)

    owned_current_fd = -1
    owned_fds: list[int] = []
    try:
        root_fd = os.open(normalized.anchor, _DIRECTORY_FLAGS)
        owned_fds.append(root_fd)
        owned_current_fd = root_fd
        if _has_git_marker(owned_current_fd):
            _fail(invalid_code)
        for part in normalized.parts[1:]:
            try:
                next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=owned_current_fd)
            except OSError:
                _fail(invalid_code)
            owned_fds.append(next_fd)
            previous_fd = owned_current_fd
            owned_current_fd = next_fd
            os.close(previous_fd)
            owned_fds.remove(previous_fd)
            if _has_git_marker(owned_current_fd):
                _fail(invalid_code)
        final_stat = os.fstat(owned_current_fd)
        if not stat.S_ISDIR(final_stat.st_mode):
            _fail(invalid_code)
        if final_stat.st_uid != os.geteuid():
            _fail(invalid_code)
        if stat.S_IMODE(final_stat.st_mode) != 0o700:
            _fail(invalid_code)
        owned_fds.remove(owned_current_fd)
        return (normalized, owned_current_fd)
    except (ReviewIOError, OSError, TypeError, ValueError):
        _fail(invalid_code)
    finally:
        for fd in reversed(owned_fds):
            with suppress(OSError):
                os.close(fd)


_PrivateFileFingerprint = tuple[int, int, int, int, int, int, int, int]


def _private_file_fingerprint(stat_result: os.stat_result) -> _PrivateFileFingerprint:
    """Return an 8-tuple fingerprint from a stat result for integrity comparison."""
    return (
        stat_result.st_dev,
        stat_result.st_ino,
        stat_result.st_mode,
        stat_result.st_uid,
        stat_result.st_nlink,
        stat_result.st_size,
        stat_result.st_mtime_ns,
        stat_result.st_ctime_ns,
    )


def _read_private_review_file(
    directory_path: Path,
    directory_fd: int,
    filename: str,
    maximum: int,
    *,
    invalid_code: str,
    size_code: str,
    changed_code: str,
) -> tuple[bytes, _PrivateFileFingerprint]:
    _require_supported_filesystem()
    if type(filename) is not str:
        _fail(invalid_code)
    if not filename or filename in {".", ".."} or "/" in filename or "\x00" in filename:
        _fail(invalid_code)
    if type(maximum) is not int or isinstance(maximum, bool) or maximum < 0:
        _fail(invalid_code)

    owned_fds: list[int] = []
    error_code = invalid_code

    try:
        initial_dir_st = os.fstat(directory_fd)
        if (
            not stat.S_ISDIR(initial_dir_st.st_mode)
            or initial_dir_st.st_uid != os.geteuid()
            or stat.S_IMODE(initial_dir_st.st_mode) != 0o700
        ):
            _fail(invalid_code)
        initial_dir_fp = _private_file_fingerprint(initial_dir_st)

        def revalidate() -> None:
            _normalized_path, fd = _open_private_review_directory(
                directory_path, invalid_code=changed_code
            )
            owned_fds.append(fd)
            current_dir_st = os.fstat(fd)
            current_dir_fp = _private_file_fingerprint(current_dir_st)
            if current_dir_fp != initial_dir_fp:
                _fail(changed_code)
            borrowed_st = os.fstat(directory_fd)
            borrowed_fp = _private_file_fingerprint(borrowed_st)
            if borrowed_fp != initial_dir_fp:
                _fail(changed_code)
            os.close(fd)
            owned_fds.remove(fd)

        error_code = changed_code
        revalidate()

        error_code = invalid_code
        file_fd = os.open(filename, _INPUT_FLAGS, dir_fd=directory_fd)
        owned_fds.append(file_fd)
        initial_file_st = os.fstat(file_fd)
        if (
            not stat.S_ISREG(initial_file_st.st_mode)
            or initial_file_st.st_uid != os.geteuid()
            or stat.S_IMODE(initial_file_st.st_mode) != 0o600
            or initial_file_st.st_nlink != 1
        ):
            _fail(invalid_code)
        initial_file_fp = _private_file_fingerprint(initial_file_st)

        if initial_file_st.st_size > maximum:
            _fail(size_code)

        error_code = changed_code
        payload = bytearray()
        remaining = maximum + 1
        while remaining > 0:
            chunk = os.read(file_fd, min(remaining, 1048576))
            if not chunk:
                break
            payload.extend(chunk)
            remaining -= len(chunk)

        if len(payload) > maximum:
            _fail(size_code)

        post_file_st = os.fstat(file_fd)
        post_file_fp = _private_file_fingerprint(post_file_st)
        if post_file_fp != initial_file_fp or len(payload) != initial_file_st.st_size:
            _fail(changed_code)

        final_named_st = os.stat(filename, dir_fd=directory_fd, follow_symlinks=False)
        final_named_fp = _private_file_fingerprint(final_named_st)
        if final_named_fp != initial_file_fp:
            _fail(changed_code)

        revalidate()

        os.close(file_fd)
        owned_fds.remove(file_fd)

        return bytes(payload), initial_file_fp

    except OSError:
        _fail(error_code)
    finally:
        for fd in reversed(owned_fds):
            with suppress(OSError):
                os.close(fd)


def _read_private_answer(path: Path) -> bytes:
    _require_supported_filesystem()
    fd = -1
    code = "answer_input_not_private"
    try:
        raw = os.fspath(path)
        if not (type(raw) is str and raw and "\0" not in raw):
            _fail(code)
        parsed = Path(raw)
        if (
            not parsed.is_absolute()
            or ".." in parsed.parts
            or not parsed.name
            or parsed.name in (".", "..")
        ):
            _fail(code)
        normalized, fd = _open_private_review_directory(parsed.parent, invalid_code=code)
        payload, _ = _read_private_review_file(
            normalized,
            fd,
            parsed.name,
            MAX_ANSWER_BYTES,
            invalid_code="answer_input_not_private",
            size_code="answer_size",
            changed_code="answer_input_changed",
        )
        code = "answer_input_changed"
        os.close(fd)
        fd = -1
        return payload
    except ReviewIOError:
        raise
    except (OSError, TypeError, ValueError):
        _fail(code)
    finally:
        if fd >= 0:
            with suppress(OSError):
                os.close(fd)


def write_private_review_intake_from_paths(
    bundle: object,
    original_review_dir: Path,
    output_dir: Path,
    *,
    answered_reviewer_a_path: Path | None,
    answered_reviewer_b_path: Path | None,
    incorporated_at: str,
) -> PrivateReviewIntake:
    if answered_reviewer_a_path is None and answered_reviewer_b_path is None:
        _fail("answer_missing")

    _require_supported_filesystem()

    try:
        validated_mapping = validated_private_review_files(bundle)
    except PrivateReviewError as error:
        _fail(error.code)

    normalized_original, original_fd = _open_private_review_directory(
        original_review_dir, invalid_code="original_review_invalid"
    )

    try:
        try:
            initial_directory_stat = os.fstat(original_fd)
            listed_names = set(os.listdir(original_fd))
        except (OSError, TypeError, ValueError):
            _fail("original_review_invalid")

        expected_names = set(_OUTPUT_NAMES)
        if listed_names != expected_names:
            _fail("original_review_invalid")

        directory_fingerprint = _private_file_fingerprint(initial_directory_stat)
        factory_files = {name: validated_mapping[name] for name in _OUTPUT_NAMES}

        payload_mapping: dict[str, bytes] = {}
        fingerprint_mapping: dict[str, _PrivateFileFingerprint] = {}

        for name in _OUTPUT_NAMES:
            cap = MAX_COORDINATOR_BYTES if name == "coordinator.json" else MAX_BLIND_PACK_BYTES
            payload, file_fingerprint = _read_private_review_file(
                normalized_original,
                original_fd,
                name,
                cap,
                invalid_code="original_review_invalid",
                size_code="original_review_invalid",
                changed_code="original_review_changed",
            )
            if payload != factory_files[name]:
                _fail("original_bundle_mismatch")
            payload_mapping[name] = payload
            fingerprint_mapping[name] = file_fingerprint

        try:
            raw = os.fspath(output_dir)
            if type(raw) is not str or not raw or "\x00" in raw:
                _fail("output_path_invalid")

            parsed = Path(raw)
            if not parsed.is_absolute():
                _fail("output_path_invalid")
            if ".." in parsed.parts:
                _fail("output_path_invalid")
            if parsed.name in {"", ".", ".."}:
                _fail("output_path_invalid")

            normalized_output = Path(os.path.abspath(parsed))
        except ReviewIOError:
            raise
        except (OSError, TypeError, ValueError):
            _fail("output_path_invalid")

        if _is_within(normalized_output, normalized_original):
            _fail("output_original_review_forbidden")

        def callback() -> None:
            try:
                current_directory_stat = os.fstat(original_fd)
                current_fingerprint = _private_file_fingerprint(current_directory_stat)
                if current_fingerprint != directory_fingerprint:
                    _fail("original_review_changed")

                current_listed = set(os.listdir(original_fd))
                if current_listed != expected_names:
                    _fail("original_review_changed")

                for name in _OUTPUT_NAMES:
                    cap = (
                        MAX_COORDINATOR_BYTES
                        if name == "coordinator.json"
                        else MAX_BLIND_PACK_BYTES
                    )
                    current_payload, current_file_fingerprint = _read_private_review_file(
                        normalized_original,
                        original_fd,
                        name,
                        cap,
                        invalid_code="original_review_changed",
                        size_code="original_review_changed",
                        changed_code="original_review_changed",
                    )
                    if current_payload != payload_mapping[name]:
                        _fail("original_review_changed")
                    if current_file_fingerprint != fingerprint_mapping[name]:
                        _fail("original_review_changed")

                final_directory_stat = os.fstat(original_fd)
                final_fingerprint = _private_file_fingerprint(final_directory_stat)
                if final_fingerprint != directory_fingerprint:
                    _fail("original_review_changed")
            except ReviewIOError:
                raise
            except (OSError, TypeError, ValueError):
                _fail("original_review_changed")

        reviewer_a_bytes: bytes | None = None
        reviewer_b_bytes: bytes | None = None

        if answered_reviewer_a_path is not None:
            reviewer_a_bytes = _read_private_answer(answered_reviewer_a_path)
        if answered_reviewer_b_path is not None:
            reviewer_b_bytes = _read_private_answer(answered_reviewer_b_path)

        callback()

        try:
            result = ingest_blind_review_answers(
                bundle,
                answered_reviewer_a_bytes=reviewer_a_bytes,
                answered_reviewer_b_bytes=reviewer_b_bytes,
                incorporated_at=incorporated_at,
            )
        except PrivateReviewError as error:
            _fail(error.code)

        _write_private_files(
            {"intake.json": result.result_bytes},
            normalized_output,
            forbidden_ancestor_identity=(
                initial_directory_stat.st_dev,
                initial_directory_stat.st_ino,
            ),
            revalidate_callback=callback,
        )

        return result

    finally:
        try:
            os.close(original_fd)
        except OSError:
            with suppress(OSError):
                os.close(original_fd)


def _open_output_parent(
    output: Path,
    *,
    require_absent: bool = True,
    forbidden_ancestor_identity: tuple[int, int] | None = None,
) -> tuple[Path, int]:
    try:
        raw = os.fspath(output)
        parsed = Path(raw)
    except (OSError, TypeError, ValueError):
        _fail("output_path_invalid")
    if (
        not raw
        or "\x00" in raw
        or not parsed.is_absolute()
        or ".." in parsed.parts
        or parsed.name in {"", ".", ".."}
    ):
        _fail("output_path_invalid")
    normalized = Path(os.path.abspath(parsed))
    repository_root = Path(__file__).resolve().parents[2]
    if _is_within(normalized, repository_root):
        _fail("output_repository_forbidden")

    try:
        directory_fd = os.open(normalized.anchor, _DIRECTORY_FLAGS)
    except OSError:
        _fail("output_path_invalid")
    try:
        if _has_git_marker(directory_fd):
            _fail("output_repository_forbidden")
        root_stat = os.fstat(directory_fd)
        if (
            forbidden_ancestor_identity is not None
            and (root_stat.st_dev, root_stat.st_ino) == forbidden_ancestor_identity
        ):
            _fail("output_original_review_forbidden")
        for part in normalized.parent.parts[1:]:
            try:
                next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=directory_fd)
            except OSError as error:
                if error.errno == errno.ENOENT:
                    _fail("output_parent_missing")
                _fail("output_path_invalid")
            os.close(directory_fd)
            directory_fd = next_fd
            if _has_git_marker(directory_fd):
                _fail("output_repository_forbidden")
            current_stat = os.fstat(directory_fd)
            if (
                forbidden_ancestor_identity is not None
                and (current_stat.st_dev, current_stat.st_ino) == forbidden_ancestor_identity
            ):
                _fail("output_original_review_forbidden")
        parent_stat = os.fstat(directory_fd)
        if (
            not stat.S_ISDIR(parent_stat.st_mode)
            or parent_stat.st_uid != os.geteuid()
            or stat.S_IMODE(parent_stat.st_mode) != 0o700
        ):
            _fail("output_parent_not_private")
        if require_absent:
            try:
                existing = os.stat(normalized.name, dir_fd=directory_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            except OSError:
                _fail("output_path_invalid")
            else:
                if stat.S_ISLNK(existing.st_mode):
                    _fail("output_path_invalid")
                _fail("output_exists")
        return normalized, directory_fd
    except Exception:
        os.close(directory_fd)
        raise


def _verify_output_parent(
    output: Path,
    pinned_parent_fd: int,
    *,
    require_absent: bool = True,
    forbidden_ancestor_identity: tuple[int, int] | None = None,
) -> int:
    """Reopen the caller-visible parent and verify it is still the pinned directory."""

    _normalized, current_fd = _open_output_parent(
        output,
        require_absent=require_absent,
        forbidden_ancestor_identity=forbidden_ancestor_identity,
    )
    try:
        pinned = os.fstat(pinned_parent_fd)
        current = os.fstat(current_fd)
        if (pinned.st_dev, pinned.st_ino) != (current.st_dev, current.st_ino):
            _fail("output_parent_changed")
        return current_fd
    except Exception:
        os.close(current_fd)
        raise


def _rename_noreplace_at(parent_fd: int, source: str, destination: str) -> None:
    """Publish within one opened directory without replacing a race winner."""

    try:
        libc = ctypes.CDLL(None, use_errno=True)
        source_bytes = os.fsencode(source)
        destination_bytes = os.fsencode(destination)
        if sys.platform.startswith("linux"):
            operation = libc.renameat2
            operation.argtypes = [
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_uint,
            ]
            operation.restype = ctypes.c_int
            result = operation(parent_fd, source_bytes, parent_fd, destination_bytes, 1)
        elif sys.platform == "darwin":
            operation = libc.renameatx_np
            operation.argtypes = [
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_uint,
            ]
            operation.restype = ctypes.c_int
            result = operation(parent_fd, source_bytes, parent_fd, destination_bytes, 0x4)
        else:
            _fail("output_platform_unsupported")
    except ReviewIOError:
        raise
    except (AttributeError, OSError, TypeError, ValueError):
        _fail("output_write_failed")
    if result == 0:
        return
    if ctypes.get_errno() in {errno.EEXIST, errno.ENOTEMPTY}:
        _fail("output_exists")
    _fail("output_write_failed")


def _create_temporary_directory(parent_fd: int, output_name: str) -> tuple[str, int]:
    for _attempt in range(64):
        name = f".{output_name}.tmp-{secrets.token_hex(12)}"
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent_fd)
        except FileExistsError:
            continue
        except OSError:
            _fail("output_write_failed")
        try:
            descriptor = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
            os.fchmod(descriptor, 0o700)
            return name, descriptor
        except OSError:
            if "descriptor" in locals():
                os.close(descriptor)
            with suppress(OSError):
                os.rmdir(name, dir_fd=parent_fd)
            _fail("output_write_failed")
    _fail("output_write_failed")


def _write_all(descriptor: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            _fail("output_write_failed")
        view = view[written:]


def _cleanup_owned_directory(
    parent_fd: int,
    directory_fd: int,
    directory_name: str,
    output_names: tuple[str, ...] = _OUTPUT_NAMES,
) -> None:
    for name in output_names:
        try:
            os.unlink(name, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
        except OSError:
            pass
    try:
        named = os.stat(directory_name, dir_fd=parent_fd, follow_symlinks=False)
        opened = os.fstat(directory_fd)
    except OSError:
        return
    if (named.st_dev, named.st_ino) == (opened.st_dev, opened.st_ino):
        with suppress(OSError):
            os.rmdir(directory_name, dir_fd=parent_fd)


def _write_private_files(
    files: Mapping[str, bytes],
    output_dir: Path,
    *,
    forbidden_ancestor_identity: tuple[int, int] | None = None,
    revalidate_callback: Callable[[], None] | None = None,
) -> Path:
    """Persist a mapping of filenames to bytes into output_dir atomically."""
    output, parent_fd = _open_output_parent(
        output_dir,
        forbidden_ancestor_identity=forbidden_ancestor_identity,
    )
    temporary_name = ""
    temporary_fd = -1
    committed = False
    finished = False
    try:
        if revalidate_callback is not None:
            revalidate_callback()
        temporary_name, temporary_fd = _create_temporary_directory(parent_fd, output.name)
        for name in files:
            payload = files[name]
            try:
                descriptor = os.open(
                    name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
                    0o600,
                    dir_fd=temporary_fd,
                )
            except OSError:
                _fail("output_write_failed")
            try:
                os.fchmod(descriptor, 0o600)
                _write_all(descriptor, payload)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        if set(os.listdir(temporary_fd)) != set(files):
            _fail("output_write_failed")
        os.fsync(temporary_fd)
        current_parent_fd = _verify_output_parent(
            output,
            parent_fd,
            require_absent=True,
            forbidden_ancestor_identity=forbidden_ancestor_identity,
        )
        try:
            if revalidate_callback is not None:
                revalidate_callback()
            _rename_noreplace_at(parent_fd, temporary_name, output.name)
            committed = True
            os.fsync(parent_fd)
        finally:
            os.close(current_parent_fd)
        visible_parent_fd = _verify_output_parent(
            output,
            parent_fd,
            require_absent=False,
            forbidden_ancestor_identity=forbidden_ancestor_identity,
        )
        try:
            try:
                visible = os.stat(output.name, dir_fd=visible_parent_fd, follow_symlinks=False)
            except OSError:
                _fail("output_parent_changed")
            written = os.fstat(temporary_fd)
            if (visible.st_dev, visible.st_ino) != (written.st_dev, written.st_ino):
                _fail("output_parent_changed")
        finally:
            os.close(visible_parent_fd)
        if revalidate_callback is not None:
            revalidate_callback()
        finished = True
        return output
    except ReviewIOError:
        raise
    except OSError:
        _fail("output_write_failed")
    finally:
        if temporary_fd >= 0:
            if not finished:
                owned_name = output.name if committed else temporary_name
                _cleanup_owned_directory(
                    parent_fd, temporary_fd, owned_name, output_names=tuple(files)
                )
            os.close(temporary_fd)
        os.close(parent_fd)


def write_private_review_bundle(bundle: object, output_dir: Path) -> Path:
    """Atomically write one factory-validated bundle into a fresh private directory."""

    _require_supported_filesystem()
    if not isinstance(bundle, PrivateReviewBundle):
        _fail("review_bundle_invalid")
    try:
        files = validated_private_review_files(bundle)
    except PrivateReviewError as error:
        _fail(error.code)
    if set(files) != set(_OUTPUT_NAMES):
        _fail("bundle_invalid")

    return _write_private_files(files, output_dir)


def write_private_review_intake(
    bundle: object,
    output_dir: Path,
    *,
    answered_reviewer_a_bytes: bytes | None,
    answered_reviewer_b_bytes: bytes | None,
    incorporated_at: str,
) -> PrivateReviewIntake:
    """Write a private review intake result into a fresh private directory."""
    _require_supported_filesystem()
    if not isinstance(bundle, PrivateReviewBundle):
        _fail("review_bundle_invalid")
    try:
        result = ingest_blind_review_answers(
            bundle,
            answered_reviewer_a_bytes=answered_reviewer_a_bytes,
            answered_reviewer_b_bytes=answered_reviewer_b_bytes,
            incorporated_at=incorporated_at,
        )
    except PrivateReviewError as error:
        _fail(error.code)
    files: Mapping[str, bytes] = {"intake.json": result.result_bytes}
    _write_private_files(files, output_dir)
    return result

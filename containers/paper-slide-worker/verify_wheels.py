"""Verify immutable worker image inputs before an offline wheel install."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import os
import re
import stat
from pathlib import Path

_DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
_REGISTRY = re.compile(
    r"(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+"
    r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?\Z"
)
_REPOSITORY_COMPONENT = re.compile(r"[a-z0-9]+(?:[._-][a-z0-9]+)*\Z")
_PAPERPILOT_WHEEL = re.compile(r"paperpilot-[0-9][A-Za-z0-9_.!+~-]*-py3-none-any\.whl\Z")
_PYPDF_WHEEL = re.compile(r"pypdf-6\.[0-9][A-Za-z0-9_.!+~-]*-py3-none-any\.whl\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_MAX_WHEEL_BYTES = 256 * 1024 * 1024


def _validate_base_reference(value: str) -> None:
    """Accept a tag-free OCI repository bound to one lowercase SHA-256 digest."""

    if value.count("@") != 1:
        raise ValueError("base image must use one immutable digest")
    repository, digest = value.split("@", 1)
    if not repository or not _DIGEST.fullmatch(digest):
        raise ValueError("base image digest is invalid")
    components = repository.split("/")
    if len(components) < 2 or any(not component for component in components):
        raise ValueError("base image repository is invalid")
    registry_match = _REGISTRY.fullmatch(components[0])
    if registry_match is None:
        raise ValueError("base image registry is invalid")
    port = registry_match.group(1)
    if port is not None and int(port) > 65535:
        raise ValueError("base image registry is invalid")
    if any(not _REPOSITORY_COMPONENT.fullmatch(component) for component in components[1:]):
        raise ValueError("base image repository is invalid")


def _open_wheelhouse(wheelhouse: Path) -> int:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0)
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if nofollow:
        flags |= nofollow
    try:
        path_stat = os.lstat(wheelhouse)
        if not stat.S_ISDIR(path_stat.st_mode):
            raise ValueError("wheelhouse is unavailable")
        descriptor = os.open(wheelhouse, flags)
        opened_stat = os.fstat(descriptor)
    except ValueError:
        raise
    except OSError:
        raise ValueError("wheelhouse is unavailable") from None
    if not stat.S_ISDIR(opened_stat.st_mode) or (path_stat.st_dev, path_stat.st_ino) != (
        opened_stat.st_dev,
        opened_stat.st_ino,
    ):
        os.close(descriptor)
        raise ValueError("wheelhouse is unavailable")
    return descriptor


def _open_regular_at(directory_fd: int, filename: str) -> tuple[int, os.stat_result]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if nofollow:
        flags |= nofollow
    try:
        path_stat = os.stat(filename, dir_fd=directory_fd, follow_symlinks=False)
        if not stat.S_ISREG(path_stat.st_mode):
            raise ValueError("wheel is unavailable")
        descriptor = os.open(filename, flags, dir_fd=directory_fd)
        opened_stat = os.fstat(descriptor)
    except ValueError:
        raise
    except OSError:
        raise ValueError("wheel is unavailable") from None
    if (
        not stat.S_ISREG(opened_stat.st_mode)
        or (path_stat.st_dev, path_stat.st_ino) != (opened_stat.st_dev, opened_stat.st_ino)
        or not 1 <= opened_stat.st_size <= _MAX_WHEEL_BYTES
    ):
        os.close(descriptor)
        raise ValueError("wheel is unavailable")
    return descriptor, opened_stat


def _write_all(descriptor: int, block: bytes) -> None:
    offset = 0
    while offset < len(block):
        written = os.write(descriptor, block[offset:])
        if written < 1:
            raise ValueError("wheel staging failed")
        offset += written


def _verify_wheel_at(
    wheelhouse_fd: int,
    filename: str,
    expected_sha256: str,
    filename_pattern: re.Pattern[str],
    *,
    staging_fd: int | None = None,
) -> None:
    if not filename_pattern.fullmatch(filename):
        raise ValueError("wheel filename is invalid")
    if not _SHA256.fullmatch(expected_sha256):
        raise ValueError("wheel digest is invalid")
    source_fd, before = _open_regular_at(wheelhouse_fd, filename)
    destination_fd: int | None = None
    try:
        if staging_fd is not None:
            destination_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
            destination_flags |= getattr(os, "O_NOFOLLOW", 0)
            try:
                destination_fd = os.open(
                    filename,
                    destination_flags,
                    0o444,
                    dir_fd=staging_fd,
                )
            except OSError:
                raise ValueError("wheel staging failed") from None
        digest_builder = hashlib.sha256()
        remaining = _MAX_WHEEL_BYTES + 1
        byte_count = 0
        while remaining:
            block = os.read(source_fd, min(1024 * 1024, remaining))
            if not block:
                break
            digest_builder.update(block)
            byte_count += len(block)
            remaining -= len(block)
            if destination_fd is not None:
                _write_all(destination_fd, block)
        after = os.fstat(source_fd)
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
        if stable_before != stable_after or byte_count != before.st_size:
            raise ValueError("wheel changed during verification")
        if not hmac.compare_digest(digest_builder.hexdigest(), expected_sha256):
            raise ValueError("wheel digest mismatch")
        if destination_fd is not None:
            os.fsync(destination_fd)
    finally:
        os.close(source_fd)
        if destination_fd is not None:
            os.close(destination_fd)


def _verified_wheel(
    wheelhouse: Path,
    filename: str,
    expected_sha256: str,
    filename_pattern: re.Pattern[str],
) -> Path:
    directory_fd = _open_wheelhouse(wheelhouse)
    try:
        _verify_wheel_at(directory_fd, filename, expected_sha256, filename_pattern)
    finally:
        os.close(directory_fd)
    return wheelhouse / filename


def _validate_closed_wheelhouse(wheelhouse: Path, expected_filenames: tuple[str, str]) -> None:
    """Require exactly two distinct, non-symlink regular wheel entries."""

    if len(set(expected_filenames)) != 2:
        raise ValueError("wheel filenames must be distinct")
    directory_fd = _open_wheelhouse(wheelhouse)
    try:
        names = os.listdir(directory_fd)
        if len(names) != 2 or set(names) != set(expected_filenames):
            raise ValueError("wheelhouse entries are invalid")
        for name in names:
            entry_stat = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if not stat.S_ISREG(entry_stat.st_mode):
                raise ValueError("wheelhouse entries are invalid")
    except ValueError:
        raise
    except OSError:
        raise ValueError("wheelhouse entries are invalid") from None
    finally:
        os.close(directory_fd)


def _create_staging_directory(path: Path) -> int:
    try:
        os.mkdir(path, mode=0o700)
    except OSError:
        raise ValueError("wheel staging failed") from None
    return _open_wheelhouse(path)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--base-ref", required=True)
    parser.add_argument("--wheelhouse", required=True, type=Path)
    parser.add_argument("--paperpilot-wheel", required=True)
    parser.add_argument("--paperpilot-sha256", required=True)
    parser.add_argument("--pypdf-wheel", required=True)
    parser.add_argument("--pypdf-sha256", required=True)
    parser.add_argument("--staging-directory", type=Path)
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    _validate_base_reference(arguments.base_ref)
    wheelhouse = arguments.wheelhouse
    _validate_closed_wheelhouse(
        wheelhouse,
        (arguments.paperpilot_wheel, arguments.pypdf_wheel),
    )
    wheelhouse_fd = _open_wheelhouse(wheelhouse)
    staging_fd = None
    try:
        if arguments.staging_directory is not None:
            staging_fd = _create_staging_directory(arguments.staging_directory)
        _verify_wheel_at(
            wheelhouse_fd,
            arguments.paperpilot_wheel,
            arguments.paperpilot_sha256,
            _PAPERPILOT_WHEEL,
            staging_fd=staging_fd,
        )
        _verify_wheel_at(
            wheelhouse_fd,
            arguments.pypdf_wheel,
            arguments.pypdf_sha256,
            _PYPDF_WHEEL,
            staging_fd=staging_fd,
        )
    finally:
        os.close(wheelhouse_fd)
        if staging_fd is not None:
            os.close(staging_fd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

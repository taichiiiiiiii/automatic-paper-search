"""Tests for _read_private_review_file in review_io."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from paperpilot.lineage_pilot import review_io as io


def _setup_private_dir(tmp_path: Path) -> Path:
    """Create a private directory with mode 0700 and return its resolved path."""
    d = tmp_path / "private"
    d.mkdir(mode=0o700)
    d.chmod(0o700)
    return d.resolve()


def _write_private_file(directory: Path, filename: str, data: bytes) -> None:
    """Write a file with mode 0600 inside the given directory."""
    fpath = directory / filename
    fpath.write_bytes(data)
    fpath.chmod(0o600)


class TestReadPrivateReviewFileSuccess:
    def test_success_returns_payload_and_fingerprint(self, tmp_path, monkeypatch):
        directory = _setup_private_dir(tmp_path)
        content = b"hello world"
        _write_private_file(directory, "review.txt", content)

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            payload, fp = io._read_private_review_file(
                directory,
                dir_fd,
                "review.txt",
                len(content),
                invalid_code="INVALID",
                size_code="SIZE",
                changed_code="CHANGED",
            )
        finally:
            os.close(dir_fd)

        assert payload == content
        st = os.stat(directory / "review.txt")
        expected_fp = io._private_file_fingerprint(st)
        assert fp == expected_fp

    def test_borrowed_fd_not_closed(self, tmp_path):
        directory = _setup_private_dir(tmp_path)
        content = b"data"
        _write_private_file(directory, "f.txt", content)

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            io._read_private_review_file(
                directory,
                dir_fd,
                "f.txt",
                len(content),
                invalid_code="INVALID",
                size_code="SIZE",
                changed_code="CHANGED",
            )
            # Should not raise EBADF if FD is still open
            os.fstat(dir_fd)
        finally:
            os.close(dir_fd)


class TestReadPrivateReviewFileCaps:
    def test_exact_cap_allowed(self, tmp_path):
        directory = _setup_private_dir(tmp_path)
        content = b"x" * 10
        _write_private_file(directory, "exact.bin", content)

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            payload, _ = io._read_private_review_file(
                directory,
                dir_fd,
                "exact.bin",
                10,
                invalid_code="INVALID",
                size_code="SIZE",
                changed_code="CHANGED",
            )
        finally:
            os.close(dir_fd)

        assert payload == content

    def test_overflow_rejected(self, tmp_path):
        directory = _setup_private_dir(tmp_path)
        content = b"x" * 11
        _write_private_file(directory, "overflow.bin", content)

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            with pytest.raises(io.ReviewIOError) as exc_info:
                io._read_private_review_file(
                    directory,
                    dir_fd,
                    "overflow.bin",
                    10,
                    invalid_code="INVALID",
                    size_code="SIZE",
                    changed_code="CHANGED",
                )
            assert exc_info.value.code == "SIZE"
        finally:
            os.close(dir_fd)

    def test_maximum_zero_empty_file(self, tmp_path):
        directory = _setup_private_dir(tmp_path)
        _write_private_file(directory, "empty.bin", b"")

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            payload, _ = io._read_private_review_file(
                directory,
                dir_fd,
                "empty.bin",
                0,
                invalid_code="INVALID",
                size_code="SIZE",
                changed_code="CHANGED",
            )
        finally:
            os.close(dir_fd)

        assert payload == b""


class TestReadPrivateReviewFileBadBasename:
    @pytest.mark.parametrize("name", ["", ".", "..", "a/b", "a\x00b"])
    def test_bad_basename_rejected(self, tmp_path, name):
        directory = _setup_private_dir(tmp_path)

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            with pytest.raises(io.ReviewIOError) as exc_info:
                io._read_private_review_file(
                    directory,
                    dir_fd,
                    name,
                    10,
                    invalid_code="INVALID",
                    size_code="SIZE",
                    changed_code="CHANGED",
                )
            assert exc_info.value.code == "INVALID"
        finally:
            os.close(dir_fd)


class TestReadPrivateReviewFileModeVariants:
    def test_mode_0400_rejected(self, tmp_path):
        directory = _setup_private_dir(tmp_path)
        fpath = directory / "r.txt"
        fpath.write_bytes(b"test")
        fpath.chmod(0o400)

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            with pytest.raises(io.ReviewIOError) as exc_info:
                io._read_private_review_file(
                    directory,
                    dir_fd,
                    "r.txt",
                    10,
                    invalid_code="INVALID",
                    size_code="SIZE",
                    changed_code="CHANGED",
                )
            assert exc_info.value.code == "INVALID"
        finally:
            os.close(dir_fd)

    def test_mode_0644_rejected(self, tmp_path):
        directory = _setup_private_dir(tmp_path)
        fpath = directory / "w.txt"
        fpath.write_bytes(b"test")
        fpath.chmod(0o644)

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            with pytest.raises(io.ReviewIOError) as exc_info:
                io._read_private_review_file(
                    directory,
                    dir_fd,
                    "w.txt",
                    10,
                    invalid_code="INVALID",
                    size_code="SIZE",
                    changed_code="CHANGED",
                )
            assert exc_info.value.code == "INVALID"
        finally:
            os.close(dir_fd)


class TestReadPrivateReviewFileTypeChecks:
    def test_symlink_rejected(self, tmp_path):
        directory = _setup_private_dir(tmp_path)
        target = directory / "target.txt"
        target.write_bytes(b"real")
        target.chmod(0o600)
        link = directory / "link.txt"
        link.symlink_to(target)

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            with pytest.raises(io.ReviewIOError) as exc_info:
                io._read_private_review_file(
                    directory,
                    dir_fd,
                    "link.txt",
                    10,
                    invalid_code="INVALID",
                    size_code="SIZE",
                    changed_code="CHANGED",
                )
            assert exc_info.value.code == "INVALID"
        finally:
            os.close(dir_fd)

    def test_fifo_rejected(self, tmp_path):
        directory = _setup_private_dir(tmp_path)
        fifo = directory / "pipe"
        os.mkfifo(str(fifo))
        fifo.chmod(0o600)

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            with pytest.raises(io.ReviewIOError) as exc_info:
                io._read_private_review_file(
                    directory,
                    dir_fd,
                    "pipe",
                    10,
                    invalid_code="INVALID",
                    size_code="SIZE",
                    changed_code="CHANGED",
                )
            assert exc_info.value.code == "INVALID"
        finally:
            os.close(dir_fd)

    def test_directory_as_filename_rejected(self, tmp_path):
        directory = _setup_private_dir(tmp_path)
        subdir = directory / "subdir"
        subdir.mkdir(mode=0o700)

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            with pytest.raises(io.ReviewIOError) as exc_info:
                io._read_private_review_file(
                    directory,
                    dir_fd,
                    "subdir",
                    10,
                    invalid_code="INVALID",
                    size_code="SIZE",
                    changed_code="CHANGED",
                )
            assert exc_info.value.code == "INVALID"
        finally:
            os.close(dir_fd)

    def test_hardlink_nlink_gt1_rejected(self, tmp_path):
        directory = _setup_private_dir(tmp_path)
        original = directory / "orig.txt"
        original.write_bytes(b"content")
        original.chmod(0o600)
        hardlink = directory / "hard.txt"
        os.link(str(original), str(hardlink))

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            with pytest.raises(io.ReviewIOError) as exc_info:
                io._read_private_review_file(
                    directory,
                    dir_fd,
                    "hard.txt",
                    10,
                    invalid_code="INVALID",
                    size_code="SIZE",
                    changed_code="CHANGED",
                )
            assert exc_info.value.code == "INVALID"
        finally:
            os.close(dir_fd)


class TestReadPrivateReviewFileInodeSwap:
    def test_same_byte_named_inode_swap_detected(self, tmp_path, monkeypatch):
        """Simulate inode swap by wrapping os.read to change the file between open and read."""
        directory = _setup_private_dir(tmp_path)
        content_a = b"AAAA"
        content_b = b"AAAA"
        fpath = directory / "swap.txt"
        fpath.write_bytes(content_a)
        fpath.chmod(0o600)

        original_read = os.read
        call_count = [0]

        def swapping_read(fd, n):
            call_count[0] += 1
            if call_count[0] == 1:
                # First read call: swap the file content on disk
                replacement = directory / "replacement"
                replacement.write_bytes(content_b)
                replacement.chmod(0o600)
                replacement.replace(fpath)
            return original_read(fd, n)

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            monkeypatch.setattr(io.os, "read", swapping_read)
            with pytest.raises(io.ReviewIOError) as exc_info:
                io._read_private_review_file(
                    directory,
                    dir_fd,
                    "swap.txt",
                    10,
                    invalid_code="INVALID",
                    size_code="SIZE",
                    changed_code="CHANGED",
                )
            assert exc_info.value.code == "CHANGED"
        finally:
            os.close(dir_fd)


class TestReadPrivateReviewFileParentRenameSwap:
    def test_parent_rename_swap_detected(self, tmp_path, monkeypatch):
        """Simulate parent directory being renamed/swapped after initial validation."""
        directory = _setup_private_dir(tmp_path)
        content = b"data"
        _write_private_file(directory, "file.txt", content)

        original_read = os.read
        changed = False

        def renaming_read(fd, size):
            nonlocal changed
            if not changed:
                changed = True
                directory.rename(directory.with_name("moved"))
                directory.mkdir(mode=0o700)
            return original_read(fd, size)

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            monkeypatch.setattr(io.os, "read", renaming_read)
            with pytest.raises(io.ReviewIOError) as exc_info:
                io._read_private_review_file(
                    directory,
                    dir_fd,
                    "file.txt",
                    10,
                    invalid_code="INVALID",
                    size_code="SIZE",
                    changed_code="CHANGED",
                )
            assert exc_info.value.code == "CHANGED"
        finally:
            os.close(dir_fd)


class TestReadPrivateReviewFileInPlaceWrite:
    def test_in_place_write_and_restore_detects_changed(self, tmp_path, monkeypatch):
        """Simulate in-place modification detected via post-read fingerprint mismatch."""
        directory = _setup_private_dir(tmp_path)
        content = b"original"
        fpath = directory / "modify.txt"
        fpath.write_bytes(content)
        fpath.chmod(0o600)

        original_read = os.read
        changed = False

        def tampering_read(fd, size):
            nonlocal changed
            if not changed:
                changed = True
                fpath.write_bytes(b"modified")
                fpath.write_bytes(content)
            return original_read(fd, size)

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            monkeypatch.setattr(io.os, "read", tampering_read)
            with pytest.raises(io.ReviewIOError) as exc_info:
                io._read_private_review_file(
                    directory,
                    dir_fd,
                    "modify.txt",
                    10,
                    invalid_code="INVALID",
                    size_code="SIZE",
                    changed_code="CHANGED",
                )
            assert exc_info.value.code == "CHANGED"
        finally:
            os.close(dir_fd)


class TestReadPrivateReviewFileReadError:
    def test_read_error_mapped_to_changed(self, tmp_path, monkeypatch):
        directory = _setup_private_dir(tmp_path)
        content = b"test"
        _write_private_file(directory, "err.txt", content)

        def failing_read(fd, n):
            raise OSError("read failed")

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            monkeypatch.setattr(io.os, "read", failing_read)
            with pytest.raises(io.ReviewIOError) as exc_info:
                io._read_private_review_file(
                    directory,
                    dir_fd,
                    "err.txt",
                    10,
                    invalid_code="INVALID",
                    size_code="SIZE",
                    changed_code="CHANGED",
                )
            assert exc_info.value.code == "CHANGED"
        finally:
            os.close(dir_fd)


class TestReadPrivateReviewFilePostStatError:
    def test_post_stat_error_mapped_to_changed(self, tmp_path, monkeypatch):
        directory = _setup_private_dir(tmp_path)
        content = b"test"
        _write_private_file(directory, "stat_err.txt", content)

        original_fstat = os.fstat
        original_read = os.read
        did_read = False

        def recording_read(fd, size):
            nonlocal did_read
            did_read = True
            return original_read(fd, size)

        def failing_post_fstat(fd):
            if did_read:
                raise OSError("sensitive stat failure")
            return original_fstat(fd)

        dir_fd = os.open(str(directory), io._DIRECTORY_FLAGS)
        try:
            monkeypatch.setattr(io.os, "read", recording_read)
            monkeypatch.setattr(io.os, "fstat", failing_post_fstat)
            with pytest.raises(io.ReviewIOError) as exc_info:
                io._read_private_review_file(
                    directory,
                    dir_fd,
                    "stat_err.txt",
                    10,
                    invalid_code="INVALID",
                    size_code="SIZE",
                    changed_code="CHANGED",
                )
            assert exc_info.value.code == "CHANGED"
        finally:
            os.close(dir_fd)

import os
from pathlib import Path

import pytest

import paperpilot.lineage_pilot.review_io as io


def test_success(tmp_path):
    private = tmp_path.resolve() / "private"
    private.mkdir(mode=0o700)
    normalized, fd = io._open_private_review_directory(private, invalid_code="private_invalid")
    try:
        assert normalized == private
        st = os.fstat(fd)
        pst = private.stat()
        assert st.st_dev == pst.st_dev
        assert st.st_ino == pst.st_ino
    finally:
        os.close(fd)


@pytest.mark.parametrize("mode", [0o755, 0o710, 0o770])
def test_bad_mode(tmp_path, mode):
    private = tmp_path.resolve() / "private"
    private.mkdir(mode=mode)
    private.chmod(mode)
    with pytest.raises(io.ReviewIOError) as excinfo:
        io._open_private_review_directory(private, invalid_code="private_invalid")
    assert excinfo.value.code == "private_invalid"
    assert str(excinfo.value) == "private_invalid"


@pytest.mark.parametrize(
    "kind",
    [
        "relative",
        "dotdot",
        "nul",
        "missing",
        "file",
        "symlink",
        "ancestor_symlink",
        "git_final",
        "git_ancestor",
    ],
)
def test_rejected_paths(tmp_path, kind):
    private = tmp_path.resolve() / "private"
    private.mkdir(mode=0o700)
    base = tmp_path.resolve()

    if kind == "relative":
        path = Path("private")
    elif kind == "dotdot":
        path = Path(str(private) + "/../private")
    elif kind == "nul":
        path = Path("bad\x00")
    elif kind == "missing":
        path = tmp_path / "no_such_dir"
    elif kind == "file":
        fpath = private / "somefile.txt"
        fpath.write_text("x")
        path = fpath
    elif kind == "symlink":
        alias = base / "alias"
        alias.symlink_to(private)
        path = alias
    elif kind == "ancestor_symlink":
        child = private / "child"
        child.mkdir()
        alias = base / "alias"
        alias.symlink_to(private)
        path = alias / "child"
    elif kind == "git_final":
        marker = private / ".git"
        marker.mkdir()
        path = private
    elif kind == "git_ancestor":
        marker = base / ".git"
        marker.mkdir()
        path = private
    else:
        raise AssertionError(f"unknown kind {kind}")

    with pytest.raises(io.ReviewIOError) as excinfo:
        io._open_private_review_directory(path, invalid_code="private_invalid")
    assert excinfo.value.code == "private_invalid"
    assert str(excinfo.value) == "private_invalid"


def test_has_git_marker_raises_mapped(tmp_path, monkeypatch):
    private = tmp_path.resolve() / "private"
    private.mkdir(mode=0o700)

    def fake_has_git_marker(_path):
        raise io.ReviewIOError("output_path_invalid")

    monkeypatch.setattr(io, "_has_git_marker", fake_has_git_marker)

    with pytest.raises(io.ReviewIOError) as excinfo:
        io._open_private_review_directory(private, invalid_code="private_invalid")
    assert excinfo.value.code == "private_invalid"
    assert str(excinfo.value) == "private_invalid"


def test_unsupported_filesystem_preserved(tmp_path, monkeypatch):
    private = tmp_path.resolve() / "private"
    private.mkdir(mode=0o700)

    monkeypatch.setattr(io, "_FILESYSTEM_SUPPORTED", False)

    with pytest.raises(io.ReviewIOError) as excinfo:
        io._open_private_review_directory(private, invalid_code="private_invalid")
    assert excinfo.value.code == "filesystem_platform_unsupported"
    assert str(excinfo.value) == "filesystem_platform_unsupported"

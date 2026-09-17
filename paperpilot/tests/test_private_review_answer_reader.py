"""Independent boundary checks for the private answer path wrapper."""

import os
from pathlib import Path

import pytest

from paperpilot.lineage_pilot import review_io as io


def _answer(tmp_path: Path) -> Path:
    parent = tmp_path.resolve() / "private"
    parent.mkdir(mode=0o700)
    parent.chmod(0o700)
    answer = parent / "answer.json"
    answer.write_bytes(b"answer")
    answer.chmod(0o600)
    return answer


def test_private_answer_path_returns_exact_bytes(tmp_path):
    assert io._read_private_answer(_answer(tmp_path)) == b"answer"


@pytest.mark.parametrize(
    "mutation", ["relative", "dotdot", "missing", "symlink", "mode", "parent", "git", "directory"]
)
def test_private_answer_path_rejects_nonprivate_inputs(tmp_path, mutation):
    answer = _answer(tmp_path)
    if mutation == "relative":
        answer = Path("answer.json")
    elif mutation == "dotdot":
        answer = answer.parent / ".." / "private" / answer.name
    elif mutation == "missing":
        answer = answer.with_name("missing")
    elif mutation == "symlink":
        link = answer.with_name("link")
        link.symlink_to(answer)
        answer = link
    elif mutation == "mode":
        answer.chmod(0o644)
    elif mutation == "parent":
        answer.parent.chmod(0o755)
    elif mutation == "git":
        (answer.parent / ".git").mkdir()
    else:
        answer = answer.parent
    with pytest.raises(io.ReviewIOError) as error:
        io._read_private_answer(answer)
    assert error.value.code == "answer_input_not_private"


def test_private_answer_size_code_is_preserved(tmp_path, monkeypatch):
    answer = _answer(tmp_path)
    monkeypatch.setattr(io, "MAX_ANSWER_BYTES", 3)
    with pytest.raises(io.ReviewIOError) as error:
        io._read_private_answer(answer)
    assert error.value.code == "answer_size"


def test_private_answer_changed_code_is_preserved(tmp_path, monkeypatch):
    answer = _answer(tmp_path)

    def fail_read(*args):
        raise OSError("private sentinel")

    monkeypatch.setattr(io.os, "read", fail_read)
    with pytest.raises(io.ReviewIOError) as error:
        io._read_private_answer(answer)
    assert error.value.code == "answer_input_changed"


def test_private_answer_unsupported_precedes_file_access(monkeypatch):
    monkeypatch.setattr(io, "_FILESYSTEM_SUPPORTED", False)

    def forbidden(*args, **kwargs):
        pytest.fail("filesystem touched")

    monkeypatch.setattr(os, "open", forbidden)
    with pytest.raises(io.ReviewIOError) as error:
        io._read_private_answer(Path("/private/absent/answer"))
    assert error.value.code == "filesystem_platform_unsupported"

import os
from pathlib import Path

import pytest

import paperpilot.lineage_pilot.review_io as review_io


def _make_parent(tmp_path: Path) -> Path:
    parent = tmp_path.resolve() / "private"
    parent.mkdir(mode=0o700)
    parent.chmod(0o700)
    return parent


class CallbackCounter:
    def __init__(self) -> None:
        self.calls: list[int] = []
        self.phase: int = 0

    def callback(self) -> None:
        self.phase += 1
        self.calls.append(self.phase)


class CallbackRaiser:
    def __init__(self, phase_to_fail: int) -> None:
        self.phase_to_fail = phase_to_fail
        self.current_phase: int = 0

    def callback(self) -> None:
        self.current_phase += 1
        if self.current_phase == self.phase_to_fail:
            raise review_io.ReviewIOError("callback_blocked")


class CallbackOSErrorRaiser:
    def __init__(self, phase_to_fail: int) -> None:
        self.phase_to_fail = phase_to_fail
        self.current_phase: int = 0

    def callback(self) -> None:
        self.current_phase += 1
        if self.current_phase == self.phase_to_fail:
            raise OSError("os failure")


def test_default_success(tmp_path: Path) -> None:
    parent = _make_parent(tmp_path)
    output_dir = parent / "dest"
    files = {"intake.json": b"{}"}
    result = review_io._write_private_files(files, output_dir)
    assert result == output_dir
    intake_file = output_dir / "intake.json"
    assert intake_file.read_bytes() == b"{}"


def test_callback_three_calls(tmp_path: Path) -> None:
    """Callback should be called 3 times during a successful write."""
    parent = _make_parent(tmp_path)
    output_dir = parent / "dest"
    counter = CallbackCounter()
    files = {"intake.json": b"{}"}

    review_io._write_private_files(files, output_dir, revalidate_callback=counter.callback)
    assert counter.calls == [1, 2, 3]


def test_callback_raises_reviewioerror_phase1(tmp_path: Path) -> None:
    parent = _make_parent(tmp_path)
    output_dir = parent / "dest"
    raiser = CallbackRaiser(phase_to_fail=1)
    files = {"intake.json": b"{}"}

    with pytest.raises(review_io.ReviewIOError, match="callback_blocked"):
        review_io._write_private_files(files, output_dir, revalidate_callback=raiser.callback)

    # Verify temp directory was cleaned up
    entries = list(parent.iterdir())
    assert len(entries) == 0 or all(not e.name.startswith(".dest.tmp-") for e in entries)
    # Output dir should not exist
    assert not output_dir.exists()


def test_callback_raises_reviewioerror_phase2(tmp_path: Path) -> None:
    parent = _make_parent(tmp_path)
    output_dir = parent / "dest"
    raiser = CallbackRaiser(phase_to_fail=2)
    files = {"intake.json": b"{}"}

    with pytest.raises(review_io.ReviewIOError, match="callback_blocked"):
        review_io._write_private_files(files, output_dir, revalidate_callback=raiser.callback)

    # Temp should be cleaned up, output should not exist
    assert not output_dir.exists()


def test_callback_raises_reviewioerror_phase3(tmp_path: Path) -> None:
    parent = _make_parent(tmp_path)
    output_dir = parent / "dest"
    raiser = CallbackRaiser(phase_to_fail=3)
    files = {"intake.json": b"{}"}

    with pytest.raises(review_io.ReviewIOError, match="callback_blocked"):
        review_io._write_private_files(files, output_dir, revalidate_callback=raiser.callback)

    # After commit, output should be cleaned up since we own it
    assert not output_dir.exists()


def test_callback_oserror_maps_to_output_write_failed(tmp_path: Path) -> None:
    parent = _make_parent(tmp_path)
    output_dir = parent / "dest"
    raiser = CallbackOSErrorRaiser(phase_to_fail=1)
    files = {"intake.json": b"{}"}

    with pytest.raises(review_io.ReviewIOError, match="output_write_failed"):
        review_io._write_private_files(files, output_dir, revalidate_callback=raiser.callback)


def test_forbidden_outer_ancestor_identity_rejected(tmp_path: Path) -> None:
    parent = _make_parent(tmp_path)
    output_dir = parent / "dest"
    # Get identity of tmp_path itself (an ancestor)
    forbidden_stat = os.stat(tmp_path.resolve())
    forbidden_identity = (forbidden_stat.st_dev, forbidden_stat.st_ino)
    files = {"intake.json": b"{}"}

    with pytest.raises(review_io.ReviewIOError, match="output_original_review_forbidden"):
        review_io._write_private_files(
            files, output_dir, forbidden_ancestor_identity=forbidden_identity
        )


def test_forbidden_parent_identity_rejected(tmp_path: Path) -> None:
    parent = _make_parent(tmp_path)
    output_dir = parent / "dest"
    # Get identity of the output parent.
    forbidden_stat = os.stat(parent)
    forbidden_identity = (forbidden_stat.st_dev, forbidden_stat.st_ino)
    files = {"intake.json": b"{}"}

    with pytest.raises(review_io.ReviewIOError, match="output_original_review_forbidden"):
        review_io._write_private_files(
            files, output_dir, forbidden_ancestor_identity=forbidden_identity
        )


def test_forbidden_final_parent_rejected(tmp_path: Path) -> None:
    parent = _make_parent(tmp_path)
    output_dir = parent / "dest"
    # Get identity of the final parent directory
    forbidden_stat = os.stat(parent)
    forbidden_identity = (forbidden_stat.st_dev, forbidden_stat.st_ino)
    files = {"intake.json": b"{}"}

    with pytest.raises(review_io.ReviewIOError, match="output_original_review_forbidden"):
        review_io._write_private_files(
            files, output_dir, forbidden_ancestor_identity=forbidden_identity
        )


def test_nonmatching_identity_success(tmp_path: Path) -> None:
    parent = _make_parent(tmp_path)
    output_dir = parent / "dest"
    # Use a fake identity that doesn't match anything
    forbidden_identity = (99999, 99999)
    files = {"intake.json": b"{}"}

    result = review_io._write_private_files(
        files, output_dir, forbidden_ancestor_identity=forbidden_identity
    )
    assert result == output_dir
    assert (output_dir / "intake.json").read_bytes() == b"{}"


def test_competing_winner_preserved(tmp_path: Path) -> None:
    parent = _make_parent(tmp_path)
    output_dir = parent / "dest"
    output_dir.mkdir(mode=0o700)
    # Create a "competing winner" file
    winner_file = output_dir / "intake.json"
    winner_file.write_bytes(b"winner")

    files = {"intake.json": b"loser"}
    with pytest.raises(review_io.ReviewIOError, match="output_exists"):
        review_io._write_private_files(files, output_dir)

    # Competing winner should be preserved
    assert winner_file.read_bytes() == b"winner"


def test_forbidden_identity_precedes_existing_output_rejection(tmp_path: Path) -> None:
    """Reject a forbidden parent even when the destination already exists."""
    parent = _make_parent(tmp_path)
    output_dir = parent / "dest"

    # First, create the output directory successfully
    files = {"intake.json": b"{}"}
    review_io._write_private_files(files, output_dir)

    # Now get the identity of parent
    forbidden_stat = os.stat(parent)
    forbidden_identity = (forbidden_stat.st_dev, forbidden_stat.st_ino)

    # The forbidden identity is detected during the initial parent open.
    files2 = {"intake.json": b"updated"}
    with pytest.raises(review_io.ReviewIOError, match="output_original_review_forbidden"):
        review_io._write_private_files(
            files2, output_dir, forbidden_ancestor_identity=forbidden_identity
        )

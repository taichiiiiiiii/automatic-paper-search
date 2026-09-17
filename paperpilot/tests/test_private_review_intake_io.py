import hashlib
import json
import os
import socket
import stat
import subprocess
from pathlib import Path

import pytest

import paperpilot.lineage_pilot.review_io as review_io
from paperpilot.lineage_pilot.review_intake import ReviewIntakeError, ingest_blind_review_answers
from paperpilot.lineage_pilot.review_prep import PrivateReviewBundle
from paperpilot.tests.test_lineage_review_intake import _answer_bytes
from paperpilot.tests.test_lineage_review_prep import _prepare


def _write(
    bundle: object,
    output: Path,
    *,
    a: bytes | None = None,
    b: bytes | None = None,
    incorporated_at: str = "2026-09-05T04:00:00Z",
) -> review_io.PrivateReviewIntake:
    return review_io.write_private_review_intake(
        bundle,
        output,
        answered_reviewer_a_bytes=a,
        answered_reviewer_b_bytes=b,
        incorporated_at=incorporated_at,
    )


@pytest.mark.parametrize(
    ("scenario",),
    [
        ("no_answers",),
        ("a_only",),
        ("both_agree",),
        ("disagreement",),
    ],
)
def test_four_states(tmp_path: Path, scenario: str) -> None:
    parent = tmp_path.resolve() / "private"
    parent.mkdir(mode=0o700)
    parent.chmod(0o700)
    output = parent / "intake"

    bundle = _prepare()
    a: bytes | None = _answer_bytes(bundle, "a")
    b: bytes | None = _answer_bytes(bundle, "b")

    if scenario == "no_answers":
        a = None
        b = None
    elif scenario == "a_only":
        b = None
    elif scenario == "both_agree":
        pass
    else:  # disagreement
        assert b is not None
        parsed_b = json.loads(b)
        parsed_b["candidates"][0]["response"]["citation_valid"] = False
        b = json.dumps(parsed_b).encode()

    result = _write(bundle, output, a=a, b=b)

    direct_result = ingest_blind_review_answers(
        bundle,
        answered_reviewer_a_bytes=a,
        answered_reviewer_b_bytes=b,
        incorporated_at="2026-09-05T04:00:00Z",
    )

    expected_status = (
        "pending"
        if scenario in ("no_answers", "a_only")
        else ("complete" if scenario == "both_agree" else "disagreement")
    )
    assert result.status == expected_status
    assert result.result_bytes == direct_result.result_bytes
    assert hashlib.sha256(result.result_bytes).hexdigest() == result.result_sha256
    assert isinstance(result.candidate_count, int)
    assert isinstance(result.dual_reviewed_count, int)
    assert isinstance(result.pending_review_ids, tuple)
    assert isinstance(result.disagreement_review_ids, tuple)

    intake_path = output / "intake.json"
    stored_bytes = intake_path.read_bytes()
    assert stored_bytes == result.result_bytes

    data = json.loads(stored_bytes)
    for key in (
        "audit_fixture_authorized",
        "artifact_update_authorized",
        "quality_authorized",
        "publication_authorized",
    ):
        assert data[key] is False

    assert stat.S_IMODE(output.stat().st_mode) == 0o700
    assert stat.S_IMODE(intake_path.stat().st_mode) == 0o600
    assert set(os.listdir(output)) == {"intake.json"}


def test_idempotent_sibling(tmp_path: Path) -> None:
    parent = tmp_path.resolve() / "private"
    parent.mkdir(mode=0o700)
    parent.chmod(0o700)

    bundle = _prepare()
    a = _answer_bytes(bundle, "a")
    b = _answer_bytes(bundle, "b")

    output1 = parent / "intake1"
    output2 = parent / "intake2"

    r1 = _write(bundle, output1, a=a, b=b)
    r2 = _write(bundle, output2, a=a, b=b)

    assert r1.result_bytes == r2.result_bytes
    assert r1.result_sha256 == r2.result_sha256


@pytest.mark.parametrize(
    ("bad_bundle",),
    [
        (object(),),
        ("corrupt_content",),
        ("previous_intake",),
    ],
)
def test_forged_inputs_rejected(tmp_path: Path, bad_bundle: object) -> None:
    parent = tmp_path.resolve() / "private"
    parent.mkdir(mode=0o700)
    parent.chmod(0o700)
    output = parent / "intake"

    valid_bundle = _prepare()
    a = _answer_bytes(valid_bundle, "a")

    if bad_bundle == "corrupt_content":
        forged: object = PrivateReviewBundle(
            files=valid_bundle.files,
            coordinator_sha256=valid_bundle.coordinator_sha256,
            reviewer_pack_sha256s=dict(valid_bundle.reviewer_pack_sha256s),
        )
    elif bad_bundle == "previous_intake":
        prev_result = ingest_blind_review_answers(
            valid_bundle,
            answered_reviewer_a_bytes=a,
            answered_reviewer_b_bytes=_answer_bytes(valid_bundle, "b"),
            incorporated_at="2026-09-05T04:00:00Z",
        )
        forged = prev_result
    else:
        forged = bad_bundle

    with pytest.raises(review_io.ReviewIOError):
        _write(forged, output, a=a)

    assert not output.exists()


def test_invalid_incorporated_at(tmp_path: Path) -> None:
    parent = tmp_path.resolve() / "private"
    parent.mkdir(mode=0o700)
    parent.chmod(0o700)
    output = parent / "intake"

    bundle = _prepare()
    a = _answer_bytes(bundle, "a")

    with pytest.raises(ReviewIntakeError):
        _write(bundle, output, a=a, incorporated_at="not-a-date")

    assert not output.exists()


def test_existing_output_preserved(tmp_path: Path) -> None:
    parent = tmp_path.resolve() / "private"
    parent.mkdir(mode=0o700)
    parent.chmod(0o700)
    output = parent / "intake"
    output.mkdir(mode=0o700)
    sentinel = output / "sentinel.txt"
    sentinel.write_text("keep")

    bundle = _prepare()
    a = _answer_bytes(bundle, "a")
    b = _answer_bytes(bundle, "b")

    with pytest.raises(review_io.ReviewIOError, match=r"^output_exists$"):
        _write(bundle, output, a=a, b=b)

    assert sentinel.read_text() == "keep"


@pytest.mark.parametrize("mode", [0o755, 0o750, 0o777])
def test_non_private_parent_rejected(tmp_path: Path, mode: int) -> None:
    parent = tmp_path.resolve() / "private"
    parent.mkdir(mode=mode)
    parent.chmod(mode)
    output = parent / "intake"

    bundle = _prepare()
    a = _answer_bytes(bundle, "a")

    with pytest.raises(review_io.ReviewIOError, match="output_parent_not_private"):
        _write(bundle, output, a=a)

    assert not output.exists()


def test_repository_forbidden(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    output = repo_root / ".forbidden-intake"

    bundle = _prepare()
    a = _answer_bytes(bundle, "a")

    with pytest.raises(review_io.ReviewIOError, match="output_repository_forbidden"):
        _write(bundle, output, a=a)

    assert not output.exists()


@pytest.mark.parametrize(
    ("fault",),
    [
        ("partial_write",),
        ("race_winner",),
        ("parent_swap",),
        ("permission_widen",),
    ],
)
def test_fault_injection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fault: str) -> None:
    parent = tmp_path.resolve() / "private"
    parent.mkdir(mode=0o700)
    parent.chmod(0o700)
    output = parent / "intake"

    bundle = _prepare()
    a = _answer_bytes(bundle, "a")
    b = _answer_bytes(bundle, "b")

    original_create_temp = review_io._create_temporary_directory

    if fault == "partial_write":

        def failing_write_all(fd: int, payload: bytes) -> None:
            os.write(fd, payload[:1])
            raise OSError("injected")

        monkeypatch.setattr(review_io, "_write_all", failing_write_all)
        with pytest.raises(review_io.ReviewIOError, match="output_write_failed"):
            _write(bundle, output, a=a, b=b)
        assert not output.exists()
        assert len(os.listdir(parent)) == 0

    elif fault == "race_winner":

        def race_wrapper(parent_fd: int, output_name: str) -> tuple[str, int]:
            pair = original_create_temp(parent_fd, output_name)
            output.mkdir(mode=0o700)
            winner = output / "winner.txt"
            winner.write_text("winner")
            return pair

        monkeypatch.setattr(review_io, "_create_temporary_directory", race_wrapper)
        with pytest.raises(review_io.ReviewIOError, match=r"^output_exists$"):
            _write(bundle, output, a=a, b=b)
        winner_path = output / "winner.txt"
        assert winner_path.read_text() == "winner"
        assert set(os.listdir(output)) == {"winner.txt"}
        assert set(os.listdir(parent)) == {"intake"}

    elif fault == "parent_swap":
        parked = parent.with_name("parked")

        def swap_wrapper(parent_fd: int, output_name: str) -> tuple[str, int]:
            pair = original_create_temp(parent_fd, output_name)
            parent.rename(parked)
            parent.mkdir(mode=0o700)
            (parent / "sentinel.txt").write_text("new")
            return pair

        monkeypatch.setattr(review_io, "_create_temporary_directory", swap_wrapper)
        with pytest.raises(review_io.ReviewIOError, match="output_parent_changed"):
            _write(bundle, output, a=a, b=b)
        assert not output.exists()
        assert parked.is_dir()
        assert list(parked.iterdir()) == []
        assert set(os.listdir(parent)) == {"sentinel.txt"}

    elif fault == "permission_widen":

        def widen_wrapper(parent_fd: int, output_name: str) -> tuple[str, int]:
            pair = original_create_temp(parent_fd, output_name)
            parent.chmod(0o755)
            return pair

        monkeypatch.setattr(review_io, "_create_temporary_directory", widen_wrapper)
        with pytest.raises(review_io.ReviewIOError, match="output_parent_not_private"):
            _write(bundle, output, a=a, b=b)
        assert not output.exists()
        assert len(os.listdir(parent)) == 0


def test_network_disabled_guard(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = tmp_path.resolve() / "private"
    parent.mkdir(mode=0o700)
    parent.chmod(0o700)
    output = parent / "intake"

    def block_socket(*args: object, **kwargs: object) -> None:
        raise AssertionError("network blocked")

    def block_popen(*args: object, **kwargs: object) -> None:
        raise AssertionError("network blocked")

    monkeypatch.setattr(socket, "socket", block_socket)
    monkeypatch.setattr(subprocess, "Popen", block_popen)

    bundle = _prepare()
    a = _answer_bytes(bundle, "a")
    b = _answer_bytes(bundle, "b")

    result = _write(bundle, output, a=a, b=b)
    assert result.status == "complete"


@pytest.mark.parametrize(
    ("incorporated_at", "answer_b", "expected_code"),
    [
        ("not-a-date", None, "incorporated_at_invalid"),
        ("2026-09-05T04:00:00Z", b"not-json", "answer_invalid"),
    ],
)
def test_invalid_inputs_parametrized(
    tmp_path: Path, incorporated_at: str, answer_b: bytes | None, expected_code: str
) -> None:
    parent = tmp_path.resolve() / "private"
    parent.mkdir(mode=0o700)
    parent.chmod(0o700)
    output = parent / "intake"

    bundle = _prepare()
    a = _answer_bytes(bundle, "a")

    with pytest.raises(ReviewIntakeError) as exc_info:
        _write(bundle, output, a=a, b=answer_b, incorporated_at=incorporated_at)

    assert exc_info.value.code == expected_code
    assert not output.exists()

"""Independent acceptance checks; all reviews and sources are synthetic."""

from __future__ import annotations

import json
import os
import stat
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import pytest

from paperpilot.lineage_pilot import review_io
from paperpilot.lineage_pilot.review_intake import PrivateReviewIntake, ingest_blind_review_answers
from paperpilot.lineage_pilot.review_prep import PrivateReviewBundle
from paperpilot.tests.test_lineage_review_intake import INCORPORATED_AT, _answer_bytes, _response
from paperpilot.tests.test_lineage_review_prep import _prepare, _unknown_without_evidence_inputs


@dataclass
class _Case:
    bundle: PrivateReviewBundle
    original: Path
    output: Path
    a: Path
    b: Path


def _private_file(path: Path, payload: bytes) -> None:
    path.write_bytes(payload)
    path.chmod(0o600)


def _case(tmp_path: Path, *, source_less: bool = False) -> _Case:
    parent = tmp_path.resolve() / "private"
    parent.mkdir(mode=0o700)
    parent.chmod(0o700)
    bundle = _prepare(_unknown_without_evidence_inputs() if source_less else None)
    original = parent / "original"
    review_io.write_private_review_bundle(bundle, original)
    a, b = parent / "a.json", parent / "b.json"
    for slot, path in (("a", a), ("b", b)):
        responses: list[dict[str, object] | None] | None = (
            [_response(slot, gold_family=None, gold_relation=None, evidence_support="insufficient")]
            if source_less
            else None
        )
        _private_file(path, _answer_bytes(bundle, slot, responses))
    return _Case(bundle, original, parent / "result", a, b)


def _write(case: _Case, *, use_a: bool = True, use_b: bool = True) -> PrivateReviewIntake:
    operation = review_io.write_private_review_intake_from_paths
    result: PrivateReviewIntake = operation(
        case.bundle,
        case.original,
        case.output,
        answered_reviewer_a_path=case.a if use_a else None,
        answered_reviewer_b_path=case.b if use_b else None,
        incorporated_at=INCORPORATED_AT,
    )
    return result


@pytest.mark.parametrize(
    "scenario", ["a_only", "b_only", "agreement", "disagreement", "source_less"]
)
def test_states_and_authority(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, scenario: str
) -> None:
    case = _case(tmp_path, source_less=scenario == "source_less")
    if scenario == "disagreement":
        _private_file(
            case.b, _answer_bytes(case.bundle, "b", [_response("b", citation_valid=False)])
        )
    use_a, use_b = scenario != "b_only", scenario != "a_only"
    expected = ingest_blind_review_answers(
        case.bundle,
        answered_reviewer_a_bytes=case.a.read_bytes() if use_a else None,
        answered_reviewer_b_bytes=case.b.read_bytes() if use_b else None,
        incorporated_at=INCORPORATED_AT,
    )
    calls = []
    ingest = review_io.ingest_blind_review_answers

    def counted(*args, **kwargs):
        calls.append(1)
        return ingest(*args, **kwargs)

    monkeypatch.setattr(review_io, "ingest_blind_review_answers", counted)
    result = _write(case, use_a=use_a, use_b=use_b)
    assert result == expected
    assert len(calls) == 1
    assert result.status == (
        "pending"
        if not (use_a and use_b)
        else "disagreement"
        if scenario == "disagreement"
        else "complete"
    )
    assert (case.output / "intake.json").read_bytes() == expected.result_bytes
    assert set(os.listdir(case.output)) == {"intake.json"}
    assert stat.S_IMODE(case.output.stat().st_mode) == 0o700
    assert stat.S_IMODE((case.output / "intake.json").stat().st_mode) == 0o600
    data = json.loads(result.result_bytes)
    for key in (
        "audit_fixture_authorized",
        "artifact_update_authorized",
        "quality_authorized",
        "publication_authorized",
    ):
        assert data[key] is False


def test_answer_missing_precedes_any_io(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    case = _Case(cast(PrivateReviewBundle, None), tmp_path, tmp_path, tmp_path, tmp_path)

    def forbidden(*args, **kwargs):
        pytest.fail("No I/O or platform/factory validation is permitted without answers")

    for name in (
        "_require_supported_filesystem",
        "validated_private_review_files",
        "_open_private_review_directory",
    ):
        monkeypatch.setattr(review_io, name, forbidden)
    with pytest.raises(review_io.ReviewIOError, match=r"^answer_missing$"):
        _write(case, use_a=False, use_b=False)


@pytest.mark.parametrize(
    "mutation", ["bytes", "extra", "missing", "file_mode", "directory_mode", "symlink", "hardlink"]
)
def test_original_rejected_before_answer_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mutation: str
) -> None:
    case = _case(tmp_path)
    source = case.original / "coordinator.json"
    expected = "original_review_invalid"
    if mutation == "bytes":
        source.write_bytes(source.read_bytes() + b"\n")
        expected = "original_bundle_mismatch"
    elif mutation == "extra":
        _private_file(case.original / "extra", b"extra")
    elif mutation == "missing":
        source.unlink()
    elif mutation == "file_mode":
        source.chmod(0o400)
    elif mutation == "directory_mode":
        case.original.chmod(0o755)
    elif mutation == "symlink":
        parked = case.original.parent / "parked.json"
        source.rename(parked)
        source.symlink_to(parked)
    else:
        os.link(source, case.original.parent / "linked.json")

    def forbidden(*args, **kwargs):
        pytest.fail("Invalid originals must fail before reading answers")

    monkeypatch.setattr(review_io, "_read_private_answer", forbidden)
    with pytest.raises(review_io.ReviewIOError, match=f"^{expected}$"):
        _write(case)
    assert not case.output.exists()


@pytest.mark.parametrize("target", ["same", "child", "deep_child", "relative", "dotdot"])
def test_output_precheck_before_answers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, target: str
) -> None:
    case = _case(tmp_path)
    outputs = {
        "same": case.original,
        "child": case.original / "result",
        "deep_child": case.original / "nested" / "result",
        "relative": Path("relative-result"),
        "dotdot": case.output.parent / ".." / "result",
    }
    case.output = outputs[target]

    def forbidden(*args, **kwargs):
        pytest.fail("Output precheck must precede answer reads")

    monkeypatch.setattr(review_io, "_read_private_answer", forbidden)
    code = (
        "output_path_invalid"
        if target in {"relative", "dotdot"}
        else "output_original_review_forbidden"
    )
    with pytest.raises(review_io.ReviewIOError, match=f"^{code}$"):
        _write(case)


@pytest.mark.parametrize("phase", ["answer_read", "staging", "after_publish"])
def test_original_changes_at_each_phase_reject_and_clean(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str
) -> None:
    case = _case(tmp_path)
    original_bytes = (case.original / "coordinator.json").read_bytes()
    hook = {
        "answer_read": "_read_private_answer",
        "staging": "_create_temporary_directory",
        "after_publish": "_rename_noreplace_at",
    }[phase]
    operation = getattr(review_io, hook)
    mutated = False

    def wrapper(*args, **kwargs):
        nonlocal mutated
        result = operation(*args, **kwargs)
        if not mutated:
            mutated = True
            (case.original / "coordinator.json").write_bytes(original_bytes + b" ")
        return result

    monkeypatch.setattr(review_io, hook, wrapper)
    if phase == "answer_read":

        def no_intake(*args, **kwargs):
            pytest.fail("Original must be revalidated before intake")

        monkeypatch.setattr(review_io, "ingest_blind_review_answers", no_intake)
    with pytest.raises(review_io.ReviewIOError, match=r"^original_review_changed$"):
        _write(case)
    assert mutated
    assert set(os.listdir(case.output.parent)) == {"original", "a.json", "b.json"}


def test_same_byte_inode_swap_between_reads_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = _case(tmp_path)
    read = review_io._read_private_answer
    swapped = False

    def swap(path: Path) -> bytes:
        nonlocal swapped
        answer: bytes = read(path)
        if not swapped:
            swapped = True
            source = case.original / "coordinator.json"
            replacement = case.original / "replacement"
            _private_file(replacement, source.read_bytes())
            os.replace(replacement, source)
        return answer

    monkeypatch.setattr(review_io, "_read_private_answer", swap)
    with pytest.raises(review_io.ReviewIOError, match=r"^original_review_changed$"):
        _write(case)
    assert not case.output.exists()


@pytest.mark.parametrize("fault", [False, True])
def test_original_and_reopened_descriptors_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fault: bool
) -> None:
    case = _case(tmp_path)
    opened: list[int] = []
    original_open = review_io._open_private_review_directory

    def tracking_open(*args, **kwargs):
        result = original_open(*args, **kwargs)
        opened.append(result[1])
        return result

    monkeypatch.setattr(review_io, "_open_private_review_directory", tracking_open)
    if fault:

        def failed_answer(path: Path) -> bytes:
            raise review_io.ReviewIOError("answer_input_changed")

        monkeypatch.setattr(review_io, "_read_private_answer", failed_answer)
        with pytest.raises(review_io.ReviewIOError, match=r"^answer_input_changed$"):
            _write(case)
    else:
        _write(case)
    assert opened
    for descriptor in set(opened):
        with pytest.raises(OSError):
            os.fstat(descriptor)


def test_renamed_original_cannot_become_output_ancestor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = _case(tmp_path)
    destination = case.output.parent / "destination"
    destination.mkdir(mode=0o700)
    destination.chmod(0o700)
    case.output = destination / "result"
    save = review_io._write_private_files
    original_stat = case.original.stat()

    def swap_before_save(files, output, **kwargs):
        assert kwargs["forbidden_ancestor_identity"] == (original_stat.st_dev, original_stat.st_ino)
        assert callable(kwargs["revalidate_callback"])
        destination.rmdir()
        case.original.rename(destination)
        return save(files, output, **kwargs)

    monkeypatch.setattr(review_io, "_write_private_files", swap_before_save)
    with pytest.raises(review_io.ReviewIOError, match=r"^output_original_review_forbidden$"):
        _write(case)
    assert not case.output.exists()
    assert set(os.listdir(destination)) == set(case.bundle.files)


@pytest.mark.parametrize("after_answers", [False, True])
def test_original_listdir_fault_is_safe_and_closes_descriptor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, after_answers: bool
) -> None:
    case = _case(tmp_path)
    original_stat = case.original.stat()
    identity = (original_stat.st_dev, original_stat.st_ino)
    listdir = os.listdir
    read_answer = review_io._read_private_answer
    armed = not after_answers
    descriptors: list[int] = []

    def fail_original_listdir(path):
        if isinstance(path, int):
            opened = os.fstat(path)
            if armed and (opened.st_dev, opened.st_ino) == identity:
                descriptors.append(path)
                raise OSError("private-path-and-answer-must-not-leak")
        return listdir(path)

    def arm_after_answer(path: Path) -> bytes:
        nonlocal armed
        payload: bytes = read_answer(path)
        armed = True
        return payload

    monkeypatch.setattr(review_io.os, "listdir", fail_original_listdir)
    monkeypatch.setattr(review_io, "_read_private_answer", arm_after_answer)
    code = "original_review_changed" if after_answers else "original_review_invalid"
    with pytest.raises(review_io.ReviewIOError, match=f"^{code}$"):
        _write(case)
    assert descriptors
    for descriptor in set(descriptors):
        with pytest.raises(OSError):
            os.fstat(descriptor)
    assert not case.output.exists()


@pytest.mark.parametrize("answer_error", [False, True])
def test_original_close_fault_gets_final_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, answer_error: bool
) -> None:
    case = _case(tmp_path)
    original_open = review_io._open_private_review_directory
    real_close = os.close
    tracked = -1
    attempts = 0

    def tracking_open(*args, **kwargs):
        nonlocal tracked
        result = original_open(*args, **kwargs)
        if tracked < 0 and result[0] == case.original:
            tracked = result[1]
        return result

    def fail_first_original_close(descriptor: int) -> None:
        nonlocal attempts
        if descriptor == tracked:
            attempts += 1
            if attempts == 1:
                raise OSError("single pre-close fault")
        real_close(descriptor)

    def fail_answer(path: Path) -> bytes:
        raise review_io.ReviewIOError("answer_input_changed")

    monkeypatch.setattr(review_io, "_open_private_review_directory", tracking_open)
    monkeypatch.setattr(review_io.os, "close", fail_first_original_close)
    if answer_error:
        monkeypatch.setattr(review_io, "_read_private_answer", fail_answer)
    try:
        if answer_error:
            with pytest.raises(review_io.ReviewIOError, match=r"^answer_input_changed$"):
                _write(case)
        else:
            assert _write(case).status == "complete"
        assert tracked >= 0
        assert attempts == 2
        with pytest.raises(OSError):
            os.fstat(tracked)
    finally:
        # A RED implementation leaks this owned test descriptor; do not leak the probe itself.
        if tracked >= 0:
            with suppress(OSError):
                real_close(tracked)

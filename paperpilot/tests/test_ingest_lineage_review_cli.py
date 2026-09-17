"""Independent CLI acceptance checks with synthetic private review inputs."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

from paperpilot.tests.test_lineage_review_intake import INCORPORATED_AT, _answer_bytes, _response
from paperpilot.tests.test_lineage_review_prep import (
    SOURCE_REF,
    _inputs,
    _unknown_without_evidence_inputs,
)
from paperpilot.tests.test_prepare_lineage_review_cli import _argv
from paperpilot.tests.test_private_review_intake_paths import _case, _private_file


def _cli():
    return importlib.import_module("paperpilot.scripts.ingest_lineage_review")


def _setup(tmp_path: Path, *, source_less: bool = False):
    case = _case(tmp_path, source_less=source_less)
    values = _unknown_without_evidence_inputs() if source_less else _inputs()
    paths = {}
    for name, key in (
        ("artifact", "artifact_bytes"),
        ("catalog", "catalog_bytes"),
        ("candidates", "candidate_snapshot_bytes"),
    ):
        path = tmp_path.resolve() / f"{name}.json"
        path.write_bytes(values[key])
        paths[name] = path
    paths["source"] = tmp_path.resolve() / "source.snapshot"
    if not source_less:
        paths["source"].write_bytes(values["source_snapshots"][SOURCE_REF])
    argv = _argv(paths, case.output)
    if source_less:
        index = argv.index("--source-snapshot")
        del argv[index : index + 2]
    argv += [
        "--original-review-dir",
        str(case.original),
        "--reviewer-a-answer",
        str(case.a),
        "--reviewer-b-answer",
        str(case.b),
        "--incorporated-at",
        INCORPORATED_AT,
    ]
    return case, argv


@pytest.mark.parametrize("scenario", ["complete", "pending", "disagreement", "source_less"])
def test_cli_states_safe_summary_and_single_calls(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    scenario: str,
) -> None:
    cli = _cli()
    case, argv = _setup(tmp_path, source_less=scenario == "source_less")
    if scenario == "pending":
        index = argv.index("--reviewer-b-answer")
        del argv[index : index + 2]
    elif scenario == "disagreement":
        _private_file(
            case.b, _answer_bytes(case.bundle, "b", [_response("b", citation_valid=False)])
        )
    factory, writer = cli.prepare_blind_review, cli.write_private_review_intake_from_paths
    calls = []

    def counted_factory(*args, **kwargs):
        calls.append("factory")
        return factory(*args, **kwargs)

    def counted_writer(*args, **kwargs):
        calls.append("writer")
        return writer(*args, **kwargs)

    monkeypatch.setattr(cli, "prepare_blind_review", counted_factory)
    monkeypatch.setattr(cli, "write_private_review_intake_from_paths", counted_writer)
    assert cli.main(argv) == 0
    assert calls == ["factory", "writer"]
    captured = capsys.readouterr()
    assert captured.err == ""
    summary = json.loads(captured.out)
    assert set(summary) == {
        "status",
        "candidate_count",
        "dual_reviewed_count",
        "pending_count",
        "disagreement_count",
        "result_sha256",
    }
    assert summary["status"] == ("complete" if scenario == "source_less" else scenario)
    assert summary["candidate_count"] == 1
    assert summary["pending_count"] == int(scenario == "pending")
    assert summary["disagreement_count"] == int(scenario == "disagreement")
    assert captured.out == json.dumps(summary, sort_keys=True, separators=(",", ":")) + "\n"
    data = json.loads((case.output / "intake.json").read_bytes())
    for key in (
        "audit_fixture_authorized",
        "artifact_update_authorized",
        "quality_authorized",
        "publication_authorized",
    ):
        assert data[key] is False
    for private in (
        str(tmp_path),
        "synthetic-reviewer",
        "Synthetic Parent",
        "Synthetic Author",
        "Synthetic test response",
        "The child explicitly",
    ):
        assert private not in captured.out


@pytest.mark.parametrize(
    "fault", ["no_answers", "duplicate", "abbreviation", "unknown", "missing", "duplicate_source"]
)
def test_argument_errors_precede_file_reads(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, fault: str
) -> None:
    cli = _cli()
    case, argv = _setup(tmp_path)
    code = "argument_invalid"
    if fault == "no_answers":
        for flag in ("--reviewer-a-answer", "--reviewer-b-answer"):
            index = argv.index(flag)
            del argv[index : index + 2]
        code = "answer_missing"
    elif fault == "duplicate":
        argv += ["--reviewer-a-answer", str(case.a)]
        code = "argument_duplicate"
    elif fault == "abbreviation":
        argv[argv.index("--original-review-dir")] = "--original-review-d"
    elif fault == "unknown":
        argv += ["--secret-unknown", str(case.a)]
    elif fault == "missing":
        index = argv.index("--incorporated-at")
        del argv[index : index + 2]
    else:
        value = argv[argv.index("--source-snapshot") + 1]
        argv += ["--source-snapshot", value]
        code = "source_ref_duplicate"

    def forbidden(*args, **kwargs):
        pytest.fail("Argument failure must precede file reads and factory")

    monkeypatch.setattr(cli, "read_bounded_regular_file", forbidden)
    monkeypatch.setattr(cli, "prepare_blind_review", forbidden)
    # Duplicate source references must use the real parser but never reach its reader.
    monkeypatch.setattr("paperpilot.lineage_pilot.review_io.read_bounded_regular_file", forbidden)
    assert cli.main(argv) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == code + "\n"
    assert not case.output.exists()


@pytest.mark.parametrize("filename", ["coordinator.json", "reviewer-a.json", "reviewer-b.json"])
def test_original_bytes_are_bound(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], filename: str
) -> None:
    cli = _cli()
    case, argv = _setup(tmp_path)
    source = case.original / filename
    source.write_bytes(source.read_bytes() + b"\n")
    assert cli.main(argv) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "original_bundle_mismatch\n"
    assert not case.output.exists()


@pytest.mark.parametrize(
    "fault", ["answer_mode", "answer_json", "output_inside_original", "output_exists", "unexpected"]
)
def test_safe_failures_do_not_leak_private_values(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, fault: str
) -> None:
    cli = _cli()
    case, argv = _setup(tmp_path)
    expected = "review_intake_failed"
    if fault == "answer_mode":
        case.a.chmod(0o644)
        expected = "answer_input_not_private"
    elif fault == "answer_json":
        _private_file(case.a, b"private-not-valid-json")
        expected = "answer_invalid"
    elif fault == "output_inside_original":
        argv[argv.index("--output") + 1] = str(case.original / "result")
        expected = "output_original_review_forbidden"
    elif fault == "output_exists":
        case.output.mkdir(mode=0o700)
        (case.output / "keep").write_bytes(b"winner")
        expected = "output_exists"
    else:

        def fail_factory(*args, **kwargs):
            raise ValueError(f"private failure: {case.a}")

        monkeypatch.setattr(cli, "prepare_blind_review", fail_factory)
    assert cli.main(argv) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == expected + "\n"
    if fault == "output_exists":
        assert (case.output / "keep").read_bytes() == b"winner"
        assert set(path.name for path in case.output.iterdir()) == {"keep"}
    else:
        assert not case.output.exists()


def test_help_has_no_io_or_private_data(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    cli = _cli()

    def forbidden(*args, **kwargs):
        pytest.fail("Help must not read files")

    monkeypatch.setattr(cli, "read_source_snapshots", forbidden)
    with pytest.raises(SystemExit) as result:
        cli.main(["--help"])
    assert result.value.code == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    for flag in (
        "--original-review-dir",
        "--reviewer-a-answer",
        "--reviewer-b-answer",
        "--incorporated-at",
    ):
        assert flag in captured.out

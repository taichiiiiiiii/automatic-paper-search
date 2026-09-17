from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

import paperpilot.lineage_pilot.review_io as review_io
from paperpilot.lineage_pilot.review_prep import MAX_ARTIFACT_BYTES
from paperpilot.replay import strict_json_loads
from paperpilot.scripts.prepare_lineage_review import main
from paperpilot.tests.test_lineage_review_prep import (
    CONFERENCE,
    PAPER_ID,
    SOURCE_REF,
    _inputs,
    _unknown_without_evidence_inputs,
)


def _required_bytes(values: dict[str, object], key: str) -> bytes:
    value = values[key]
    assert isinstance(value, bytes)
    return value


def _required_source_bytes(values: dict[str, object], reference: str) -> bytes:
    snapshots = values["source_snapshots"]
    assert isinstance(snapshots, dict)
    value = snapshots[reference]
    assert isinstance(value, bytes)
    return value


def _write_inputs(root: Path) -> tuple[dict[str, object], dict[str, Path]]:
    values = _inputs()
    paths = {
        "artifact": root / "artifact.json",
        "catalog": root / "catalog.json",
        "candidates": root / "candidates.json",
        "source": root / "source.snapshot",
    }
    paths["artifact"].write_bytes(_required_bytes(values, "artifact_bytes"))
    # A real published catalog is pretty JSON, not replay-canonical JSON.
    paths["catalog"].write_text(
        json.dumps(values["catalog"], ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    paths["candidates"].write_bytes(_required_bytes(values, "candidate_snapshot_bytes"))
    paths["source"].write_bytes(_required_source_bytes(values, SOURCE_REF))
    return values, paths


def _argv(paths: dict[str, Path], output: Path) -> list[str]:
    return [
        "--artifact",
        str(paths["artifact"]),
        "--catalog",
        str(paths["catalog"]),
        "--candidates",
        str(paths["candidates"]),
        "--source-snapshot",
        f"{SOURCE_REF}={paths['source']}",
        "--conference",
        CONFERENCE,
        "--paper-id",
        PAPER_ID,
        "--fixture-id",
        "pilot-fixture-v1",
        "--created-at",
        "2026-09-05T01:00:00Z",
        "--output",
        str(output),
    ]


def _private_parent(tmp_path: Path, name: str = "private") -> Path:
    parent = tmp_path / name
    parent.mkdir(mode=0o700)
    parent.chmod(0o700)
    return parent


def test_cli_writes_only_three_private_pending_files_and_safe_summary(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    values, paths = _write_inputs(tmp_path)
    output = _private_parent(tmp_path) / "review"

    assert main(_argv(paths, output)) == 0

    assert {path.name for path in output.iterdir()} == {
        "coordinator.json",
        "reviewer-a.json",
        "reviewer-b.json",
    }
    assert stat.S_IMODE(output.stat().st_mode) == 0o700
    assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in output.iterdir())
    first = strict_json_loads((output / "reviewer-a.json").read_bytes())
    second = strict_json_loads((output / "reviewer-b.json").read_bytes())
    coordinator = strict_json_loads((output / "coordinator.json").read_bytes())
    assert isinstance(first, dict)
    assert isinstance(second, dict)
    assert isinstance(coordinator, dict)
    bindings = coordinator.get("bindings")
    assert isinstance(bindings, dict)
    assert bindings["catalog_sha256"] == hashlib.sha256(paths["catalog"].read_bytes()).hexdigest()
    assert first["status"] == second["status"] == "pending"
    candidates = first["candidates"]
    assert isinstance(candidates, list)
    candidate = candidates[0]
    assert isinstance(candidate, dict)
    assert candidate["response"] == {
        "reviewer_id": None,
        "blind_to_model": None,
        "blind_to_peer": None,
        "citation_valid": None,
        "gold_family": None,
        "gold_relation": None,
        "evidence_support": None,
        "notes": None,
        "reviewed_at": None,
    }

    captured = capsys.readouterr()
    summary = json.loads(captured.out)
    assert captured.err == ""
    assert summary["pending"] is True
    assert summary["candidate_count"] == 1
    assert summary["file_count"] == 3
    assert set(summary["reviewer_pack_sha256s"]) == {"a", "b"}
    rendered = captured.out + captured.err
    source_payload = _required_source_bytes(values, SOURCE_REF)
    for secret in (
        str(output),
        str(paths["source"]),
        "Synthetic Parent",
        "Synthetic Author",
        "Machine-only proposal",
        source_payload.decode(),
    ):
        assert secret not in rendered


def test_cli_output_is_deterministic(tmp_path: Path) -> None:
    _values, paths = _write_inputs(tmp_path)
    parent = _private_parent(tmp_path)
    first = parent / "first"
    second = parent / "second"
    assert main(_argv(paths, first)) == 0
    assert main(_argv(paths, second)) == 0
    assert {path.name: path.read_bytes() for path in first.iterdir()} == {
        path.name: path.read_bytes() for path in second.iterdir()
    }


def test_cli_accepts_source_less_unknown_population(tmp_path: Path) -> None:
    values = _unknown_without_evidence_inputs()
    _normal_values, paths = _write_inputs(tmp_path)
    paths["artifact"].write_bytes(_required_bytes(values, "artifact_bytes"))
    paths["candidates"].write_bytes(_required_bytes(values, "candidate_snapshot_bytes"))
    output = _private_parent(tmp_path) / "review"
    argv = _argv(paths, output)
    source_index = argv.index("--source-snapshot")
    del argv[source_index : source_index + 2]

    assert main(argv) == 0
    pack = strict_json_loads((output / "reviewer-a.json").read_bytes())
    assert isinstance(pack, dict)
    candidates = pack["candidates"]
    assert isinstance(candidates, list)
    candidate = candidates[0]
    assert isinstance(candidate, dict)
    assert candidate["evidence"] == []


def test_cli_never_overwrites_existing_output(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _values, paths = _write_inputs(tmp_path)
    output = _private_parent(tmp_path) / "review"
    output.mkdir(mode=0o700)
    sentinel = output / "keep.txt"
    sentinel.write_text("winner", encoding="utf-8")

    assert main(_argv(paths, output)) == 1
    assert sentinel.read_text(encoding="utf-8") == "winner"
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "output_exists\n"


@pytest.mark.parametrize("mode", [0o755, 0o750, 0o777])
def test_cli_requires_existing_caller_owned_0700_parent(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    mode: int,
) -> None:
    _values, paths = _write_inputs(tmp_path)
    parent = tmp_path / "shared"
    parent.mkdir(mode=mode)
    parent.chmod(mode)
    assert main(_argv(paths, parent / "review")) == 1
    assert capsys.readouterr().err == "output_parent_not_private\n"
    assert not (parent / "review").exists()


def test_cli_does_not_create_missing_output_parents(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _values, paths = _write_inputs(tmp_path)
    missing = tmp_path / "missing" / "nested"
    assert main(_argv(paths, missing / "review")) == 1
    assert capsys.readouterr().err == "output_parent_missing\n"
    assert not (tmp_path / "missing").exists()


def test_cli_rejects_relative_repo_and_public_output_targets(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _values, paths = _write_inputs(tmp_path)
    assert main(_argv(paths, Path("relative-output"))) == 1
    assert capsys.readouterr().err == "output_path_invalid\n"

    repository = Path(__file__).resolve().parents[2]
    for output in (
        repository / ".private-review-test",
        repository / "docs" / ".private-review-test",
        repository / "paperpilot" / "data" / ".private-review-test",
    ):
        assert main(_argv(paths, output)) == 1
        assert capsys.readouterr().err == "output_repository_forbidden\n"
        assert not output.exists()


def test_cli_rejects_output_symlink_ancestor_and_dotdot(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _values, paths = _write_inputs(tmp_path)
    real = _private_parent(tmp_path, "real")
    linked = tmp_path / "linked"
    linked.symlink_to(real, target_is_directory=True)
    assert main(_argv(paths, linked / "review")) == 1
    assert capsys.readouterr().err == "output_path_invalid\n"
    assert not (real / "review").exists()

    target_link = real / "review-link"
    target_link.symlink_to(real / "missing", target_is_directory=True)
    assert main(_argv(paths, target_link)) == 1
    assert capsys.readouterr().err == "output_path_invalid\n"
    assert target_link.is_symlink()

    raw = real / "missing" / ".." / "review"
    assert main(_argv(paths, raw)) == 1
    assert capsys.readouterr().err == "output_path_invalid\n"


def test_cli_rejects_any_git_worktree_ancestor(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _values, paths = _write_inputs(tmp_path)
    private = _private_parent(tmp_path)
    worktree = private / "linked-worktree"
    worktree.mkdir(mode=0o700)
    worktree.chmod(0o700)
    (worktree / ".git").write_text("gitdir: /private/elsewhere\n", encoding="utf-8")
    assert main(_argv(paths, worktree / "review")) == 1
    assert capsys.readouterr().err == "output_repository_forbidden\n"
    assert not (worktree / "review").exists()


@pytest.mark.parametrize("kind", ["symlink", "directory", "fifo", "missing"])
def test_cli_rejects_non_regular_inputs_without_blocking(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    kind: str,
) -> None:
    _values, paths = _write_inputs(tmp_path)
    target = paths["artifact"]
    target.unlink()
    if kind == "symlink":
        target.symlink_to(paths["catalog"])
    elif kind == "directory":
        target.mkdir()
    elif kind == "fifo":
        os.mkfifo(target)

    assert main(_argv(paths, _private_parent(tmp_path) / "review")) == 1
    assert capsys.readouterr().err == (
        "input_missing\n" if kind == "missing" else "input_not_regular\n"
    )


def test_cli_rejects_oversized_and_total_source_inputs(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _values, paths = _write_inputs(tmp_path)
    paths["artifact"].write_bytes(b"x" * (MAX_ARTIFACT_BYTES + 1))
    assert main(_argv(paths, _private_parent(tmp_path, "one") / "review")) == 1
    assert capsys.readouterr().err == "input_too_large\n"

    _values, paths = _write_inputs(tmp_path)
    monkeypatch.setattr(review_io, "MAX_TOTAL_SOURCE_BYTES", 1)
    assert main(_argv(paths, _private_parent(tmp_path, "two") / "review")) == 1
    assert capsys.readouterr().err == "source_inputs_too_large\n"


def test_bounded_reader_detects_mutation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "mutable.json"
    path.write_bytes(b"{}\n")
    real_fstat = review_io.os.fstat
    calls = 0

    def changed_fstat(fd: int):
        nonlocal calls
        result = real_fstat(fd)
        calls += 1
        if calls == 2:
            return SimpleNamespace(
                st_mode=result.st_mode,
                st_uid=result.st_uid,
                st_dev=result.st_dev,
                st_ino=result.st_ino,
                st_size=result.st_size,
                st_mtime_ns=result.st_mtime_ns + 1,
                st_ctime_ns=result.st_ctime_ns,
            )
        return result

    monkeypatch.setattr(review_io.os, "fstat", changed_fstat)
    with pytest.raises(review_io.ReviewIOError, match=r"^input_changed$"):
        review_io.read_bounded_regular_file(path, 100)


def test_cli_rejects_duplicate_source_refs_before_reading_paths(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _values, paths = _write_inputs(tmp_path)
    argv = _argv(paths, _private_parent(tmp_path) / "review")
    insert_at = argv.index("--conference")
    argv[insert_at:insert_at] = [
        "--source-snapshot",
        f"{SOURCE_REF}=/definitely/not/read",
    ]
    assert main(argv) == 1
    assert capsys.readouterr().err == "source_ref_duplicate\n"


@pytest.mark.parametrize(
    "extra",
    [
        ["--unknown", "do-not-echo-this-secret"],
        ["--source-snapshot", "invalid-without-equals"],
        ["--source-snapshot", "=do-not-echo-this-secret"],
    ],
)
def test_cli_argument_errors_are_sanitized(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    extra: list[str],
) -> None:
    _values, paths = _write_inputs(tmp_path)
    argv = _argv(paths, _private_parent(tmp_path) / "review") + extra
    assert main(argv) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err in {"argument_invalid\n", "source_ref_invalid\n"}
    assert "do-not-echo-this-secret" not in captured.err


def test_writer_rejects_unvalidated_bundle(tmp_path: Path) -> None:
    with pytest.raises(review_io.ReviewIOError, match=r"^review_bundle_invalid$"):
        review_io.write_private_review_bundle(object(), _private_parent(tmp_path) / "review")


def test_writer_detects_parent_swap_and_cleans_only_its_temporary_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _values, paths = _write_inputs(tmp_path)
    parent = _private_parent(tmp_path)
    output = parent / "review"
    from paperpilot.lineage_pilot.review_prep import prepare_blind_review

    bundle = prepare_blind_review(
        artifact_bytes=paths["artifact"].read_bytes(),
        catalog_bytes=paths["catalog"].read_bytes(),
        candidate_snapshot_bytes=paths["candidates"].read_bytes(),
        source_snapshots={SOURCE_REF: paths["source"].read_bytes()},
        conference=CONFERENCE,
        paper_id=PAPER_ID,
        fixture_id="pilot-fixture-v1",
        created_at="2026-09-05T01:00:00Z",
    )
    real_create = review_io._create_temporary_directory
    parked = tmp_path / "parked"

    def swap_after_create(parent_fd: int, output_name: str):
        result = real_create(parent_fd, output_name)
        parent.rename(parked)
        parent.mkdir(mode=0o700)
        parent.chmod(0o700)
        return result

    monkeypatch.setattr(review_io, "_create_temporary_directory", swap_after_create)
    with pytest.raises(review_io.ReviewIOError, match=r"^output_parent_changed$"):
        review_io.write_private_review_bundle(bundle, output)
    assert list(parked.iterdir()) == []
    assert list(parent.iterdir()) == []


def test_writer_detects_parent_permission_widening_before_commit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _values, paths = _write_inputs(tmp_path)
    parent = _private_parent(tmp_path)
    output = parent / "review"
    from paperpilot.lineage_pilot.review_prep import prepare_blind_review

    bundle = prepare_blind_review(
        artifact_bytes=paths["artifact"].read_bytes(),
        catalog_bytes=paths["catalog"].read_bytes(),
        candidate_snapshot_bytes=paths["candidates"].read_bytes(),
        source_snapshots={SOURCE_REF: paths["source"].read_bytes()},
        conference=CONFERENCE,
        paper_id=PAPER_ID,
        fixture_id="pilot-fixture-v1",
        created_at="2026-09-05T01:00:00Z",
    )
    real_create = review_io._create_temporary_directory

    def widen_after_create(parent_fd: int, output_name: str):
        result = real_create(parent_fd, output_name)
        parent.chmod(0o755)
        return result

    monkeypatch.setattr(review_io, "_create_temporary_directory", widen_after_create)
    with pytest.raises(review_io.ReviewIOError, match=r"^output_parent_not_private$"):
        review_io.write_private_review_bundle(bundle, output)
    assert list(parent.iterdir()) == []


def test_writer_loses_output_race_without_overwriting_competitor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _values, paths = _write_inputs(tmp_path)
    parent = _private_parent(tmp_path)
    output = parent / "review"
    from paperpilot.lineage_pilot.review_prep import prepare_blind_review

    bundle = prepare_blind_review(
        artifact_bytes=paths["artifact"].read_bytes(),
        catalog_bytes=paths["catalog"].read_bytes(),
        candidate_snapshot_bytes=paths["candidates"].read_bytes(),
        source_snapshots={SOURCE_REF: paths["source"].read_bytes()},
        conference=CONFERENCE,
        paper_id=PAPER_ID,
        fixture_id="pilot-fixture-v1",
        created_at="2026-09-05T01:00:00Z",
    )
    real_create = review_io._create_temporary_directory

    def add_competitor(parent_fd: int, output_name: str):
        result = real_create(parent_fd, output_name)
        output.mkdir(mode=0o700)
        (output / "winner.txt").write_text("winner", encoding="utf-8")
        return result

    monkeypatch.setattr(review_io, "_create_temporary_directory", add_competitor)
    with pytest.raises(review_io.ReviewIOError, match=r"^output_exists$"):
        review_io.write_private_review_bundle(bundle, output)
    assert (output / "winner.txt").read_text(encoding="utf-8") == "winner"
    assert not list(parent.glob(".review.tmp-*"))


def test_cli_rejects_repeated_single_value_arguments_without_echoing_value(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _values, paths = _write_inputs(tmp_path)
    argv = _argv(paths, _private_parent(tmp_path) / "review")
    argv.extend(["--fixture-id", "do-not-echo-this-secret"])
    assert main(argv) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "argument_duplicate\n"


def test_cli_rejects_unsupported_filesystem_before_io(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _values, paths = _write_inputs(tmp_path)
    output = _private_parent(tmp_path) / "review"
    monkeypatch.setattr(review_io, "_FILESYSTEM_SUPPORTED", False)

    assert main(_argv(paths, output)) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "filesystem_platform_unsupported\n"
    assert not output.exists()
    with pytest.raises(review_io.ReviewIOError, match=r"^filesystem_platform_unsupported$"):
        review_io.read_source_snapshots([])

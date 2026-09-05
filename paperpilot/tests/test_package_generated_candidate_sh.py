"""Hermetic tests for changed-only generated candidate packaging."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / ".github/scripts/package-generated-candidate.sh"
GIT_ENV = {
    "GIT_AUTHOR_NAME": "test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
}


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    subprocess.run(
        ["git", "init", "--initial-branch=develop"],
        cwd=root,
        check=True,
        capture_output=True,
        env={**os.environ, **GIT_ENV},
    )
    (root / "docs/themes/old").mkdir(parents=True)
    (root / "docs/themes/old/lineage.json").write_text('{"old":true}\n')
    (root / "README.md").write_text("baseline\n")
    subprocess.run(
        ["git", "add", "."],
        cwd=root,
        check=True,
        env={**os.environ, **GIT_ENV},
    )
    subprocess.run(
        ["git", "commit", "-m", "seed"],
        cwd=root,
        check=True,
        capture_output=True,
        env={**os.environ, **GIT_ENV},
    )
    return root


def _run(
    repo: Path,
    destination: Path,
    *included: str,
    snapshot: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT), str(destination), *included],
        cwd=repo,
        capture_output=True,
        text=True,
        env={
            **os.environ,
            **GIT_ENV,
            "PAPERPILOT_PACKAGE_INCLUDE_UNCHANGED": "1" if snapshot else "0",
        },
        timeout=30,
    )


def test_packages_only_changed_files_below_included_paths(repo: Path, tmp_path: Path) -> None:
    (repo / "docs/themes/old/lineage.json").write_text('{"old":false}\n')
    new = repo / "docs/themes/new/lineage.json"
    new.parent.mkdir(parents=True)
    new.write_text('{"new":true}\n')
    (repo / "README.md").write_text("must not be packaged\n")
    destination = tmp_path / "candidate"

    result = _run(repo, destination, "docs/themes")

    assert result.returncode == 0, result.stdout + result.stderr
    assert (destination / "docs/themes/old/lineage.json").is_file()
    assert (destination / "docs/themes/new/lineage.json").is_file()
    assert not (destination / "README.md").exists()


def test_rejects_symlink_candidate(repo: Path, tmp_path: Path) -> None:
    link = repo / "docs/themes/escape"
    link.symlink_to("/etc/passwd")

    result = _run(repo, tmp_path / "candidate", "docs/themes")

    assert result.returncode != 0
    assert "symlink" in (result.stdout + result.stderr).lower()


def test_fails_when_no_included_file_changed(repo: Path, tmp_path: Path) -> None:
    (repo / "README.md").write_text("outside allowlist\n")

    result = _run(repo, tmp_path / "candidate", "docs/themes")

    assert result.returncode != 0
    assert "no generated candidate files changed" in (result.stdout + result.stderr)


def test_snapshot_mode_preserves_exact_unchanged_subtree_only(repo: Path, tmp_path: Path) -> None:
    (repo / "docs/themes/other").mkdir()
    (repo / "docs/themes/other/lineage.json").write_text('{"other":true}\n')
    destination = tmp_path / "candidate"

    result = _run(
        repo,
        destination,
        "docs/themes/old",
        snapshot=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert (destination / "docs/themes/old/lineage.json").is_file()
    assert not (destination / "docs/themes/other").exists()

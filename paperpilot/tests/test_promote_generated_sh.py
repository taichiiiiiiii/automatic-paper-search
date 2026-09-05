"""Hermetic tests for the fresh-tree generated-data promoter."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / ".github" / "scripts" / "promote-generated.sh"
GIT_ENV = {
    "GIT_AUTHOR_NAME": "test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
}


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, **GIT_ENV},
        timeout=30,
    )


@pytest.fixture
def promotion_world(tmp_path: Path) -> dict[str, Path]:
    remote = tmp_path / "remote.git"
    remote.mkdir()
    _git(remote, "init", "--bare", "--initial-branch=develop")

    checkout = tmp_path / "checkout"
    checkout.mkdir()
    _git(checkout, "init", "--initial-branch=develop")
    _git(checkout, "remote", "add", "origin", str(remote))
    (checkout / "docs" / "themes").mkdir(parents=True)
    (checkout / "docs" / "themes" / "manifest.json").write_text("{}\n")
    _git(checkout, "add", ".")
    _git(checkout, "commit", "-m", "seed")
    _git(checkout, "push", "-u", "origin", "develop")

    candidate = tmp_path / "candidate"
    target = candidate / "docs" / "themes" / "new-theme"
    target.mkdir(parents=True)
    (target / "lineage.json").write_text('{"nodes":[],"edges":[]}\n')
    return {"remote": remote, "checkout": checkout, "candidate": candidate}


def _run(
    world: dict[str, Path],
    *stage_paths: str,
    base_sha: str | None = None,
) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        **GIT_ENV,
        "PAPERPILOT_PROMOTION_TEST_MODE": "1",
        "PROMOTE_NO_SLEEP": "1",
        "PROMOTE_MAX_ATTEMPTS": "2",
        "PROMOTE_BASE_SHA": base_sha or _git(world["checkout"], "rev-parse", "HEAD").stdout.strip(),
    }
    return subprocess.run(
        [
            "bash",
            str(SCRIPT),
            "test-only",
            str(world["candidate"]),
            "data(test): promote candidate",
            *stage_paths,
        ],
        cwd=world["checkout"],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )


def test_promoter_exists_and_never_force_pushes() -> None:
    assert SCRIPT.is_file()
    assert os.access(SCRIPT, os.X_OK)
    text = SCRIPT.read_text(encoding="utf-8")
    assert "git worktree add" in text
    assert "git fetch" in text
    assert "PROMOTE_MAX_ATTEMPTS" in text
    assert "PROMOTE_BASE_SHA" in text
    assert "git merge-base --is-ancestor" in text
    assert "source_sha=" in text
    assert "changed=" in text
    assert not any(flag in text for flag in ("--force", "--force-with-lease", "reset --hard"))


def test_promoter_refreshes_shared_outputs_with_one_as_of() -> None:
    text = SCRIPT.read_text(encoding="utf-8")
    assert 'promotion_as_of="${PROMOTE_AS_OF:-$(date -u' in text
    assert text.count('--as-of "$promotion_as_of"') == 3
    assert "build_lineage_quality --check" not in text
    for shared in (
        "docs/lineage-quality-v1.json",
        "docs/identity-aliases-v1.json",
        "docs/search-index-v2.json",
        "docs/search-paper-ids-v1",
        "docs/paper-details-v1",
        "paperpilot/data/identity-coverage-v1.json",
        "docs/assets/versions.json",
    ):
        assert shared in text
    assert "sync_asset_versions.py" in text
    assert '"${shared_paths[@]}"' in text
    refresh_function = text.split("refresh_shared_outputs()", 1)[1].split(
        "validate_promoted_tree()", 1
    )[0]
    conference_block = refresh_function.split("conference)", 1)[1].split(";;", 1)[0]
    expected_order = (
        "build_pages.py",
        "build_identity_lite",
        "build_search_index",
        "build_lineage_quality",
        "sync_asset_versions.py",
    )
    offsets = [conference_block.index(command) for command in expected_order]
    assert offsets == sorted(offsets)


def test_promotes_candidate_from_fresh_remote_tip(promotion_world: dict[str, Path]) -> None:
    result = _run(promotion_world, "docs/themes")
    assert result.returncode == 0, result.stdout + result.stderr

    verify = promotion_world["remote"].parent / "verify"
    _git(promotion_world["remote"].parent, "clone", str(promotion_world["remote"]), str(verify))
    assert (verify / "docs" / "themes" / "new-theme" / "lineage.json").is_file(), (
        result.stdout + result.stderr
    )
    assert "source_sha=" in result.stdout
    assert "changed=true" in result.stdout


def test_rejects_candidate_outside_allowlist(promotion_world: dict[str, Path]) -> None:
    bad = promotion_world["candidate"] / ".github" / "workflows"
    bad.mkdir(parents=True)
    (bad / "pwn.yml").write_text("permissions: write-all\n")

    result = _run(promotion_world, "docs/themes")
    assert result.returncode != 0
    assert "allow" in (result.stdout + result.stderr).lower()


def test_rejects_candidate_symlink(promotion_world: dict[str, Path]) -> None:
    link = promotion_world["candidate"] / "docs" / "themes" / "escape"
    link.symlink_to("/etc/passwd")

    result = _run(promotion_world, "docs/themes")
    assert result.returncode != 0
    assert "symlink" in (result.stdout + result.stderr).lower()


def test_rejects_same_path_change_since_generation(
    promotion_world: dict[str, Path],
) -> None:
    base_sha = _git(promotion_world["checkout"], "rev-parse", "HEAD").stdout.strip()
    writer = promotion_world["remote"].parent / "writer"
    _git(promotion_world["remote"].parent, "clone", str(promotion_world["remote"]), str(writer))
    target = writer / "docs" / "themes" / "new-theme"
    target.mkdir(parents=True)
    (target / "lineage.json").write_text('{"remote":true}\n')
    _git(writer, "add", ".")
    _git(writer, "commit", "-m", "concurrent same-path update")
    _git(writer, "push", "origin", "develop")
    before = _git(writer, "rev-parse", "HEAD").stdout.strip()

    result = _run(promotion_world, "docs/themes", base_sha=base_sha)

    assert result.returncode != 0
    assert "changed on develop after generation" in (result.stdout + result.stderr)
    assert _git(writer, "ls-remote", "origin", "refs/heads/develop").stdout.split()[0] == before


def test_preserves_unrelated_change_since_generation(
    promotion_world: dict[str, Path],
) -> None:
    base_sha = _git(promotion_world["checkout"], "rev-parse", "HEAD").stdout.strip()
    writer = promotion_world["remote"].parent / "writer"
    _git(promotion_world["remote"].parent, "clone", str(promotion_world["remote"]), str(writer))
    (writer / "README.md").write_text("concurrent but unrelated\n")
    _git(writer, "add", "README.md")
    _git(writer, "commit", "-m", "unrelated update")
    _git(writer, "push", "origin", "develop")

    result = _run(promotion_world, "docs/themes", base_sha=base_sha)

    assert result.returncode == 0, result.stdout + result.stderr
    verify = promotion_world["remote"].parent / "verify"
    _git(promotion_world["remote"].parent, "clone", str(promotion_world["remote"]), str(verify))
    assert (verify / "README.md").read_text() == "concurrent but unrelated\n"
    assert (verify / "docs/themes/new-theme/lineage.json").is_file()


def test_exact_theme_path_preserves_concurrent_different_theme(
    promotion_world: dict[str, Path],
) -> None:
    base_sha = _git(promotion_world["checkout"], "rev-parse", "HEAD").stdout.strip()
    writer = promotion_world["remote"].parent / "writer"
    _git(promotion_world["remote"].parent, "clone", str(promotion_world["remote"]), str(writer))
    other = writer / "docs/themes/other-theme/lineage.json"
    other.parent.mkdir(parents=True)
    other.write_text('{"other":true}\n')
    _git(writer, "add", ".")
    _git(writer, "commit", "-m", "concurrent different-theme update")
    _git(writer, "push", "origin", "develop")

    result = _run(
        promotion_world,
        "docs/themes/new-theme",
        base_sha=base_sha,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    verify = promotion_world["remote"].parent / "verify-different-theme"
    _git(promotion_world["remote"].parent, "clone", str(promotion_world["remote"]), str(verify))
    assert (verify / "docs/themes/new-theme/lineage.json").is_file()
    assert (verify / "docs/themes/other-theme/lineage.json").is_file()

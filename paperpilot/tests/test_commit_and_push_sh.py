"""Tests for .github/scripts/commit-and-push.sh — the git push retry helper
that backs theme-on-demand.yml and regen-themes.yml.

We exercise the bash script through subprocess against tmp git repositories
because the live targets (workflow_dispatch on develop) can't be unit-tested
directly. Same pattern as test_worker_slug_parity.py which calls Node via
subprocess for the JS slugger.

Each scenario constructs:
  - a *remote* bare repo (the develop ref the workflow pushes to)
  - a *local* clone (the workflow's checkout)
  - an optional *competitor* clone that races a commit in between

then runs commit-and-push.sh and asserts:
  - exit code
  - which commits ended up on the remote
  - the script's stdout/stderr include the retry diagnostics
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / ".github" / "scripts" / "commit-and-push.sh"


# Hermetic git identity so the host runner's ~/.gitconfig or pre-existing
# GIT_AUTHOR_* env doesn't leak into the fixture and silently win over our
# test defaults. Defined once at module level so _git and _run_script stay
# in sync (review-MED-2: previous setdefault pattern allowed leaks).
_TEST_GIT_ENV: dict[str, str] = {
    "GIT_AUTHOR_NAME": "test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
}


def _git(cwd: Path, *args: str, check: bool = True, env: dict | None = None) -> subprocess.CompletedProcess:
    """Run git with hermetic identity, regardless of host env."""
    full_env = {**os.environ, **_TEST_GIT_ENV, **(env or {})}
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
        env=full_env,
        timeout=30,
    )


@pytest.fixture
def world(tmp_path: Path):
    """Construct a remote bare repo + local clone with one seed commit."""
    remote = tmp_path / "remote.git"
    remote.mkdir()
    _git(remote, "init", "--bare", "--initial-branch=develop")

    local = tmp_path / "local"
    local.mkdir()
    _git(local, "init", "--initial-branch=develop")
    _git(local, "remote", "add", "origin", str(remote))

    # Seed commit so push targets aren't dangling.
    (local / "README.md").write_text("seed\n")
    _git(local, "add", "README.md")
    _git(local, "commit", "-m", "seed")
    _git(local, "push", "-u", "origin", "develop")

    # Stage a fresh change that commit-and-push.sh will commit + push.
    themes = local / "docs" / "themes" / "test-theme"
    themes.mkdir(parents=True)
    (themes / "lineage.json").write_text('{"slug":"test-theme"}\n')

    return {"remote": remote, "local": local, "tmp": tmp_path}


def _run_script(local: Path, msg: str, stage: str = "docs/themes/", env: dict | None = None) -> subprocess.CompletedProcess:
    """Invoke commit-and-push.sh against the local clone.

    Mimics the workflow's pre-step that does `git config user.email ...` by
    passing GIT_*_NAME / GIT_*_EMAIL through the env. Without this the
    sandboxed runner has no identity and `git commit` aborts with 128.
    timeout=30 (review-MED-1): a hung git push must surface as a test
    failure, never as an indefinitely-blocked CI job."""
    full_env = {**os.environ, **_TEST_GIT_ENV, **(env or {})}
    return subprocess.run(
        ["bash", str(SCRIPT_PATH), msg, stage],
        cwd=local,
        capture_output=True,
        text=True,
        env=full_env,
        timeout=30,
    )


def test_script_exists_and_executable():
    """RED guard: the helper must exist before any other test can pass."""
    assert SCRIPT_PATH.exists(), f"missing helper: {SCRIPT_PATH}"
    # The workflow invokes via `bash ...sh`, so x-bit isn't required, but we
    # want it set anyway so it can be invoked directly during ops drills.
    assert os.access(SCRIPT_PATH, os.X_OK), f"helper not executable: {SCRIPT_PATH}"


def test_simple_push_succeeds_when_no_competitor(world):
    """Happy path: no race, single push attempt suffices."""
    r = _run_script(world["local"], 'data(themes): on-demand generation of "Test Theme"')
    assert r.returncode == 0, f"stdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    # The remote should now have 2 commits: seed + the on-demand one.
    log = _git(world["remote"], "log", "--oneline").stdout.strip().splitlines()
    assert len(log) == 2, log
    assert 'on-demand generation of "Test Theme"' in log[0]
    # First attempt should not say "retry".
    assert "retry" not in r.stdout.lower() or "succeeded on attempt 1" in r.stdout


def test_noop_when_nothing_staged(world):
    """If the stage glob matches nothing changed, exit 0 without committing."""
    # Clear the staged change so the script sees a clean tree.
    shutil.rmtree(world["local"] / "docs", ignore_errors=True)
    r = _run_script(world["local"], "data(themes): noop")
    assert r.returncode == 0, r.stderr
    assert "nothing changed" in r.stdout.lower()
    # Remote still has only the seed.
    log = _git(world["remote"], "log", "--oneline").stdout.strip().splitlines()
    assert len(log) == 1


def test_recovers_from_concurrent_push(world):
    """RED→GREEN core test: a competitor pushes between our checkout and our
    push, so our first push gets rejected. The retry loop must pull --rebase
    and re-push, ending with BOTH commits on the remote."""
    # Simulate a parallel workflow that races us. We do its commit before
    # invoking our script — that way our script's first push attempt sees a
    # stale develop and must rebase.
    competitor = world["tmp"] / "competitor"
    _git(world["tmp"], "clone", str(world["remote"]), "competitor")
    (competitor / "docs" / "themes" / "other-theme").mkdir(parents=True)
    (competitor / "docs" / "themes" / "other-theme" / "lineage.json").write_text('{"slug":"other-theme"}\n')
    _git(competitor, "add", "docs/themes/other-theme/lineage.json")
    _git(competitor, "commit", "-m", "competitor commit")
    _git(competitor, "push", "origin", "develop")

    # Now invoke our script with --no-jitter for deterministic timing.
    r = _run_script(
        world["local"],
        'data(themes): on-demand generation of "Test Theme"',
        env={"COMMIT_PUSH_NO_SLEEP": "1"},
    )
    assert r.returncode == 0, f"stdout:\n{r.stdout}\nstderr:\n{r.stderr}"

    # Remote should have 3 commits: seed, competitor's, then ours (in rebase
    # order, ours is on top). This is the real proof that the race was
    # handled — both writers' content survived.
    log = _git(world["remote"], "log", "--oneline").stdout.strip().splitlines()
    assert len(log) == 3, log
    assert 'on-demand generation of "Test Theme"' in log[0]
    assert "competitor commit" in log[1]
    # The rebase activity itself shows up in stderr (git rebase writes its
    # progress lines there). Either stream is fine — we just want evidence
    # that the script went through the rebase path, not that it silently
    # pushed without integrating the competitor's commit.
    combined = (r.stdout + r.stderr).lower()
    assert "rebase" in combined or "retry" in combined, combined


def test_eventually_fails_after_max_retries(world, monkeypatch):
    """Sanity: if every push attempt is rejected, the script must exit 1
    (not silently 0). We force this by giving the local clone a pre-receive
    hook that ALWAYS rejects pushes."""
    hooks = world["remote"] / "hooks"
    hooks.mkdir(exist_ok=True)
    reject = hooks / "pre-receive"
    reject.write_text("#!/bin/sh\necho 'always reject for test'\nexit 1\n")
    reject.chmod(0o755)

    r = _run_script(
        world["local"],
        "data(themes): doomed push",
        env={"COMMIT_PUSH_NO_SLEEP": "1", "COMMIT_PUSH_MAX_ATTEMPTS": "2"},
    )
    assert r.returncode == 1, f"expected failure, stdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    # Error annotation for GitHub Actions log surface.
    assert "push failed" in (r.stdout + r.stderr).lower()


def test_injection_safe_commit_message(world):
    """Defence-in-depth: a commit message containing $() / backticks must be
    treated as a literal string, not interpreted by the shell.

    The sentinel path lives under the per-test tmp_path (review-HIGH-1) so
    parallel pytest workers (pytest-xdist) can't observe each other's
    sentinels and produce a flaky pass/fail."""
    sentinel = world["tmp"] / "pwned_by_commit_sh"
    payload = f'data(themes): "$(touch {sentinel})" `id`'
    r = _run_script(world["local"], payload)
    assert r.returncode == 0, r.stderr
    assert not sentinel.exists(), "shell expanded the user-controlled message"
    log = _git(world["remote"], "log", "-1", "--pretty=%s").stdout.strip()
    assert "$(touch" in log
    assert "`id`" in log

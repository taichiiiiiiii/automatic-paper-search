"""Static checks for .github/workflows/*.yml that catch the class of
errors GitHub Actions reports as 'startup_failure' (0s runs that never
instantiate any job).

#124 traced collect-weekly.yml 3+ days of silent breakage to one of
these: `if: ${{ secrets.GROQ_API_KEY != '' }}` at the step level.
Per GitHub Actions context-availability rules, the `secrets` context
is available in `env`, in `jobs.<id>.steps.<id>.run`, and in
`jobs.<id>.steps.<id>.with` — but NOT in step-level `if:` expressions.
Referencing it there causes the whole workflow to fail at parse time,
which surfaces as a 0-second 'startup_failure' that's almost invisible
unless you go looking for it.

These tests are intentionally pure-Python (no actionlint dependency) so
they run in the same fast pytest suite as the rest of the codebase.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS_DIR = REPO_ROOT / ".github" / "workflows"


def _workflow_files() -> list[Path]:
    return sorted(WORKFLOWS_DIR.glob("*.yml"))


@pytest.fixture(scope="module")
def workflow_files() -> list[Path]:
    files = _workflow_files()
    assert files, f"no workflow YAMLs found under {WORKFLOWS_DIR}"
    return files


def _strip_block_comments(text: str) -> str:
    """Remove # comment lines so YAML examples inside comments don't
    trigger false positives. Keeps inline `# ...` on lines that have
    real content so a `run: ...  # comment` isn't gutted."""
    out: list[str] = []
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("#"):
            continue
        out.append(line)
    return "\n".join(out)


def test_no_secrets_in_step_level_if(workflow_files: list[Path]) -> None:
    """`if: ${{ secrets.FOO != '' }}` at step level is the #124 trap.

    GitHub Actions rejects it at parse time and surfaces a 0-second
    'startup_failure'. Use one of:
      - Move the check into `run:` (`if [ -z "$FOO" ]; then exit 0; fi`)
      - Promote the check to a job-level `if:` (allowed there)
      - Split into a separate job
    """
    bad: list[tuple[Path, int, str]] = []
    pattern = re.compile(r"^\s+if:\s*.*\bsecrets\.", re.MULTILINE)
    for f in workflow_files:
        text = f.read_text(encoding="utf-8")
        text = _strip_block_comments(text)
        for m in pattern.finditer(text):
            # Get the line number by counting newlines up to the match.
            line_no = text[: m.start()].count("\n") + 1
            bad.append((f, line_no, m.group(0).strip()))
    assert not bad, (
        "secrets context in step-level if (causes #124 startup_failure):\n"
        + "\n".join(f"  {f.name}:{ln}  {snippet}" for f, ln, snippet in bad)
    )


def test_workflow_yamls_parse_as_yaml(workflow_files: list[Path]) -> None:
    """Belt-and-braces: confirm every workflow YAML is at least
    well-formed YAML. This won't catch the secrets-in-if bug (that file
    parses fine) but does catch outright syntax errors that GitHub would
    also flag with a startup_failure."""
    import yaml

    for f in workflow_files:
        with open(f, encoding="utf-8") as fp:
            try:
                yaml.safe_load(fp)
            except yaml.YAMLError as exc:
                pytest.fail(f"{f.name} fails yaml.safe_load: {exc}")


def test_workflow_yamls_have_top_level_on(workflow_files: list[Path]) -> None:
    """Every workflow needs a top-level `on:` trigger. Missing it is
    another startup_failure cause."""
    import yaml

    for f in workflow_files:
        with open(f, encoding="utf-8") as fp:
            data = yaml.safe_load(fp)
        # yaml.safe_load on a workflow YAML with `on:` returns either
        # the string "on" as a key or the Python literal `True` because
        # "on" is a YAML 1.1 boolean. Either is fine for our purposes.
        keys = set(data.keys()) if isinstance(data, dict) else set()
        assert "on" in keys or True in keys, (
            f"{f.name} has no top-level `on:` trigger"
        )

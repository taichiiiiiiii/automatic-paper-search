"""Documentation and source must not point at paths that do not exist.

This repository has repeatedly described things it does not have. The
pattern that this test closes is the narrow, mechanical half of it: a
literal repo-relative path written in prose or a docstring, where the file
is simply not there.

Issue #369 found three:

* `CLAUDE.md` described a CI step in `.github/workflows/theme-audit.yml`
  — no such workflow (the real one is `data-audit.yml`).
* `generate_themes_manifest.py`'s own docstring named its output
  `docs/themes-manifest.json`; it writes `docs/themes/themes-manifest.json`.
* `paperpilot/scripts/README.md` repeated that wrong path, because the
  rewrite that produced it copied the docstring faithfully. A wrong primary
  source propagates into everything written from it.

Scope is deliberately limited to files that must be accurate. Excluded:

* `docs/design/**` — carries a staleness banner (#360) whose text names
  `.github/workflows/collect.yml` precisely because it does not exist.
* `CHANGELOG*.md` — a historical record; entries describe the repo as it
  was, including files since removed.
* `.claude/**` — agent and skill definitions using illustrative examples.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

#: Prose files whose paths must resolve.
DOC_TARGETS = [
    "CLAUDE.md",
    "README.md",
    "paperpilot/scripts/README.md",
    "worker/README.md",
]

# A repo-relative path with a known extension.
#
# Two independent things stop `relation_gold_set.jsonl` being read as
# `...json` (which the first version of this sweep did, reporting a file
# that exists as missing):
#
#   1. `jsonl` precedes `json` in the alternation, so the longer extension
#      wins when the engine backtracks.
#   2. the trailing `(?![\w])` rejects a match followed by a word char.
#
# Either alone is sufficient — verified by removing each in turn, which
# changes nothing, and both together, which truncates. That redundancy is
# why `test_path_regex_does_not_truncate_extensions` cannot be satisfied by
# a single-element mutation: it pins the *behaviour*, not one mechanism.
_PATH_RE = re.compile(
    r"(?<![\w/.-])"
    r"((?:paperpilot|docs|worker|scripts|analysis|archive|\.github)/[\w./-]+"
    r"\.(?:py|md|jsonl|json|ya?ml|html|js|mjs|ts|css|sh|txt|xml))"
    r"(?![\w])"
)


def _dangling(text: str) -> list[str]:
    return sorted(
        {
            candidate
            for raw in _PATH_RE.findall(text)
            if not (REPO_ROOT / (candidate := raw.rstrip(".,)"))).exists()
        }
    )


def test_path_regex_does_not_truncate_extensions() -> None:
    """Guard the guard: `.jsonl` must not be read as `.json`."""
    found = _PATH_RE.findall("see paperpilot/tests/fixtures/relation_gold_set.jsonl now")
    assert found == ["paperpilot/tests/fixtures/relation_gold_set.jsonl"]


@pytest.mark.parametrize("relpath", DOC_TARGETS)
def test_doc_paths_exist(relpath: str) -> None:
    path = REPO_ROOT / relpath
    assert path.exists(), f"{relpath} itself is missing"
    dangling = _dangling(path.read_text(encoding="utf-8"))
    assert not dangling, f"{relpath} references paths that do not exist: {dangling}"


def test_python_source_paths_exist() -> None:
    """Docstrings and comments in `paperpilot/` must name real files.

    #369 started in a module docstring, so source is in scope — that is
    where the wrong path was authored before anything copied it.
    """
    broken: dict[str, list[str]] = {}
    for path in sorted((REPO_ROOT / "paperpilot").rglob("*.py")):
        # Tests legitimately name fixtures that do not exist on disk
        # (`docs/themes/test-theme/lineage.json`, `nonexistent-cache.json`),
        # so they are out of scope: the concern is source that documents
        # the real layout.
        if "__pycache__" in path.parts or "tests" in path.parts:
            continue
        if dangling := _dangling(path.read_text(encoding="utf-8")):
            broken[str(path.relative_to(REPO_ROOT))] = dangling
    assert not broken, f"source references paths that do not exist: {broken}"

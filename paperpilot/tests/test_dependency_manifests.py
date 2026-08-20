"""The two dependency manifests must not drift apart.

`pyproject.toml` (`project.dependencies`) and `paperpilot/requirements.txt`
are two independent ways to install the same runtime. README documents the
requirements.txt path as "runtime のみ", so anything the code imports at
module scope has to appear in *both*.

Issue #361: `numpy` was declared in pyproject.toml but missing from
requirements.txt, while `pipeline/runner.py` imports `stage_embedding`
(which imports numpy) at module scope. Following the README produced an
install where `import paperpilot.collector` raised ModuleNotFoundError.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PYPROJECT = REPO_ROOT / "pyproject.toml"
REQUIREMENTS = REPO_ROOT / "paperpilot" / "requirements.txt"

# `name>=1.2` / `name[extra]==1.2` / `name` → `name`
_NAME_RE = re.compile(r"^\s*([A-Za-z0-9._-]+)")


def _dist_name(spec: str) -> str:
    match = _NAME_RE.match(spec)
    assert match, f"unparseable requirement: {spec!r}"
    # PEP 503 normalisation: '_' and '.' are equivalent to '-'
    return re.sub(r"[-_.]+", "-", match.group(1)).lower()


def _pyproject_core_deps() -> set[str]:
    if sys.version_info < (3, 11):
        pytest.skip("tomllib requires Python 3.11+")
    import tomllib

    with PYPROJECT.open("rb") as handle:
        data = tomllib.load(handle)
    return {_dist_name(d) for d in data["project"]["dependencies"]}


def _requirements() -> set[str]:
    names: set[str] = set()
    for raw in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", "-")):
            continue
        names.add(_dist_name(line))
    return names


def test_requirements_covers_every_pyproject_core_dependency() -> None:
    missing = _pyproject_core_deps() - _requirements()
    assert not missing, (
        "these core dependencies are declared in pyproject.toml but absent "
        f"from paperpilot/requirements.txt: {sorted(missing)}. "
        "README documents `pip install -r paperpilot/requirements.txt` as a "
        "complete runtime install, so that path would be broken (#361)."
    )


def test_requirements_adds_nothing_outside_pyproject() -> None:
    """The reverse direction — requirements.txt should not grow its own deps.

    A package that only requirements.txt knows about would be missing from
    `pip install -e .`, which is the other documented install path.
    """
    extra = _requirements() - _pyproject_core_deps()
    assert not extra, (
        "these packages are in paperpilot/requirements.txt but not in "
        f"pyproject.toml's project.dependencies: {sorted(extra)}"
    )

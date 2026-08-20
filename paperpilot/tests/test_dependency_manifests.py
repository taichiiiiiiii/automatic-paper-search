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


# --- extras referenced from source must exist (#362) -------------------
#
# `utils/unarxive.py` told users to run `pip install 'paperpilot[unarxive]'`
# for two years' worth of nothing: that extra did not exist, so the one
# remediation the message offered could not be followed.

_EXTRA_REF_RE = re.compile(r"paperpilot\[([a-z][a-z0-9-]*)\]")
_SOURCE_ROOT = REPO_ROOT / "paperpilot"


def _referenced_extras() -> dict[str, list[str]]:
    """Map extra name -> files that tell a user to install it."""
    refs: dict[str, list[str]] = {}
    for path in sorted(_SOURCE_ROOT.rglob("*.py")):
        if "tests" in path.parts:
            continue
        for name in _EXTRA_REF_RE.findall(path.read_text(encoding="utf-8")):
            refs.setdefault(name, []).append(str(path.relative_to(REPO_ROOT)))
    return refs


def _declared_extras() -> set[str]:
    if sys.version_info < (3, 11):
        pytest.skip("tomllib requires Python 3.11+")
    import tomllib

    with PYPROJECT.open("rb") as handle:
        data = tomllib.load(handle)
    return set(data["project"].get("optional-dependencies", {}))


def test_every_extra_named_in_source_exists() -> None:
    referenced = _referenced_extras()
    assert referenced, "no `paperpilot[extra]` reference found — regex broke?"
    declared = _declared_extras()
    dangling = {name: files for name, files in referenced.items() if name not in declared}
    assert not dangling, (
        "source tells users to install extras that pyproject.toml does not "
        f"define: {dangling}. Declared extras are {sorted(declared)}."
    )


# --- every imported third-party module must be declared somewhere -------
#
# The two tests above compare manifests against each other, so they stay
# green even when *both* omit something the code actually imports. That is
# exactly how `duckdb` / `huggingface_hub` went undeclared (#362) — they are
# imported lazily, so nothing failed at import time and no manifest knew
# about them. This test closes that gap by starting from the imports.

import ast  # noqa: E402

# Distributions whose import name differs from the distribution name.
# Keys must be declared distributions — `test_module_alias_map_has_no_stale_entries`
# fails if one is removed from pyproject, so this map cannot rot silently.
MODULE_ALIASES = {
    "pyyaml": "yaml",
    "python-dotenv": "dotenv",
    "sentence-transformers": "sentence_transformers",
    "google-auth": "google",
    "pytest-cov": "pytest_cov",
    "types-requests": None,   # stub-only, provides no importable module
    "types-pyyaml": None,
}


def _all_declared_dists() -> set[str]:
    if sys.version_info < (3, 11):
        pytest.skip("tomllib requires Python 3.11+")
    import tomllib

    with PYPROJECT.open("rb") as handle:
        data = tomllib.load(handle)
    project = data["project"]
    dists = {_dist_name(d) for d in project["dependencies"]}
    for specs in project.get("optional-dependencies", {}).values():
        dists |= {_dist_name(d) for d in specs}
    return dists


def _declared_module_names() -> set[str]:
    out: set[str] = set()
    for dist in _all_declared_dists():
        if dist in MODULE_ALIASES:
            alias = MODULE_ALIASES[dist]
            if alias:
                out.add(alias)
        else:
            out.add(dist.replace("-", "_"))
    return out


def _imported_third_party() -> dict[str, list[str]]:
    """Every non-stdlib, non-local module imported under paperpilot/ (tests excluded).

    Walks the whole AST, not just module scope, so lazily-imported optional
    packages are covered too.
    """
    found: dict[str, list[str]] = {}
    for path in sorted(_SOURCE_ROOT.rglob("*.py")):
        if "tests" in path.parts:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                modules = [node.module.split(".")[0]]
            else:
                continue
            for module in modules:
                if module in sys.stdlib_module_names:
                    continue
                if module == "paperpilot" or module.startswith("_"):
                    continue
                found.setdefault(module, []).append(str(path.relative_to(REPO_ROOT)))
    return found


def test_every_imported_third_party_module_is_declared() -> None:
    imported = _imported_third_party()
    assert imported, "no third-party import found — the AST walk broke?"
    declared = _declared_module_names()
    undeclared = {
        module: sorted(set(files))
        for module, files in imported.items()
        if module not in declared
    }
    assert not undeclared, (
        "these modules are imported but appear in neither project.dependencies "
        f"nor any optional-dependencies group: {undeclared}. Add them to a "
        "manifest (or to MODULE_ALIASES if the import name simply differs)."
    )


def test_module_alias_map_has_no_stale_entries() -> None:
    """Keep MODULE_ALIASES honest: every key must still be a declared dist."""
    stale = sorted(set(MODULE_ALIASES) - _all_declared_dists())
    assert not stale, (
        f"MODULE_ALIASES lists distributions that pyproject.toml no longer "
        f"declares: {stale}"
    )

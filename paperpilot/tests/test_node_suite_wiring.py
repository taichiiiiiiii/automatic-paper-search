"""Every node test suite in the repo must be executed by pytest.

There is no CI that runs tests (#358), so pytest is the only gate: a
`.mjs` suite that no Python test references is dead weight, however many
assertions it holds.

This has now happened twice.

  #364  `worker/*.test.mjs`                     — 54 assertions, unrun
  #365  `tests/viewer/test_theme_request_progress.mjs` — 31 assertions, unrun

The #364 fix added a wiring guard, but scoped it to `worker/` — so the
identical gap in `tests/viewer/` survived. This guard is deliberately
repo-wide so the *class* is closed, not one instance of it.
"""

from __future__ import annotations

import ast
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TESTS_ROOT = REPO_ROOT / "paperpilot" / "tests"
SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__", ".pytest_cache"}


def _node_suites() -> list[Path]:
    """Every `*.test.mjs` / `test_*.mjs` tracked in the repo."""
    out: list[Path] = []
    for path in REPO_ROOT.rglob("*.mjs"):
        if SKIP_DIRS & set(path.parts):
            continue
        name = path.name
        if name.endswith(".test.mjs") or name.startswith("test_"):
            out.append(path)
    return sorted(out)


def _referenced_names() -> set[str]:
    """Filenames referenced from *code* in the Python test suite.

    A plain substring search over the sources does not work: this very
    module names each suite in its docstring while explaining #364/#365,
    and a docstring mention would then satisfy the check it is describing.
    That is not hypothetical — the first version of this guard passed
    while the wiring it guards was removed.

    So: parse each test module and collect string literals, minus
    docstrings. Comments never reach the AST, so they drop out for free.
    """
    names: set[str] = set()
    for path in TESTS_ROOT.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        docstrings = set()
        for node in ast.walk(tree):
            if isinstance(
                node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
            ):
                body = getattr(node, "body", None)
                if (
                    body
                    and isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)
                ):
                    docstrings.add(id(body[0].value))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and id(node) not in docstrings
            ):
                names.add(node.value)
    return names


def test_every_node_suite_is_referenced_by_a_python_test() -> None:
    suites = _node_suites()
    assert suites, "no node suite found — did the glob break?"
    referenced = _referenced_names()
    unwired = sorted(
        str(p.relative_to(REPO_ROOT)) for p in suites if p.name not in referenced
    )
    assert not unwired, (
        "these node test suites are never executed by pytest, and no CI runs "
        f"tests either — so nothing runs them at all: {unwired}. Wire each one "
        "into a Python test (see tests/viewer/test_theme_viewer_smoke.py or "
        "tests/test_worker_node_suites.py for the pattern)."
    )

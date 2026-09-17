"""`.env.example` must list every environment variable the code reads.

README tells users to `cp paperpilot/.env.example paperpilot/.env`, and the
file itself claims to enumerate the options ("All variables are optional").
When the code grows a new variable and the example does not, the variable
becomes invisible: the feature exists but nobody can turn it on.

Issue #366 found eight such variables, including the whole Google Sheets
integration (`PAPERPILOT_SHEET_ID` / `PAPERPILOT_SHEET_SHARE_EMAIL` /
`GOOGLE_APPLICATION_CREDENTIALS`) and the `PAPERPILOT_LLM_PROVIDER`
override.

This is the same shape as #361 (numpy missing from requirements.txt) and
#362 (an extra the code advertised but pyproject did not define): two
places that must agree, with nothing checking that they do.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = REPO_ROOT / "paperpilot"
ENV_EXAMPLE = SOURCE_ROOT / ".env.example"

# `NAME=` or `# NAME=` (commented entries still document the variable).
_DECL_RE = re.compile(r"^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=")


def _declared() -> set[str]:
    return {
        m.group(1)
        for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines()
        if (m := _DECL_RE.match(line))
    }


def _environ_param_names(tree: ast.AST) -> set[str]:
    """Parameter names whose default is `os.environ` (dependency-injected reads).

    E.g. `def f(..., environ: Mapping[str, str] = os.environ): environ.get("X")`
    reads env var X just as surely as `os.environ.get("X")` does, but the
    read happens through the parameter name, not through `os.environ`
    directly.
    """
    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        args = node.args
        positional = [*args.posonlyargs, *args.args]
        for arg, default in zip(positional[len(positional) - len(args.defaults) :], args.defaults):
            if isinstance(default, ast.Attribute) and default.attr == "environ":
                names.add(arg.arg)
        for arg, default in zip(args.kwonlyargs, args.kw_defaults):
            if isinstance(default, ast.Attribute) and default.attr == "environ":
                names.add(arg.arg)
    return names


def _env_reads_in(tree: ast.AST) -> set[str]:
    """Names passed to os.getenv / os.environ.get / os.environ[...].

    Also follows env-var reads made through a parameter that defaults to
    `os.environ` (see `_environ_param_names`), so dependency-injected code
    like `sol_local.py`'s `environ: Mapping[str, str] = os.environ` is
    still recognized as reading that variable.
    """
    names: set[str] = set()
    environ_aliases = _environ_param_names(tree)

    def literal(node: ast.AST | None) -> str | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        return None

    def is_environ_ref(node: ast.AST) -> bool:
        return (isinstance(node, ast.Attribute) and node.attr == "environ") or (
            isinstance(node, ast.Name) and node.id in environ_aliases
        )

    for node in ast.walk(tree):
        name: str | None = None
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            fn = node.func
            is_getenv = fn.attr == "getenv"
            is_environ_get = fn.attr == "get" and is_environ_ref(fn.value)
            if (is_getenv or is_environ_get) and node.args:
                name = literal(node.args[0])
        elif isinstance(node, ast.Subscript) and is_environ_ref(node.value):
            name = literal(node.slice)
        if name:
            names.add(name)
    return names


def _used() -> dict[str, list[str]]:
    """env var -> source files reading it (tests excluded)."""
    used: dict[str, list[str]] = {}
    for path in sorted(SOURCE_ROOT.rglob("*.py")):
        if "tests" in path.parts or "__pycache__" in path.parts:
            continue
        for name in _env_reads_in(ast.parse(path.read_text(encoding="utf-8"))):
            used.setdefault(name, []).append(str(path.relative_to(REPO_ROOT)))
    return used


def test_env_example_documents_every_variable_the_code_reads() -> None:
    used = _used()
    assert used, "no env var read found — did the AST walk break?"
    declared = _declared()
    missing = {name: files for name, files in used.items() if name not in declared}
    assert not missing, (
        "these environment variables are read by the code but absent from "
        f"paperpilot/.env.example, so a user copying it cannot discover them: "
        f"{ {k: sorted(v) for k, v in sorted(missing.items())} }"
    )


def test_env_example_has_no_variables_the_code_ignores() -> None:
    """The reverse: a documented knob that nothing reads is a lie too."""
    stale = sorted(_declared() - set(_used()))
    assert not stale, (
        f"paperpilot/.env.example documents variables no code reads: {stale}"
    )

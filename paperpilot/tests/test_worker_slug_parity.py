"""Pin: Worker slug must match Python's theme_slug() exactly.

The CF Worker (worker/slug.js) and the GitHub Actions workflow each
derive a slug from the user's free-text theme. The Worker's output is
spliced into the redirect URL the user sees; the workflow's output
becomes the directory name on disk. If the two ever diverge — even by
a single character — a freshly generated theme would be invisible to
the redirect (404 in the viewer).

This test runs the same input list through both implementations and
fails on any mismatch. Run via the existing pytest suite; a node
binary on PATH is required.

M-5a: the parity above is only 2-way (Python theme_slug() <-> Worker
themeSlug()). The browser-side input validation in docs/assets/theme.js
(SLUG_RE / THEME_REQUEST_PATTERN) is a *third* independent copy of the
same two shapes (worker/slug.js's own SLUG_RE / THEME_INPUT_PATTERN), and
nothing pinned it against the other two — a client regex drift would let
the browser accept input the server rejects (or the reverse) without any
test catching it. test_theme_js_slug_regexes_match_worker_slug_js below
closes that gap by comparing the regex literal source text of all three
pairs, making the contract genuinely 3-way.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from paperpilot.scripts._common import theme_slug

ROOT = Path(__file__).resolve().parents[2]
SLUG_JS = ROOT / "worker" / "slug.js"
THEME_JS = ROOT / "docs" / "assets" / "theme.js"

# Inputs cover the everyday case + the edge cases that have bitten us:
# whitespace runs, trailing hyphens after the 64-char cap, NFKD-strippable
# unicode, path-traversal probes.
PARITY_INPUTS = [
    "Mixture of Experts",
    "Direct-Preference-Optimization",
    "Vision_Transformer",
    "Vision    Transformer",
    "  Diffusion Model  ",
    "RLHF",
    "BERT 2018",
    "Reinforcement Learning from Human Feedback",
    "Retrieval-Augmented Generation",
    "../../etc/passwd",  # path traversal probe
    "MoE モデル",         # NFKD strips the CJK part
    "a" * 200,           # 64-char cap stress
]


def _js_slugs(inputs: list[str]) -> list[str]:
    """Invoke worker/slug.js once with all inputs → list of slugs."""
    node = shutil.which("node")
    if node is None:
        pytest.skip("node not installed; skipping JS/Python slug parity test")
    script = (
        f"import {{ themeSlug }} from {json.dumps(str(SLUG_JS))};\n"
        "const inputs = JSON.parse(process.argv[1]);\n"
        "const out = inputs.map((s) => {\n"
        "  try { return themeSlug(s); } catch (e) { return `ERR:${e.message}`; }\n"
        "});\n"
        "process.stdout.write(JSON.stringify(out));\n"
    )
    res = subprocess.run(
        [node, "--input-type=module", "-e", script, json.dumps(inputs)],
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if res.returncode != 0:
        pytest.fail(f"node invocation failed: {res.stderr}")
    # json.loads returns Any; narrow to the declared list[str] so mypy
    # doesn't flag the implicit-Any return. The node script always
    # emits a JSON array of strings; downstream tests assert per-entry.
    parsed: list[str] = json.loads(res.stdout)
    return parsed


def test_worker_slug_matches_python_slug() -> None:
    js_slugs = _js_slugs(PARITY_INPUTS)
    py_slugs: list[str] = []
    for label in PARITY_INPUTS:
        try:
            py_slugs.append(theme_slug(label))
        except ValueError as e:
            py_slugs.append(f"ERR:{e}")

    mismatches = [
        (inp, js, py)
        for inp, js, py in zip(PARITY_INPUTS, js_slugs, py_slugs, strict=True)
        if js != py
        # Error messages can diverge in wording; treat both being errors as a match.
        and not (js.startswith("ERR:") and py.startswith("ERR:"))
    ]
    assert not mismatches, (
        "Worker / Python slug divergence:\n"
        + "\n".join(f"  {inp!r:50}  js={js!r}  py={py!r}" for inp, js, py in mismatches)
    )


def _extract_regex_literal(source: str, const_name: str) -> str:
    """Pull the body of a ``const NAME = /.../flags;`` regex literal out of
    JS source text (no node/eval needed — this is a text-level pin, same
    as the `json.dumps` source-splicing trick the other viewer tests use).
    Matches both bare ``const NAME =`` and ``export const NAME =``.
    """
    m = re.search(
        rf"const\s+{re.escape(const_name)}\s*=\s*/((?:\\.|[^/\\\n])*)/[a-z]*\s*;",
        source,
    )
    if m is None:
        raise AssertionError(f"could not find `const {const_name} = /.../;` in source")
    return m.group(1)


def _normalize_charclass_hyphen_escape(pattern: str) -> str:
    """``[_-]`` and ``[_\\-]`` denote the identical regex (an escaped
    literal hyphen is behaviorally a no-op), but the two files don't
    always agree on which style to write. Comparing *meaning* rather than
    raw bytes means this test only fires on a real shape divergence, not
    a cosmetic escaping choice.
    """
    return pattern.replace("\\-", "-")


def test_theme_js_slug_regexes_match_worker_slug_js() -> None:
    """M-5a: make the slug-shape parity genuinely 3-way.

    worker/slug.js's themeSlug() is already pinned against Python's
    theme_slug() above. This test adds the missing third leg: the
    browser-side validation regexes in docs/assets/theme.js (SLUG_RE,
    THEME_REQUEST_PATTERN) must denote exactly the same shapes as
    worker/slug.js's own SLUG_RE / THEME_INPUT_PATTERN. A silent drift
    here lets the client accept input the server will reject (confusing
    post-submit error) or reject input the server would accept (a false
    "invalid input" banner the user can't work around) — neither of
    which the existing Python<->Worker pin would ever catch.
    """
    theme_src = THEME_JS.read_text(encoding="utf-8")
    worker_src = SLUG_JS.read_text(encoding="utf-8")

    theme_slug_re = _normalize_charclass_hyphen_escape(
        _extract_regex_literal(theme_src, "SLUG_RE")
    )
    worker_slug_re = _normalize_charclass_hyphen_escape(
        _extract_regex_literal(worker_src, "SLUG_RE")
    )
    assert theme_slug_re == worker_slug_re, (
        f"docs/assets/theme.js SLUG_RE ({theme_slug_re!r}) != "
        f"worker/slug.js SLUG_RE ({worker_slug_re!r})"
    )

    theme_input_re = _normalize_charclass_hyphen_escape(
        _extract_regex_literal(theme_src, "THEME_REQUEST_PATTERN")
    )
    worker_input_re = _normalize_charclass_hyphen_escape(
        _extract_regex_literal(worker_src, "THEME_INPUT_PATTERN")
    )
    assert theme_input_re == worker_input_re, (
        f"docs/assets/theme.js THEME_REQUEST_PATTERN ({theme_input_re!r}) != "
        f"worker/slug.js THEME_INPUT_PATTERN ({worker_input_re!r})"
    )

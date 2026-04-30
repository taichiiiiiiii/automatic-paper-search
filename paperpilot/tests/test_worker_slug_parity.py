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
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from paperpilot.scripts._common import theme_slug

ROOT = Path(__file__).resolve().parents[2]
SLUG_JS = ROOT / "worker" / "slug.js"

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
    return json.loads(res.stdout)


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

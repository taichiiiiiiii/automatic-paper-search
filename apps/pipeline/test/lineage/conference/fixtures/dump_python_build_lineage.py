"""Parity fixture generator for the TS port of `build_lineage.py::build`
(P4d part 3).

Runs the REAL Python `build()` against a canned S2 response map
(`request_with_retry` monkeypatched; network never touched), a fake LLM
provider that always returns `None` from `classify_relation` (simulating
"LLM dark" / no API key, the common steady state under free-tier quota —
exercises the `derive_relation(strict_mode="off")` heuristic fallback path
that `classifyCachedV2` must also take), and a fixed `generated_at`. Dumps
the resulting lineage graph to `<scenario>.expected.json` so a Vitest test
can feed the identical canned responses to the TS port and assert the two
outputs are structurally equal.

This script is NOT part of the pipeline or its test suite; it is a one-off
generator whose only consumer is
apps/pipeline/test/lineage/conference/buildLineage.parity.test.ts (which
reads its committed *.expected.json rather than re-running Python).

Run with:
    uv run --extra dev python apps/pipeline/test/lineage/conference/fixtures/dump_python_build_lineage.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[5]
sys.path.insert(0, str(REPO_ROOT))

from paperpilot.scripts import build_lineage as bl  # noqa: E402

FIXED_GENERATED_AT = "2026-08-30T00:00:00Z"
PAPER_ID_ONE = "1" * 40


class _FakeProvider:
    """Always returns None from classify_relation (LLM dark / no key) so
    `_classify_cached_v2` takes the `derive_relation(strict_mode="off")`
    heuristic fallback path -- the deterministic, network-free branch."""

    name = "fake"
    model = None

    def classify_relation(self, a, b):  # noqa: ANN001
        return None


RESPONSES: dict[str, tuple[int, dict]] = {
    "https://api.semanticscholar.org/graph/v1/paper/arXiv:2601.00001": (
        200,
        {
            "paperId": "S2FOCUS",
            "title": "Oral Paper One",
            "year": 2026,
            "venue": "arXiv",
            "citationCount": 0,
            "authors": [{"name": "A. Author"}],
            "abstract": "Focus abstract.",
            "externalIds": {"ArXiv": "2601.00001"},
        },
    ),
    "https://api.semanticscholar.org/graph/v1/paper/S2FOCUS/references": (
        200,
        {
            "data": [
                {
                    "citedPaper": {
                        "paperId": "S2PARENT",
                        "title": "Parent Paper",
                        "year": 2020,
                        "venue": "NeurIPS",
                        "citationCount": 100,
                        "authors": [{"name": "B. Author"}],
                        "abstract": "Parent abstract.",
                        "externalIds": {},
                    },
                    "isInfluential": True,
                    "intents": ["methodology"],
                }
            ]
        },
    ),
    "https://api.semanticscholar.org/graph/v1/paper/S2FOCUS/citations": (
        200,
        {
            "data": [
                {
                    "citingPaper": {
                        "paperId": "S2CHILD",
                        "title": "Child Paper",
                        "year": 2027,
                        "venue": "ICML",
                        "citationCount": 3,
                        "authors": [{"name": "C. Author"}],
                        "abstract": "Child abstract.",
                        "externalIds": {},
                    },
                    "isInfluential": True,
                    "intents": ["result"],
                }
            ]
        },
    ),
}


def _resp(status: int, body) -> SimpleNamespace:
    return SimpleNamespace(status_code=status, json=lambda: body)


def _fake_request_with_retry(method, url, *, params=None, timeout=None, headers=None, **_kw):  # noqa: ANN001
    base = url.split("?", 1)[0]
    if base not in RESPONSES:
        raise AssertionError(f"no canned response for url={base!r}")
    status, body = RESPONSES[base]
    return _resp(status, body)


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        docs_dir = tmp_path / "docs" / "testconf"
        docs_dir.mkdir(parents=True)
        (docs_dir / "papers.json").write_text(
            json.dumps(
                [
                    {
                        "paper_id": PAPER_ID_ONE,
                        "title": "Oral Paper One",
                        "type": "Oral",
                        "arxiv_id": "2601.00001",
                        "tags": ["vision"],
                        "citation_count": 5,
                        "github_stars": 2,
                    }
                ]
            ),
            encoding="utf-8",
        )
        cache_dir = tmp_path / "lineage-cache"
        cache_dir.mkdir(parents=True)

        with (
            patch.object(bl, "DOCS_ROOT", tmp_path / "docs"),
            patch.object(bl, "CACHE_DIR", cache_dir),
            patch.object(bl, "build_provider", lambda: (_FakeProvider(), 0.0)),
            patch.object(bl, "request_with_retry", _fake_request_with_retry),
            patch.object(bl.time, "sleep", lambda *_a, **_kw: None),
        ):
            graph = bl.build(conference="testconf", generated_at=FIXED_GENERATED_AT)

    out = HERE / "build_lineage_happy.expected.json"
    out.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()

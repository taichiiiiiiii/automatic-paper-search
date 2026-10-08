"""Parity fixture generator for the TS port of
`build_deep_lineage.py::build_deep` (P4d part 3).

Runs the REAL Python `build_deep` against a canned S2 response map
(`request_with_retry` monkeypatched; network never touched), a fake LLM
provider whose `complete_json` returns a canned JSON string keyed by which
paper's title appears in the prompt (one response has an EMPTY rationale,
to exercise the `_slot_fill_rationale` fallback this module's lenient
classifier exists for — LIN-36), and `depth=1`. Dumps the resulting deep
lineage graph to `build_deep_happy.expected.json` so a Vitest test can feed
the identical canned responses to the TS port and assert the two outputs
are structurally equal.

This script is NOT part of the pipeline or its test suite; it is a one-off
generator whose only consumer is
apps/pipeline/test/lineage/deep/buildDeepLineage.parity.test.ts.

Run with:
    uv run --extra dev python apps/pipeline/test/lineage/deep/fixtures/dump_python_build_deep_lineage.py
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

from paperpilot.scripts import build_deep_lineage as bdl  # noqa: E402
from paperpilot.scripts import build_lineage as bl  # noqa: E402

SEED_PAPER_ID = "1" * 40


class _FakeProvider:
    name = "fake"
    model = None

    def complete_json(self, system, user):  # noqa: ANN001
        if "Parent Paper" in user:
            # Empty rationale -> exercises _slot_fill_rationale (LIN-36).
            return json.dumps({"relation": "extends", "confidence": 0.6, "rationale": ""})
        if "Child Paper" in user:
            return json.dumps(
                {
                    "relation": "successor",
                    "confidence": 0.5,
                    "rationale": "十分に長い具体的な論文固有の根拠文です。",
                }
            )
        raise AssertionError(f"unexpected prompt: {user!r}")


RESPONSES: dict[str, tuple[int, dict]] = {
    "https://api.semanticscholar.org/graph/v1/paper/arXiv:2602.18473": (
        200,
        {
            "paperId": "S2FOCUS",
            "title": "Deep Focus Paper",
            "year": 2026,
            "venue": "arXiv",
            "citationCount": 0,
            "authors": [{"name": "A. Author"}],
            "abstract": "Focus abstract.",
            "externalIds": {"ArXiv": "2602.18473"},
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
        cache_dir = Path(tmp) / "lineage-cache"
        cache_dir.mkdir(parents=True)
        with (
            patch.object(bdl, "CACHE_DIR", cache_dir),
            patch.object(bl, "CACHE_DIR", cache_dir),
            patch.object(bdl, "build_provider", lambda: (_FakeProvider(), 0.0)),
            patch.object(bl, "request_with_retry", _fake_request_with_retry),
            patch.object(bdl.time, "sleep", lambda *_a, **_kw: None),
            patch.object(bdl, "_utc_now") as mock_now,
        ):
            import datetime as _dt

            mock_now.return_value = _dt.datetime(2026, 8, 30, 0, 0, 0, tzinfo=_dt.timezone.utc)
            graph = bdl.build_deep(
                "2602.18473",
                seed_paper_id=SEED_PAPER_ID,
                depth=1,
                top_parents=5,
                top_children=5,
                venue_override="ICLR 2026",
                tier_override="A+",
            )

    # generated_at uses time.strftime(time.gmtime()) directly (not _utc_now),
    # so blank it to a fixed sentinel for a stable fixture comparison -- the
    # TS test asserts everything else and checks this field only shape-wise.
    graph["meta"]["generated_at"] = "FIXED"
    out = HERE / "build_deep_happy.expected.json"
    out.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()

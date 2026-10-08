"""Parity fixture generator for the TS port of `build_conference_lineage.py`
(P4d part 3).

Runs the REAL Python `build_graph` against a canned OpenAlex response map
(`request_with_retry` monkeypatched; network never touched) with a FIXED
`generated_at`, and dumps the resulting lineage graph to
`<scenario>.expected.json` so a Vitest test can feed the identical canned
responses to the TS port and assert the two outputs are structurally equal.

This script is NOT part of the pipeline or its test suite; it is a one-off
generator whose only consumer is
apps/pipeline/test/lineage/conference/buildConferenceLineage.parity.test.ts
(which reads its committed *.expected.json rather than re-running Python).

Run with:
    uv run --extra dev python apps/pipeline/test/lineage/conference/fixtures/dump_python_conference_lineage.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[5]
sys.path.insert(0, str(REPO_ROOT))

from paperpilot.scripts import build_conference_lineage as bcl  # noqa: E402
from paperpilot.scripts._fetch_state import BuildCompleteness, IncompleteFetchError  # noqa: E402

FIXED_GENERATED_AT = "2026-08-30T00:00:00Z"

PAPER_ID_ONE = "1" * 40

# Keyed by the request's `filter` query param. Each entry is
# (status_code, json_body) or an exception instance to simulate a transient
# failure for that specific query.
RESPONSES_HAPPY: dict[str, tuple[int, dict]] = {
    'title.search:Oral Paper One': (
        200,
        {
            "results": [
                {
                    "id": "https://openalex.org/W100",
                    "title": "Oral Paper One",
                    "publication_year": 2026,
                    "authorships": [{"author": {"display_name": "A. Author"}}],
                    "primary_location": {"source": {"display_name": "ICLR"}},
                    "locations": [],
                    "ids": {"openalex": "https://openalex.org/W100", "arxiv": "2601.00001"},
                    "doi": None,
                    "referenced_works": ["https://openalex.org/W200"],
                    "cited_by_count": 10,
                }
            ]
        },
    ),
    "ids.openalex:W200": (
        200,
        {
            "results": [
                {
                    "id": "https://openalex.org/W200",
                    "title": "Reference Paper",
                    "publication_year": 2020,
                    "authorships": [{"author": {"display_name": "B. Author"}}],
                    "primary_location": {"source": {"display_name": "NeurIPS"}},
                }
            ]
        },
    ),
    "cites:W100": (
        200,
        {
            "results": [
                {
                    "id": "https://openalex.org/W300",
                    "title": "Citer Paper",
                    "publication_year": 2027,
                    "authorships": [{"author": {"display_name": "C. Author"}}],
                    "primary_location": {"source": {"display_name": "ICML"}},
                }
            ]
        },
    ),
}


def _resp(status: int, body) -> SimpleNamespace:
    return SimpleNamespace(status_code=status, json=lambda: body)


def _make_fake_request_with_retry(responses: dict[str, tuple[int, dict]]):
    def _fake(method, url, *, params=None, timeout=None, **_kw):  # noqa: ANN001
        filt = (params or {}).get("filter", "")
        if filt not in responses:
            raise AssertionError(f"no canned response for filter={filt!r}")
        status, body = responses[filt]
        return _resp(status, body)

    return _fake


def run_happy() -> dict:
    orals = [
        {
            "paper_id": PAPER_ID_ONE,
            "title": "Oral Paper One",
            "source": "arxiv",
            "source_id": "2601.00001",
            "arxiv_id": "2601.00001",
        }
    ]
    completeness = BuildCompleteness()
    with patch.object(bcl, "request_with_retry", _make_fake_request_with_retry(RESPONSES_HAPPY)):
        graph = bcl.build_graph(
            orals,
            display="ICLR 2026",
            refs_per=4,
            citers_per=2,
            generated_at=FIXED_GENERATED_AT,
            completeness=completeness,
        )
    return graph


def run_subject_failure() -> dict:
    """The resolve_oral query for the one Oral fails transiently -> subject_failures non-empty."""
    orals = [
        {
            "paper_id": PAPER_ID_ONE,
            "title": "Oral Paper One",
            "source": "arxiv",
            "source_id": "2601.00001",
            "arxiv_id": "2601.00001",
        }
    ]

    def _fake(method, url, *, params=None, timeout=None, **_kw):  # noqa: ANN001
        raise IncompleteFetchError("simulated outage")

    completeness = BuildCompleteness()
    with patch.object(bcl, "request_with_retry") as mock_req:
        mock_req.side_effect = lambda *a, **kw: _resp(503, {})
        graph = bcl.build_graph(
            orals,
            display="ICLR 2026",
            refs_per=4,
            citers_per=2,
            generated_at=FIXED_GENERATED_AT,
            completeness=completeness,
        )
    return {"graph": graph, "subject_failures": completeness.subject_failures}


def main() -> None:
    out_dir = HERE
    happy = run_happy()
    (out_dir / "happy.expected.json").write_text(
        json.dumps(happy, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {out_dir / 'happy.expected.json'}")

    subject_failure = run_subject_failure()
    (out_dir / "subject_failure.expected.json").write_text(
        json.dumps(subject_failure, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {out_dir / 'subject_failure.expected.json'}")


if __name__ == "__main__":
    main()

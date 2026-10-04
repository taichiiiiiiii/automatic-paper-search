"""Parity fixture generator for the TypeScript collect/ port (P4a).

Runs the REAL Python sources (paperpilot.sources.{arxiv_source,s2_source,
openalex_source}) against canned fixtures in this directory and dumps
`[Paper.to_dict(), ...]` plus `truncated_keywords`/`degraded_keywords` to
`<scenario>.expected.json`, so a Vitest test can feed the identical input to
the TS port and assert the two outputs are structurally equal.

Network is never touched: `request_with_retry` is monkeypatched for S2/
OpenAlex, and the arXiv client's HTTP session is given a transport adapter
that always answers with the canned Atom body on disk (the same technique
`paperpilot/tests/test_arxiv_source.py`'s `_CannedAdapter` uses).

Run with:
    uv run --extra dev python apps/pipeline/test/collect/fixtures/parity/dump_python_papers.py

This script is NOT part of the pipeline or its test suite; it is a one-off
generator whose only consumer is apps/pipeline/test/collect/parity.test.ts
(which reads its *.expected.json output, already committed, rather than
re-running Python itself).
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[5]
sys.path.insert(0, str(REPO_ROOT))

import requests  # noqa: E402
from requests.models import Response  # noqa: E402

from paperpilot.sources.arxiv_source import ArxivSource  # noqa: E402
from paperpilot.sources.openalex_source import OpenAlexSource  # noqa: E402
from paperpilot.sources.s2_source import S2Source  # noqa: E402


def _resp(status: int, body) -> SimpleNamespace:
    return SimpleNamespace(status_code=status, json=lambda: body)


class _CannedAdapter(requests.adapters.BaseAdapter):
    def __init__(self, content: bytes) -> None:
        super().__init__()
        self._content = content

    def send(self, request, **_kwargs):  # type: ignore[override]
        resp = Response()
        resp.status_code = 200
        resp._content = self._content
        resp._content_consumed = True
        resp.request = request
        resp.url = request.url
        return resp

    def close(self) -> None:  # pragma: no cover
        pass


def dump_papers(papers, truncated, degraded) -> dict:
    out = []
    for p in papers:
        d = p.to_dict()
        d["published_date"] = p.published_date.isoformat()
        out.append(d)
    return {
        "papers": out,
        "truncatedKeywords": list(truncated),
        "degradedKeywords": [list(t) for t in degraded],
    }


def run_arxiv(fixture_name: str, keyword: str, since: date, max_results: int) -> dict:
    body = (HERE / f"{fixture_name}.atom.xml").read_bytes()
    src = ArxivSource({"enabled": True, "delay_seconds": 0})
    adapter = _CannedAdapter(body)
    src._client._session.mount("http://", adapter)
    src._client._session.mount("https://", adapter)
    papers = src.fetch(keywords=[keyword], categories=[], since_date=since, max_results=max_results)
    return dump_papers(papers, src.truncated_keywords, src.degraded_keywords)


def run_s2(fixture_name: str, keyword: str, since: date, max_results: int) -> dict:
    body = json.loads((HERE / f"{fixture_name}.json").read_text())
    src = S2Source({"enabled": True, "delay_seconds": 0})
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src.fetch(keywords=[keyword], categories=[], since_date=since, max_results=max_results)
    return dump_papers(papers, src.truncated_keywords, src.degraded_keywords)


def run_openalex(fixture_name: str, keyword: str, since: date, max_results: int) -> dict:
    body = json.loads((HERE / f"{fixture_name}.json").read_text())
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src.fetch(keywords=[keyword], categories=[], since_date=since, max_results=max_results)
    return dump_papers(papers, src.truncated_keywords, src.degraded_keywords)


SCENARIOS = {
    "arxiv_happy": lambda: run_arxiv("arxiv_happy", "transformer", date(2000, 1, 1), 10),
    "arxiv_truncated": lambda: run_arxiv("arxiv_truncated", "llm", date(2026, 1, 1), 3),
    "s2_happy": lambda: run_s2("s2_happy", "rag", date(2026, 1, 1), 10),
    "s2_skip": lambda: run_s2("s2_skip", "kw", date(2026, 1, 1), 10),
    "openalex_happy": lambda: run_openalex("openalex_happy", "sample topic", date(2026, 1, 1), 10),
}


def main() -> None:
    for name, runner in SCENARIOS.items():
        result = runner()
        out_path = HERE / f"{name}.expected.json"
        out_path.write_text(json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True) + "\n")
        print(f"wrote {out_path} ({len(result['papers'])} papers)")


if __name__ == "__main__":
    main()

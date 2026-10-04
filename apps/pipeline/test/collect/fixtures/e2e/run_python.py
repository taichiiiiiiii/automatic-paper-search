#!/usr/bin/env python3
"""E2E parity fixture generator / failure-path checker for the TS port (P4a
part 2). Runs the REAL Python `PipelineRunner` against a canned arXiv Atom
feed (network never touched — the `arxiv` package's `requests` session is
given a transport adapter that always answers with the body on disk, same
technique as `fixtures/parity/dump_python_papers.py`) under a FIXED clock
(`datetime.now`/`date.today` monkeypatched in every module that reads them),
so output filenames/timestamps are deterministic across repeated runs and
across languages.

Like `fixtures/parity/dump_python_papers.py`, this script is a ONE-OFF
generator, NOT part of the pipeline or its test suite — `e2e.test.ts` reads
the committed `expected/happy/` tree it produces (never re-runs Python) and,
for the failure-path scenarios, reads the committed `expected/<scenario>/
manifest.json` this script also writes, comparing the TS side's own exit
code/behavior against it rather than re-invoking `uv` at test time.

Regenerate after a behavior change with:
    uv run --extra dev python apps/pipeline/test/collect/fixtures/e2e/run_python.py happy apps/pipeline/test/collect/fixtures/e2e/expected/happy
    uv run --extra dev python apps/pipeline/test/collect/fixtures/e2e/run_python.py corrupt-seen-ids apps/pipeline/test/collect/fixtures/e2e/expected/corrupt_seen_ids
    uv run --extra dev python apps/pipeline/test/collect/fixtures/e2e/run_python.py all-sources-failed apps/pipeline/test/collect/fixtures/e2e/expected/all_sources_failed
and review the diff.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from datetime import date, datetime
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[5]
sys.path.insert(0, str(REPO_ROOT))

import requests  # noqa: E402
from requests.models import Response  # noqa: E402

import paperpilot.exporters.csv_exporter as csv_mod  # noqa: E402
import paperpilot.exporters.json_exporter as json_mod  # noqa: E402
import paperpilot.pipeline.runner as runner_mod  # noqa: E402
import paperpilot.pipeline.stage_collect as stage_collect_mod  # noqa: E402
import paperpilot.utils.dedup as dedup_mod  # noqa: E402
from paperpilot.collector import _failure_exit_code  # noqa: E402
from paperpilot.pipeline.runner import PipelineRunner  # noqa: E402
from paperpilot.sources.arxiv_source import ArxivSource  # noqa: E402

# Whole-second instant (no microseconds) so Python's isoformat() and the TS
# side's analogous fixed Date (constructed with the SAME y/m/d/h/m/s, see
# e2e.test.ts) represent the identical wall-clock moment, even though their
# string renderings differ (ignored via the rules file, not relied upon to
# match byte-for-byte).
FIXED_NOW = datetime(2026, 4, 10, 12, 0, 0)
FIXED_TODAY = date(2026, 4, 10)


class _FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):  # noqa: ANN001
        return FIXED_NOW


class _FixedDate(date):
    @classmethod
    def today(cls):
        return FIXED_TODAY


class _CannedAdapter(requests.adapters.BaseAdapter):
    """Same technique as `fixtures/parity/dump_python_papers.py`."""

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


def _build_config(out_dir: Path) -> dict:
    return {
        "search": {
            "keywords": ["diffusion model"],
            "categories": ["cs.LG"],
            "days_back": 7,
            "max_results_per_keyword": 10,
            "exclude_words": [],
        },
        "sources": {"arxiv": {"enabled": True, "delay_seconds": 0}},
        "signals": {"venue": {"enabled": True}},
        "weights": {"venue": 3.0, "keyword": 0.5},
        "pipeline": {"stage2_top_n": 10},
        "output": {
            "csv": {"enabled": True, "dir": str(out_dir), "encoding": "utf-8-sig"},
            "json": {"enabled": True, "dir": str(out_dir)},
        },
        "incremental": {
            "enabled": True,
            "seen_ids_file": str(out_dir / "seen_ids.json"),
            # Routed OUTSIDE out_dir on purpose (see module docstring): a
            # `.jsonl` file is compared byte-for-byte by the parity tool
            # (it only parses `.json`), and started_at/finished_at render
            # in a language-specific ISO format even under a fixed clock.
            "run_history_file": str(out_dir.parent / "history" / "run_history.jsonl"),
            "max_age_days": 14,
        },
        "env": {
            "github_token": None,
            "s2_api_key": None,
            "openalex_email": None,
            "slack_webhook_url": None,
            "gemini_api_key": None,
            "claude_api_key": None,
            "groq_api_key": None,
        },
    }


def _mount_canned_arxiv(runner: PipelineRunner, body: bytes) -> None:
    src = runner.sources[0]
    assert isinstance(src, ArxivSource)
    adapter = _CannedAdapter(body)
    src._client._session.mount("http://", adapter)
    src._client._session.mount("https://", adapter)


def _patches():
    return [
        patch.object(stage_collect_mod, "date", _FixedDate),
        patch.object(runner_mod, "datetime", _FixedDateTime),
        patch.object(csv_mod, "datetime", _FixedDateTime),
        patch.object(json_mod, "datetime", _FixedDateTime),
        patch.object(dedup_mod, "datetime", _FixedDateTime),
    ]


def _run_under_fixed_clock(runner: PipelineRunner, extra_patches: list):
    patches = _patches() + extra_patches
    for p in patches:
        p.start()
    try:
        return asyncio.run(runner.run())
    finally:
        for p in patches:
            p.stop()


def _write_manifest(out_dir: Path, result, exit_code: int) -> None:
    (out_dir / "manifest.json").write_text(
        json.dumps(
            {"exitCode": exit_code, "outputCount": result.output_count, "errors": result.errors},
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )


def run_happy(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    body = (HERE / "arxiv_e2e.atom.xml").read_bytes()
    config = _build_config(out_dir)
    runner = PipelineRunner(config)
    _mount_canned_arxiv(runner, body)

    result = _run_under_fixed_clock(runner, [])
    exit_code = _failure_exit_code(result, logging.getLogger("e2e"))
    _write_manifest(out_dir, result, exit_code)
    print(f"wrote {out_dir} (exit_code={exit_code}, output_count={result.output_count})")


def run_corrupt_seen_ids(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "seen_ids.json").write_text('{"arxiv:2604.00001": "2026-01-01T00:00:00",')
    body = (HERE / "arxiv_e2e.atom.xml").read_bytes()
    config = _build_config(out_dir)
    runner = PipelineRunner(config)
    _mount_canned_arxiv(runner, body)

    result = _run_under_fixed_clock(runner, [])
    exit_code = _failure_exit_code(result, logging.getLogger("e2e"))
    _write_manifest(out_dir, result, exit_code)
    print(f"wrote {out_dir} (exit_code={exit_code})")


def run_all_sources_failed(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    config = _build_config(out_dir)
    runner = PipelineRunner(config)
    src = runner.sources[0]

    def _boom(*_args, **_kwargs):
        raise RuntimeError("arxiv client exploded")

    result = _run_under_fixed_clock(runner, [patch.object(src._client, "results", side_effect=_boom)])
    exit_code = _failure_exit_code(result, logging.getLogger("e2e"))
    _write_manifest(out_dir, result, exit_code)
    print(f"wrote {out_dir} (exit_code={exit_code})")


SCENARIOS = {
    "happy": run_happy,
    "corrupt-seen-ids": run_corrupt_seen_ids,
    "all-sources-failed": run_all_sources_failed,
}


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in SCENARIOS:
        print(f"usage: run_python.py <{'|'.join(SCENARIOS)}> <out_dir>", file=sys.stderr)
        raise SystemExit(2)
    SCENARIOS[sys.argv[1]](Path(sys.argv[2]))


if __name__ == "__main__":
    main()

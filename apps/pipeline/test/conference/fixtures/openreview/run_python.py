#!/usr/bin/env python3
"""Parity fixture generator for collect_openreview.py (P4c part 1).

Runs the REAL Python collector against a canned OpenReview API response
(network never touched: `request_with_retry` is monkeypatched, same
technique as the P4a/P4b fixture generators) under a FIXED clock, so the
written `papers_<date>.csv` filename is deterministic.

This is a ONE-OFF generator, NOT part of the pipeline or its test suite —
`openreviewParity.test.ts` reads the committed `expected/` tree this script
produces (never re-runs Python).

Regenerate after a behavior change with:
    uv run --extra dev python apps/pipeline/test/conference/fixtures/openreview/run_python.py happy apps/pipeline/test/conference/fixtures/openreview/expected/happy
    uv run --extra dev python apps/pipeline/test/conference/fixtures/openreview/run_python.py incomplete apps/pipeline/test/conference/fixtures/openreview/expected/incomplete
and review the diff.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[5]
sys.path.insert(0, str(REPO_ROOT))

from paperpilot.scripts import collect_conference as cc  # noqa: E402
from paperpilot.scripts import collect_openreview as co  # noqa: E402

FIXED_TODAY = datetime(2026, 6, 28, tzinfo=timezone.utc)


class _FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return FIXED_TODAY


NOTES_FIXTURE = json.loads((HERE / "notes.json").read_text(encoding="utf-8"))


def _resp(notes):
    return SimpleNamespace(status_code=200, json=lambda: {"notes": notes})


def run_happy(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    def fake(method, url, *, params=None, **kw):
        return _resp(NOTES_FIXTURE if params["offset"] == 0 else [])

    with patch.object(cc, "PROJECT", out_dir), patch.object(cc, "datetime", _FixedDateTime):
        with patch.object(co, "request_with_retry", side_effect=fake):
            argv = [
                "collect_openreview.py",
                "--conference",
                "iclr-2025",
                "--venue",
                "ICLR",
                "--venueid",
                "ICLR.cc/2025/Conference",
            ]
            with patch.object(sys, "argv", argv):
                rc = co.main()
    (out_dir / "manifest.json").write_text(json.dumps({"exitCode": rc}, indent=2) + "\n")
    print(f"wrote {out_dir} (exit_code={rc})")


def _full_page(n: int) -> list[dict]:
    """`n` synthetic notes — content is irrelevant here since the refused
    run writes nothing; only the exit code / absence of output matters."""
    return [
        {
            "id": f"note-{i}",
            "content": {
                "title": {"value": f"Paper {i}"},
                "venue": {"value": "ICLR 2025 Poster"},
                "venueid": {"value": "ICLR.cc/2025/Conference"},
            },
        }
        for i in range(n)
    ]


def run_incomplete(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    page1 = _full_page(1000)  # a FULL page (== page_size) forces a second request

    def fake(method, url, *, params=None, **kw):
        if params["offset"] == 0:
            return _resp(page1)
        return None  # mid-run failure on page 2

    with patch.object(cc, "PROJECT", out_dir), patch.object(cc, "datetime", _FixedDateTime):
        with patch.object(co, "request_with_retry", side_effect=fake):
            argv = [
                "collect_openreview.py",
                "--conference",
                "iclr-2025",
                "--venue",
                "ICLR",
                "--venueid",
                "ICLR.cc/2025/Conference",
            ]
            with patch.object(sys, "argv", argv):
                rc = co.main()
    (out_dir / "manifest.json").write_text(json.dumps({"exitCode": rc}, indent=2) + "\n")
    print(f"wrote {out_dir} (exit_code={rc})")


SCENARIOS = {"happy": run_happy, "incomplete": run_incomplete}


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in SCENARIOS:
        print(f"usage: run_python.py <{'|'.join(SCENARIOS)}> <out_dir>", file=sys.stderr)
        raise SystemExit(2)
    SCENARIOS[sys.argv[1]](Path(sys.argv[2]))


if __name__ == "__main__":
    main()

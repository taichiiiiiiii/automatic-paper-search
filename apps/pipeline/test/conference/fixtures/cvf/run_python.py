#!/usr/bin/env python3
"""Parity fixture generator for collect_cvf.py (P4c part 1).

Network never touched (`request_with_retry` is monkeypatched). This is a
ONE-OFF generator, NOT part of the pipeline or its test suite —
`cvfParity.test.ts` reads the committed `expected/` tree this script
produces (never re-runs Python).

Regenerate after a behavior change with:
    uv run --extra dev python apps/pipeline/test/conference/fixtures/cvf/run_python.py happy apps/pipeline/test/conference/fixtures/cvf/expected/happy
    uv run --extra dev python apps/pipeline/test/conference/fixtures/cvf/run_python.py one-detail-fails apps/pipeline/test/conference/fixtures/cvf/expected/one_detail_fails
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
from paperpilot.scripts import collect_cvf as cvf  # noqa: E402

FIXED_TODAY = datetime(2026, 6, 28, tzinfo=timezone.utc)


class _FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return FIXED_TODAY


LISTING_HTML = (HERE / "listing.html").read_text(encoding="utf-8")
DETAIL_XIAO = (HERE / "detail_xiao.html").read_text(encoding="utf-8")
DETAIL_LEE = (HERE / "detail_lee.html").read_text(encoding="utf-8")


def _canned_fetch(fail_lee: bool = False):
    def fake(method, url, **kw):
        if url.endswith("?day=all"):
            return SimpleNamespace(status_code=200, text=LISTING_HTML)
        if "Xiao_Det_paper" in url:
            return SimpleNamespace(status_code=200, text=DETAIL_XIAO)
        if "Lee_Seg_paper" in url:
            if fail_lee:
                return SimpleNamespace(status_code=500, text="")
            return SimpleNamespace(status_code=200, text=DETAIL_LEE)
        return SimpleNamespace(status_code=404, text="")

    return fake


def run_happy(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    with patch.object(cc, "PROJECT", out_dir), patch.object(cc, "datetime", _FixedDateTime):
        with patch.object(cvf, "request_with_retry", side_effect=_canned_fetch()):
            argv = [
                "collect_cvf.py",
                "--conference",
                "cvpr-2025",
                "--venue",
                "CVPR",
                "--cvf-id",
                "CVPR2025",
                "--max-workers",
                "2",
                "--delay-seconds",
                "0",
            ]
            with patch.object(sys, "argv", argv):
                rc = cvf.main()
    (out_dir / "manifest.json").write_text(json.dumps({"exitCode": rc}, indent=2) + "\n")
    print(f"wrote {out_dir} (exit_code={rc})")


def run_one_detail_fails(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    with patch.object(cc, "PROJECT", out_dir), patch.object(cc, "datetime", _FixedDateTime):
        with patch.object(cvf, "request_with_retry", side_effect=_canned_fetch(fail_lee=True)):
            argv = [
                "collect_cvf.py",
                "--conference",
                "cvpr-2025",
                "--venue",
                "CVPR",
                "--cvf-id",
                "CVPR2025",
                "--max-workers",
                "1",
                "--delay-seconds",
                "0",
            ]
            with patch.object(sys, "argv", argv):
                rc = cvf.main()
    (out_dir / "manifest.json").write_text(json.dumps({"exitCode": rc}, indent=2) + "\n")
    print(f"wrote {out_dir} (exit_code={rc})")


SCENARIOS = {"happy": run_happy, "one-detail-fails": run_one_detail_fails}


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in SCENARIOS:
        print(f"usage: run_python.py <{'|'.join(SCENARIOS)}> <out_dir>", file=sys.stderr)
        raise SystemExit(2)
    SCENARIOS[sys.argv[1]](Path(sys.argv[2]))


if __name__ == "__main__":
    main()

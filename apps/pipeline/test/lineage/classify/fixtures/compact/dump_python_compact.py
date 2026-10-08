"""Parity fixture generator for the TS port of
`compact_classifications.py::compact` (P4d lineage).

Runs the REAL Python `compact()` against the committed
`input/classifications.json` cache and `input/docs/**/lineage.json`
survey tree (module-level `CACHE_PATH` / `DOCS_DIR` monkeypatched so the
real production cache is never touched), then copies the mutated cache
file to `expected/classifications.json` (or `--out-dir` for a
regeneration check).

This script is NOT part of the pipeline or its test suite; its only
consumers are apps/pipeline/test/lineage/classify/compact.test.ts and
pythonParity.test.ts, which read the committed `expected/*.json` rather
than re-running Python.

Run with:
    uv run --extra dev python apps/pipeline/test/lineage/classify/fixtures/compact/dump_python_compact.py
    uv run --extra dev python apps/pipeline/test/lineage/classify/fixtures/compact/dump_python_compact.py --out-dir /tmp/regen
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[6]
sys.path.insert(0, str(REPO_ROOT))

from paperpilot.scripts import compact_classifications as cc  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", type=Path, default=HERE / "expected")
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=REPO_ROOT) as tmp:
        tmp_path = Path(tmp)
        cache_path = tmp_path / "classifications.json"
        shutil.copyfile(HERE / "input" / "classifications.json", cache_path)
        docs_dir = tmp_path / "docs"
        shutil.copytree(HERE / "input" / "docs", docs_dir)

        with (
            patch.object(cc, "CACHE_PATH", cache_path),
            patch.object(cc, "DOCS_DIR", docs_dir),
        ):
            rc = cc.compact(dry_run=False)
        if rc != 0:
            raise SystemExit(f"compact() returned {rc}, expected 0")

        out = args.out_dir / "classifications.json"
        shutil.copyfile(cache_path, out)
        print(f"wrote {out}")


if __name__ == "__main__":
    main()

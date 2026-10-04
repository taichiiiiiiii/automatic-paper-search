"""Parity fixture generator for the TS port of
`purge_template_classifications.py` (P4d lineage).

Runs the REAL Python `_purge_locked()` (the locked write core `main()`
delegates to, after acquiring the shared flock the CLI takes — the lock
itself has no effect on the bytes written) against a cache file seeded
from the committed `input/classifications.json` (copied to a scratch
path under the repo root so the real production cache is never
touched), and copies the result to `expected/classifications.json` (or
`--out-dir` for a regeneration check).

This script is NOT part of the pipeline or its test suite; its only
consumers are apps/pipeline/test/lineage/classify/purge.test.ts and
pythonParity.test.ts, which read the committed
`expected/classifications.json` rather than re-running Python.

Run with:
    uv run --extra dev python apps/pipeline/test/lineage/classify/fixtures/purge/dump_python_purge.py
    uv run --extra dev python apps/pipeline/test/lineage/classify/fixtures/purge/dump_python_purge.py --out-dir /tmp/regen
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[6]
sys.path.insert(0, str(REPO_ROOT))

from paperpilot.scripts import purge_template_classifications as ptc  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", type=Path, default=HERE / "expected")
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=REPO_ROOT) as tmp:
        tmp_path = Path(tmp)
        cache_path = tmp_path / "classifications.json"
        shutil.copyfile(HERE / "input" / "classifications.json", cache_path)

        rc = ptc._purge_locked(cache_path, dry_run=False)
        if rc != 0:
            raise SystemExit(f"_purge_locked() returned {rc}, expected 0")

        out = args.out_dir / "classifications.json"
        shutil.copyfile(cache_path, out)
        print(f"wrote {out}")


if __name__ == "__main__":
    main()

"""Parity fixture generator for the TS port of
`build_lineage.py::persist_classifications` (P4d lineage).

Runs the REAL Python `persist_classifications()` with the same
in-memory classifications dict the Vitest parity test uses, against a
cache file seeded from the committed `input/disk.json` (copied to a
scratch path under the repo root so the real production cache is never
touched), and copies the result to `expected/classifications.json` (or
`--out-dir` for a regeneration check).

This script is NOT part of the pipeline or its test suite; its only
consumer is apps/pipeline/test/lineage/classify/pythonParity.test.ts,
which reads the committed `expected/classifications.json` rather than
re-running Python.

Run with:
    uv run --extra dev python apps/pipeline/test/lineage/classify/fixtures/persist/dump_python_persist.py
    uv run --extra dev python apps/pipeline/test/lineage/classify/fixtures/persist/dump_python_persist.py --out-dir /tmp/regen
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

from paperpilot.scripts import build_lineage as bl  # noqa: E402

# Must match the in-memory `classifications` dict the Vitest parity
# test (pythonParity.test.ts) passes to `persistClassifications`.
IN_MEMORY = {
    "new->one": {
        "relation": "successor",
        "confidence": 0.75,
        "rationale": "freshly computed in-memory entry",
    },
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", type=Path, default=HERE / "expected")
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=REPO_ROOT) as tmp:
        tmp_path = Path(tmp)
        cache_path = tmp_path / "classifications.json"
        shutil.copyfile(HERE / "input" / "disk.json", cache_path)

        bl.persist_classifications(dict(IN_MEMORY), cache_path)

        out = args.out_dir / "classifications.json"
        shutil.copyfile(cache_path, out)
        print(f"wrote {out}")


if __name__ == "__main__":
    main()

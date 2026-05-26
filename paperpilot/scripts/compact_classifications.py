"""Prune orphaned entries from the shared classification cache.

`paperpilot/data/lineage-cache/classifications.json` holds the LLM-
classified relation between every (paperA, paperB) pair seen in any
generation run. The file grows monotonically; without compaction it
collects entries for papers that have since been dropped from every
viewer artefact (e.g. seeds rejected by the topic-relevance filter
on a later regen, or themes deleted entirely).

This script removes entries where either paperId isn't present in any
current `docs/**/lineage.json` or `docs/**/deep-*.json`. The kept set
is exactly what future runs can still re-use; the dropped set would
have to be re-derived if those papers ever resurfaced anyway.

Safe to re-run: the operation is idempotent on a clean cache.

Run:
    uv run python -m paperpilot.scripts.compact_classifications

Add `--dry-run` to report what would be dropped without writing.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS_DIR = ROOT / "docs"
CACHE_PATH = ROOT / "paperpilot" / "data" / "lineage-cache" / "classifications.json"


def _collect_live_paper_ids() -> set[str]:
    """Walk every shipped lineage.json + deep-*.json under docs/ and
    collect every node.id string. This is the union of "papers the
    viewer might currently render"; classifications outside it are
    eligible for removal."""
    live: set[str] = set()
    for p in DOCS_DIR.rglob("lineage.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        for n in data.get("nodes") or []:
            nid = n.get("id") if isinstance(n, dict) else None
            if isinstance(nid, str):
                live.add(nid)
    for p in DOCS_DIR.rglob("deep-*.json"):
        # Skip the manifest, which is just a list of slugs.
        if p.name == "deep-manifest.json":
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        for n in data.get("nodes") or []:
            nid = n.get("id") if isinstance(n, dict) else None
            if isinstance(nid, str):
                live.add(nid)
    return live


def compact(dry_run: bool = False) -> int:
    try:
        cache = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"cache unreadable: {e}", file=sys.stderr)
        return 1
    if not isinstance(cache, dict):
        print("cache root is not a dict — refusing to touch", file=sys.stderr)
        return 1

    live = _collect_live_paper_ids()
    before = len(cache)
    if before == 0:
        print("cache is empty, nothing to compact.")
        return 0

    kept: dict[str, dict] = {}
    dropped = 0
    for key, value in cache.items():
        a, _, b = key.partition("->")
        if a in live and b in live:
            kept[key] = value
        else:
            dropped += 1

    pct = (dropped / before) * 100
    print(
        f"live paperIds: {len(live)}\n"
        f"cache entries: {before}\n"
        f"  kept:        {len(kept)}\n"
        f"  dropped:     {dropped} ({pct:.0f}%)"
    )

    if dry_run:
        print("\n(dry-run; no file written)")
        return 0

    # Atomic write: serialize to a sibling tmp file then os.replace.
    tmp = CACHE_PATH.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(kept, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    tmp.replace(CACHE_PATH)
    new_size = CACHE_PATH.stat().st_size
    print(f"wrote {CACHE_PATH.relative_to(ROOT)} ({new_size // 1024} KB)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be dropped without writing the file.",
    )
    args = parser.parse_args()
    return compact(dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())

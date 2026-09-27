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
import fcntl
import json
import os
import sys
import tempfile
from pathlib import Path

from paperpilot.utils.payload import first_unusable

ROOT = Path(__file__).resolve().parents[2]
DOCS_DIR = ROOT / "docs"
CACHE_PATH = ROOT / "paperpilot" / "data" / "lineage-cache" / "classifications.json"


def _cache_endpoints(key: str, value: object) -> tuple[str, str] | None:
    """Read endpoints from an opaque v2 value or a legacy ``src->dst`` key.

    The two v2 producers do not agree on where the endpoints live:
    build_deep_lineage stores ``src``/``dst`` at the top level, while
    build_theme_lineage stores them only inside ``cache_identity``. Reading
    just the top level therefore classified every theme entry as having no
    endpoints, and "no endpoints" is treated as orphaned — so compaction
    deleted live theme classifications and the next rebuild had to pay for
    those LLM calls again. Both shapes are accepted here.
    """

    if key.startswith("v2:"):
        if not isinstance(value, dict):
            return None
        src, dst = value.get("src"), value.get("dst")
        if not (isinstance(src, str) and isinstance(dst, str)):
            identity = value.get("cache_identity")
            if isinstance(identity, dict):
                src, dst = identity.get("src"), identity.get("dst")
        return (src, dst) if isinstance(src, str) and isinstance(dst, str) else None
    src, separator, dst = key.partition("->")
    return (src, dst) if separator and src and dst else None


def _collect_live_paper_ids() -> tuple[set[str], list[Path]]:
    """Walk every shipped lineage.json + deep-*.json under docs/ and
    collect every node.id string. This is the union of "papers the
    viewer might currently render"; classifications outside it are
    eligible for removal.

    Returns (live_ids, unreadable_artifacts). An artifact that will not
    parse contributes no ids, which would make every classification that
    only it references look orphaned — and dropping is irreversible. The
    caller must refuse to compact when the second element is non-empty
    rather than deleting on the strength of an incomplete survey. A
    truncated file is expected in normal operation: the lineage builders
    write some artifacts with a plain write_text, so a concurrent read
    can catch a partial file.
    """
    live: set[str] = set()
    unreadable: list[Path] = []

    def _absorb(path: Path) -> None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            unreadable.append(path)
            return
        if not isinstance(data, dict):
            unreadable.append(path)
            return
        nodes = data.get("nodes")
        # An ABSENT key is not an empty graph. Our builders always write
        # `nodes`, so a file without one is not an artifact we can
        # survey — and reading it as "contributes no ids" is what makes
        # the classifications only it references look orphaned, right
        # before they are deleted for good. `nodes: []` is different:
        # that is an artifact stating it has no papers.
        if not isinstance(nodes, list) or first_unusable(
            nodes, lambda n: isinstance(n.get("id"), str) and bool(n["id"])
        ):
            # Dropping here is irreversible: a node this survey cannot
            # read makes every classification only that artifact
            # references look orphaned, and the caller then deletes it.
            # "Keep the ids we could parse" is exactly the partial-page
            # bug with a destructive consequence.
            unreadable.append(path)
            return
        for n in nodes:
            live.add(n["id"])

    for p in DOCS_DIR.rglob("lineage.json"):
        _absorb(p)
    for p in DOCS_DIR.rglob("deep-*.json"):
        # Skip the manifest, which is just a list of slugs.
        if p.name == "deep-manifest.json":
            continue
        _absorb(p)
    return live, unreadable


def compact(dry_run: bool = False) -> int:
    try:
        cache = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"cache unreadable: {e}", file=sys.stderr)
        return 1
    if not isinstance(cache, dict):
        print("cache root is not a dict — refusing to touch", file=sys.stderr)
        return 1

    # The docs survey runs OUTSIDE the lock: it is the slow part, and
    # holding the classification lock across it would stall every
    # concurrent lineage build. The write below re-reads under the lock.
    live, unreadable = _collect_live_paper_ids()
    if unreadable:
        listing = "\n  ".join(str(p) for p in unreadable)
        print(
            f"refusing to compact: {len(unreadable)} lineage artifact(s) could not be "
            "read, so the live-id survey is incomplete and every classification they "
            f"alone reference would look orphaned:\n  {listing}",
            file=sys.stderr,
        )
        return 1
    before = len(cache)
    if before == 0:
        print("cache is empty, nothing to compact.")
        return 0

    kept: dict[str, dict] = {}
    dropped = 0
    for key, value in cache.items():
        endpoints = _cache_endpoints(key, value)
        if endpoints is not None and endpoints[0] in live and endpoints[1] in live:
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

    # Take the SAME lock build_lineage.persist_classifications uses, and
    # re-read inside it. An atomic rename stops a torn read but not a lost
    # update: without this, a classification written after our snapshot
    # was taken would be erased by our replace.
    lock_path = CACHE_PATH.with_suffix(CACHE_PATH.suffix + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            try:
                current = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
            except (FileNotFoundError, json.JSONDecodeError) as e:
                print(f"cache became unreadable under lock: {e}", file=sys.stderr)
                return 1
            if not isinstance(current, dict):
                print("cache root is not a dict — refusing to touch", file=sys.stderr)
                return 1
            # Only drop keys we actually surveyed. A key that appeared
            # after the survey is evidence-free — its endpoints may be in
            # an artifact the writer has not published yet — so it is
            # carried over untouched rather than judged orphaned.
            final = {k: v for k, v in current.items() if k not in cache or k in kept}
            added = len(final) - len(kept)
            tmp_path: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="w",
                    encoding="utf-8",
                    dir=CACHE_PATH.parent,
                    prefix=f".{CACHE_PATH.name}.",
                    suffix=".tmp",
                    delete=False,
                ) as f:
                    tmp_path = Path(f.name)
                    json.dump(final, f, ensure_ascii=False, indent=2, sort_keys=True)
                os.replace(tmp_path, CACHE_PATH)
                tmp_path = None
            finally:
                if tmp_path is not None:
                    tmp_path.unlink(missing_ok=True)
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    new_size = CACHE_PATH.stat().st_size
    if added:
        print(f"carried over {added} entry/entries written during the survey")
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

"""One-shot purge of template-poisoned entries from classifications cache.

The shared LLM classification cache (``paperpilot/data/lineage-cache/
classifications.json``) accumulates ``{paper_id_pair: {relation,
confidence, rationale}}`` across every theme build. Pre-#131 the
``from_dict`` template-echo reject did not exist, so any LLM call that
mirrored back a heuristic template phrasing was cached as a successful
classification. The 2026-05-27 audit (issue #209) counted **118 of 419**
cache entries (~28%) whose rationale was byte-for-byte one of
``TEMPLATE_RATIONALES.values()`` — i.e. the LLM "agreed" with the
heuristic but added no real signal.

The cached template entries silently outvote any later re-classification:
``_CachedClassifyProvider`` hits the cache first, ``from_dict`` rejects
the entry, the caller (``_apply_llm_classification``) falls back to the
heuristic edge. Net result: an LLM call never happens for that pair on
subsequent theme rebuilds, locking in the template forever.

This script deletes every cached entry whose rationale is in the
template reject set, leaving non-template (LLM-specific) entries
untouched. After running, the next theme regen will re-query the LLM
for the purged pairs and either persist a paper-specific rationale or
(if the LLM still emits a template) skip caching (because ``from_dict``
returns ``None``, which the cache layer respects by NOT writing).

Run:
    uv run python -m paperpilot.scripts.purge_template_classifications

Idempotent: running twice on an already-purged cache is a no-op.

Exit codes:
- 0: purge succeeded (or cache was already clean / missing)
- 1: I/O or JSON error reading the cache (manual investigation needed)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from paperpilot.llm.base import TEMPLATE_RATIONALES
from paperpilot.utils.logger import get_logger

logger = get_logger(__name__)

_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_CACHE_PATH = (
    _ROOT / "paperpilot" / "data" / "lineage-cache" / "classifications.json"
)
_TEMPLATE_RATIONALES_SET = frozenset(TEMPLATE_RATIONALES.values())


def purge_template_entries(cache: dict[str, dict]) -> tuple[dict[str, dict], int]:
    """Return (kept_entries, dropped_count).

    Drops any entry whose ``rationale`` is byte-for-byte one of the
    heuristic templates. Non-dict or rationale-less entries are kept
    verbatim — they're either malformed (worth preserving for
    diagnosis) or genuine LLM outputs.
    """
    kept: dict[str, dict] = {}
    dropped = 0
    for key, value in cache.items():
        if not isinstance(value, dict):
            kept[key] = value
            continue
        rationale = value.get("rationale")
        if isinstance(rationale, str) and rationale.strip() in _TEMPLATE_RATIONALES_SET:
            dropped += 1
            continue
        kept[key] = value
    return kept, dropped


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cache",
        type=Path,
        default=_DEFAULT_CACHE_PATH,
        help=(
            "Path to classifications.json. Defaults to the canonical "
            "location under paperpilot/data/lineage-cache/."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the count that would be purged, don't write the file.",
    )
    args = parser.parse_args()

    if not args.cache.exists():
        print(f"cache file not found at {args.cache} — nothing to purge.")
        return 0

    try:
        raw = args.cache.read_text(encoding="utf-8")
        cache = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR reading {args.cache}: {exc}", file=sys.stderr)
        return 1

    if not isinstance(cache, dict):
        print(
            f"ERROR: cache root is {type(cache).__name__}, expected dict",
            file=sys.stderr,
        )
        return 1

    kept, dropped = purge_template_entries(cache)
    print(f"cache entries  total: {len(cache)}")
    print(f"               kept : {len(kept)}")
    print(f"               drop : {dropped}  (template-poisoned)")

    if args.dry_run:
        print("--dry-run: file not modified.")
        return 0

    if dropped == 0:
        print("already clean — no write needed.")
        return 0

    # Pretty-print with stable key order so the diff in git is meaningful.
    args.cache.write_text(
        json.dumps(kept, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"wrote purged cache to {args.cache}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

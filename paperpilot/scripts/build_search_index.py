"""Build docs/search-index.json — one cross-conference search payload.

The catalog is split one papers.json per conference (24 MB in total), so a
visitor who wants "every diffusion paper across all ten venues" has no way
to ask: each catalog page only knows its own proceedings. This script folds
all of them into a single small index the landing page can search.

An entry is just [title, conference]. That is enough to navigate, because
each catalog page already reads `?q=` from the URL and filters on
title+authors+abstract (app.js readUrlState / getFiltered). Linking a hit to
`<conference>/?q=<title>` therefore lands on exactly that paper with the
existing, tested machinery and no per-paper id to mint or keep stable.

Run:
    python paperpilot/scripts/build_search_index.py
    python paperpilot/scripts/build_search_index.py --docs-root docs
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from paperpilot.scripts import build_pages

ROOT = Path(__file__).resolve().parents[2]
DOCS_ROOT = ROOT / "docs"

INDEX_FILENAME = "search-index.json"

# Entries are positional pairs rather than objects: [title, conference].
# At 28,300 papers, repeating two JSON keys per row would add ~0.7 MB raw
# for no information. The reader in docs/assets/search.js destructures by
# position.
TITLE, CONFERENCE = 0, 1


def build_index(docs_root: Path) -> tuple[list[list[str]], int]:
    """Fold every conference papers.json into a flat entry list.

    Returns (entries, skipped) where skipped counts rows with no title —
    those cannot be searched for or linked to. Conferences are walked in
    sorted order so a rebuild with unchanged inputs is byte-identical.
    """
    entries: list[list[str]] = []
    skipped = 0

    for conf_dir in sorted(p for p in docs_root.iterdir() if p.is_dir()):
        # `daily` is the daily-watch collection output, not a conference; it
        # has no catalog page, so a search hit there would lead nowhere.
        if conf_dir.name in build_pages._NON_CONFERENCE:
            continue
        papers_json = conf_dir / "papers.json"
        if not papers_json.exists():
            continue

        for row in json.loads(papers_json.read_text(encoding="utf-8")):
            title = (row.get("title") or "").strip()
            if not title:
                skipped += 1
                continue
            entries.append([title, conf_dir.name])

    return entries, skipped


def write_index(docs_root: Path, entries: list[list[str]]) -> Path:
    """Write the index with compact separators (it ships to every searcher)."""
    out = docs_root / INDEX_FILENAME
    out.write_text(
        json.dumps(entries, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--docs-root",
        type=Path,
        default=DOCS_ROOT,
        help=f"Directory holding <conference>/papers.json (default: {DOCS_ROOT})",
    )
    args = ap.parse_args()

    entries, skipped = build_index(args.docs_root)
    out = write_index(args.docs_root, entries)

    print(f"Wrote {len(entries):,} entries -> {out} ({out.stat().st_size / 1024:,.0f} KB raw)")
    if skipped:
        print(f"  skipped {skipped:,} row(s) with no title")


if __name__ == "__main__":
    main()

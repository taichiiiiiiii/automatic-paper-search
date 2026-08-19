"""Build docs/search-index.json — one cross-conference search payload.

The catalog is split one papers.json per conference (24 MB in total), so a
visitor who wants "every diffusion paper across all ten venues" currently has
no way to ask: each catalog page only knows its own proceedings. This script
folds all of them into a single small index the landing page can search.

papers.json has no usable per-paper key of its own -- 27,042 of 28,300 rows
(95.5%) ship an empty `arxiv_id`, because only the arXiv-sourced venues
(aaai-2026, eccv-2024) populate it. The stable id is therefore derived from
`arxiv_url`, which is present on 100% of rows and encodes a durable id in
every one of the four venue URL families we collect from.

Run:
    python paperpilot/scripts/build_search_index.py
    python paperpilot/scripts/build_search_index.py --docs-root docs
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from paperpilot.scripts import build_pages

ROOT = Path(__file__).resolve().parents[2]
DOCS_ROOT = ROOT / "docs"

INDEX_FILENAME = "search-index.json"

# Entries are positional triples rather than objects: [title, conference, id].
# At 28,300 papers, repeating three JSON keys per row would add ~1.1 MB raw
# for no information. The reader in docs/assets/ destructures by position.
_TITLE, _CONF, _PID = 0, 1, 2

# arXiv abs URLs carry a revision suffix (/abs/2403.06764v3). Two revisions of
# one preprint must collapse to a single permalink, so the suffix is stripped.
_ARXIV_ABS_RE = re.compile(r"/abs/(?P<id>.+?)(?:v\d+)?/?$")

# CVF open access paper pages are /content/<VENUE>/html/<stem>.html, where the
# stem (e.g. Held_3D_Convex_Splatting_CVPR_2025_paper) is the canonical id.
_CVF_HTML_RE = re.compile(r"/html/(?P<id>.+?)\.html$")


def paper_id(url: str | None) -> str | None:
    """Derive a stable per-paper id from its venue URL.

    Returns None when the URL is empty or from a host we have no extractor
    for -- the caller skips those rows rather than inventing an id, since a
    wrong id would produce a permalink that silently resolves to nothing.
    """
    if not url or not url.strip():
        return None
    parsed = urlparse(url.strip())

    if parsed.netloc == "openreview.net":
        ids = parse_qs(parsed.query).get("id")
        return ids[0] if ids else None

    if parsed.netloc.endswith("arxiv.org"):
        m = _ARXIV_ABS_RE.search(parsed.path)
        return m.group("id") if m else None

    if parsed.netloc == "aclanthology.org":
        # https://aclanthology.org/2025.acl-long.153/ -> 2025.acl-long.153
        return parsed.path.strip("/") or None

    if parsed.netloc == "openaccess.thecvf.com":
        m = _CVF_HTML_RE.search(parsed.path)
        return m.group("id") if m else None

    return None


def build_index(docs_root: Path) -> tuple[list[list[str]], int]:
    """Fold every conference papers.json into a flat entry list.

    Returns (entries, skipped) where skipped counts rows whose URL yielded no
    id. Conferences are walked in sorted order so a rebuild with unchanged
    inputs produces a byte-identical file.
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
            pid = paper_id(row.get("arxiv_url"))
            if pid is None:
                skipped += 1
                continue
            entries.append([row["title"], conf_dir.name, pid])

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

    size_kb = out.stat().st_size / 1024
    print(f"Wrote {len(entries):,} entries -> {out} ({size_kb:,.0f} KB raw)")
    if skipped:
        print(f"  skipped {skipped:,} row(s) with no extractable id")


if __name__ == "__main__":
    main()

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
import re
from pathlib import Path

from paperpilot.identity import identity_from_url, normalize_alias
from paperpilot.scripts import build_pages

ROOT = Path(__file__).resolve().parents[2]
DOCS_ROOT = ROOT / "docs"

INDEX_FILENAME = "search-index.json"
INDEX_V2_FILENAME = "search-index-v2.json"

# Entries are positional pairs rather than objects: [title, conference].
# At 28,300 papers, repeating two JSON keys per row would add ~0.7 MB raw
# for no information. The reader in docs/assets/search.js destructures by
# position.
TITLE, CONFERENCE = 0, 1
PAPER_REF, AUTHORS, TAGS, YEAR, PAPER_TYPE = 2, 3, 4, 5, 6
PAPER_ID_BLOCK_SIZE = 256
_CONFERENCE_YEAR_RE = re.compile(r"-(\d{4})$")


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
        if conf_dir.name in build_pages.NON_CONFERENCE:
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


def _string_list(value: object, field: str, conference: str, ordinal: int) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{conference} row {ordinal}: {field} must be a string array")
    return value


def build_index_v2(docs_root: Path) -> tuple[list[list[object]], list[str]]:
    """Build the identity-rich search projection with strict row validation."""

    entries: list[list[object]] = []
    paper_ids: list[str] = []
    for conf_dir in sorted(path for path in docs_root.iterdir() if path.is_dir()):
        if conf_dir.name in build_pages.NON_CONFERENCE:
            continue
        papers_json = conf_dir / "papers.json"
        if not papers_json.exists():
            continue

        rows = json.loads(papers_json.read_text(encoding="utf-8"))
        if not isinstance(rows, list):
            raise ValueError(f"{conf_dir.name}: papers.json must be an array")
        for ordinal, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ValueError(f"{conf_dir.name} row {ordinal}: paper must be an object")
            title = row.get("title")
            if not isinstance(title, str) or not title.strip():
                raise ValueError(f"{conf_dir.name} row {ordinal}: title is required")

            identity = identity_from_url(str(row.get("arxiv_url") or ""))
            embedded_id = row.get("paper_id")
            if embedded_id is not None and embedded_id != identity.paper_id:
                raise ValueError(
                    f"{conf_dir.name} row {ordinal}: embedded paper_id does not match source URL"
                )
            embedded_source = row.get("source")
            embedded_source_id = row.get("source_id")
            if embedded_source is not None or embedded_source_id is not None:
                if not isinstance(embedded_source, str) or not isinstance(embedded_source_id, str):
                    raise ValueError(
                        f"{conf_dir.name} row {ordinal}: source/source_id must be strings"
                    )
                if normalize_alias(embedded_source, embedded_source_id) != (
                    identity.source,
                    identity.source_id,
                ):
                    raise ValueError(
                        f"{conf_dir.name} row {ordinal}: embedded source identity mismatch"
                    )

            authors = _string_list(row.get("authors"), "authors", conf_dir.name, ordinal)
            tags = _string_list(row.get("tags"), "tags", conf_dir.name, ordinal)
            paper_type = row.get("type")
            if paper_type not in {"Oral", "Poster"}:
                raise ValueError(f"{conf_dir.name} row {ordinal}: type must be Oral or Poster")

            source_year = row.get("year")
            if source_year is not None and not isinstance(source_year, int):
                raise ValueError(f"{conf_dir.name} row {ordinal}: year must be integer or null")
            match = _CONFERENCE_YEAR_RE.search(conf_dir.name)
            year = (
                source_year if source_year is not None else (int(match.group(1)) if match else None)
            )
            entries.append(
                [
                    title.strip(),
                    conf_dir.name,
                    len(paper_ids),
                    authors,
                    tags,
                    year,
                    paper_type,
                ]
            )
            paper_ids.append(identity.paper_id)
    return entries, paper_ids


def write_index_v2(docs_root: Path, entries: list[list[object]]) -> Path:
    """Write the compact v2 index consumed by the unified landing search."""

    out = docs_root / INDEX_V2_FILENAME
    out.write_text(
        json.dumps(entries, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return out


def _paper_id_block_payload(block: int, paper_ids: list[str]) -> str:
    return (
        json.dumps(
            {
                "schema_version": "search-paper-ids-v1",
                "block": block,
                "start": block * PAPER_ID_BLOCK_SIZE,
                "paper_ids": paper_ids,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n"
    )


def write_paper_id_blocks(docs_root: Path, paper_ids: list[str]) -> list[Path]:
    """Write fixed-size canonical-ID blocks addressed by v2 ``paper_ref``."""

    block_root = docs_root / "search-paper-ids-v1"
    block_root.mkdir(parents=True, exist_ok=True)
    outputs: list[Path] = []
    for start in range(0, len(paper_ids), PAPER_ID_BLOCK_SIZE):
        block = start // PAPER_ID_BLOCK_SIZE
        output = block_root / f"{block:04d}.json"
        output.write_text(
            _paper_id_block_payload(block, paper_ids[start : start + PAPER_ID_BLOCK_SIZE]),
            encoding="utf-8",
        )
        outputs.append(output)
    expected = set(outputs)
    for stale in block_root.glob("*.json"):
        if stale not in expected:
            stale.unlink()
    return outputs


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--docs-root",
        type=Path,
        default=DOCS_ROOT,
        help=f"Directory holding <conference>/papers.json (default: {DOCS_ROOT})",
    )
    ap.add_argument(
        "--check",
        action="store_true",
        help="Fail if committed legacy/v2 indexes differ from deterministic projections",
    )
    args = ap.parse_args()

    entries, skipped = build_index(args.docs_root)
    entries_v2, paper_ids = build_index_v2(args.docs_root)

    if args.check:
        expected_v1 = json.dumps(entries, ensure_ascii=False, separators=(",", ":"))
        expected_v2 = json.dumps(entries_v2, ensure_ascii=False, separators=(",", ":"))
        actual_v1 = (args.docs_root / INDEX_FILENAME).read_text(encoding="utf-8")
        actual_v2 = (args.docs_root / INDEX_V2_FILENAME).read_text(encoding="utf-8")
        if actual_v1 != expected_v1 or actual_v2 != expected_v2:
            raise SystemExit("committed search indexes are stale; rebuild without --check")
        block_root = args.docs_root / "search-paper-ids-v1"
        expected_blocks = {
            block_root / f"{start // PAPER_ID_BLOCK_SIZE:04d}.json": _paper_id_block_payload(
                start // PAPER_ID_BLOCK_SIZE,
                paper_ids[start : start + PAPER_ID_BLOCK_SIZE],
            )
            for start in range(0, len(paper_ids), PAPER_ID_BLOCK_SIZE)
        }
        actual_blocks = set(block_root.glob("*.json"))
        if actual_blocks != set(expected_blocks) or any(
            path.read_text(encoding="utf-8") != payload for path, payload in expected_blocks.items()
        ):
            raise SystemExit("committed search paper ID blocks are stale")
        print(f"Search indexes are current ({len(entries_v2):,} v2 entries)")
        return

    out = write_index(args.docs_root, entries)
    out_v2 = write_index_v2(args.docs_root, entries_v2)
    id_blocks = write_paper_id_blocks(args.docs_root, paper_ids)

    print(f"Wrote {len(entries):,} entries -> {out} ({out.stat().st_size / 1024:,.0f} KB raw)")
    print(
        f"Wrote {len(entries_v2):,} entries -> {out_v2} "
        f"({out_v2.stat().st_size / 1024:,.0f} KB raw)"
    )
    print(f"Wrote {len(id_blocks)} canonical-ID blocks")
    if skipped:
        print(f"  skipped {skipped:,} row(s) with no title")


if __name__ == "__main__":
    main()

"""Build static GitHub Pages site from summary.csv.

Converts `output/<conference>/summary.csv` -> `docs/<conference>/papers.json`,
which the static viewer (`docs/<conference>/index.html`) consumes. Running
without --conference rebuilds every conference directory that has a
summary.csv.

Run:
    python paperpilot/scripts/build_pages.py                    # all conferences
    python paperpilot/scripts/build_pages.py --conference iclr-2026
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
PROJECT = Path(__file__).resolve().parents[1]
DOCS_ROOT = ROOT / "docs"


def _maybe_int(value: str | None) -> int | None:
    """Parse a numeric field from the CSV. Empty / missing / unparseable -> None."""
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return int(float(value))  # handles "17.0" etc from pandas-exported CSVs
    except ValueError:
        return None


def load_summary(summary_csv: Path) -> list[dict[str, Any]]:
    with summary_csv.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        return [
            {
                "title": row["title"],
                "type": row["type"],
                "tags": row["tags"].split() if row["tags"] else [],
                "venue": row["venue"],
                "authors": [a.strip() for a in re.split(r"[;,]", row["authors"]) if a.strip()],
                "arxiv_url": row["arxiv_url"],
                "pdf_url": row["pdf_url"],
                "abstract": row["abstract"],
                # Stage 2 signal outputs carried forward from summary.csv.
                # Strings stay as strings (empty="" for missing); numerics
                # become ints so the viewer skips coercion.
                "arxiv_id": row.get("arxiv_id", ""),
                "citation_count": _maybe_int(row.get("citation_count")),
                "venue_tier": _maybe_int(row.get("venue_tier")),
                "github_stars": _maybe_int(row.get("github_stars")),
            }
            for row in reader
        ]


def build_conference(name: str) -> dict[str, Any] | None:
    summary_csv = PROJECT / "output" / name / "summary.csv"
    if not summary_csv.exists():
        print(f"  skip {name}: no summary.csv")
        return None

    papers = load_summary(summary_csv)
    out_dir = DOCS_ROOT / name
    out_dir.mkdir(parents=True, exist_ok=True)

    out_json = out_dir / "papers.json"
    out_json.write_text(json.dumps(papers, ensure_ascii=False, indent=0), encoding="utf-8")

    tag_counts: dict[str, int] = {}
    type_counts: dict[str, int] = {}
    for p in papers:
        for t in p["tags"]:
            tag_counts[t] = tag_counts.get(t, 0) + 1
        type_counts[p["type"]] = type_counts.get(p["type"], 0) + 1

    return {
        "name": name,
        "papers": len(papers),
        "types": type_counts,
        "top_tags": sorted(tag_counts.items(), key=lambda x: -x[1])[:6],
    }


def write_index(conferences: list[dict[str, Any]]) -> None:
    index_data = DOCS_ROOT / "conferences.json"
    index_data.write_text(json.dumps(conferences, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--conference", help="Build only this conference (e.g. iclr-2026)")
    args = ap.parse_args()

    conf_dirs: list[str]
    output_dir = PROJECT / "output"
    if args.conference:
        conf_dirs = [args.conference]
    else:
        conf_dirs = sorted(d.name for d in output_dir.iterdir() if d.is_dir() and (d / "summary.csv").exists())

    if not conf_dirs:
        print(f"No conferences with summary.csv found under {output_dir}")
        return

    print(f"Building {len(conf_dirs)} conference(s):")
    results = []
    for name in conf_dirs:
        res = build_conference(name)
        if res:
            print(f"  {name}: {res['papers']} papers")
            results.append(res)

    write_index(results)
    print(f"\nWrote conferences.json -> {DOCS_ROOT}/")


if __name__ == "__main__":
    main()

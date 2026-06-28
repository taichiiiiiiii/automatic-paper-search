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

# Output dirs that have a summary.csv but are NOT conferences and must not
# appear in the conference index / catalog. "daily" is the daily-watch
# collection output (config.daily-watch.yaml); rendering it as a conference
# card would link to docs/daily/ which has no catalog page.
_NON_CONFERENCE = {"daily"}


# papers.json ships in full to every catalog visitor, so storing complete
# 1,400-char abstracts for a multi-thousand-paper proceedings (e.g. ICLR's
# 5k+ accepted set) would be a ~10 MB download per page. The list view only
# needs a teaser; the full paper is one click away via the card's OpenReview /
# arXiv link. Previewing here keeps every catalog page light.
_ABSTRACT_PREVIEW_CHARS = 320


def _abstract_preview(text: str | None) -> str:
    """Trim an abstract to a short, word-boundary preview with an ellipsis."""
    text = (text or "").strip()
    if len(text) <= _ABSTRACT_PREVIEW_CHARS:
        return text
    head = text[:_ABSTRACT_PREVIEW_CHARS]
    # Cut back to the last word boundary so we don't slice a word in half;
    # fall back to the hard cut if there's no space (one very long token).
    cut = head.rsplit(" ", 1)[0].rstrip() or head.rstrip()
    return f"{cut}…"


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
                "abstract": _abstract_preview(row["abstract"]),
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


_DATA_DATE_RE = re.compile(r"^papers_(\d{4}-\d{2}-\d{2})\.csv$")


def _latest_data_date(conf_dir: Path) -> str | None:
    """The newest papers_YYYY-MM-DD.csv date — the real data collection date.

    This is the honest "last updated" value for the catalog (the viewer used
    to show the page-load date, which drifts every visit). Returns None if no
    dated papers file exists (legacy conferences built before this convention).
    """
    dates = sorted(
        m.group(1)
        for f in conf_dir.glob("papers_*.csv")
        if (m := _DATA_DATE_RE.match(f.name))
    )
    return dates[-1] if dates else None


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
        # Real collection date (newest papers_*.csv) so the viewer's
        # "last updated" stat reflects the data, not the page-load time.
        "generated": _latest_data_date(summary_csv.parent),
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
        conf_dirs = sorted(
            d.name
            for d in output_dir.iterdir()
            if d.is_dir() and d.name not in _NON_CONFERENCE and (d / "summary.csv").exists()
        )

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

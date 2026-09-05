"""Collect a conference's accepted papers from arXiv into the catalog pipeline.

This is the committed, parameterized form of the one-off CVPR 2026 collection.
It queries arXiv by the comment field (e.g. ``co:"CVPR 2026"``), keeps ONLY
genuine acceptances for the target venue using the SAME ``VenueSignal``
classifier the main pipeline uses (so the "accepted to <VENUE>" semantics match
production exactly — bare mentions / workshops / rejections are dropped),
detects Oral / Highlight from the comment, and writes:

    paperpilot/output/<slug>/papers_YYYY-MM-DD.csv   (build_summary_csv.py input)
    paperpilot/output/<slug>/oral_summaries_ja.md    (Oral/Highlight titles)

From there the existing chain takes over:

    build_summary_csv.py --conference <slug>   ->  summary.csv
    build_pages.py        --conference <slug>   ->  docs/<slug>/papers.json
    scaffold_conference_page.py --conference <slug> ...  ->  docs/<slug>/index.html

Usage:
    uv run python -m paperpilot.scripts.collect_conference \\
        --conference cvpr-2026 --venue CVPR --query 'co:"CVPR 2026"' --max 800

Notes:
    - ``--venue`` is the VenueSignal token to KEEP (CVPR / ICLR / NEURIPS / ...).
      Only papers whose arXiv comment matches "accepted to <venue>" (etc.) and
      classify to exactly that venue (NOT "<venue> Workshop") are kept.
    - citation_count / github_stars are written as 0 — fresh-from-arXiv papers
      have no S2 / GitHub signal yet; the catalog viewer does not sort on them.
"""

from __future__ import annotations

import argparse
import csv
import re
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import arxiv

from ..identity import IdentityError, identity_from_url, normalize_alias
from ..signals.venue_signal import VenueSignal

PROJECT = Path(__file__).resolve().parents[1]
_ARXIV_ID_RE = re.compile(r"abs/([0-9]+\.[0-9]+)")
_ORAL_RE = re.compile(r"\b(oral|highlight)\b", re.IGNORECASE)

_CSV_COLUMNS = [
    "title",
    "authors",
    "venue",
    "venue_tier",
    "citation_count",
    "github_stars",
    "arxiv_id",
    "abstract",
    "url",
    "pdf_url",
    "comment",
    "source",
    "source_id",
]


def _arxiv_id(entry_id: str) -> str:
    """Extract the bare arXiv id (e.g. 2604.15174) from an entry URL."""
    m = _ARXIV_ID_RE.search(entry_id or "")
    return m.group(1) if m else ""


def fetch_results(query: str, max_results: int, *, page_size: int = 100) -> list[Any]:
    """Run the arXiv API query, newest first. Network call — mocked in tests."""
    client = arxiv.Client(page_size=page_size, delay_seconds=3, num_retries=3)
    search = arxiv.Search(
        query=query,
        max_results=max_results,
        sort_by=arxiv.SortCriterion.SubmittedDate,
        sort_order=arxiv.SortOrder.Descending,
    )
    return list(client.results(search))


def oral_titles_from_arxiv(query: str, venue: str, *, max_results: int = 1600) -> list[str]:
    """Oral / Highlight titles for a venue, harvested from arXiv comments.

    CVF Open Access and the ACL Anthology don't expose the oral/highlight
    designation, so collectors built on them mark every paper Poster. The
    subset of accepted papers whose authors self-tagged "Oral"/"Highlight" in
    their arXiv comment is the best free signal, and overlaying those titles
    restores the Oral filter on those catalogs. Reuses the same fetch +
    VenueSignal classifier as the full arXiv collector. Network — mocked in tests.
    """
    results = fetch_results(query, max_results)
    _rows, oral_titles = build_rows(results, venue)
    return oral_titles


def build_rows(results: Iterable[Any], target_venue: str) -> tuple[list[dict[str, Any]], list[str]]:
    """Filter arXiv results to genuine acceptances of ``target_venue``.

    Returns (rows, oral_titles). Dedups by arXiv id. Reuses the production
    ``VenueSignal._classify`` so the acceptance test is identical to the
    pipeline's (a "<venue> Workshop" classification is excluded because it
    does not equal the bare venue token).
    """
    target = target_venue.upper()
    papers: dict[str, dict[str, Any]] = {}
    oral_titles: list[str] = []

    for r in results:
        comment = " ".join((getattr(r, "comment", None) or "").split())
        venue, tier, _score = VenueSignal._classify(comment)
        if venue != target:
            continue
        aid = _arxiv_id(getattr(r, "entry_id", "") or "")
        if not aid or aid in papers:
            continue
        title = " ".join((getattr(r, "title", "") or "").split())
        authors = "; ".join(getattr(a, "name", "") for a in (getattr(r, "authors", None) or []))
        papers[aid] = {
            "title": title,
            "authors": authors,
            "venue": target,
            "venue_tier": tier,
            "citation_count": 0,
            "github_stars": 0,
            "arxiv_id": aid,
            "abstract": " ".join((getattr(r, "summary", "") or "").split()),
            "url": getattr(r, "entry_id", "") or "",
            "pdf_url": getattr(r, "pdf_url", "") or "",
            "comment": comment,
        }
        if _ORAL_RE.search(comment):
            oral_titles.append(title)

    return list(papers.values()), oral_titles


def write_outputs(
    conference: str,
    rows: list[dict[str, Any]],
    oral_titles: list[str],
    *,
    output_root: Path | None = None,
    date: str | None = None,
) -> Path:
    """Write papers_<date>.csv (+ oral_summaries_ja.md) under the conf dir."""
    root = output_root if output_root is not None else PROJECT / "output"
    out_dir = root / conference
    out_dir.mkdir(parents=True, exist_ok=True)
    day = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    projected_rows: list[dict[str, Any]] = []
    for row in rows:
        identity = identity_from_url(str(row.get("url") or ""))
        declared_source = str(row.get("source") or "").strip()
        declared_source_id = str(row.get("source_id") or "").strip()
        if bool(declared_source) != bool(declared_source_id):
            raise IdentityError("source and source_id must be present together")
        if declared_source:
            normalized = normalize_alias(declared_source, declared_source_id)
            if normalized != (identity.source, identity.source_id):
                raise IdentityError(
                    "declared source/source_id does not match the native source URL"
                )
        projected_rows.append({**row, "source": identity.source, "source_id": identity.source_id})

    csv_path = out_dir / f"papers_{day}.csv"
    with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=_CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(projected_rows)

    # The oral file must reflect THIS collection. When the new run has no
    # orals (e.g. a CVF / ACL re-collection of a venue first gathered from
    # arXiv), clear any stale file so build_summary_csv doesn't keep marking
    # the old titles Oral.
    oral_md = out_dir / "oral_summaries_ja.md"
    if oral_titles:
        md = [
            f"# {conference} Oral / Highlight\n",
            "*Oral / Highlight と判定された採択論文*\n",
        ]
        md += [f"## {i}. {t}" for i, t in enumerate(oral_titles, 1)]
        oral_md.write_text("\n".join(md) + "\n", encoding="utf-8")
    elif oral_md.exists():
        oral_md.unlink()

    return csv_path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--conference", required=True, help="output slug, e.g. cvpr-2026")
    ap.add_argument("--venue", required=True, help="VenueSignal token to keep, e.g. CVPR")
    ap.add_argument("--query", required=True, help='arXiv API query, e.g. co:"CVPR 2026"')
    ap.add_argument("--max", type=int, default=800, help="max arXiv results to scan (default 800)")
    args = ap.parse_args()

    results = fetch_results(args.query, args.max)
    rows, oral_titles = build_rows(results, args.venue)
    csv_path = write_outputs(args.conference, rows, oral_titles)

    print(f"scanned {len(results)} arXiv results for query: {args.query}")
    print(
        f"✅ {len(rows)} genuine {args.venue.upper()} papers "
        f"({len(oral_titles)} oral/highlight) -> {csv_path}"
    )
    if not rows:
        print(
            "⚠️  0 papers matched — VenueSignal needs an 'accepted to <venue>' "
            "style comment; check --venue / --query."
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

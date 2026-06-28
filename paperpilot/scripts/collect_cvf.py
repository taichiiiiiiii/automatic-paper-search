"""Collect CVPR / ICCV accepted papers from CVF Open Access.

openaccess.thecvf.com is the authoritative open-access proceedings for the
IEEE/CVF conferences (CVPR, ICCV, WACV). The per-year listing (?day=all)
enumerates every accepted paper; each paper's detail page carries Highwire
``citation_*`` meta tags (title, authors, pdf) plus the abstract in a
``<div id="abstract">``. Detail pages are fetched concurrently.

This is the authoritative full set, unlike the arXiv-comment collector which
only captures the subset of acceptances whose authors self-tagged the venue.

Writes the same outputs as collect_conference (reusing write_outputs):
    paperpilot/output/<slug>/papers_YYYY-MM-DD.csv
No oral_summaries_ja.md — CVF Open Access does not mark oral/highlight, so
every paper is a Poster in the catalog's binary type.

Note: ECCV is hosted on ECVA (ecva.net), NOT CVF — use a separate adapter.

Usage:
    uv run python -m paperpilot.scripts.collect_cvf \\
        --conference cvpr-2025 --venue CVPR --cvf-id CVPR2025
"""

from __future__ import annotations

import argparse
import concurrent.futures
import html
import re
from typing import Any

from ..signals.venue_signal import TIER_1, TIER_2, TIER_3
from ..utils.http import request_with_retry
from ..utils.logger import get_logger
from .collect_conference import write_outputs

logger = get_logger(__name__)

CVF_BASE = "https://openaccess.thecvf.com"

_ABSTRACT_RE = re.compile(r'<div id="abstract"[^>]*>(.*?)</div>', re.DOTALL)
_TITLE_RE = re.compile(r'<meta\s+name="citation_title"\s+content="(.*?)"', re.IGNORECASE)
_AUTHOR_RE = re.compile(r'<meta\s+name="citation_author"\s+content="(.*?)"', re.IGNORECASE)
_PDF_RE = re.compile(r'<meta\s+name="citation_pdf_url"\s+content="(.*?)"', re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")


def _venue_tier(venue: str) -> int:
    v = venue.upper()
    if v in TIER_1:
        return 1
    if v in TIER_2:
        return 2
    if v in TIER_3:
        return 3
    return 0


def _clean(text: str) -> str:
    """Strip tags + unescape entities + collapse whitespace."""
    return " ".join(html.unescape(_TAG_RE.sub(" ", text)).split())


def _reformat_author(name: str) -> str:
    """Highwire gives "Last, First"; render "First Last" to match other catalogs."""
    name = name.strip()
    if ", " in name:
        last, first = name.split(", ", 1)
        return f"{first.strip()} {last.strip()}"
    return name


def detail_paths(listing_html: str, cvf_id: str) -> list[str]:
    """Ordered, de-duplicated detail-page paths for a CVF year listing."""
    seen: set[str] = set()
    out: list[str] = []
    for m in re.finditer(rf'href="(/content/{re.escape(cvf_id)}/html/[^"]+?\.html)"', listing_html):
        path = m.group(1)
        if path not in seen:
            seen.add(path)
            out.append(path)
    return out


def parse_detail(detail_html: str, detail_url: str, venue: str) -> dict[str, Any] | None:
    """Map one CVF detail page to a catalog row. Returns None if no title."""
    title_m = _TITLE_RE.search(detail_html)
    title = _clean(title_m.group(1)) if title_m else ""
    if not title:
        return None
    authors = "; ".join(_reformat_author(html.unescape(a)) for a in _AUTHOR_RE.findall(detail_html))
    pdf_m = _PDF_RE.search(detail_html)
    abs_m = _ABSTRACT_RE.search(detail_html)
    return {
        "title": title,
        "authors": authors,
        "venue": venue.upper(),
        "venue_tier": _venue_tier(venue),
        "citation_count": 0,
        "github_stars": 0,
        "arxiv_id": "",
        "abstract": _clean(abs_m.group(1)) if abs_m else "",
        "url": detail_url,
        "pdf_url": html.unescape(pdf_m.group(1)) if pdf_m else "",
        "comment": "",
    }


def fetch_listing(cvf_id: str, *, timeout: float = 30.0) -> list[str]:
    """Fetch the year listing and return detail-page paths. Network — mocked in tests."""
    resp = request_with_retry("GET", f"{CVF_BASE}/{cvf_id}?day=all", timeout=timeout)
    if resp is None or resp.status_code != 200:
        return []
    return detail_paths(resp.text, cvf_id)


def _fetch_one(path: str, venue: str, *, timeout: float = 30.0) -> dict[str, Any] | None:
    # Fail-Safe: any error on a single page returns None (the row is dropped),
    # so one bad page never aborts the whole concurrent collection via ex.map.
    try:
        resp = request_with_retry("GET", f"{CVF_BASE}{path}", timeout=timeout)
        if resp is None or resp.status_code != 200:
            return None
        return parse_detail(resp.text, f"{CVF_BASE}{path}", venue)
    except Exception as exc:  # collection must survive a single bad page
        logger.warning("cvf: failed to fetch/parse %s: %s", path, exc)
        return None


def collect(cvf_id: str, venue: str, *, max_workers: int = 8) -> list[dict[str, Any]]:
    """Full collection: listing -> concurrent detail fetch -> rows (deduped by url)."""
    paths = fetch_listing(cvf_id)
    rows: dict[str, dict[str, Any]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
        for row in ex.map(lambda p: _fetch_one(p, venue), paths):
            if row and row["url"] not in rows:
                rows[row["url"]] = row
    return list(rows.values())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--conference", required=True, help="output slug, e.g. cvpr-2025")
    ap.add_argument("--venue", required=True, help="VenueSignal token, e.g. CVPR / ICCV")
    ap.add_argument("--cvf-id", required=True, help='CVF listing id, e.g. "CVPR2025"')
    ap.add_argument("--max-workers", type=int, default=8, help="concurrent detail fetches")
    args = ap.parse_args()

    rows = collect(args.cvf_id, args.venue, max_workers=args.max_workers)
    print(f"collected {len(rows)} {args.venue.upper()} papers from CVF {args.cvf_id}")
    if not rows:
        print("⚠️  0 papers — check --cvf-id (e.g. 'CVPR2025'). Nothing written.")
        return 1

    csv_path = write_outputs(args.conference, rows, [])
    print(f"✅ {len(rows)} accepted {args.venue.upper()} papers -> {csv_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

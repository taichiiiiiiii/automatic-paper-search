"""Collect *ACL accepted papers from the ACL Anthology XML data.

The ACL Anthology (aclanthology.org) is the authoritative, complete record of
ACL / EMNLP / NAACL papers. Its machine-readable XML dump carries title,
authors, and ABSTRACT for every paper in a single file — far richer and more
complete than the arXiv-comment collector (which only captures the subset of
acceptances whose authors self-tagged the venue on arXiv).

Only the main-track volumes (Long + Short papers) are kept by default; Findings,
workshops, demos, tutorials and the student research workshop are separate
acceptance tracks and are skipped.

Writes the same outputs as collect_conference (reusing its write_outputs), so
the rest of the chain (build_summary_csv -> build_pages -> scaffold) is unchanged:

    paperpilot/output/<slug>/papers_YYYY-MM-DD.csv

No oral_summaries_ja.md is written — the Anthology does not mark oral/spotlight,
so every paper is a Poster in the catalog's binary type.

Usage:
    uv run python -m paperpilot.scripts.collect_acl_anthology \\
        --conference acl-2025 --venue ACL --xml-id 2025.acl

`--xml-id` is the Anthology collection id (e.g. "2025.acl", "2025.emnlp",
"2024.naacl"); the XML is fetched from the acl-org/acl-anthology GitHub mirror.
"""

from __future__ import annotations

import argparse
import xml.etree.ElementTree as ET
from typing import Any

from ..signals.venue_signal import TIER_1, TIER_2, TIER_3
from ..utils.http import request_with_retry
from .collect_conference import oral_titles_from_arxiv, write_outputs

_XML_BASE = "https://raw.githubusercontent.com/acl-org/acl-anthology/master/data/xml"
_ANTHOLOGY_URL = "https://aclanthology.org/"

# Main-conference proceedings only. ACL/NAACL split the main track into
# "long" + "short"; EMNLP uses a single "main" volume. Findings / workshops /
# demos / industry / tutorials / srw live in their own volumes and are
# separate acceptance tracks.
_MAIN_VOLUMES = {"long", "short", "main"}


def _venue_tier(venue: str) -> int:
    v = venue.upper()
    if v in TIER_1:
        return 1
    if v in TIER_2:
        return 2
    if v in TIER_3:
        return 3
    return 0


def _text(elem: ET.Element | None) -> str:
    """Flattened text of an element (handles nested <fixed-case>/<i> markup)."""
    if elem is None:
        return ""
    return " ".join("".join(elem.itertext()).split())


def _author_name(author: ET.Element) -> str:
    first = _text(author.find("first"))
    last = _text(author.find("last"))
    return " ".join(p for p in (first, last) if p)


def fetch_xml(xml_id: str, *, timeout: float = 30.0) -> bytes | None:
    """Fetch the Anthology XML for a collection id. Network — mocked in tests."""
    resp = request_with_retry("GET", f"{_XML_BASE}/{xml_id}.xml", timeout=timeout)
    if resp is None or resp.status_code != 200:
        return None
    return resp.content


def parse_papers(
    xml_bytes: bytes, venue: str, *, volumes: set[str] | None = None
) -> list[dict[str, Any]]:
    """Parse main-track papers (title, authors, abstract, url) from Anthology XML.

    Skips volume front-matter (no authors) and non-main volumes. Dedups by the
    Anthology paper id (its <url> stub, e.g. "2025.acl-long.1").
    """
    keep_volumes = volumes if volumes is not None else _MAIN_VOLUMES
    venue_token = venue.upper()
    tier = _venue_tier(venue)
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return []

    papers: dict[str, dict[str, Any]] = {}
    for volume in root.iter("volume"):
        if (volume.get("id") or "") not in keep_volumes:
            continue
        for p in volume.iter("paper"):
            stub = _text(p.find("url"))  # e.g. "2025.acl-long.1"
            title = _text(p.find("title"))
            authors = [_author_name(a) for a in p.findall("author")]
            authors = [a for a in authors if a]
            # Front-matter / non-papers have no authors — skip them.
            if not stub or not title or not authors or stub in papers:
                continue
            papers[stub] = {
                "title": title,
                "authors": "; ".join(authors),
                "venue": venue_token,
                "venue_tier": tier,
                "citation_count": 0,
                "github_stars": 0,
                "arxiv_id": "",
                "abstract": _text(p.find("abstract")),
                "url": f"{_ANTHOLOGY_URL}{stub}/",
                "pdf_url": f"{_ANTHOLOGY_URL}{stub}.pdf",
                "comment": "",  # the Anthology marks no oral/spotlight
            }
    return list(papers.values())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--conference", required=True, help="output slug, e.g. acl-2025")
    ap.add_argument("--venue", required=True, help="VenueSignal token, e.g. ACL / EMNLP / NAACL")
    ap.add_argument("--xml-id", required=True, help='Anthology collection id, e.g. "2025.acl"')
    ap.add_argument(
        "--oral-arxiv-query",
        default=None,
        help='restore Oral marks from arXiv comments (the Anthology marks none), e.g. '
        "co:\"ACL 2025\"",
    )
    args = ap.parse_args()

    xml_bytes = fetch_xml(args.xml_id)
    if xml_bytes is None:
        print(f"⚠️  could not fetch Anthology XML for '{args.xml_id}'. Nothing written.")
        return 1
    rows = parse_papers(xml_bytes, args.venue)
    print(f"parsed {len(rows)} main-track {args.venue.upper()} papers from {args.xml_id}.xml")
    if not rows:
        print("⚠️  0 papers — check --xml-id (e.g. '2025.acl'). Nothing written.")
        return 1

    # The Anthology marks no oral/spotlight; optionally overlay arXiv-tagged orals.
    orals = oral_titles_from_arxiv(args.oral_arxiv_query, args.venue) if args.oral_arxiv_query else []
    csv_path = write_outputs(args.conference, rows, orals)
    print(f"✅ {len(rows)} accepted {args.venue.upper()} papers ({len(orals)} oral via arXiv) -> {csv_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

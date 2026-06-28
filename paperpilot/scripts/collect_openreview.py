"""Collect a conference's accepted papers from OpenReview into the catalog.

OpenReview is the official submission/review system for ICLR, NeurIPS and
ICML (among others), so its accepted-paper list is AUTHORITATIVE and COMPLETE
— unlike the arXiv-comment collector (``collect_conference.py``) which only
captures the ~30-40% of acceptances whose authors self-tagged the venue in
their arXiv comment. OpenReview also carries the official decision label
(Oral / Spotlight / Poster) per paper, so the highlighted set is exact rather
than regex-guessed from a free-text comment.

It writes the SAME outputs as ``collect_conference.py`` (reusing its
``write_outputs``) so the rest of the chain is unchanged:

    paperpilot/output/<slug>/papers_YYYY-MM-DD.csv   (build_summary_csv input)
    paperpilot/output/<slug>/oral_summaries_ja.md    (Oral + Spotlight titles)

From there:

    build_summary_csv.py --conference <slug>          -> summary.csv
    build_pages.py [--conference <slug>]               -> docs/<slug>/papers.json
        (omit --conference to also re-aggregate docs/conferences.json)
    scaffold_conference_page.py --conference <slug> ... -> docs/<slug>/index.html

Usage:
    uv run python -m paperpilot.scripts.collect_openreview \\
        --conference iclr-2025 --venue ICLR --venueid "ICLR.cc/2025/Conference"

Notes:
    - ``--venueid`` is the OpenReview group id; look it up on openreview.net
      (e.g. "NeurIPS.cc/2024/Conference", "ICML.cc/2025/Conference"). The v2
      API returns only accepted submissions for a Conference venueid.
    - citation_count / github_stars are written as 0 (no S2 / GitHub signal at
      collection time; the catalog viewer does not sort on them).
    - Spotlight papers are grouped with Oral into the highlighted set so the
      catalog's Oral filter surfaces both; the exact label is kept in the
      ``comment`` column for any future finer-grained display.
"""

from __future__ import annotations

import argparse
import re
from typing import Any

from ..signals.venue_signal import TIER_1, TIER_2, TIER_3
from ..utils.http import request_with_retry
from .collect_conference import write_outputs  # reuse the identical output writer

OPENREVIEW_API = "https://api2.openreview.net/notes"
OPENREVIEW_FORUM = "https://openreview.net/forum?id="
OPENREVIEW_PDF = "https://openreview.net/pdf?id="

# Venues spell the decision differently in the `venue` value: ICLR/NeurIPS use
# space-separated words ("ICLR 2026 Oral", "NeurIPS 2025 spotlight"), while
# ICML 2025 uses the compound token "spotlightposter" (a spotlight-tier poster).
# The compound alternative must precede the bare words so it is matched whole.
_DECISION_RE = re.compile(r"\b(oral|spotlightposter|spotlight|poster)\b", re.IGNORECASE)
_COMPOUND_DECISIONS = {"spotlightposter": "Spotlight"}
_HIGHLIGHTED = {"Oral", "Spotlight"}

_PAGE_SIZE = 1000          # OpenReview v2 max page size
_MAX_PAGES = 25            # 25k-paper ceiling — guards against an unbounded loop


def _value(content: dict[str, Any], key: str, default: Any = "") -> Any:
    """Read an OpenReview API v2 content field (values are wrapped as {value: ...}).

    An explicit ``{"value": None}`` (OpenReview's representation of a null
    field) yields the default, not None, so callers never stringify None into
    the CSV as the literal "None".
    """
    node = content.get(key)
    if isinstance(node, dict):
        value = node.get("value", default)
        return value if value is not None else default
    return node if node is not None else default


def _decision(venue_label: str) -> str:
    """Parse the decision (Oral / Spotlight / Poster) from a `venue` label.

    e.g. "ICLR 2025 Oral" -> "Oral", "ICML 2025 spotlightposter" -> "Spotlight".
    Returns "" when no recognised tier word is present (e.g. a bare "Accept"),
    which is treated as non-highlighted.
    """
    m = _DECISION_RE.search(venue_label or "")
    if not m:
        return ""
    raw = m.group(1).lower()
    return _COMPOUND_DECISIONS.get(raw, raw.capitalize())


def _venue_tier(venue: str) -> int:
    """Tier for the venue token, reusing the production VenueSignal tier sets."""
    v = venue.upper()
    if v in TIER_1:
        return 1
    if v in TIER_2:
        return 2
    if v in TIER_3:
        return 3
    return 0


def fetch_notes(
    venueid: str,
    *,
    page_size: int = _PAGE_SIZE,
    max_pages: int = _MAX_PAGES,
    timeout: float = 20.0,
) -> list[dict[str, Any]]:
    """Page through every accepted note for ``venueid``. Network — mocked in tests.

    Fail-Safe: on any non-200 / network failure the pages gathered so far are
    returned (empty if the very first call failed) rather than raising.
    """
    notes: list[dict[str, Any]] = []
    for page in range(max_pages):
        resp = request_with_retry(
            "GET",
            OPENREVIEW_API,
            params={
                "content.venueid": venueid,
                "limit": page_size,
                "offset": page * page_size,
            },
            timeout=timeout,
        )
        if resp is None or resp.status_code != 200:
            break
        try:
            body = resp.json()
        except ValueError:
            # 200 with a non-JSON body (maintenance page / proxy error):
            # Fail-Safe — return the pages gathered so far rather than raising.
            break
        batch = (body or {}).get("notes") or []
        notes.extend(batch)
        if len(batch) < page_size:
            break
    return notes


def build_rows(
    notes: list[dict[str, Any]], venue: str, venueid: str
) -> tuple[list[dict[str, Any]], list[str]]:
    """Map OpenReview notes to catalog rows + the highlighted (Oral/Spotlight) titles.

    Dedups by note id. Drops notes without a title/id and any stray note whose
    venueid does not match (rejected / withdrawn submissions carry a different
    venueid even though the query filters on the accepted one).
    """
    target_tier = _venue_tier(venue)
    venue_token = venue.upper()
    papers: dict[str, dict[str, Any]] = {}
    highlighted: list[str] = []

    for n in notes:
        nid = n.get("id") or ""
        content = n.get("content") or {}
        # Drop notes whose venueid explicitly differs from the target (withdrawn /
        # rejected submissions carry a different venueid). The server-side
        # content.venueid filter is the primary defence; a note with no venueid
        # field passes through rather than being silently dropped.
        note_venueid = str(_value(content, "venueid", ""))
        if note_venueid and note_venueid != venueid:
            continue
        title = " ".join(str(_value(content, "title", "")).split())
        if not nid or not title or nid in papers:
            continue
        raw_authors = _value(content, "authors", []) or []
        if isinstance(raw_authors, str):  # malformed note: a bare string, not a list
            raw_authors = [raw_authors]
        authors = "; ".join(str(a) for a in raw_authors)
        label = str(_value(content, "venue", ""))
        papers[nid] = {
            "title": title,
            "authors": authors,
            "venue": venue_token,
            "venue_tier": target_tier,
            "citation_count": 0,
            "github_stars": 0,
            "arxiv_id": "",
            "abstract": " ".join(str(_value(content, "abstract", "")).split()),
            "url": f"{OPENREVIEW_FORUM}{nid}",
            "pdf_url": f"{OPENREVIEW_PDF}{nid}",
            "comment": label,  # official decision label, retained verbatim
        }
        if _decision(label) in _HIGHLIGHTED:
            highlighted.append(title)

    return list(papers.values()), highlighted


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--conference", required=True, help="output slug, e.g. iclr-2025")
    ap.add_argument("--venue", required=True, help="VenueSignal token, e.g. ICLR / NEURIPS / ICML")
    ap.add_argument(
        "--venueid", required=True, help='OpenReview group id, e.g. "ICLR.cc/2025/Conference"'
    )
    args = ap.parse_args()

    notes = fetch_notes(args.venueid)
    rows, highlighted = build_rows(notes, args.venue, args.venueid)
    print(f"fetched {len(notes)} OpenReview notes for venueid: {args.venueid}")

    if not rows:
        print(
            f"⚠️  0 accepted {args.venue.upper()} papers for venueid '{args.venueid}' "
            "— check --venueid (e.g. 'ICLR.cc/2025/Conference'). Nothing written."
        )
        return 1

    csv_path = write_outputs(args.conference, rows, highlighted)
    print(
        f"✅ {len(rows)} accepted {args.venue.upper()} papers "
        f"({len(highlighted)} oral/spotlight) -> {csv_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

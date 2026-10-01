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
import io
import logging
import re
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NamedTuple

import arxiv

from ..identity import IdentityError, identity_from_url, normalize_alias
from ..identity.source_ids import ARXIV_MODERN_PATTERN
from ..signals.venue_signal import VenueSignal
from ..utils.atomic import atomic_write_text
from ..utils.csv_safety import neutralize_row
from ._common import validate_conference_slug

PROJECT = Path(__file__).resolve().parents[1]
_ARXIV_MODERN_RE = re.compile(rf"^{ARXIV_MODERN_PATTERN}$")
_ORAL_RE = re.compile(r"\b(oral|highlight)\b", re.IGNORECASE)
# Shared by the overlay itself and the collectors' --oral-max default, so the
# cap an operator raises is the cap the overlay reports it hit.
ORAL_MAX_RESULTS_DEFAULT = 1600
# The only arXiv client failure that returns quietly instead of raising; see
# fetch_results_checked.
_MALFORMED_FEED_PREFIX = "Malformed feed"

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
    """Extract the bare arXiv id (e.g. 2604.15174) from an entry URL.

    Parsed by the shared identity module, so only a real arXiv host
    counts. Legacy ``archive/NNNNNNN`` IDs are skipped like any other
    unparseable entry: the arXiv API never returns them for the recent
    conferences this collects, and downstream file names assume the
    slash-free modern form.
    """
    try:
        identity = identity_from_url(entry_id or "")
    except IdentityError:
        return ""
    if identity.source != "arxiv" or not _ARXIV_MODERN_RE.fullmatch(identity.source_id):
        return ""
    return identity.source_id


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


def fetch_results_checked(
    query: str, max_results: int, *, page_size: int = 100
) -> tuple[list[Any], bool]:
    """``fetch_results`` plus a completeness signal: returns ``(results, complete)``.

    A short list is not evidence of an outage. The installed client retries HTTP
    failures and an empty non-first page and then RAISES (``HTTPError`` /
    ``UnexpectedEmptyPageError``), and it stops paginating only at ``total_results``,
    so those paths cannot be mistaken for "the venue is that small". The one case that
    returns quietly with fewer entries than it fetched is a malformed feed: the parser
    logs ``Malformed feed; consider handling: ...`` on the "arxiv" logger and keeps
    going with the pages it could read. That warning is the only observable sign of
    such a partial return, so it is captured here rather than left in the log.

    ``fetch_results`` stays the raw fetch (and the mock point for the other collectors'
    tests); this wrapper is the only caller that judges completeness.
    """
    logger = logging.getLogger("arxiv")
    malformed: list[str] = []

    class _MalformedFeedHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            if record.getMessage().startswith(_MALFORMED_FEED_PREFIX):
                malformed.append(record.getMessage())

    handler = _MalformedFeedHandler(level=logging.WARNING)
    previous_level = logger.level
    if previous_level == logging.NOTSET or previous_level > logging.WARNING:
        # An ambient ERROR level would hide the warning and read as "complete".
        logger.setLevel(logging.WARNING)
    logger.addHandler(handler)
    try:
        results = fetch_results(query, max_results, page_size=page_size)
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous_level)
    return results, not malformed


class OralOverlay(NamedTuple):
    """What the arXiv oral overlay returned, or why it returned nothing usable.

    ``titles`` is ``None`` exactly when ``reason`` is set, and the two reasons call
    for different advice: a full ``--oral-max`` window is fixed by raising the cap,
    a malformed feed only by re-running. The collectors print the matching sentence
    from ``reason`` instead of guessing it from ``None``, and an incomplete overlay
    (``titles is None``) is never evidence that a venue has no orals — it must not
    authorize removing ``oral_summaries_ja.md`` even with ``--clear-oral``.
    """

    titles: list[str] | None
    reason: str | None


# OralOverlay.reason values.
ORAL_WINDOW_FILLED = "window-filled"
ORAL_MALFORMED_FEED = "malformed-feed"


def oral_titles_from_arxiv(
    query: str, venue: str, *, max_results: int = ORAL_MAX_RESULTS_DEFAULT
) -> OralOverlay:
    """Oral / Highlight titles for a venue, harvested from arXiv comments.

    CVF Open Access and the ACL Anthology don't expose the oral/highlight
    designation, so collectors built on them mark every paper Poster. The
    subset of accepted papers whose authors self-tagged "Oral"/"Highlight" in
    their arXiv comment is the best free signal, and overlaying those titles
    restores the Oral filter on those catalogs. Reuses the same fetch +
    VenueSignal classifier as the full arXiv collector. Network — mocked in tests.

    Reports ``titles=None`` (with the matching ``reason``) when the fetch is
    incomplete: either it filled the whole ``max_results`` window, or the client
    reported a malformed feed page. The scan is newest-first and bounded, so a
    window that full cannot show it reached the older acceptances, and a malformed
    page drops entries from the middle — a short list is then no proof of a complete
    scan either. Either way the titles would be a partial set, and
    ``write_outputs`` replaces the published oral file with whatever it is given. A
    caller that gets ``titles=None`` must pass an empty list so the existing
    ``oral_summaries_ja.md`` survives, or raise ``--oral-max`` and retry (window) /
    re-run later (malformed feed).
    """
    results, complete = fetch_results_checked(query, max_results)
    if not complete:
        print(
            "⚠️  oral overlay incomplete: arXiv returned a malformed feed page and "
            "kept going, so the fetched set is missing entries and the oral list "
            "would be partial"
        )
        return OralOverlay(None, ORAL_MALFORMED_FEED)
    if len(results) >= max_results:
        print(
            f"⚠️  oral overlay truncated: the arXiv fetch returned the full "
            f"{max_results}-result --oral-max window (newest first), so older "
            "Oral/Highlight acceptances are outside the scan and the list would "
            "be incomplete"
        )
        return OralOverlay(None, ORAL_WINDOW_FILLED)
    _rows, oral_titles = build_rows(results, venue)
    return OralOverlay(oral_titles, None)


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
    clear_oral: bool = False,
) -> Path:
    """Write papers_<date>.csv (+ oral_summaries_ja.md) under the conf dir.

    An empty ``oral_titles`` writes nothing and leaves an existing oral file alone;
    only ``clear_oral=True`` removes it. The four collectors share this writer, and
    an empty list usually means "this run found no oral evidence" (the arXiv overlay
    was skipped or came back empty), not "this venue has no orals".
    """
    validate_conference_slug(conference)
    root = output_root if output_root is not None else PROJECT / "output"
    out_dir = root / conference
    # Defense-in-depth: validate_conference_slug's allowlist regex already
    # makes traversal structurally impossible (no "/" or ".." can match),
    # but a resolve()-based containment check costs nothing and protects
    # against a future loosening of that regex.
    resolved_root = root.resolve()
    resolved_out_dir = out_dir.resolve()
    if resolved_root != resolved_out_dir and resolved_root not in resolved_out_dir.parents:
        raise ValueError(f"conference output dir {resolved_out_dir} escapes {resolved_root}")
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
    # Buffer the projection and replace the dated CSV in one rename, so a
    # reader never opens a half-written collection file mid-build.
    projection = io.StringIO(newline="")
    writer = csv.DictWriter(projection, fieldnames=_CSV_COLUMNS)
    writer.writeheader()
    # Titles, abstracts, authors and comments here come straight from
    # arXiv / OpenReview / CVF / ACL. CSV quoting does not stop a
    # spreadsheet evaluating a cell that starts a formula, and this
    # file is opened by hand and re-read by build_summary_csv.
    writer.writerows(neutralize_row(row) for row in projected_rows)
    atomic_write_text(csv_path, projection.getvalue(), encoding="utf-8-sig")

    # The oral file drives the catalog's Oral/Poster split, so an empty list here is
    # ambiguous: a CVF / ACL re-collection without --oral-arxiv-query, or an overlay
    # whose fetch came back empty, both produce [] while the venue still has orals.
    # Deleting the file on that reading would silently turn every paper into Poster,
    # so it is kept as-is and only removed when the operator asked for it.
    oral_md = out_dir / "oral_summaries_ja.md"
    if oral_titles:
        md = [
            f"# {conference} Oral / Highlight\n",
            "*Oral / Highlight と判定された採択論文*\n",
        ]
        md += [f"## {i}. {t}" for i, t in enumerate(oral_titles, 1)]
        atomic_write_text(oral_md, "\n".join(md) + "\n")
    elif clear_oral and oral_md.exists():
        oral_md.unlink()

    return csv_path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--conference", required=True, help="output slug, e.g. cvpr-2026")
    ap.add_argument("--venue", required=True, help="VenueSignal token to keep, e.g. CVPR")
    ap.add_argument("--query", required=True, help='arXiv API query, e.g. co:"CVPR 2026"')
    ap.add_argument("--max", type=int, default=800, help="max arXiv results to scan (default 800)")
    ap.add_argument(
        "--clear-oral",
        action="store_true",
        help="delete an existing oral_summaries_ja.md when this run finds no oral titles "
        "(default: keep it, so a skipped or empty overlay cannot erase the Oral labels)",
    )
    args = ap.parse_args()

    results, complete = fetch_results_checked(args.query, args.max)
    rows, oral_titles = build_rows(results, args.venue)

    print(f"scanned {len(results)} arXiv results for query: {args.query}")
    if not complete:
        # The client logged a malformed feed and continued, so entries are missing
        # from the middle of the window. Nothing here proves which papers were lost,
        # so the fetched set cannot be called a venue — re-run instead.
        print(
            "⚠️  incomplete arXiv feed: the client logged a malformed page and kept "
            "going, so this fetch is missing entries and the catalog would silently "
            "drop papers. Re-run the collection. Nothing written."
        )
        return 1
    if len(results) >= args.max:
        # Same reasoning as oral_titles_from_arxiv: the scan is newest-first and bounded,
        # so a window that full proves nothing about the older acceptances. Here it is
        # worse than the overlay, because a NEW conference has no published catalog for
        # build_pages' shrink gate to compare against — a partial collection would be
        # published as if it were the whole venue.
        #
        # No opt-in override (same policy as collect_openreview, closes #388): a written
        # papers_<date>.csv carries no marker telling "complete" from "partial", so there
        # is no safe way to force-publish a truncated window under the same schema.
        print(
            f"⚠️  --max window truncated: the arXiv fetch returned the full {args.max}-result "
            "window (newest first), so older acceptances are outside the scan and the "
            f"catalog would be partial. Raise --max above {args.max} and re-run. "
            "Nothing written."
        )
        return 1
    if not rows:
        # Do NOT call write_outputs: it would write a header-only CSV for
        # today's date and silently overwrite/mask an existing good
        # catalog file from an earlier run on the same day (closes #389).
        print(
            "⚠️  0 papers matched — VenueSignal needs an 'accepted to <venue>' "
            "style comment; check --venue / --query. Nothing written."
        )
        return 1

    csv_path = write_outputs(args.conference, rows, oral_titles, clear_oral=args.clear_oral)
    print(
        f"✅ {len(rows)} genuine {args.venue.upper()} papers "
        f"({len(oral_titles)} oral/highlight) -> {csv_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

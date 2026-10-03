"""CSV exporter — one row per paper, dated filename."""

from __future__ import annotations

import csv
import io
from datetime import datetime
from pathlib import Path

from ..models import Paper
from ..utils.atomic import atomic_write_text
from ..utils.csv_safety import neutralize_row
from ..utils.logger import get_logger
from .base import AbstractExporter

logger = get_logger(__name__)


def _resolve_export_path(out_dir: Path, ext: str) -> Path:
    """Pick the path this run writes to, without ever destroying an earlier
    same-day export.

    The daily collect workflow runs with `--fail-on-errors` and commits its
    output even on a red run; the failure Slack ping invites a same-day
    re-dispatch. Run 1 writes `papers_<date>.<ext>` and stamps seen_ids for
    its papers. If run 2 that day filtered those papers out (already seen)
    and simply overwrote `papers_<date>.<ext>` with its own (different)
    papers, run 1's output would be marked delivered yet gone from disk.

    So: the first export of the day keeps the plain name. Once that file
    exists, later exports in the same day go to a run-unique sibling
    `papers_<date>-<HHMMSS>.<ext>` (local time), falling back to a numeric
    counter if even that collides (two runs in the same wall-clock second).

    Both the date and the HHMMSS suffix are read off ONE `datetime.now()` call
    (L-3): using local `date.today()` for the date but UTC `datetime.now
    (timezone.utc)` for the suffix let the two clocks disagree right around
    local midnight (one has already rolled to the next day while the other
    hasn't), which could pick a name that doesn't actually sit next to the
    plain file it is meant to avoid clobbering.

    NOTE: `dir` (the exporter's `out_dir`) must never be pointed at a
    conference catalog directory (`paperpilot/output/<conf>/`) — the catalog
    readers (`build_summary_csv.py` / `build_pages.py`) only recognise the
    plain `papers_YYYY-MM-DD.csv` name, so a `-HHMMSS[-N]` sibling written
    here into that directory would silently never be picked up (L-2).
    """
    now = datetime.now()
    today = now.date().isoformat()
    plain = out_dir / f"papers_{today}.{ext}"
    if not plain.exists():
        return plain
    stamp = now.strftime("%H%M%S")
    candidate = out_dir / f"papers_{today}-{stamp}.{ext}"
    counter = 2
    while candidate.exists():
        candidate = out_dir / f"papers_{today}-{stamp}-{counter}.{ext}"
        counter += 1
    return candidate


COLUMNS = [
    "rank",
    "total_score",
    "llm_relevance",
    "llm_summary_ja",
    "llm_reason",
    "llm_tags",
    "follow_score",
    "follow_reason",
    "title",
    "authors",
    "affiliations",
    "venue",
    "venue_tier",
    "venue_score",
    "citation_count",
    "influential_citations",
    "citation_velocity",
    "citation_score",
    "author_h_index",
    "author_score",
    "embedding_similarity",
    "github_stars",
    "github_score",
    "has_code",
    "is_official_repo",
    "keyword_match_count",
    "keyword_score",
    "matched_keywords",
    "categories",
    "published_date",
    "url",
    "pdf_url",
    "github_url",
    "arxiv_id",
    "source",
    "abstract",
    # Additive identity columns, appended last so the existing column order stays a
    # stable prefix. `uid` is the legacy Paper.uid alias (NOT the canonical paper_id).
    "uid",
    "doi",
]


class CSVExporter(AbstractExporter):
    name = "csv"

    def export(self, papers: list[Paper]) -> str | None:
        if not papers:
            logger.info("csv: no papers to export")
            return None

        out_dir = Path(self.config.get("dir", "./output"))
        out_dir.mkdir(parents=True, exist_ok=True)
        encoding = self.config.get("encoding", "utf-8-sig")
        path = _resolve_export_path(out_dir, "csv")

        # Built in memory first, then replaced atomically: `open(path, "w")`
        # truncates the published CSV before the first row is written, so a
        # failure mid-write (or a reader in another step of the same run)
        # would see an empty or half-written catalog instead of the previous
        # complete one. newline="" keeps csv's own line terminators verbatim,
        # exactly as the file-mode write did.
        buffer = io.StringIO(newline="")
        writer = csv.DictWriter(buffer, fieldnames=COLUMNS)
        writer.writeheader()
        for rank, p in enumerate(papers, start=1):
            row: dict[str, object] = {
                "rank": rank,
                "total_score": round(p.total_score, 2),
                "llm_relevance": p.llm_relevance if p.llm_relevance is not None else "",
                "llm_summary_ja": p.llm_summary_ja or "",
                "llm_reason": p.llm_reason or "",
                "llm_tags": "; ".join(p.llm_tags),
                "follow_score": round(p.follow_score, 2),
                "follow_reason": p.follow_reason or "",
                "title": p.title,
                "authors": "; ".join(p.authors),
                "affiliations": "; ".join(p.affiliations),
                "venue": p.venue or "",
                "venue_tier": p.venue_tier,
                "venue_score": round(p.venue_score, 2),
                "citation_count": p.citation_count,
                "influential_citations": p.influential_citations,
                "citation_velocity": round(p.citation_velocity, 3),
                "citation_score": round(p.citation_score, 2),
                "author_h_index": p.author_h_index,
                "author_score": round(p.author_score, 2),
                "embedding_similarity": (
                    round(p.embedding_similarity, 2)
                    if p.embedding_similarity is not None
                    else ""
                ),
                "github_stars": p.github_stars,
                "github_score": round(p.github_score, 2),
                "has_code": p.has_code,
                "is_official_repo": p.is_official_repo,
                "keyword_match_count": p.keyword_match_count,
                "keyword_score": round(p.keyword_score, 2),
                "matched_keywords": "; ".join(p.matched_keywords),
                "categories": "; ".join(p.categories),
                "published_date": p.published_date.isoformat(),
                "url": p.url,
                "pdf_url": p.pdf_url or "",
                "github_url": p.github_url or "",
                "arxiv_id": p.arxiv_id or "",
                "source": p.source,
                "abstract": p.abstract,
                "uid": p.uid,
                "doi": p.doi or "",
            }
            writer.writerow(neutralize_row(row))
        atomic_write_text(path, buffer.getvalue(), encoding=encoding)
        logger.info("csv: wrote %d rows to %s", len(papers), path)
        return str(path)

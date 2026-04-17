"""CSV exporter — one row per paper, dated filename."""

from __future__ import annotations

import csv
from datetime import date
from pathlib import Path

from ..models import Paper
from ..utils.logger import get_logger
from .base import AbstractExporter

logger = get_logger(__name__)

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
        path = out_dir / f"papers_{date.today().isoformat()}.csv"

        with path.open("w", newline="", encoding=encoding) as f:
            writer = csv.DictWriter(f, fieldnames=COLUMNS)
            writer.writeheader()
            for rank, p in enumerate(papers, start=1):
                row = {
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
                }
                writer.writerow(row)
        logger.info("csv: wrote %d rows to %s", len(papers), path)
        return str(path)

"""Paper data model shared across all pipeline stages.

This is the core entity that flows through the pipeline. Sources produce
Papers, Signals enrich them with quality metrics, and Exporters serialize
them.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import date, datetime
from typing import Any


@dataclass
class Paper:
    # ---- Required (from source) ----
    title: str
    authors: list[str]
    abstract: str
    url: str
    published_date: date
    source: str  # "arxiv" | "s2" | "openalex"

    # ---- Optional metadata ----
    arxiv_id: str | None = None
    doi: str | None = None
    pdf_url: str | None = None
    categories: list[str] = field(default_factory=list)
    comment: str | None = None  # arXiv comment field (e.g. "Accepted at ICLR 2026")

    # ---- Enriched by Signals ----
    venue: str | None = None
    venue_tier: int = 0  # 1..4 (1=top), 0=unreviewed
    venue_score: float = 0.0
    github_url: str | None = None
    github_stars: int = 0
    github_score: float = 0.0
    has_code: bool = False
    is_official_repo: bool = False
    citation_count: int = 0
    influential_citations: int = 0
    citation_velocity: float = 0.0
    citation_score: float = 0.0
    first_author_id: str | None = None
    author_h_index: int = 0
    author_score: float = 0.0
    keyword_match_count: int = 0
    keyword_score: float = 0.0

    # ---- Final ranking ----
    total_score: float = 0.0
    matched_keywords: list[str] = field(default_factory=list)

    # ---- Identity ----
    @property
    def uid(self) -> str:
        """Stable unique identifier for dedup / seen_ids tracking."""
        if self.arxiv_id:
            return f"arxiv:{self.arxiv_id}"
        if self.doi:
            return f"doi:{self.doi}"
        return f"url:{self.url}"

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a JSON/CSV-friendly dict (dates as ISO strings)."""
        d = asdict(self)
        d["published_date"] = self.published_date.isoformat()
        d["uid"] = self.uid
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Paper":
        """Inverse of to_dict() for reading cached papers."""
        d = dict(d)
        d.pop("uid", None)
        pub = d["published_date"]
        if isinstance(pub, str):
            d["published_date"] = datetime.fromisoformat(pub).date()
        return cls(**d)

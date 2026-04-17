"""Semantic Scholar source.

Uses the /paper/search endpoint per keyword and filters by publication
date window client-side. S2 ranks by relevance — we take the first N
matches then filter to since_date.

Auth: optional x-api-key header (higher rate limits).
API: https://api.semanticscholar.org/graph/v1
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from ..models import Paper
from ..utils.http import request_with_retry
from ..utils.logger import get_logger
from ..utils.rate_limiter import RateLimiter
from .base import AbstractSource

logger = get_logger(__name__)

S2_BASE = "https://api.semanticscholar.org/graph/v1"
SEARCH_FIELDS = (
    "paperId,title,abstract,authors.name,authors.authorId,"
    "year,publicationDate,externalIds,openAccessPdf,venue,url"
)


class S2Source(AbstractSource):
    name = "s2"

    def __init__(self, config: dict, api_key: str | None = None) -> None:
        super().__init__(config)
        self._api_key = api_key
        # Without key: polite ~1req/sec. With key: up to 10 req/sec.
        delay = float(self.config.get("delay_seconds", 1.0))
        self._limiter = RateLimiter(delay)

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self._api_key:
            headers["x-api-key"] = self._api_key
        return headers

    def fetch(
        self,
        keywords: list[str],
        categories: list[str],
        since_date: date,
        max_results: int,
    ) -> list[Paper]:
        # S2 ignores arXiv-style categories; we keep the param for interface
        # symmetry. Category filtering happens in Stage 1.
        papers: list[Paper] = []
        for kw in keywords:
            self._limiter.wait()
            batch = self._search(kw, since_date, max_results)
            logger.info("s2: keyword '%s' returned %d papers", kw, len(batch))
            papers.extend(batch)
        logger.info("s2: collected %d papers (pre-dedup)", len(papers))
        return papers

    # ---- helpers ----

    def _search(
        self, keyword: str, since_date: date, max_results: int
    ) -> list[Paper]:
        params = {
            "query": keyword,
            "limit": min(max_results, 100),
            "fields": SEARCH_FIELDS,
        }
        resp = request_with_retry(
            "GET", f"{S2_BASE}/paper/search", params=params, headers=self._headers()
        )
        if resp is None or resp.status_code != 200:
            logger.warning(
                "s2: search failed for '%s' (status=%s)",
                keyword,
                getattr(resp, "status_code", None),
            )
            return []
        data = resp.json() or {}
        results: list[dict[str, Any]] = data.get("data") or []

        papers: list[Paper] = []
        for item in results:
            paper = self._to_paper(item, keyword, since_date)
            if paper is not None:
                papers.append(paper)
        return papers

    def _to_paper(
        self, item: dict[str, Any], matched_kw: str, since_date: date
    ) -> Paper | None:
        pub = self._parse_pub_date(item)
        if pub is None or pub < since_date:
            return None

        title = (item.get("title") or "").strip()
        if not title:
            return None

        external = item.get("externalIds") or {}
        arxiv_id = external.get("ArXiv")
        doi = external.get("DOI")

        open_access = item.get("openAccessPdf") or {}
        pdf_url = open_access.get("url") if isinstance(open_access, dict) else None

        authors_raw = item.get("authors") or []
        authors = [a.get("name") for a in authors_raw if a and a.get("name")]

        url = item.get("url") or f"https://www.semanticscholar.org/paper/{item.get('paperId')}"

        return Paper(
            title=title,
            authors=authors,
            abstract=(item.get("abstract") or "").strip(),
            url=url,
            published_date=pub,
            source=self.name,
            arxiv_id=arxiv_id,
            doi=doi,
            pdf_url=pdf_url,
            categories=[],  # S2 does not expose arXiv categories
            comment=None,
            venue=item.get("venue") or None,
            matched_keywords=[matched_kw],
        )

    @staticmethod
    def _parse_pub_date(item: dict[str, Any]) -> date | None:
        pub_str = item.get("publicationDate")
        if pub_str:
            try:
                return datetime.strptime(pub_str, "%Y-%m-%d").date()
            except ValueError:
                pass
        year = item.get("year")
        if year:
            try:
                return date(int(year), 1, 1)
            except (TypeError, ValueError):
                return None
        return None

"""OpenAlex source (third Source plugin).

Uses the OpenAlex `/works` endpoint. Abstracts arrive as an inverted
index (token -> [positions]); we rehydrate them back to plain text.

Auth: no API key needed. Supplying a contact email puts requests into
the "polite pool" which is more reliable under load.
API: https://api.openalex.org
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

OPENALEX_BASE = "https://api.openalex.org"
_DOI_PREFIX = "https://doi.org/"


class OpenAlexSource(AbstractSource):
    name = "openalex"

    def __init__(self, config: dict, email: str | None = None) -> None:
        super().__init__(config)
        delay = float(self.config.get("delay_seconds", 1.0))
        self._limiter = RateLimiter(delay)
        self._email = email

    def fetch(
        self,
        keywords: list[str],
        categories: list[str],
        since_date: date,
        max_results: int,
    ) -> list[Paper]:
        papers: list[Paper] = []
        for kw in keywords:
            self._limiter.wait()
            batch = self._search(kw, since_date, max_results)
            logger.info("openalex: keyword '%s' returned %d papers", kw, len(batch))
            papers.extend(batch)
        logger.info("openalex: collected %d papers (pre-dedup)", len(papers))
        return papers

    # ---- helpers ----

    def _search(
        self, keyword: str, since_date: date, max_results: int
    ) -> list[Paper]:
        params: dict[str, Any] = {
            "search": keyword,
            "per-page": min(max_results, 200),
            "filter": f"from_publication_date:{since_date.isoformat()}",
            "sort": "publication_date:desc",
        }
        if self._email:
            params["mailto"] = self._email

        resp = request_with_retry(
            "GET", f"{OPENALEX_BASE}/works", params=params
        )
        if resp is None or resp.status_code != 200:
            logger.warning(
                "openalex: search failed for '%s' (status=%s)",
                keyword,
                getattr(resp, "status_code", None),
            )
            return []
        data = resp.json() or {}
        results = data.get("results") or []

        papers: list[Paper] = []
        for work in results:
            paper = self._to_paper(work, keyword, since_date)
            if paper is not None:
                papers.append(paper)
        return papers

    def _to_paper(
        self, work: dict[str, Any], matched_kw: str, since_date: date
    ) -> Paper | None:
        pub = self._parse_pub_date(work)
        if pub is None or pub < since_date:
            return None

        title = (work.get("title") or work.get("display_name") or "").strip()
        if not title:
            return None

        abstract = self._rehydrate_abstract(work.get("abstract_inverted_index"))

        # DOI normalization: strip the `https://doi.org/` prefix.
        doi_raw = work.get("doi") or (work.get("ids") or {}).get("doi")
        doi = doi_raw[len(_DOI_PREFIX):] if isinstance(doi_raw, str) and doi_raw.startswith(_DOI_PREFIX) else doi_raw

        authorships = work.get("authorships") or []
        authors = [
            a.get("author", {}).get("display_name")
            for a in authorships
            if a.get("author", {}).get("display_name")
        ]

        # OpenAlex deprecated `host_venue` in 2023 in favor of
        # `primary_location.source.display_name`. Try the new field first,
        # then fall back to the legacy one for older fixtures.
        primary = work.get("primary_location") or {}
        primary_source = primary.get("source") or {}
        venue = primary_source.get("display_name")
        if not venue:
            venue = (work.get("host_venue") or {}).get("display_name")

        open_access = work.get("open_access") or {}
        pdf_url = open_access.get("oa_url") if isinstance(open_access, dict) else None

        url = work.get("id") or ""

        return Paper(
            title=title,
            authors=authors,
            abstract=abstract,
            url=url,
            published_date=pub,
            source=self.name,
            doi=doi,
            pdf_url=pdf_url,
            categories=[],
            comment=None,
            venue=venue or None,
            matched_keywords=[matched_kw],
        )

    @staticmethod
    def _parse_pub_date(work: dict[str, Any]) -> date | None:
        pub_str = work.get("publication_date")
        if pub_str:
            try:
                return datetime.strptime(pub_str, "%Y-%m-%d").date()
            except ValueError:
                pass
        year = work.get("publication_year")
        if year:
            try:
                return date(int(year), 1, 1)
            except (TypeError, ValueError):
                return None
        return None

    @staticmethod
    def _rehydrate_abstract(inverted: dict[str, list[int]] | None) -> str:
        """OpenAlex stores abstracts as a token -> positions mapping."""
        if not inverted:
            return ""
        positions: list[tuple[int, str]] = []
        for token, indices in inverted.items():
            for idx in indices:
                positions.append((idx, token))
        positions.sort(key=lambda p: p[0])
        return " ".join(tok for _, tok in positions)

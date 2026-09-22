"""arXiv source: fetches recent papers per (keyword × category) combination.

Uses the official `arxiv` package which wraps the arXiv API. Requests
are throttled by the package's built-in client; we additionally apply
our own RateLimiter between batches to stay polite.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import arxiv

from ..models import Paper
from ..utils.logger import get_logger
from ..utils.rate_limiter import RateLimiter
from .base import AbstractSource

logger = get_logger(__name__)


class ArxivSource(AbstractSource):
    name = "arxiv"

    def __init__(self, config: dict) -> None:
        super().__init__(config)
        delay = float(self.config.get("delay_seconds", 3))
        self._limiter = RateLimiter(delay)
        # Reuse a single client; arxiv package handles internal pacing too.
        self._client = arxiv.Client(
            page_size=100,
            delay_seconds=delay,
            num_retries=3,
        )

    def fetch(
        self,
        keywords: list[str],
        categories: list[str],
        since_date: date,
        max_results: int,
    ) -> list[Paper]:
        papers: list[Paper] = []
        cat_clause = self._build_category_clause(categories)
        failures: list[str] = []

        for kw in keywords:
            self._limiter.wait()
            query = self._build_query(kw, cat_clause)
            logger.info("arxiv query: %s (max=%d)", query, max_results)

            search = arxiv.Search(
                query=query,
                max_results=max_results,
                sort_by=arxiv.SortCriterion.SubmittedDate,
                sort_order=arxiv.SortOrder.Descending,
            )

            try:
                for result in self._client.results(search):
                    pub = self._to_date(result.published)
                    if pub < since_date:
                        # Results are sorted DESC; older ones won't qualify.
                        break
                    papers.append(self._to_paper(result, kw))
            except Exception as e:
                logger.warning("arxiv fetch failed for keyword '%s': %s", kw, e)
                failures.append(kw)
                continue

        if keywords and len(failures) == len(keywords):
            # Every keyword failed: this is an outage, not "genuinely 0 new
            # papers today". Raise so Stage 0's existing per-source failure
            # path (stage_collect.py) records sources_status["arxiv"]["ok"]
            # = False, rather than a misleadingly-successful empty result
            # (same masking pattern as #387's S2 fix).
            #
            # A partial failure (at least one keyword succeeded) is NOT
            # raised — `papers` is returned as-is with those real results
            # kept, and the per-keyword warning above already logs the
            # failure. Note the one asymmetry this implies: if a keyword's
            # generator yields some papers before failing mid-stream, those
            # already-appended papers survive ONLY when at least one other
            # keyword succeeds outright — if every keyword fails this way,
            # the raise below still discards them along with everything
            # else, since there is no way to both signal "outage" and
            # return partial data through this interface's single return
            # value / exception contract. Confirmed outage visibility is
            # judged more valuable than an unreliable partial scrap in that
            # narrow, already-degenerate scenario.
            raise RuntimeError(f"arxiv fetch failed for all {len(keywords)} keyword(s)")

        logger.info("arxiv: collected %d papers (pre-dedup)", len(papers))
        return papers

    # ---- helpers ----

    @staticmethod
    def _build_category_clause(categories: list[str]) -> str:
        if not categories:
            return ""
        return " OR ".join(f"cat:{c}" for c in categories)

    @staticmethod
    def _build_query(keyword: str, cat_clause: str) -> str:
        kw = keyword.strip()
        # Quote multi-word phrases.
        kw_clause = f'all:"{kw}"' if " " in kw else f"all:{kw}"
        if cat_clause:
            return f"({kw_clause}) AND ({cat_clause})"
        return kw_clause

    @staticmethod
    def _to_date(dt: datetime) -> date:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).date()

    def _to_paper(self, result: arxiv.Result, matched_kw: str) -> Paper:
        arxiv_id = result.get_short_id().split("v")[0]  # strip version suffix
        return Paper(
            title=result.title.strip(),
            authors=[a.name for a in result.authors],
            abstract=(result.summary or "").strip(),
            url=result.entry_id,
            published_date=self._to_date(result.published),
            source=self.name,
            arxiv_id=arxiv_id,
            doi=result.doi,
            pdf_url=result.pdf_url,
            categories=list(result.categories or []),
            comment=getattr(result, "comment", None),
            matched_keywords=[matched_kw],
        )

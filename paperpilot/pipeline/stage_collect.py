"""Stage 0: parallel collection from enabled sources."""

from __future__ import annotations

import asyncio
from datetime import date, timedelta
from typing import Any

from ..models import Paper
from ..sources import AbstractSource
from ..utils.dedup import dedup_papers
from ..utils.logger import get_logger

logger = get_logger(__name__)


async def collect(
    sources: list[AbstractSource],
    keywords: list[str],
    categories: list[str],
    days_back: int,
    max_results_per_keyword: int,
) -> tuple[list[Paper], date, dict[str, dict[str, Any]]]:
    """Returns (deduped_papers, since_date, sources_status).

    sources_status maps source name to {"ok": bool, "count": int, "error": str|None}
    for run_history.
    """
    since = date.today() - timedelta(days=days_back)
    enabled = [s for s in sources if s.enabled]
    status: dict[str, dict[str, Any]] = {}
    if not enabled:
        logger.warning("stage0: no enabled sources")
        return [], since, status

    tasks = [
        s.afetch(keywords, categories, since, max_results_per_keyword)
        for s in enabled
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    papers: list[Paper] = []
    for src, result in zip(enabled, results, strict=False):
        # asyncio.gather(return_exceptions=True) may return BaseException
        # subclasses too (e.g. CancelledError); handle the full hierarchy.
        if isinstance(result, BaseException):
            logger.warning("stage0: source '%s' failed: %s", src.name, result)
            status[src.name] = {"ok": False, "count": 0, "error": str(result)}
            continue
        logger.info("stage0: source '%s' returned %d papers", src.name, len(result))
        status[src.name] = {"ok": True, "count": len(result), "error": None}
        papers.extend(result)

    deduped = dedup_papers(papers)
    logger.info("stage0: %d papers after dedup (from %d)", len(deduped), len(papers))
    return deduped, since, status

"""Stage 2: enrich with signals, compute total_score, keep top N.

total_score = sum( signal_score * weight ) for each enabled signal.
All signal scores are normalized to [0, 100].
"""

from __future__ import annotations

from ..models import Paper
from ..signals import AbstractSignal
from ..utils.logger import get_logger

logger = get_logger(__name__)


def metric_score(
    papers: list[Paper],
    signals: list[AbstractSignal],
    weights: dict[str, float],
    top_n: int,
) -> list[Paper]:
    if not papers:
        return []

    for sig in signals:
        if not sig.enabled:
            continue
        try:
            papers = sig.enrich_batch(papers)
            logger.info("stage2: signal '%s' enriched %d papers", sig.name, len(papers))
        except Exception as e:
            logger.warning("stage2: signal '%s' failed: %s", sig.name, e)

    for p in papers:
        p.total_score = (
            p.venue_score * float(weights.get("venue", 0.0))
            + p.github_score * float(weights.get("github", 0.0))
            + p.citation_score * float(weights.get("citation", 0.0))
            + p.author_score * float(weights.get("author", 0.0))
            + p.keyword_score * float(weights.get("keyword", 0.0))
            + p.follow_score * float(weights.get("follow", 0.0))
        )

    papers.sort(key=lambda p: p.total_score, reverse=True)
    top = papers[:top_n] if top_n > 0 else papers
    logger.info("stage2: kept top %d papers", len(top))
    return top

"""Stage 2: enrich with signals, compute total_score, keep top N.

total_score = sum( signal_score * weight ) for each enabled signal.
All signal scores are normalized to [0, 100].

Signal degradation never changes the return value (rule §4): it is reported
through each signal's `run_failures` channel, which PipelineRunner reads after
this stage returns.
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
    require_follow_match: bool = False,
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
            # The crash is itself a degraded run: record it on the signal's
            # per-run channel so the runner can surface it in run_history
            # without Stage 2 gaining a second return type (rule §4).
            sig.run_failures.append(f"enrich_batch raised {type(e).__name__}: {e}")

    for p in papers:
        p.total_score = (
            p.venue_score * float(weights.get("venue", 0.0))
            + p.github_score * float(weights.get("github", 0.0))
            + p.citation_score * float(weights.get("citation", 0.0))
            + p.author_score * float(weights.get("author", 0.0))
            + p.keyword_score * float(weights.get("keyword", 0.0))
            + p.follow_score * float(weights.get("follow", 0.0))
        )

    if require_follow_match:
        before = len(papers)
        papers = [p for p in papers if p.follow_score > 0]
        logger.info(
            "stage2: require_follow_match kept %d/%d papers", len(papers), before
        )

    papers.sort(key=lambda p: p.total_score, reverse=True)
    top = papers[:top_n] if top_n > 0 else papers
    logger.info("stage2: kept top %d papers", len(top))
    return top

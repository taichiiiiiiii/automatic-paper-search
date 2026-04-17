"""Stage 4: LLM rerank + Japanese summary (design doc §4.5).

Input: top-N papers from Stage 2 (or Stage 3 once Embedding lands).
Steps:
    1. Split into chunks of provider.batch_size
    2. Provider evaluates each chunk (returns structured PaperEvaluation)
    3. Attach llm_* fields to each paper
    4. Sort by (llm_relevance desc, total_score desc); take top_n
    5. Papers that fail evaluation keep llm_relevance=None but are
       still retained — ranked below successfully-evaluated ones.

If the provider is disabled or returns nothing, this stage is a no-op
and papers pass through unchanged (Fail-Safe).
"""

from __future__ import annotations

from ..llm.base import AbstractLLMProvider, PaperEvaluation
from ..models import Paper
from ..utils.logger import get_logger

logger = get_logger(__name__)


def llm_rerank(
    papers: list[Paper],
    provider: AbstractLLMProvider | None,
    profile: str,
    top_n: int,
) -> list[Paper]:
    if not papers:
        return []
    if provider is None or not provider.enabled:
        logger.info("stage4: LLM provider disabled — pass-through")
        return papers[:top_n] if top_n > 0 else papers

    batch_size = max(1, provider.batch_size)
    for chunk_start in range(0, len(papers), batch_size):
        chunk = papers[chunk_start : chunk_start + batch_size]
        try:
            results = provider.evaluate_batch(chunk, profile)
        except Exception as e:
            logger.warning("stage4: provider '%s' raised: %s", provider.name, e)
            results = [None] * len(chunk)
        for paper, evaluation in zip(chunk, results):
            _apply(paper, evaluation)

    # Sort: evaluated (relevance high->low) first, then total_score
    def _key(p: Paper) -> tuple:
        has_rel = p.llm_relevance is not None
        rel = p.llm_relevance if has_rel else 0
        return (has_rel, rel, p.total_score)

    papers.sort(key=_key, reverse=True)
    out = papers[:top_n] if top_n > 0 else papers
    logger.info("stage4: kept top %d papers", len(out))
    return out


def _apply(paper: Paper, evaluation: PaperEvaluation | None) -> None:
    if evaluation is None:
        return
    paper.llm_relevance = evaluation.relevance
    paper.llm_summary_ja = evaluation.summary_ja or None
    paper.llm_reason = evaluation.reason or None
    paper.llm_tags = evaluation.tags or []

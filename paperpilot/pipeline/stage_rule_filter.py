"""Stage 1: pure rule-based filtering (no scoring).

Filters applied (design doc §4.2, Table 10):
  1. category — keep only papers with at least one configured category
  2. date     — keep only papers with published_date >= since_date
  3. exclude  — drop if any exclude_word appears in title/abstract/comment
  4. seen_ids — drop papers already seen in prior runs (incremental mode)
"""

from __future__ import annotations

from datetime import date

from ..models import Paper
from ..utils.dedup import filter_unseen
from ..utils.logger import get_logger

logger = get_logger(__name__)


def rule_filter(
    papers: list[Paper],
    exclude_words: list[str],
    categories: list[str],
    since_date: date | None = None,
    seen_ids: dict[str, str] | None = None,
) -> list[Paper]:
    excludes_lower = [w.lower().strip() for w in exclude_words if w.strip()]
    cat_set = {c.strip() for c in categories if c.strip()}

    def passes(p: Paper) -> bool:
        # Category filter: papers whose source doesn't expose categories
        # (S2, OpenAlex) pass through; only reject when the paper has
        # categories and none of them match the configured set.
        if cat_set and p.categories and not (set(p.categories) & cat_set):
            return False
        if since_date is not None and p.published_date < since_date:
            return False
        text = f"{p.title}\n{p.abstract}\n{p.comment or ''}".lower()
        return not any(w in text for w in excludes_lower)

    kept = [p for p in papers if passes(p)]
    logger.info(
        "stage1: %d papers after rule filter (from %d)", len(kept), len(papers)
    )

    if seen_ids:
        before = len(kept)
        kept = filter_unseen(kept, seen_ids)
        logger.info("stage1: %d papers after seen-id filter (was %d)", len(kept), before)

    return kept

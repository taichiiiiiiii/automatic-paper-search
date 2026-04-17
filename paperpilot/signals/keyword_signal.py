"""Keyword match signal — boosts papers that hit configured keywords.

Normalization (design doc §4.3, Table 12):
    score = min(match_count / 3, 1) * 100

where `match_count` is the number of distinct keywords that appear in
either the title or abstract (a keyword found in both counts once).

Matching is case-insensitive and hyphen-insensitive — "retrieval
augmented" matches "Retrieval-Augmented" (common in ML titles).
"""

from __future__ import annotations

import re

from ..models import Paper
from .base import AbstractSignal

_NORMALIZE_RE = re.compile(r"[-_/]+")
_SATURATION = 3  # match_count >= 3 -> 100


def _normalize(text: str) -> str:
    """Lowercase + collapse hyphens/underscores/slashes to spaces."""
    return _NORMALIZE_RE.sub(" ", text.lower())


class KeywordSignal(AbstractSignal):
    name = "keyword"

    def __init__(self, config: dict, keywords: list[str] | None = None) -> None:
        super().__init__(config)
        self.keywords = [_normalize(k.strip()) for k in (keywords or []) if k.strip()]

    def enrich_one(self, paper: Paper) -> Paper:
        if not self.keywords:
            return paper

        haystack = _normalize(f"{paper.title}\n{paper.abstract}")
        matched: set[str] = set(paper.matched_keywords)
        match_count = 0
        for kw in self.keywords:
            if kw in haystack:
                match_count += 1
                matched.add(kw)

        paper.keyword_match_count = match_count
        paper.keyword_score = float(min(match_count / _SATURATION, 1.0) * 100.0)
        paper.matched_keywords = sorted(matched)
        return paper

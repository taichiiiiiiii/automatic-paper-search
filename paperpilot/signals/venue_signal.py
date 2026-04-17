"""Venue signal: detects conference acceptance from arXiv comment field.

Tier system (from design doc §5.3.1):
  Tier 1 (NeurIPS/ICML/ICLR)         -> 100 pts
  Tier 2 (AAAI/CVPR/ACL/EMNLP)       ->  80 pts
  Tier 3 (AISTATS/NAACL/ECCV/ICCV)   ->  60 pts
  Workshop                            ->  30 pts (tier=4)
  Unreviewed                          ->   0 pts (tier=0)

MVP detection uses regex on the arXiv `comment` field only. Future
versions can layer OpenReview / Semantic Scholar lookups on top.
"""

from __future__ import annotations

import re

from ..models import Paper
from .base import AbstractSignal

TIER_1 = {"NEURIPS", "NIPS", "ICML", "ICLR"}
TIER_2 = {"AAAI", "CVPR", "ACL", "EMNLP"}
TIER_3 = {"AISTATS", "NAACL", "ECCV", "ICCV", "IJCAI", "KDD", "WWW"}

_VENUE_PATTERN = re.compile(
    r"\b(?:accepted (?:at|to|by)|to appear (?:at|in)|published (?:at|in))\s+"
    r"(?:the\s+)?([A-Za-z]+)",
    re.IGNORECASE,
)
_WORKSHOP_PATTERN = re.compile(r"\bworkshop\b", re.IGNORECASE)


class VenueSignal(AbstractSignal):
    name = "venue"

    def enrich_one(self, paper: Paper) -> Paper:
        comment = (paper.comment or "").strip()
        if not comment:
            return paper

        venue, tier, score = self._classify(comment)
        if venue:
            paper.venue = venue
            paper.venue_tier = tier
            paper.venue_score = float(score)
        return paper

    @staticmethod
    def _classify(text: str) -> tuple[str | None, int, int]:
        # Workshop check first (often co-occurs with a top venue name).
        is_workshop = bool(_WORKSHOP_PATTERN.search(text))

        match = _VENUE_PATTERN.search(text)
        venue_name = None
        if match:
            candidate = match.group(1).upper()
            for tier_set, tier, score in (
                (TIER_1, 1, 100),
                (TIER_2, 2, 80),
                (TIER_3, 3, 60),
            ):
                if candidate in tier_set:
                    venue_name = candidate
                    if is_workshop:
                        return f"{candidate} Workshop", 4, 30
                    return candidate, tier, score

        # Workshop with no recognized top venue still gets workshop credit.
        if is_workshop:
            return "Workshop", 4, 30

        return venue_name, 0, 0

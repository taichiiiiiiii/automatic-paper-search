"""Follow signal — highlight papers by specific authors or organizations.

Day-1 papers have no citations, no GitHub stars, and usually no venue
stamp. The one signal that IS available immediately is "who wrote this
paper". This signal lets users curate a watchlist so a LeCun / Hinton /
OpenAI paper ranks #1 the moment it appears on arXiv — before anyone
else has noticed.

Scoring (0..100 per AbstractSignal contract):
  - Any followed author in paper.authors        -> 100 (reason: followed_author)
  - No author match but followed org in affiliations -> 50 (reason: followed_org)
  - Otherwise                                   -> 0

Matching:
  - Author names: whitespace-normalized, case-insensitive exact match
  - Organizations: case-insensitive substring match (affiliations often
    include extras like "Meta AI Research, NY", so we accept "Meta" as
    a substring)
"""

from __future__ import annotations

import re

from ..models import Paper
from .base import AbstractSignal

_WHITESPACE_RE = re.compile(r"\s+")


def _normalize_name(name: str) -> str:
    """Lowercase + collapse internal whitespace. For exact-name comparison."""
    return _WHITESPACE_RE.sub(" ", name.strip().lower())


class FollowSignal(AbstractSignal):
    name = "follow"

    def __init__(
        self,
        config: dict,
        follow_authors: list[str] | None = None,
        follow_orgs: list[str] | None = None,
    ) -> None:
        super().__init__(config)
        self._author_set = {_normalize_name(a) for a in (follow_authors or []) if a}
        # Orgs stay lowercase but preserve internal spaces for substring check.
        self._orgs_lower = [o.strip().lower() for o in (follow_orgs or []) if o.strip()]

    def enrich_one(self, paper: Paper) -> Paper:
        if not self._author_set and not self._orgs_lower:
            return paper  # empty watchlist — nothing to do

        # Priority 1: author match -> 100
        if self._author_set:
            for author in paper.authors:
                if _normalize_name(author) in self._author_set:
                    paper.follow_score = 100.0
                    paper.follow_reason = "followed_author"
                    return paper

        # Priority 2: org substring match -> 50
        if self._orgs_lower and paper.affiliations:
            for aff in paper.affiliations:
                aff_lower = aff.lower()
                for org in self._orgs_lower:
                    if org in aff_lower:
                        paper.follow_score = 50.0
                        paper.follow_reason = "followed_org"
                        return paper

        return paper

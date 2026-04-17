"""Quality-signal plugin contract.

All signals output values normalized to [0, 100]. The pipeline applies
configured weights to combine them into total_score.

Batch processing is the default — signals with batch APIs override
enrich_batch(); simple signals only need enrich_one().
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from ..models import Paper


class AbstractSignal(ABC):
    name: str = "abstract"

    def __init__(self, config: dict) -> None:
        self.config = config or {}
        self.enabled: bool = bool(self.config.get("enabled", True))

    def enrich_batch(self, papers: list[Paper]) -> list[Paper]:
        """Default: enrich one-by-one. Override for batch APIs."""
        return [self.enrich_one(p) for p in papers]

    @abstractmethod
    def enrich_one(self, paper: Paper) -> Paper:
        """Enrich a single paper. Must set the relevant *_score field."""

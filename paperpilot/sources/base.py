"""Source plugin contract.

A Source fetches Paper objects from one external API. New sources can
be added without modifying the pipeline by subclassing this and
registering the class in PipelineRunner.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date

from ..models import Paper


class AbstractSource(ABC):
    name: str = "abstract"

    def __init__(self, config: dict) -> None:
        self.config = config or {}
        self.enabled: bool = bool(self.config.get("enabled", True))

    @abstractmethod
    def fetch(
        self,
        keywords: list[str],
        categories: list[str],
        since_date: date,
        max_results: int,
    ) -> list[Paper]:
        """Synchronous fetch. Async variant provided as default wrapper."""

    async def afetch(
        self,
        keywords: list[str],
        categories: list[str],
        since_date: date,
        max_results: int,
    ) -> list[Paper]:
        """Default async wrapper. Override for true async I/O."""
        import asyncio

        return await asyncio.to_thread(
            self.fetch, keywords, categories, since_date, max_results
        )

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
        # The completeness report of the LAST fetch(), declared here so a new
        # source cannot omit it. PipelineRunner reads both lists after every
        # Stage 0, and a source that never sets them looks exactly like a source
        # that answered every keyword completely — the one failure mode this
        # channel exists to prevent.
        #
        # CONTRACT: `fetch()` resets both to empty before it gathers, and
        # publishes this fetch's own answer before it returns OR raises (so an
        # attribute read after a failed fetch describes this run, never the last
        # successful one). A stale entry is not cosmetic: it makes the NEXT run
        # report a keyword it never touched, and a degraded entry is a `source:`
        # error that collector.py's --fail-on-errors refuses.
        #
        # Keywords whose fetch filled the whole requested window, so matching
        # papers beyond it were never fetched. Real papers still shipped, so
        # this is a warning the run records, never an error.
        self.truncated_keywords: list[str] = []
        # Keywords whose fetch is known INCOMPLETE — the request failed, the
        # body could not be read, or part of it could not. Each entry is
        # `(keyword, reason)` so the loss names what was lost and why; those
        # keywords are missing papers while the surviving keywords still ship,
        # which is why Stage 0 honestly records ok=True and only this list makes
        # the gap visible.
        self.degraded_keywords: list[tuple[str, str]] = []

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

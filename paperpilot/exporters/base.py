"""Exporter plugin contract."""

from __future__ import annotations

from abc import ABC, abstractmethod

from ..models import Paper


class AbstractExporter(ABC):
    name: str = "abstract"

    def __init__(self, config: dict) -> None:
        self.config = config or {}
        self.enabled: bool = bool(self.config.get("enabled", True))

    @abstractmethod
    def export(self, papers: list[Paper]) -> str | None:
        """Persist papers. Returns the output path or None."""

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
        """Persist papers. Returns the output path/name, or None for a no-op
        (disabled, unconfigured, or nothing to export — never a failure).

        A real failure (network error, non-2xx response, SMTP error, etc.)
        must be raised, not swallowed into a None return: PipelineRunner
        catches it per-exporter and records it in run_history.errors so it
        stays visible while the pipeline still continues (fail-safe)."""

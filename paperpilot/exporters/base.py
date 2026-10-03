"""Exporter plugin contract."""

from __future__ import annotations

from abc import ABC, abstractmethod

from ..models import Paper


class AbstractExporter(ABC):
    name: str = "abstract"

    #: Papers the most recent export() call actually handed to the user, or
    #: None when the exporter always consumes the whole list. Notification
    #: exporters cap at max_items, so they set it and PipelineRunner can warn
    #: about a truncated delivery without duplicating that slicing here.
    #: None (not 0) is what keeps an un-capped exporter out of the tally.
    last_delivered: int | None = None

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
        stays visible while the pipeline still continues (fail-safe).

        Exporters that deliver a subset must set `last_delivered` to the count
        actually sent once the delivery succeeded, so a quiet
        "3 papers delivered out of 30" cannot be mistaken for a full run."""

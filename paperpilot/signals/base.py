"""Quality-signal plugin contract.

All signals output values normalized to [0, 100]. The pipeline applies
configured weights to combine them into total_score.

Batch processing is the default — signals with batch APIs override
enrich_batch(); simple signals only need enrich_one().

Every signal also carries a per-run failure channel (`run_failures`). A score
of 0.0 is only meaningful if the lookups that would have produced it actually
answered, so the signal records the batches/lookups it lost instead of letting
an outage look identical to a quiet day. `PipelineRunner` reads the channel
after Stage 2 and copies it into `result.errors` and `run_history` — Stage
input/output types stay untouched (CLAUDE.md absolute rule §4).
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from ..models import Paper


class AbstractSignal(ABC):
    name: str = "abstract"

    def __init__(self, config: dict) -> None:
        self.config = config or {}
        self.enabled: bool = bool(self.config.get("enabled", True))
        # One short summary per failed batch/lookup of the most recent run.
        # Status codes and counts only — the text lands in run_history.jsonl.
        self.run_failures: list[str] = []

    def reset_run_failures(self) -> None:
        """Open a fresh failure channel for a new run.

        Called at the start of every `enrich_batch()` so a run never reports
        the previous run's losses, and again by `PipelineRunner` before Stage 2
        because Stage 2 skips the signals entirely when Stage 1 kept no papers
        (no `enrich_batch()` call means no reset of its own).
        """
        self.run_failures = []

    def enrich_batch(self, papers: list[Paper]) -> list[Paper]:
        """Default: enrich one-by-one. Override for batch APIs."""
        self.reset_run_failures()
        return [self.enrich_one(p) for p in papers]

    @abstractmethod
    def enrich_one(self, paper: Paper) -> Paper:
        """Enrich a single paper. Must set the relevant *_score field."""

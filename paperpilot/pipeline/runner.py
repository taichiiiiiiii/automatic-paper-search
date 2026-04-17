"""PipelineRunner — orchestrates Stage 0..2 and exporters.

This MVP runs:
    Stage 0 (collect, async)
      -> Stage 1 (rule filter + seen-id incremental)
      -> Stage 2 (signal enrichment + scoring + top-N)
      -> Exporters
      -> Persist seen IDs

Stages 3 (Embedding) and 4 (LLM rank) are intentionally not implemented
in the MVP; the architecture allows them to be slotted in here without
touching the existing stages.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from ..exporters import (
    AbstractExporter,
    CSVExporter,
    JSONExporter,
    SlackExporter,
)
from ..signals import (
    AbstractSignal,
    AuthorSignal,
    CitationSignal,
    GitHubSignal,
    KeywordSignal,
    VenueSignal,
)
from ..sources import AbstractSource, ArxivSource, S2Source
from ..utils.dedup import load_seen_ids, mark_seen, purge_seen_ids, save_seen_ids
from ..utils.logger import get_logger
from .stage_collect import collect
from .stage_metric_score import metric_score
from .stage_rule_filter import rule_filter

logger = get_logger(__name__)


@dataclass
class PipelineResult:
    output_count: int
    output_files: list[str]
    stage_counts: dict[str, int]
    duration_seconds: float
    sources_status: dict[str, dict[str, Any]] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)


class PipelineRunner:
    def __init__(self, config: dict) -> None:
        self.config = config
        self.sources = self._build_sources()
        self.signals = self._build_signals()
        self.exporters = self._build_exporters()

    # ---- builders ----

    def _build_sources(self) -> list[AbstractSource]:
        srcs_cfg = self.config.get("sources", {})
        env = self.config.get("env", {})
        sources: list[AbstractSource] = []
        if "arxiv" in srcs_cfg:
            sources.append(ArxivSource(srcs_cfg["arxiv"]))
        if "s2" in srcs_cfg:
            sources.append(
                S2Source(srcs_cfg["s2"], api_key=env.get("s2_api_key"))
            )
        return sources

    def _build_signals(self) -> list[AbstractSignal]:
        sig_cfg = self.config.get("signals", {})
        env = self.config.get("env", {})
        signals: list[AbstractSignal] = []
        if "venue" in sig_cfg:
            signals.append(VenueSignal(sig_cfg["venue"]))
        # Citation before author so author IDs are populated first.
        if "citation" in sig_cfg:
            signals.append(
                CitationSignal(sig_cfg["citation"], api_key=env.get("s2_api_key"))
            )
        if "author" in sig_cfg:
            signals.append(
                AuthorSignal(sig_cfg["author"], api_key=env.get("s2_api_key"))
            )
        if "github" in sig_cfg:
            signals.append(
                GitHubSignal(sig_cfg["github"], github_token=env.get("github_token"))
            )
        # KeywordSignal is implicit — always on, sourced from search keywords.
        keywords = self.config.get("search", {}).get("keywords", [])
        signals.append(KeywordSignal({"enabled": True}, keywords=keywords))
        return signals

    def _build_exporters(self) -> list[AbstractExporter]:
        out_cfg = self.config.get("output", {})
        env = self.config.get("env", {})
        exporters: list[AbstractExporter] = []
        if out_cfg.get("csv", {}).get("enabled"):
            exporters.append(CSVExporter(out_cfg["csv"]))
        if out_cfg.get("json", {}).get("enabled"):
            exporters.append(JSONExporter(out_cfg["json"]))
        if out_cfg.get("slack", {}).get("enabled"):
            exporters.append(
                SlackExporter(out_cfg["slack"], webhook_url=env.get("slack_webhook_url"))
            )
        return exporters

    # ---- run ----

    async def run(self) -> PipelineResult:
        started = datetime.now()
        search_cfg = self.config.get("search", {})
        pipe_cfg = self.config.get("pipeline", {})
        inc_cfg = self.config.get("incremental", {})
        errors: list[str] = []

        # Stage 0
        papers, since_date, sources_status = await collect(
            sources=self.sources,
            keywords=search_cfg.get("keywords", []),
            categories=search_cfg.get("categories", []),
            days_back=int(search_cfg.get("days_back", 7)),
            max_results_per_keyword=int(search_cfg.get("max_results_per_keyword", 30)),
        )
        for name, st in sources_status.items():
            if not st["ok"]:
                errors.append(f"source:{name}:{st.get('error', 'unknown')}")
        s0 = len(papers)

        # Stage 1
        seen: dict[str, str] = {}
        if inc_cfg.get("enabled", True):
            seen = load_seen_ids(inc_cfg.get("seen_ids_file", "./data/seen_ids.json"))
            seen = purge_seen_ids(seen, int(inc_cfg.get("max_age_days", 14)))
        papers = rule_filter(
            papers,
            exclude_words=search_cfg.get("exclude_words", []),
            categories=search_cfg.get("categories", []),
            since_date=since_date,
            seen_ids=seen if inc_cfg.get("enabled", True) else None,
        )
        s1 = len(papers)

        # Stage 2
        papers = metric_score(
            papers=papers,
            signals=self.signals,
            weights=self.config.get("weights", {}),
            top_n=int(pipe_cfg.get("stage2_top_n", 30)),
        )
        s2 = len(papers)

        # Export
        output_files: list[str] = []
        for exp in self.exporters:
            if not exp.enabled:
                continue
            try:
                path = exp.export(papers)
                if path:
                    output_files.append(path)
            except Exception as e:
                logger.warning("exporter '%s' failed: %s", exp.name, e)
                errors.append(f"export:{exp.name}:{e}")

        # Persist seen IDs (mark all stage-2 outputs)
        if inc_cfg.get("enabled", True):
            seen = mark_seen(papers, seen)
            save_seen_ids(inc_cfg.get("seen_ids_file", "./data/seen_ids.json"), seen)

        finished = datetime.now()
        duration = (finished - started).total_seconds()
        result = PipelineResult(
            output_count=len(papers),
            output_files=output_files,
            stage_counts={
                "stage0_collected": s0,
                "stage1_filtered": s1,
                "stage2_scored": s2,
            },
            duration_seconds=duration,
            sources_status=sources_status,
            errors=errors,
        )
        self._append_history(result, started, finished)
        return result

    # ---- history ----

    def _append_history(
        self, result: PipelineResult, started: datetime, finished: datetime
    ) -> None:
        # Place run_history alongside seen_ids so the data/ dir stays cohesive.
        seen_path = self.config.get("incremental", {}).get(
            "seen_ids_file", "./data/seen_ids.json"
        )
        history_path = Path(seen_path).parent / "run_history.jsonl"
        history_path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "run_id": started.strftime("%Y%m%d_%H%M%S"),
            "started_at": started.isoformat(),
            "finished_at": finished.isoformat(),
            "duration_seconds": result.duration_seconds,
            "stage_counts": result.stage_counts,
            "sources_status": result.sources_status,
            "errors": result.errors,
            "output_files": result.output_files,
        }
        with history_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

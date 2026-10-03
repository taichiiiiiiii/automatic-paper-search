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
    EmailExporter,
    JSONExporter,
    SlackExporter,
)
from ..llm import (
    AbstractLLMProvider,
    ClaudeProvider,
    GeminiProvider,
    GroqProvider,
    OllamaProvider,
)
from ..signals import (
    AbstractSignal,
    AuthorSignal,
    CitationSignal,
    FollowSignal,
    GitHubSignal,
    KeywordSignal,
    VenueSignal,
)
from ..sources import AbstractSource, ArxivSource, OpenAlexSource, S2Source
from ..utils.dedup import load_seen_ids, merge_seen_ids, purge_seen_ids
from ..utils.logger import get_logger
from .stage_collect import collect
from .stage_embedding import AbstractEncoder, embed_and_rank
from .stage_llm_rank import llm_rerank
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
    # Enabled signals that lost at least one batch/lookup this run. A paper's
    # score of 0.0 only means "unremarkable" when the signals actually
    # answered, so degradation is reported instead of silently reshaping the
    # ranking (Stage types stay list[Paper], rule §4).
    degraded_signals: list[str] = field(default_factory=list)
    # Notification deliveries capped by max_items, e.g.
    # [{"exporter": "slack", "delivered": 10, "given": 30}] — seen_ids marks
    # every exported paper, so the run that dropped 20 of them from the post
    # must not look like a complete delivery.
    truncated_deliveries: list[dict[str, Any]] = field(default_factory=list)
    # Enabled sources whose fetch filled the whole requested window, so matching
    # papers beyond it were never fetched: {source name: [keyword, ...]}. A cut
    # window still shipped papers, so it is not an error and --fail-on-errors must
    # stay green on it; it only belongs in the record so a later reader can tell a
    # thin survey from a quiet window (the CLI prints the same line).
    truncated_windows: dict[str, list[str]] = field(default_factory=dict)


class PipelineRunner:
    def __init__(self, config: dict) -> None:
        self.config = config
        self.sources = self._build_sources()
        self.signals = self._build_signals()
        self.exporters = self._build_exporters()
        self.llm_provider = self._build_llm_provider()
        self.encoder = self._build_encoder()

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
        if "openalex" in srcs_cfg:
            sources.append(
                OpenAlexSource(
                    srcs_cfg["openalex"], email=env.get("openalex_email")
                )
            )
        return sources

    def _build_signals(self) -> list[AbstractSignal]:
        """Build signals in the order Stage 2 will execute them.

        Order matters: GitHubSignal's `enrich_batch` prioritizes its lookup
        budget by `venue_score + keyword_score`, so KeywordSignal must run
        BEFORE GitHubSignal for the keyword term to have any effect.

        CitationSignal is also placed before AuthorSignal because
        CitationSignal populates `first_author_id` from its /paper/batch
        response, which AuthorSignal then consumes.
        """
        sig_cfg = self.config.get("signals", {})
        env = self.config.get("env", {})
        signals: list[AbstractSignal] = []
        # Local / fast signals first so budget-aware signals (github) can see
        # their scores.
        if "venue" in sig_cfg:
            signals.append(VenueSignal(sig_cfg["venue"]))
        # FollowSignal: zero-latency authority signal. Runs before keyword so
        # follow_score contributes to total ordering before GitHub budgets.
        profile_cfg = self.config.get("profile") or {}
        follow_authors = profile_cfg.get("follow_authors") or []
        follow_orgs = profile_cfg.get("follow_orgs") or []
        if follow_authors or follow_orgs:
            signals.append(
                FollowSignal(
                    sig_cfg.get("follow") or {"enabled": True},
                    follow_authors=follow_authors,
                    follow_orgs=follow_orgs,
                )
            )
        # KeywordSignal is implicit — always on, sourced from search keywords.
        keywords = self.config.get("search", {}).get("keywords", [])
        signals.append(KeywordSignal({"enabled": True}, keywords=keywords))
        # S2 batch signals: citation before author (author needs first_author_id).
        if "citation" in sig_cfg:
            signals.append(
                CitationSignal(sig_cfg["citation"], api_key=env.get("s2_api_key"))
            )
        if "author" in sig_cfg:
            signals.append(
                AuthorSignal(sig_cfg["author"], api_key=env.get("s2_api_key"))
            )
        # GitHub lookup last — its budget prioritization uses venue + keyword
        # scores, both populated by this point.
        if "github" in sig_cfg:
            signals.append(
                GitHubSignal(sig_cfg["github"], github_token=env.get("github_token"))
            )
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
        if out_cfg.get("email", {}).get("enabled"):
            exporters.append(
                EmailExporter(out_cfg["email"], smtp_settings=env.get("smtp"))
            )
        return exporters

    def _build_llm_provider(self) -> AbstractLLMProvider | None:
        llm_cfg = self.config.get("llm", {})
        if not llm_cfg or not llm_cfg.get("enabled"):
            return None
        env = self.config.get("env", {})
        provider_name = str(llm_cfg.get("provider", "")).lower()
        if provider_name == "ollama":
            return OllamaProvider(llm_cfg)
        if provider_name == "gemini":
            return GeminiProvider(llm_cfg, api_key=env.get("gemini_api_key"))
        if provider_name == "claude":
            return ClaudeProvider(llm_cfg, api_key=env.get("claude_api_key"))
        if provider_name == "groq":
            return GroqProvider(llm_cfg, api_key=env.get("groq_api_key"))
        logger.warning("runner: unknown LLM provider '%s' — skipping Stage 4", provider_name)
        return None

    def _build_encoder(self) -> AbstractEncoder | None:
        """Stage 3 encoder. None disables Stage 3 (mode A)."""
        emb_cfg = self.config.get("embedding", {})
        if not emb_cfg.get("enabled"):
            return None
        backend = str(emb_cfg.get("backend", "minilm")).lower()
        if backend == "minilm":
            # Lazy import so the sentence-transformers dep stays optional.
            try:
                from .encoders import MiniLMEncoder
            except ImportError as e:
                logger.warning("runner: MiniLM encoder unavailable (%s) — skipping Stage 3", e)
                return None
            model = str(emb_cfg.get("model", "sentence-transformers/all-MiniLM-L6-v2"))
            return MiniLMEncoder(model_name=model)
        logger.warning("runner: unknown encoder backend '%s' — skipping Stage 3", backend)
        return None

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
        # A keyword whose fetch is known-incomplete is missing papers, so the run
        # is not complete even though the source answered with its other keywords
        # and Stage 0 records ok=True (HIGH-1). Stage 0 has no channel for a result
        # that is complete-but-partial, so the source names the keywords plus the
        # reason and the run records them as `source:` errors — the prefix
        # collector.py's --fail-on-errors already refuses. A source that failed
        # outright reported every keyword through the error above, so its own
        # degraded list is not repeated here.
        for src in self.sources:
            if not sources_status.get(src.name, {}).get("ok", False):
                continue
            for kw, reason in getattr(src, "degraded_keywords", []):
                errors.append(f"source:{src.name}: incomplete keyword '{kw}' ({reason})")
        # The other known-partial case: a keyword that filled its window shipped
        # papers, so it is not an error and must not fail the run — it is recorded
        # here so the same report the CLI prints also reaches run_history. A
        # disabled source never ran fetch(), so its own list is always empty.
        truncated_windows: dict[str, list[str]] = {}
        for src in self.sources:
            cut = list(getattr(src, "truncated_keywords", []))
            if cut:
                truncated_windows[src.name] = cut
        s0 = len(papers)

        # Stage 1
        seen: dict[str, str] = {}
        if inc_cfg.get("enabled", True):
            quarantined: list[str] = []
            seen = load_seen_ids(
                inc_cfg.get("seen_ids_file", "./data/seen_ids.json"),
                quarantine_notes=quarantined,
            )
            # The load still had to answer {} to keep the run going, so the
            # damaged history this run is running without is only visible if the
            # run says it: every paper the quarantined file listed looks unseen
            # again and is re-delivered today. `state:` is a loss the delivered
            # survey carries, so collector.py's --fail-on-errors refuses it —
            # a clean record beside a re-sent backlog is the worst of both.
            for note in quarantined:
                errors.append(f"state:seen_ids: {note}; backlog may be re-delivered")
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
        # Clear the failure channels before the stage runs: Stage 2 skips every
        # signal when Stage 1 kept no papers, so enrich_batch's own reset would
        # not happen and the previous run's losses would be reported twice.
        degraded_signals: list[str] = []
        for sig in self.signals:
            if sig.enabled:
                sig.reset_run_failures()
        papers = metric_score(
            papers=papers,
            signals=self.signals,
            weights=self.config.get("weights", {}),
            top_n=int(pipe_cfg.get("stage2_top_n", 30)),
            require_follow_match=bool(pipe_cfg.get("require_follow_match", False)),
        )
        s2 = len(papers)

        # A degraded signal never fails the run (Fail-Safe), but it has to
        # reach run_history: score 0.0 from an unanswered lookup is different
        # evidence from score 0.0 from an answered one, and a run where every
        # citation lookup timed out otherwise looks like a quiet day. The
        # signals already logged the per-batch WARNINGs, so this only names the
        # affected ranking for the operator.
        for sig in self.signals:
            if not sig.enabled or not sig.run_failures:
                continue
            degraded_signals.append(sig.name)
            for failure in sig.run_failures:
                errors.append(f"signal:{sig.name}: {failure}")
        if degraded_signals:
            logger.warning(
                "stage2: degraded signal(s) %s — their scores are missing, not low",
                ", ".join(degraded_signals),
            )

        # Profile for Stage 3 / Stage 4 (§4.4 fallback: keywords if unset)
        profile = self._build_profile()

        # Stage 3 (Embedding similarity) — optional; skipped when encoder is None.
        s3 = s2  # default unchanged
        if self.encoder is not None:
            try:
                papers = embed_and_rank(
                    papers=papers,
                    encoder=self.encoder,
                    profile_text=profile,
                    top_n=int(pipe_cfg.get("stage3_top_n", 30)),
                    weight=float(self.config.get("weights", {}).get("embedding", 2.5)),
                )
            except Exception as e:
                logger.warning("stage3: embedding failed, falling through: %s", e)
                errors.append(f"stage3:{e}")
            s3 = len(papers)

        # Stage 4 (LLM rerank) — skipped when provider is None or disabled
        stage4_top_n = int(pipe_cfg.get("stage4_top_n", 10))
        if self.llm_provider is not None and self.llm_provider.enabled:
            try:
                papers = llm_rerank(
                    papers=papers,
                    provider=self.llm_provider,
                    profile=profile,
                    top_n=stage4_top_n,
                )
            except Exception as e:
                logger.warning("stage4: LLM rerank failed, using Stage 2 score: %s", e)
                errors.append(f"stage4:{e}")
                papers = papers[:stage4_top_n] if stage4_top_n > 0 else papers
        elif stage4_top_n > 0:
            # Keep the pipeline consistent: truncate to same top-N even when skipping LLM.
            papers = papers[:stage4_top_n]
        s4 = len(papers)

        # Export
        output_files: list[str] = []
        enabled_exporters = [exp for exp in self.exporters if exp.enabled]
        export_failures = 0
        deliveries = 0
        truncated_deliveries: list[dict[str, Any]] = []
        for exp in enabled_exporters:
            try:
                path = exp.export(papers)
            except Exception as e:
                logger.warning("exporter '%s' failed: %s", exp.name, e)
                errors.append(f"export:{exp.name}:{e}")
                export_failures += 1
                continue
            # A falsy return is the documented no-op (CLAUDE.md rule 10:
            # an unconfigured webhook/SMTP must not fail the pipeline).
            # It is not a failure, but it is not a delivery either, so it
            # counts towards neither tally.
            if path:
                output_files.append(path)
                deliveries += 1
                # last_delivered stays None for exporters that write every
                # paper (CSV/JSON), so only a capped notification channel can
                # report a cut here — no max_items slicing duplicated in the
                # runner.
                delivered = exp.last_delivered
                if delivered is not None and delivered < len(papers):
                    # seen_ids is stamped from the whole export list, so the
                    # papers behind the cut are marked as delivered even
                    # though this post never showed them. Delivery and
                    # stamping policy stay as they are (product decision);
                    # this only makes the cut visible in the log and history.
                    logger.warning(
                        "exporter '%s' delivered %d of %d papers — the rest are "
                        "marked seen without ever being shown",
                        exp.name,
                        delivered,
                        len(papers),
                    )
                    truncated_deliveries.append(
                        {
                            "exporter": exp.name,
                            "delivered": delivered,
                            "given": len(papers),
                        }
                    )

        # Persist seen IDs (mark all stage-2 outputs) — but only when the
        # run did not both fail to deliver and fail outright. Marking a
        # paper seen makes it permanently unreachable (stage_rule_filter
        # drops seen_ids on every later run), so that is only correct once
        # the user has actually received it.
        #
        # The tallies deliberately do not partition the exporters:
        #   deliveries > 0        -> something reached the user; mark seen
        #                            even if another channel failed, or the
        #                            surviving delivery would be re-sent.
        #   failures, 0 deliveries -> a real outage; retry next run.
        #   0 failures, 0 deliveries -> nothing is configured (every
        #                            exporter no-opped, or none is
        #                            enabled). Not an outage; mark seen,
        #                            matching the behaviour before #400.
        delivery_outage = export_failures > 0 and deliveries == 0
        if inc_cfg.get("enabled", True):
            if delivery_outage:
                logger.warning(
                    "%d of %d enabled exporter(s) failed and none delivered; "
                    "skipping seen_ids update so these %d paper(s) are "
                    "retried next run",
                    export_failures,
                    len(enabled_exporters),
                    len(papers),
                )
            else:
                # merge_seen_ids (not mark_seen + save_seen_ids): the
                # read-merge-write runs under an exclusive lock, so a
                # concurrent run's IDs are not overwritten by this one's
                # stale snapshot.
                seen = merge_seen_ids(
                    inc_cfg.get("seen_ids_file", "./data/seen_ids.json"),
                    papers,
                    max_age_days=int(inc_cfg.get("max_age_days", 14)),
                )

        finished = datetime.now()
        duration = (finished - started).total_seconds()
        result = PipelineResult(
            output_count=len(papers),
            output_files=output_files,
            stage_counts={
                "stage0_collected": s0,
                "stage1_filtered": s1,
                "stage2_scored": s2,
                "stage3_embedded": s3,
                "stage4_ranked": s4,
            },
            duration_seconds=duration,
            sources_status=sources_status,
            errors=errors,
            degraded_signals=degraded_signals,
            truncated_deliveries=truncated_deliveries,
            truncated_windows=truncated_windows,
        )
        self._append_history(result, started, finished)
        return result

    # ---- profile ----

    def _build_profile(self) -> str:
        """Derive a research profile string (design doc §4.4 mode C: keywords).

        Preference order:
            1. explicit config['profile']['description']
            2. config['profile']['keywords']
            3. fallback to search.keywords
        """
        prof_cfg = self.config.get("profile", {}) or {}
        description = prof_cfg.get("description")
        if isinstance(description, str) and description.strip():
            return description.strip()
        keywords = prof_cfg.get("keywords") or self.config.get("search", {}).get("keywords", [])
        if keywords:
            return "関心キーワード: " + ", ".join(str(k) for k in keywords)
        return ""

    # ---- history ----

    def _append_history(
        self, result: PipelineResult, started: datetime, finished: datetime
    ) -> None:
        inc_cfg = self.config.get("incremental", {}) or {}
        # `incremental.run_history_file` lets one checkout keep one record per
        # workflow: collect-daily-watch and collect-weekly both append and push,
        # so sharing run_history.jsonl made them fight over the same file (L-7).
        # Unset keeps the previous rule — place run_history alongside seen_ids so
        # the data/ dir stays cohesive.
        explicit = inc_cfg.get("run_history_file")
        if explicit:
            history_path = Path(str(explicit))
        else:
            seen_path = inc_cfg.get("seen_ids_file", "./data/seen_ids.json")
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
            # Additions to the required fields of rule §9: which scores were
            # unverifiable this run, which notification dropped papers, and which
            # source cut a keyword short.
            "degraded_signals": result.degraded_signals,
            "truncated_deliveries": result.truncated_deliveries,
            "truncated_windows": result.truncated_windows,
        }
        with history_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

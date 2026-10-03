"""PaperPilot CLI entry point.

Usage:
    python -m paperpilot.collector --config config.yaml
    python -m paperpilot.collector --days 3 --keyword "diffusion model"
    python -m paperpilot.collector --full         # ignore seen-ids
    python -m paperpilot.collector --fail-on-errors   # CI: fail a degraded run
    python -m paperpilot.collector expand-keywords --write   # LLM synonym expansion
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

import yaml

from .pipeline import PipelineResult, PipelineRunner
from .utils.config_loader import load_config
from .utils.keyword_expand import expand_keywords
from .utils.logger import get_logger, setup_logging


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PaperPilot — AI/ML paper auto-collector")
    default_config = Path(__file__).resolve().parent / "config.yaml"
    p.add_argument(
        "--config",
        default=str(default_config),
        help=f"Path to config.yaml (default: {default_config})",
    )
    p.add_argument("--days", type=int, help="Override search.days_back")
    p.add_argument(
        "--keyword",
        action="append",
        default=[],
        help="Append additional search keyword (repeatable)",
    )
    p.add_argument(
        "--full",
        action="store_true",
        help="Ignore seen-ids (re-output papers from previous runs)",
    )
    p.add_argument(
        "--skip-llm",
        action="store_true",
        help="Skip Stage 4 (LLM rerank) even if configured",
    )
    p.add_argument(
        "--fail-on-errors",
        action="store_true",
        help=(
            "Exit non-zero when no enabled source ran, every enabled source failed, "
            "or a source, exporter or the run's own state file reported an error. "
            "Off by default so an interactive run still delivers what it found; CI "
            "runs use it so a degraded run is not read as success."
        ),
    )

    sub = p.add_subparsers(dest="command")

    exp = sub.add_parser(
        "expand-keywords",
        help="Use the configured LLM provider to add synonyms to search.keywords",
    )
    exp.add_argument(
        "--max",
        type=int,
        default=10,
        help="Maximum number of LLM-suggested additions (default: 10)",
    )
    exp.add_argument(
        "--write",
        action="store_true",
        help="Rewrite config.yaml with the expanded keywords in place",
    )

    return p.parse_args()


def main() -> int:
    args = parse_args()
    config = load_config(args.config)

    log_cfg = config.get("logging", {})
    setup_logging(level=log_cfg.get("level", "INFO"), log_file=log_cfg.get("file"))
    logger = get_logger("paperpilot")

    if args.command == "expand-keywords":
        return _run_expand_keywords(config, args, logger, Path(args.config))

    if args.days is not None:
        config.setdefault("search", {})["days_back"] = args.days
    if args.keyword:
        config.setdefault("search", {}).setdefault("keywords", []).extend(args.keyword)
    if args.full:
        config.setdefault("incremental", {})["enabled"] = False
    if args.skip_llm:
        config.setdefault("llm", {})["enabled"] = False

    runner = PipelineRunner(config)
    result = asyncio.run(runner.run())

    # A source that filled its requested window shipped papers, so this is a
    # warning, not an error. It is read from the result rather than from the source
    # plugins so the run summary and run_history can never disagree about which
    # keywords were cut short.
    truncated = [
        f"{name}:{kw}"
        for name, keywords in result.truncated_windows.items()
        for kw in keywords
    ]
    if truncated:
        logger.warning(
            "⚠️ truncated fetch windows (matching papers beyond the window were "
            "never fetched): %s",
            ", ".join(truncated),
        )

    logger.info(
        "✅ done: %d papers in %.1fs (stages: %s) -> %s",
        result.output_count,
        result.duration_seconds,
        result.stage_counts,
        result.output_files or "(no exporters enabled)",
    )
    print(f"✅ {result.output_count} papers exported in {result.duration_seconds:.1f}s")
    for f in result.output_files:
        print(f"   -> {f}")
    if args.fail_on_errors:
        return _failure_exit_code(result, logger)
    return 0


def _failure_exit_code(result: PipelineResult, logger: logging.Logger) -> int:
    """Non-zero when the run was degraded, 0 when it was clean.

    The pipeline is deliberately fail-safe: a throttled source or a broken
    webhook skips its own step and the run still exits 0. That is right for an
    interactive run and wrong for CI, where the exit code is the only thing an
    operator reads — a run that collected nothing because every source failed
    looks identical to a quiet day unless it fails loudly here.

    Only source, exporter and pipeline-state failures count. Stage 3 / Stage 4
    errors are recorded but degrade quality rather than delivery (the run still
    exported what it had), so they keep the run green. An EMPTY sources_status
    counts too: it means Stage 0 had no enabled source to ask at all, so the run
    collected nothing for a reason that has nothing to do with the day being
    quiet (L-8). A `state:` error is the run's own state file: a quarantined
    seen-ids backlog changes what the run delivered, so a green exit code would
    read as a normal day while the same papers went out a second time.

    A `signal:` error (Stage 2 signal degradation, e.g. a lost author/citation
    batch) is deliberately excluded from this check — it degrades scoring, not
    delivery, so it is recorded in run_history's `degraded_signals` instead of
    failing the run (L-2).
    """
    failed_sources = [
        name for name, status in result.sources_status.items() if not status.get("ok", False)
    ]
    delivery_errors = [
        e for e in result.errors if e.startswith(("source:", "export:", "state:"))
    ]
    nothing_ran = not result.sources_status
    if not (failed_sources or delivery_errors or nothing_ran):
        return 0
    details: list[str] = []
    if nothing_ran:
        details.append("no enabled source ran (sources_status is empty)")
    if failed_sources:
        details.append(f"sources failed: {', '.join(failed_sources)}")
    if delivery_errors:
        details.append(f"errors: {', '.join(delivery_errors)}")
    logger.error("❌ run reported failures: %s", "; ".join(details))
    print(f"❌ degraded run: {'; '.join(details)}")
    return 1


def _run_expand_keywords(
    config: dict, args: argparse.Namespace, logger, config_path: Path
) -> int:
    """Invoke the LLM once to expand config.search.keywords."""
    runner = PipelineRunner(config)
    provider = runner.llm_provider
    if provider is None or not provider.enabled:
        logger.error(
            "expand-keywords: no LLM provider is enabled — configure llm.* in %s",
            config_path,
        )
        return 2
    keywords = list(config.get("search", {}).get("keywords", []))
    expanded = expand_keywords(
        keywords=keywords,
        provider=provider,
        max_expansions=int(args.max),
    )
    added = [k for k in expanded if k not in keywords]
    print(f"📝 {len(keywords)} original → {len(expanded)} expanded (+{len(added)})")
    for kw in added:
        print(f"   + {kw}")

    if args.write:
        config["search"]["keywords"] = expanded
        # Preserve user comments is hard with PyYAML; we write a clean dump.
        # `env` holds secrets injected by load_config() from the environment
        # (see absolute rule §1: never persist secrets into config.yaml).
        to_write = {k: v for k, v in config.items() if k != "env"}
        with config_path.open("w", encoding="utf-8") as f:
            yaml.safe_dump(to_write, f, allow_unicode=True, sort_keys=False)
        print(f"✅ wrote {config_path}")
    else:
        print("ℹ️  pass --write to persist the expansion")
    return 0


if __name__ == "__main__":
    sys.exit(main())

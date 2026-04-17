"""PaperPilot CLI entry point.

Usage:
    python -m paperpilot.collector --config config.yaml
    python -m paperpilot.collector --days 3 --keyword "diffusion model"
    python -m paperpilot.collector --full   # ignore seen-ids
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from .pipeline import PipelineRunner
from .utils.config_loader import load_config
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
    return p.parse_args()


def main() -> int:
    args = parse_args()
    config = load_config(args.config)

    log_cfg = config.get("logging", {})
    setup_logging(level=log_cfg.get("level", "INFO"), log_file=log_cfg.get("file"))
    logger = get_logger("paperpilot")

    if args.days is not None:
        config.setdefault("search", {})["days_back"] = args.days
    if args.keyword:
        config.setdefault("search", {}).setdefault("keywords", []).extend(args.keyword)
    if args.full:
        config.setdefault("incremental", {})["enabled"] = False

    runner = PipelineRunner(config)
    result = asyncio.run(runner.run())

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
    return 0


if __name__ == "__main__":
    sys.exit(main())

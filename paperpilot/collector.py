"""PaperPilot CLI entry point.

Usage:
    python -m paperpilot.collector --config config.yaml
    python -m paperpilot.collector --days 3 --keyword "diffusion model"
    python -m paperpilot.collector --full         # ignore seen-ids
    python -m paperpilot.collector expand-keywords --write   # LLM synonym expansion
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

import yaml

from .pipeline import PipelineRunner
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
        with config_path.open("w", encoding="utf-8") as f:
            yaml.safe_dump(config, f, allow_unicode=True, sort_keys=False)
        print(f"✅ wrote {config_path}")
    else:
        print("ℹ️  pass --write to persist the expansion")
    return 0


if __name__ == "__main__":
    sys.exit(main())

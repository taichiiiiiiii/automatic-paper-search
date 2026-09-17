"""Generate one provisional abstract-only Paper Slide preview bundle."""

from __future__ import annotations

import argparse
import json
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from paperpilot.paper_slides.catalog import DEFAULT_CATALOG_NAMES
from paperpilot.paper_slides.provider_execution import (
    PreparedProviderExecution,
    ProviderExecutionError,
)
from paperpilot.paper_slides.service import (
    PaperSlidePreviewRequest,
    SlidePreviewServiceError,
    generate_paper_slide_preview,
)
from paperpilot.paper_slides.sol_local import (
    SOL_LOCAL_PROFILE_PATH,
    SOL_LOCAL_SOURCE_CONSTRAINT,
    SOL_PILOT_PAPER_ID,
    load_sol_local_execution,
)

PROJECT = Path(__file__).resolve().parents[2]
ExecutionLoader = Callable[[Path, datetime], PreparedProviderExecution]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--paper-id", required=True)
    parser.add_argument("--language", choices=("ja", "en"), default="ja")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--profile", type=Path, default=SOL_LOCAL_PROFILE_PATH)
    parser.add_argument("--docs-root", type=Path, default=PROJECT / "docs")
    parser.add_argument("--catalog", action="append", type=Path)
    parser.add_argument("--detail-dir", type=Path)
    parser.add_argument("--asset-dir", type=Path)
    return parser


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def main(
    argv: list[str] | None = None,
    *,
    execution_loader: ExecutionLoader | None = None,
    now: Callable[[], datetime] = _utc_now,
) -> int:
    """Run the fixed local Sol pilot, or a test-injected prepared execution."""

    args = _parser().parse_args(argv)
    try:
        local_sol = execution_loader is None
        if local_sol and (args.paper_id != SOL_PILOT_PAPER_ID or args.language != "ja"):
            raise SlidePreviewServiceError(
                "PAPER_SLIDE_REQUEST_INVALID", "local_profile_request_mismatch"
            )
        at = now()
        loader = execution_loader or load_sol_local_execution
        execution = loader(args.profile, at)
        catalog_paths = args.catalog or [
            args.docs_root / name / "papers.json" for name in DEFAULT_CATALOG_NAMES
        ]
        result = generate_paper_slide_preview(
            PaperSlidePreviewRequest(args.paper_id, args.language),
            execution=execution,
            catalog_paths=catalog_paths,
            detail_dir=args.detail_dir or args.docs_root / "paper-details-v1",
            asset_dir=args.asset_dir or args.docs_root / "assets",
            output_dir=args.output,
            at=at,
            source_constraint=SOL_LOCAL_SOURCE_CONSTRAINT if local_sol else None,
        )
        print(
            json.dumps(
                result.cli_summary(),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        return 0
    except (SlidePreviewServiceError, ProviderExecutionError) as error:
        print(str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

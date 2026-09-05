"""Build or verify an approved Paper Slide catalog snapshot."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from paperpilot.paper_slides.catalog import (
    DEFAULT_CATALOG_NAMES,
    CatalogBuildError,
    CatalogConfig,
    build_catalog_snapshot,
    check_snapshot,
    write_snapshot,
)

PROJECT = Path(__file__).resolve().parents[2]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--docs-root", type=Path, default=PROJECT / "docs")
    parser.add_argument(
        "--catalog",
        action="append",
        type=Path,
        help="Explicit papers.json path; repeat to replace the fixed conference set",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--check", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        config = CatalogConfig.from_json_file(args.config)
        catalog_paths = args.catalog or [
            args.docs_root / name / "papers.json" for name in DEFAULT_CATALOG_NAMES
        ]
        snapshot = build_catalog_snapshot(
            config=config,
            catalog_paths=catalog_paths,
            detail_dir=args.docs_root / "paper-details-v1",
        )
        if args.check:
            if not check_snapshot(snapshot, args.output):
                raise CatalogBuildError("check_mismatch")
        elif not args.dry_run:
            write_snapshot(snapshot, args.output)
        print(
            json.dumps(
                snapshot.report.as_dict(),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        return 0
    except CatalogBuildError as exc:
        print(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

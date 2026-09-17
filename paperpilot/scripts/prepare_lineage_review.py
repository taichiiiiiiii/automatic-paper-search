"""Prepare one offline pending lineage review directory from pinned local bytes."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import NoReturn

from paperpilot.lineage_pilot.review_io import (
    ReviewIOError,
    read_bounded_regular_file,
    read_source_snapshots,
    write_private_review_bundle,
)
from paperpilot.lineage_pilot.review_prep import (
    MAX_ARTIFACT_BYTES,
    MAX_CANDIDATE_SNAPSHOT_BYTES,
    MAX_CATALOG_BYTES,
    PrivateReviewBundle,
    PrivateReviewError,
    prepare_blind_review,
)
from paperpilot.replay import strict_json_loads


class _SafeArgumentParser(argparse.ArgumentParser):
    def error(self, _message: str) -> NoReturn:
        raise ReviewIOError("argument_invalid") from None


class _SingleValue(argparse.Action):
    def __call__(
        self,
        _parser: argparse.ArgumentParser,
        namespace: argparse.Namespace,
        values: object,
        _option_string: str | None = None,
    ) -> None:
        if getattr(namespace, self.dest, None) is not None:
            raise ReviewIOError("argument_duplicate") from None
        setattr(namespace, self.dest, values)


def _parser() -> argparse.ArgumentParser:
    parser = _SafeArgumentParser(allow_abbrev=False)
    parser.add_argument("--artifact", required=True, type=Path, action=_SingleValue)
    parser.add_argument("--catalog", required=True, type=Path, action=_SingleValue)
    parser.add_argument("--candidates", required=True, type=Path, action=_SingleValue)
    parser.add_argument("--source-snapshot", action="append")
    parser.add_argument("--conference", required=True, action=_SingleValue)
    parser.add_argument("--paper-id", required=True, action=_SingleValue)
    parser.add_argument("--fixture-id", required=True, action=_SingleValue)
    parser.add_argument("--created-at", required=True, action=_SingleValue)
    parser.add_argument("--output", required=True, type=Path, action=_SingleValue)
    return parser


def _safe_summary(bundle: PrivateReviewBundle) -> dict[str, object]:
    try:
        coordinator_bytes = bundle.files["coordinator.json"]
        coordinator = strict_json_loads(coordinator_bytes)
        if type(coordinator) is not dict:
            raise TypeError
        candidate_universe = coordinator.get("candidate_universe")
        if type(candidate_universe) is not dict:
            raise TypeError
        candidate_count = candidate_universe.get("candidate_count")
        coordinator_sha256 = bundle.coordinator_sha256
        reviewer_hashes = dict(bundle.reviewer_pack_sha256s)
    except (AttributeError, KeyError, TypeError, ValueError, UnicodeError, RecursionError):
        raise ReviewIOError("review_bundle_invalid") from None
    if type(candidate_count) is not int or candidate_count < 1:
        raise ReviewIOError("review_bundle_invalid") from None
    return {
        "candidate_count": candidate_count,
        "coordinator_sha256": coordinator_sha256,
        "file_count": 3,
        "pending": True,
        "reviewer_pack_sha256s": reviewer_hashes,
    }


def main(argv: list[str] | None = None) -> int:
    """Prepare and privately persist a pending A/B review bundle without collection."""

    try:
        args = _parser().parse_args(argv)
        # Parse every source reference before opening any path so duplicates fail closed.
        source_snapshots = read_source_snapshots(args.source_snapshot or [])
        artifact_bytes = read_bounded_regular_file(args.artifact, MAX_ARTIFACT_BYTES)
        catalog_bytes = read_bounded_regular_file(args.catalog, MAX_CATALOG_BYTES)
        candidate_bytes = read_bounded_regular_file(
            args.candidates,
            MAX_CANDIDATE_SNAPSHOT_BYTES,
        )
        bundle = prepare_blind_review(
            artifact_bytes=artifact_bytes,
            catalog_bytes=catalog_bytes,
            candidate_snapshot_bytes=candidate_bytes,
            source_snapshots=source_snapshots,
            conference=args.conference,
            paper_id=args.paper_id,
            fixture_id=args.fixture_id,
            created_at=args.created_at,
        )
        summary = _safe_summary(bundle)
        write_private_review_bundle(bundle, args.output)
        print(json.dumps(summary, sort_keys=True, separators=(",", ":")))
        return 0
    except (PrivateReviewError, ReviewIOError) as error:
        print(error.code, file=sys.stderr)
        return 1
    except (MemoryError, OSError, TypeError, ValueError, UnicodeError, RecursionError):
        print("review_preparation_failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

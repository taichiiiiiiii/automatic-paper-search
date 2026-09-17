from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from paperpilot.lineage_pilot.review_intake import ReviewIntakeError
from paperpilot.lineage_pilot.review_io import (
    ReviewIOError,
    read_bounded_regular_file,
    read_source_snapshots,
    write_private_review_intake_from_paths,
)
from paperpilot.lineage_pilot.review_prep import (
    MAX_ARTIFACT_BYTES,
    MAX_CANDIDATE_SNAPSHOT_BYTES,
    MAX_CATALOG_BYTES,
    PrivateReviewError,
    prepare_blind_review,
)
from paperpilot.scripts.prepare_lineage_review import _parser as _prepare_parser
from paperpilot.scripts.prepare_lineage_review import _SingleValue


def _parser() -> argparse.ArgumentParser:
    parser: argparse.ArgumentParser = _prepare_parser()
    parser.add_argument(
        "--original-review-dir",
        required=True,
        type=Path,
        action=_SingleValue,
    )
    parser.add_argument(
        "--reviewer-a-answer",
        type=Path,
        action=_SingleValue,
    )
    parser.add_argument(
        "--reviewer-b-answer",
        type=Path,
        action=_SingleValue,
    )
    parser.add_argument(
        "--incorporated-at",
        required=True,
        action=_SingleValue,
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)

        if args.reviewer_a_answer is None and args.reviewer_b_answer is None:
            raise ReviewIOError("answer_missing")

        source_snapshots = read_source_snapshots(args.source_snapshot or [])

        artifact_bytes = read_bounded_regular_file(args.artifact, MAX_ARTIFACT_BYTES)
        catalog_bytes = read_bounded_regular_file(args.catalog, MAX_CATALOG_BYTES)
        candidate_snapshot_bytes = read_bounded_regular_file(
            args.candidates, MAX_CANDIDATE_SNAPSHOT_BYTES
        )

        bundle = prepare_blind_review(
            artifact_bytes=artifact_bytes,
            catalog_bytes=catalog_bytes,
            candidate_snapshot_bytes=candidate_snapshot_bytes,
            source_snapshots=source_snapshots,
            conference=args.conference,
            paper_id=args.paper_id,
            fixture_id=args.fixture_id,
            created_at=args.created_at,
        )

        result = write_private_review_intake_from_paths(
            bundle,
            args.original_review_dir,
            args.output,
            answered_reviewer_a_path=args.reviewer_a_answer,
            answered_reviewer_b_path=args.reviewer_b_answer,
            incorporated_at=args.incorporated_at,
        )

        summary = {
            "candidate_count": result.candidate_count,
            "disagreement_count": len(result.disagreement_review_ids),
            "dual_reviewed_count": result.dual_reviewed_count,
            "pending_count": len(result.pending_review_ids),
            "result_sha256": result.result_sha256,
            "status": result.status,
        }
        print(json.dumps(summary, sort_keys=True, separators=(",", ":")))
        return 0

    except (PrivateReviewError, ReviewIntakeError, ReviewIOError) as error:
        print(error.code, file=sys.stderr)
        return 1
    except (MemoryError, OSError, TypeError, ValueError, UnicodeError, RecursionError):
        print("review_intake_failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

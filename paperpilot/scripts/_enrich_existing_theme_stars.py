"""One-shot enrichment of existing theme lineage.json files.

Loads each existing ``docs/themes/<slug>/lineage.json``, runs only the
GitHub-stars resolution layer (curated map + GitHub Search fallback)
from ``build_theme_lineage`` against its nodes, and writes the file
back. The S2 / LLM pipeline is intentionally skipped because the
existing nodes/edges/relations are still valid — they were just
generated before the curated+search resolver landed and have
``github_stars=0`` across the board.

Usage::

    PAPERPILOT_GITHUB_TOKEN=$(gh auth token) \\
        uv run python -m paperpilot.scripts._enrich_existing_theme_stars

The token is required to keep the GitHub Search API rate limit usable
(30 req/min authenticated vs. 10 req/min unauthenticated). Without it
the script will still run but most lookups will time out.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from paperpilot.scripts.build_theme_lineage import _enrich_github_stars

logger = logging.getLogger(__name__)

THEMES_DIR = Path(__file__).resolve().parents[2] / "docs" / "themes"


def enrich_one(lineage_path: Path, *, github_token: str | None) -> tuple[int, int]:
    """Enrich a single lineage.json in place.

    Returns ``(positive_before, positive_after)`` so callers can log the
    delta without re-reading the file.
    """
    data = json.loads(lineage_path.read_text())
    nodes_list = data.get("nodes", [])
    nodes_dict = {n["id"]: n for n in nodes_list if n.get("id")}

    positive_before = sum(1 for n in nodes_list if (n.get("github_stars") or 0) > 0)
    _enrich_github_stars(nodes_dict, github_token=github_token)
    positive_after = sum(1 for n in nodes_list if (n.get("github_stars") or 0) > 0)

    # Only rewrite if anything changed; bumping generated_at every
    # invocation would create noisy diffs even on no-op runs.
    if positive_after > positive_before:
        meta = data.setdefault("meta", {})
        meta["enriched_at"] = datetime.now(timezone.utc).isoformat()
        lineage_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        )
    return positive_before, positive_after


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    token = os.environ.get("PAPERPILOT_GITHUB_TOKEN")
    if not token:
        logger.warning(
            "PAPERPILOT_GITHUB_TOKEN not set — GitHub Search will be "
            "rate-limited to 10 req/min and most lookups will fail."
        )

    lineage_paths = sorted(THEMES_DIR.glob("*/lineage.json"))
    if not lineage_paths:
        logger.error("no lineage.json files found under %s", THEMES_DIR)
        return 1

    for path in lineage_paths:
        slug = path.parent.name
        before, after = enrich_one(path, github_token=token)
        logger.info(
            "%s: %d -> %d nodes with stars > 0 (delta=%+d)",
            slug,
            before,
            after,
            after - before,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())

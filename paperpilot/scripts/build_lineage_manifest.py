"""Generate `docs/lineage-manifest.json` from the per-conference lineage files.

Issue #372 P2: the unified lineage viewer's selector needs to know
which conferences actually have lineage data so it can render each
conference card as either clickable (→ `?conf=<slug>`) or "not yet
generated" (grey badge, no link). Probing every `docs/<conf>/lineage.json`
from the browser is the N+1 fetch problem; a single generated manifest
collapses it to one request.

Output schema::

    {
      "conferences": {
        "<slug>": {"has_lineage": bool, "node_count": int},
        ...
      },
      "generated_at": "<ISO-8601 UTC>"
    }

A conference is "has_lineage" iff BOTH:
  * `meta.source != "none"` (the empty-stub marker written by
    `build_conference_lineage.py` when the run is skipped), AND
  * `nodes` is a non-empty list (defence against a lineage run that
    completed but found no edges — still not useful to link to).

The walker intentionally only reads `docs/<conf>/lineage.json` — the
theme lineages (`docs/themes/<slug>/lineage.json`) live in a separate
manifest (`docs/themes/themes-manifest.json`) and the deep entries
(`docs/iclr-2026/deep-*.json`) in `docs/iclr-2026/deep-manifest.json`.
The viewer's selector fetches all three; this script owns only the
conference slice.

Usage::

    uv run python -m paperpilot.scripts.build_lineage_manifest          # rewrite
    uv run python -m paperpilot.scripts.build_lineage_manifest --check  # verify
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_ROOT = REPO_ROOT / "docs"
OUT_PATH = DOCS_ROOT / "lineage-manifest.json"


def _classify(lineage_path: Path) -> tuple[bool, int]:
    """Return `(has_lineage, node_count)` for one conference lineage file.

    `has_lineage` is the empty-stub判定 described in the module docstring.
    Tolerant of missing `meta` / `nodes` — missing means "not populated".
    """
    data = json.loads(lineage_path.read_text(encoding="utf-8"))
    nodes = data.get("nodes") or []
    meta = data.get("meta") or {}
    source_is_none = meta.get("source") == "none"
    has_lineage = (not source_is_none) and (len(nodes) > 0)
    return has_lineage, len(nodes)


def build(docs_root: Path = DOCS_ROOT) -> dict:
    """Walk `docs/<conf>/lineage.json` and return the manifest dict."""
    conferences: dict[str, dict] = {}
    for lineage_path in sorted(docs_root.glob("*/lineage.json")):
        slug = lineage_path.parent.name
        if slug == "themes":
            # themes-manifest.json owns this subtree; skip.
            continue
        has_lineage, node_count = _classify(lineage_path)
        conferences[slug] = {"has_lineage": has_lineage, "node_count": node_count}
    return {
        "conferences": conferences,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def _serialise(manifest: dict) -> str:
    """Compact JSON + trailing newline — matches other generated artefacts."""
    return json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--output",
        type=Path,
        default=OUT_PATH,
        help=f"Output path (default: {OUT_PATH})",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if the on-disk file differs from a fresh build.",
    )
    args = parser.parse_args(argv)

    fresh = _serialise(build())

    if args.check:
        if not args.output.exists():
            print(f"missing: {args.output}", file=sys.stderr)
            return 1
        existing = args.output.read_text(encoding="utf-8")
        # Compare semantically, ignoring generated_at churn — only the
        # conferences mapping matters for drift detection.
        try:
            fresh_data = json.loads(fresh)
            existing_data = json.loads(existing)
        except json.JSONDecodeError as exc:
            print(f"parse error: {exc}", file=sys.stderr)
            return 1
        if fresh_data["conferences"] != existing_data.get("conferences"):
            print(
                f"drift: {args.output} is out of step with docs/*/lineage.json. "
                "Run without --check to regenerate.",
                file=sys.stderr,
            )
            return 1
        print(f"ok: {args.output}")
        return 0

    args.output.write_text(fresh, encoding="utf-8")
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

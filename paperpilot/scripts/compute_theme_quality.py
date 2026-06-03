"""Compute per-theme data-quality statistics for the family-tree viewer.

Walks ``docs/themes/*/lineage.json`` and produces a single rollup at
``docs/themes/_quality.json`` containing per-theme metrics plus a
summary block. The script reuses the existing edge-metric implementation
in ``audit_lineage_quality.edge_metrics`` and the seed-relevance check
in ``audit_theme_seeds._is_on_topic`` so the numbers reported here match
what the audit gates would say if asked the same question.

Why this exists: the audit scripts already compute these signals, but
their output is a transient CI log and a step-summary table. The viewer
has no way to surface "this theme has a 35 % template-rationale ratio,
treat the edges with skepticism" without persisting the data alongside
the lineage JSON. This script is the persistence step.

Schema (stable for the viewer):

    {
      "generated_at": "<ISO 8601 UTC>",
      "themes": {
        "<slug>": {
          "theme": "<human-readable>",
          "node_count":         <int>,
          "focus_count":        <int>,
          "off_topic_focus":    <int>,
          "edge_count":         <int>,
          "template_count":     <int>,
          "template_ratio":     <float in [0, 1]>,
          "popularity_sinks":   <int>,
          "year_reversals":     <int>
        },
        ...
      },
      "summary": {
        "theme_count":           <int>,
        "total_nodes":           <int>,
        "total_edges":           <int>,
        "total_off_topic_focus": <int>,
        "themes_with_template_rationale_high": <int>,   // ratio > 0.30
        "themes_with_off_topic_seeds":          <int>
      }
    }

The output file is committed alongside the lineage JSONs so the viewer
can fetch it once and decorate every theme card with a quality badge.

Run:
    uv run python -m paperpilot.scripts.compute_theme_quality

Exit codes:
- 0 on success (file written, even if some themes have quality concerns)
- 1 on argv error / I/O failure
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from paperpilot.scripts.audit_lineage_quality import edge_metrics
from paperpilot.scripts.audit_theme_seeds import _is_on_topic

ROOT = Path(__file__).resolve().parents[2]
THEMES_DIR = ROOT / "docs" / "themes"
OUT_PATH = THEMES_DIR / "_quality.json"

# Threshold for "high template ratio" used in the summary rollup. Picked
# to match the audit_lineage_quality WARN gate so the two reports stay
# qualitatively consistent.
_HIGH_TEMPLATE_RATIO = 0.30


def _theme_quality(theme_dir: Path) -> dict | None:
    """Compute the quality block for a single theme dir, or None when
    the dir lacks a readable lineage.json."""
    lj = theme_dir / "lineage.json"
    if not lj.exists():
        return None
    try:
        data = json.loads(lj.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    meta = data.get("meta") or {}
    theme = meta.get("theme") or ""
    nodes = data.get("nodes") or []
    focus = [n for n in nodes if isinstance(n, dict) and n.get("is_focus")]
    off_topic = [n for n in focus if theme and not _is_on_topic(theme, n)]

    em = edge_metrics(data)
    return {
        "theme": theme,
        "node_count": len(nodes),
        "focus_count": len(focus),
        "off_topic_focus": len(off_topic),
        "edge_count": int(em["edge_count"]),
        "template_count": int(em["template_count"]),
        "template_ratio": float(em["template_ratio"]),
        "popularity_sinks": int(em["popularity_sinks"]),
        "year_reversals": int(em["year_reversals"]),
    }


def compute_quality(now: datetime | None = None) -> dict:
    """Build the full quality rollup. ``now`` is injectable so the unit
    tests can pin the timestamp without monkey-patching datetime."""
    now = now or datetime.now(timezone.utc)
    themes: dict[str, dict] = {}
    if THEMES_DIR.exists():
        for theme_dir in sorted(THEMES_DIR.iterdir()):
            if not theme_dir.is_dir():
                continue
            q = _theme_quality(theme_dir)
            if q is None:
                continue
            themes[theme_dir.name] = q

    high_template = sum(
        1 for q in themes.values() if q["template_ratio"] > _HIGH_TEMPLATE_RATIO
    )
    off_topic_themes = sum(1 for q in themes.values() if q["off_topic_focus"] > 0)
    total_off_topic = sum(q["off_topic_focus"] for q in themes.values())

    return {
        "generated_at": now.isoformat(),
        "themes": themes,
        "summary": {
            "theme_count": len(themes),
            "total_nodes": sum(q["node_count"] for q in themes.values()),
            "total_edges": sum(q["edge_count"] for q in themes.values()),
            "total_off_topic_focus": total_off_topic,
            "themes_with_template_rationale_high": high_template,
            "themes_with_off_topic_seeds": off_topic_themes,
        },
    }


def main(argv: list[str] | None = None) -> int:
    rollup = compute_quality()
    THEMES_DIR.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(
        json.dumps(rollup, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    n = rollup["summary"]["theme_count"]
    high = rollup["summary"]["themes_with_template_rationale_high"]
    off = rollup["summary"]["themes_with_off_topic_seeds"]
    print(f"wrote {OUT_PATH} with {n} themes")
    print(f"  themes with template_ratio > {_HIGH_TEMPLATE_RATIO:.0%}: {high}")
    print(f"  themes with off-topic seeds:                    {off}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

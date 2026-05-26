"""Audit ICLR-style conference lineage quality.

Companion to `audit_theme_seeds.py` for `docs/<conference>/lineage.json`
files where seeds are conference papers (focus) and the rest of the
graph is their cited / citing references. Unlike themes/, there's no
single "theme word" to match against, so the checks here are
structural:

- focus papers must be from the conference year window (default
  current year ± 1, override with --min-year). Catches the case where
  an older paper gets the is_focus tag by mistake.
- no implementation-foundation library paper (NumPy / PyTorch /
  SciPy / pandas / …) appears as a focus paper — those are always
  reference-only.
- cluster assignments are consistent — every focus paper carries a
  cluster id that resolves to a real cluster entry.

Run:
    uv run python -m paperpilot.scripts.audit_lineage_quality

Exit codes:
- 0 : every audited conference lineage passes (or there are none)
- 1 : at least one conference has a problem
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS_DIR = ROOT / "docs"
DENYLIST_PATH = ROOT / "paperpilot" / "data" / "lineage_denylist.json"


def _load_denylist_paper_ids() -> set[str]:
    """Pull the implementation-foundation paperId set from the shared
    file (same source build_theme_lineage uses, see CLAUDE.md §13.3)."""
    try:
        raw = json.loads(DENYLIST_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return set()
    ids = raw.get("paper_ids") or []
    return {pid for pid in ids if isinstance(pid, str)}


def _audit_lineage(path: Path, min_year: int) -> list[str]:
    """Return a list of problem strings; empty list = clean."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as e:
        return [f"unreadable: {e}"]
    nodes = data.get("nodes") or []
    if not isinstance(nodes, list):
        return ["nodes field missing or non-list"]
    problems: list[str] = []
    focus_papers = [n for n in nodes if n.get("is_focus")]
    if not focus_papers:
        problems.append("no focus papers")
    # Focus papers must be recent.
    for n in focus_papers:
        y = n.get("year")
        if isinstance(y, int) and y < min_year:
            problems.append(
                f"focus paper too old (year={y}): {(n.get('title') or '')[:60]}"
            )
    # Denylist intersection.
    denylist = _load_denylist_paper_ids()
    if denylist:
        for n in focus_papers:
            pid = n.get("id") or n.get("paperId")
            if pid in denylist:
                problems.append(
                    f"denylisted lib paper marked as focus: {(n.get('title') or '')[:60]}"
                )
    # Cluster consistency — every paper that names a cluster must point
    # at a real one. Themes don't have clusters so skip when none.
    clusters = {c.get("id") for c in (data.get("clusters") or []) if isinstance(c, dict)}
    if clusters:
        for n in nodes:
            cid = n.get("cluster")
            if cid is not None and cid not in clusters:
                problems.append(
                    f"dangling cluster ref ({cid}) on paper "
                    f"{(n.get('title') or '')[:60]}"
                )
                # Don't report 100 of these; one is enough signal.
                break
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--min-year",
        type=int,
        default=datetime.now().year - 1,
        help="Focus papers older than this trigger a warning. "
             "Default: last year (covers e.g. ICLR 2026 papers preprinted in 2025).",
    )
    args = parser.parse_args()

    targets = sorted(
        DOCS_DIR.glob("*/lineage.json"),
        key=lambda p: p.parent.name,
    )
    # Skip themes/ — that's covered by audit_theme_seeds.py.
    targets = [p for p in targets if p.parent.name != "themes"]

    if not targets:
        print("no conference lineage.json found.")
        return 0

    any_failed = False
    for path in targets:
        slug = path.parent.name
        problems = _audit_lineage(path, args.min_year)
        if not problems:
            print(f"OK  {slug}")
            continue
        any_failed = True
        print(f"\nFAIL {slug}:")
        for p in problems:
            print(f"  - {p}")

    if any_failed:
        print(
            "\nOperator action: investigate failures above. "
            "Most often the conference data needs regeneration via "
            "the weekly collect-weekly.yml workflow."
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

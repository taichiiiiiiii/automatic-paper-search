"""Deduplication and incremental "seen IDs" tracking.

seen_ids.json format (v2.0):
    { "<paper.uid>": "<ISO-8601 timestamp>", ... }

Old IDs are purged after `max_age_days` to prevent unbounded growth.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

from ..models import Paper


def dedup_papers(papers: list[Paper]) -> list[Paper]:
    """Remove duplicates by uid, preserving first occurrence."""
    seen: set[str] = set()
    unique: list[Paper] = []
    for p in papers:
        if p.uid in seen:
            continue
        seen.add(p.uid)
        unique.append(p)
    return unique


def load_seen_ids(path: str | Path) -> dict[str, str]:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        with p.open("r", encoding="utf-8") as f:
            data = json.load(f)
        # Support legacy list format gracefully.
        if isinstance(data, list):
            now = datetime.now().isoformat()
            return {uid: now for uid in data}
        return data
    except (json.JSONDecodeError, OSError):
        return {}


def save_seen_ids(path: str | Path, seen: dict[str, str]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8") as f:
        json.dump(seen, f, ensure_ascii=False, indent=2)


def purge_seen_ids(seen: dict[str, str], max_age_days: int) -> dict[str, str]:
    cutoff = datetime.now() - timedelta(days=max_age_days)
    kept: dict[str, str] = {}
    for uid, ts in seen.items():
        try:
            if datetime.fromisoformat(ts) > cutoff:
                kept[uid] = ts
        except ValueError:
            # Drop unparseable entries.
            continue
    return kept


def filter_unseen(papers: list[Paper], seen: dict[str, str]) -> list[Paper]:
    return [p for p in papers if p.uid not in seen]


def mark_seen(papers: list[Paper], seen: dict[str, str]) -> dict[str, str]:
    now = datetime.now().isoformat()
    for p in papers:
        seen[p.uid] = now
    return seen

"""Audit theme seed topic-relevance from the user's perspective.

Walks `docs/themes/*/lineage.json`, applies the same word / phrase
substring check that build_theme_lineage uses at generation time, but
limited to the data the viewer actually has (`title` + `tldr` — the
full S2 abstract isn't persisted to the lineage.json, only the short
TLDR). Reports each focus paper that fails the gate so a human can
decide whether to re-dispatch theme-on-demand for that theme.

Why this exists: themes generated before the seed-relevance filter was
merged (PR #127, 2026-05-24 16:47 JST) bypass the gate entirely, and
re-running the pipeline depends on the S2 free-tier rate limit cooling
off. This audit gives a quick signal-of-degradation so operators can
prioritize which themes to manually re-dispatch instead of guessing.

Run:
    uv run python -m paperpilot.scripts.audit_theme_seeds

Exit codes:
- 0: every theme passes (or has no eligible filter, e.g. 1-word names)
- 1: at least one theme has ≥1 off-topic seed
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
THEMES_DIR = ROOT / "docs" / "themes"

# Mirror the constants in build_theme_lineage.py — keep these in sync
# manually (audit is a separate process so the import path would be
# heavy). The values change rarely; if they drift, the audit can flag
# themes that the live filter would actually accept, which is a safer
# direction than the inverse.
_MIN_WORD_LEN = 3
_THRESHOLD_RATIO = 0.5


def _normalize(text: str) -> str:
    """Mirror of ``build_theme_lineage._normalize_relevance_text``.

    Lower-case + hyphen→space + collapse whitespace so the audit
    accepts "self-supervised learning" against a paper abstract that
    writes it as "self supervised learning" (and vice versa)."""
    return re.sub(r"\s+", " ", text.replace("-", " ").lower()).strip()


def _eligible_words(theme: str) -> list[str]:
    return [w.lower() for w in theme.split() if len(w) >= _MIN_WORD_LEN]


def _is_on_topic(theme: str, paper: dict) -> bool:
    """Mirror of build_theme_lineage._filter_topic_relevant_seeds (#209).

    Uses viewer-side fields (title + tldr instead of title + abstract)
    because the lineage.json doesn't persist the full abstract. The
    audit's check is therefore strictly weaker than the production
    filter — it can only flag seeds whose title+tldr also fails the
    gate, never seeds that passed at build time but would fail today.

    2-word themes: phrase in (title+tldr) OR both words in title.
    3+ word themes: phrase OR ceil(N/2) words anywhere.
    """
    words = _eligible_words(theme)
    if len(words) < 2:
        return True  # filter skipped at generation time
    haystack = _normalize(f"{paper.get('title') or ''} {paper.get('tldr') or ''}")
    phrase = _normalize(theme)
    if phrase and phrase in haystack:
        return True
    normalised_words = [_normalize(w) for w in words]
    if len(words) == 2:
        title_only = _normalize(paper.get("title") or "")
        return all(w and w in title_only for w in normalised_words)
    threshold = max(2, math.ceil(len(words) * _THRESHOLD_RATIO))
    hits = sum(1 for w in normalised_words if w and w in haystack)
    return hits >= threshold


def audit() -> int:
    problems: list[tuple[str, str, list[str]]] = []
    seen_themes = 0
    for theme_dir in sorted(THEMES_DIR.iterdir()):
        if not theme_dir.is_dir():
            continue
        lj = theme_dir / "lineage.json"
        if not lj.exists():
            continue
        try:
            data = json.loads(lj.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"WARN  {theme_dir.name}: lineage.json unreadable, skipping")
            continue
        meta = data.get("meta") or {}
        theme = meta.get("theme") or ""
        seeds = [n for n in (data.get("nodes") or []) if n.get("is_focus")]
        if not theme or not seeds:
            continue
        seen_themes += 1
        off = [s for s in seeds if not _is_on_topic(theme, s)]
        if off:
            problems.append(
                (
                    theme_dir.name,
                    theme,
                    [s.get("title") or s.get("paperId", "") for s in off],
                )
            )

    print(f"=== audited {seen_themes} themes ===")
    if not problems:
        print("all clean.")
        return 0
    print(f"\n{len(problems)} themes have off-topic seeds:\n")
    for slug, theme, titles in problems:
        print(f"  {slug}  ({theme!r})")
        for t in titles:
            print(f"    - {t[:80]}")
        print()
    print("Operator action: re-dispatch theme-on-demand.yml for each above slug")
    print("                 (or wait for the Sunday regen-themes cron at 09:00 JST).")
    return 1


if __name__ == "__main__":
    sys.exit(audit())

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


# Word endings stripped when checking a theme word against a haystack
# (audit-only — production uses full abstracts so it doesn't need this).
# Order is intentional:
#   * "ation" before "tion": "distillation" should chop to "distill"
#     (via ation) not "distilla" (via tion).
#   * "tion" before "ion":   keeps "function" → "func" instead of
#     "functi" (rare, but cleaner).
#   * "ion" present:         catches "supervision" → "supervis" so it
#     groups with "supervised" → "supervis" via the "ed" suffix.
#   * "ying" before "ing":   "studying" → "stud" via ying instead of
#     "study" via ing (groups with "studied" → "stud").
_STEM_SUFFIXES: tuple[str, ...] = (
    "ation",
    "tion",
    "ion",
    "ying",
    "ing",
    "ies",
    "ied",
    "ier",
    "est",
    "ed",
    "es",
    "er",
    "s",
)


def _stem(word: str) -> str:
    """Light suffix-stripping stemmer for audit-only fuzzy match.

    The audit operates on ``title + tldr`` (the lineage.json doesn't
    persist abstracts), so it misses inflectional variants that
    production accepts via the full abstract — e.g. "Knowledge
    Distillation" 3-word theme over a paper whose title contains
    "distilled" but not "distillation". Stem-prefix matching makes
    the audit count "distilled" as a hit for theme word "distillation"
    (both reduce to "distill").

    Strips one matching suffix from ``_STEM_SUFFIXES`` if the remainder
    is at least 4 chars long (avoids collapsing short tokens). Recurses
    on multi-char suffixes so "ablations" → "ablation" → "ablat"
    reaches a fixed point in one call. Single-char "s" suffix does NOT
    recurse — without that guard, "supervis" (correct stem of both
    "supervised" and "supervision") would further chop "s" → "supervi",
    breaking the equivalence we rely on.

    Idempotent: calling twice on the same word gives the same stem.
    """
    if not isinstance(word, str) or len(word) < 5:
        return word
    for suffix in _STEM_SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 4:
            chopped = word[: -len(suffix)]
            if len(suffix) > 1:
                return _stem(chopped)
            # Single-char suffix ("s") doesn't recurse — see docstring.
            return chopped
    return word


def _stem_contains(haystack: str, needle: str) -> bool:
    """Stem-aware substring check: does any stem-prefix variant of
    ``needle`` appear in ``haystack``?

    Tries both the raw needle and its stem; for haystacks, we cannot
    stem-tokenise efficiently without splitting on whitespace, so we
    just check whether the stem (which is a strict prefix of the
    word) appears anywhere. Matches "distillation" against
    "distilled" because both stem to "distill" and "distill" is a
    substring of "distilled".
    """
    if needle in haystack:
        return True
    stem = _stem(needle)
    return bool(stem and stem != needle and stem in haystack)


def _is_on_topic(theme: str, paper: dict) -> bool:
    """Mirror of build_theme_lineage._filter_topic_relevant_seeds (#209).

    Uses viewer-side fields (title + tldr instead of title + abstract)
    because the lineage.json doesn't persist the full abstract. The
    audit's check is therefore strictly weaker than the production
    filter — it can only flag seeds whose title+tldr also fails the
    gate, never seeds that passed at build time but would fail today.

    2-word themes: phrase in (title+tldr) OR both words in title.
    3+ word themes: phrase OR ceil(N/2) words anywhere.

    Uses ``_stem_contains`` for word checks so "distilled" matches
    theme word "distillation" — without this, DistilBERT (and similar
    inflection mismatches) raised spurious off-topic alerts even
    though production correctly accepted them via the full abstract.
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
        return all(w and _stem_contains(title_only, w) for w in normalised_words)
    threshold = max(2, math.ceil(len(words) * _THRESHOLD_RATIO))
    hits = sum(1 for w in normalised_words if w and _stem_contains(haystack, w))
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

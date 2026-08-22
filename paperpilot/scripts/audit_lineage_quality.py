"""Audit lineage.json files — structural checks + edge-level metrics.

Companion to `audit_theme_seeds.py` (which checks per-seed topic
relevance). Walks every `docs/*/lineage.json` and `docs/themes/*/
lineage.json` and checks:

### Structural (focus papers — conferences only)
- focus papers must be from the conference year window. The default
  floor is derived per conference from the directory name
  ``<venue>-<year>`` (floor = year - 1) so e.g. ``eccv-2024`` is
  judged against 2024, not against the wall-clock year. ``--min-year``
  on the CLI overrides the derivation for every conference.
- empty scaffold files (``nodes=[]`` AND ``edges=[]``) are reported as
  SKIP, not FAIL — they're the honest "not generated yet" stance the
  site takes so the viewer probe resolves 200 rather than 404.
- no implementation-foundation library paper (NumPy / PyTorch /
  SciPy / pandas / …) appears as a focus paper
- cluster assignments resolve to real cluster entries

### Edge-level (#209: applies to every lineage)
- **template_rationale_ratio**: fraction of edges whose rationale is
  byte-for-byte one of `TEMPLATE_RATIONALES.values()`. Pre-#209
  audit found 93.7 % of theme edges were template — after the edge-
  fabrication fix (PR #210) + regeneration, expect 40-60 % (the
  legitimate heuristic-intent path still emits templates). The hard
  fail threshold is generous on purpose (80 %) so the data-audit
  CI doesn't block PRs on themes that haven't been regenerated yet.
  Warn-only above 60 %.
- **short_rationale_ratio** (#297): fraction of edges whose rationale is
  non-empty but below `_MIN_RATIONALE_LEN` (the floor `from_dict` now
  rejects) — truncated LLM output like "A" / "QD" / "VLLM" shown as a
  meaningless 1-char tooltip. Warn-only above 20 % for now (legacy
  iclr-2026 is ~71 % degenerate and needs an LLM regen to clean);
  promote to a hard fail above 50 % once the data is regenerated.
- **popularity_sink_count**: nodes with `incoming ≥ 8` — a single
  paper accumulating 8+ "extends" arrows means the lineage is
  collapsing into a star around a survey / landmark paper, which
  the chronological viewer renders as a chaotic hub.
- **year_reversal_count**: edges where parent year > child year + 1
  (1-year window absorbs preprint↔conference overlap). A handful
  is expected; bulk reversals indicate the BFS direction is wrong.

### Theme contamination (#298: DETECTION, warn-only)
- **offtopic_nonfocus_ratio**: fraction of BFS-discovered (non-focus)
  nodes that are NOT topic-relevant to the theme, using the exact
  generation-time predicate (`_is_topic_relevant`) and exempting
  foundational-allowlist anchors. A high ratio flags a drifted seed that
  dragged an off-topic neighbourhood into the tree (the flash-attention
  lip-to-speech contamination). WARN-ONLY above 50 %: lineage ancestors
  normally DON'T share the theme's surface terms (vision-transformer's
  legit "Going deeper with convolutions" ancestor scores off-topic too),
  so this can also be high on a healthy deep tree. It surfaces a signal
  for an operator to inspect / blacklist / regenerate — it never prunes
  and never hard-fails.

Run:
    uv run python -m paperpilot.scripts.audit_lineage_quality

Exit codes:
- 0 : every audited lineage passes, is skipped as an empty stub,
      or has only warnings (there are none)
- 1 : at least one lineage has a hard-fail problem
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

from paperpilot.llm.base import _MIN_RATIONALE_LEN, TEMPLATE_RATIONALES

# #298 Part 4: reuse the EXACT topic-relevance predicate the seed gate uses
# (and the foundational-allowlist check) so the off-topic-non-focus audit
# below can never drift from generation-time logic. Cross-importing the
# private symbols is the established convention here (this file already
# imports `_MIN_RATIONALE_LEN` from paperpilot.llm.base). These two are the
# only build_theme_lineage symbols the audit needs.
from paperpilot.scripts.build_theme_lineage import (
    _is_foundational_ancestor,
    _is_topic_relevant,
)

ROOT = Path(__file__).resolve().parents[2]
DOCS_DIR = ROOT / "docs"
DENYLIST_PATH = ROOT / "paperpilot" / "data" / "lineage_denylist.json"

# Edge-level thresholds (#209). Generous on purpose — themes that
# haven't been regenerated since PR #210 will fail at the warn level
# but the hard-fail thresholds only catch extreme outliers so CI is
# not blocked across the board.
_TEMPLATE_RATIO_FAIL = 0.80  # > 80% template rationales is a hard fail
_TEMPLATE_RATIO_WARN = 0.60  # 60-80% is warned, not failed
_POPULARITY_SINK_INCOMING = 8  # node with ≥N incoming edges
_POPULARITY_SINK_FAIL_COUNT = 5  # > N sinks per lineage is a hard fail
_YEAR_REVERSAL_FAIL_COUNT = 10  # > N edges with parent.year > child.year+1
# Short / degenerate rationale (#297). Counts edges whose rationale is below
# `_MIN_RATIONALE_LEN` — the floor RelationClassification.from_dict now
# rejects (truncated LLM output like "A" / "QD" / "VLLM"). A spike means
# degenerate edges are reaching the viewer as meaningless 1-char tooltips.
# WARN-only for now: the already-published iclr-2026 lineage is ~71%
# degenerate and can only be cleaned by regenerating with a live LLM
# (blocked on the Groq key rotate, same as #285). Hard-failing today would
# red the data-audit job on un-regenerated legacy data with no free fix.
# Promote `_SHORT_RATIONALE_RATIO_PROMOTE_FAIL` to an actual hard fail once
# the lineage data is regenerated clean (tracked in #297).
_SHORT_RATIONALE_RATIO_WARN = 0.20  # > 20% degenerate rationales is warned
_SHORT_RATIONALE_RATIO_PROMOTE_FAIL = 0.50  # future hard-fail bar (#297, post-regen)

# Off-topic non-focus ratio (#298 Part 4 — DETECTION, never pruning). The
# fraction of BFS-discovered (non-focus) nodes that are NOT topic-relevant
# to the theme, excluding foundational-allowlist anchors (which are
# legitimately off-surface-topic — "Attention Is All You Need" has no
# 'flash' but belongs in the Flash Attention lineage). A high ratio means a
# drifted seed dragged an off-topic neighbourhood into the tree (the
# flash-attention lip-to-speech contamination). WARN-ONLY on purpose: the
# normal nature of lineage is that ancestors DON'T share the theme's surface
# terms (e.g. vision-transformer's legit ancestors "Going deeper with
# convolutions", "Distilling the Knowledge in a Neural Network"), so a deep
# legitimate tree can also score high here. Hard-failing would red the
# data-audit job on legitimate deep-ancestry themes; instead this surfaces a
# signal so an operator can inspect and decide whether to blacklist a drifted
# seed / regenerate. Mirrors the warn-only pattern of `short_rationale_ratio`.
_OFFTOPIC_NONFOCUS_RATIO_WARN = 0.50  # > 50% off-topic non-focus nodes is warned
_OFFTOPIC_EXAMPLE_LIMIT = 5  # show at most N example off-topic titles in the message

_TEMPLATE_RATIONALES_SET = frozenset(
    t.strip() for t in TEMPLATE_RATIONALES.values()
)

# #358: pattern for extracting the conference year from a directory name
# like `eccv-2024` / `iclr-2026`. Must be a 4-digit year at the end after
# a hyphen; anything else (themes, unknown slugs, malformed names) falls
# through to the legacy wall-clock default.
_CONF_DIR_YEAR_RE = re.compile(r"^(?P<venue>.+)-(?P<year>\d{4})$")


def _conference_year_from_path(path: Path) -> int | None:
    """Return the conference year encoded in the directory name, or
    ``None`` when the path isn't a ``<venue>-<year>`` conference dir.

    Examples (the part after ``docs/`` is what matters):
      - ``…/eccv-2024/lineage.json``    → 2024
      - ``…/themes/<slug>/lineage.json`` → None (themes bypass)
      - ``…/<no-year-slug>/lineage.json`` → None
      - ``…/<slug>-<5+digits>/lineage.json`` → None (not a 4-digit year)

    Used by ``main`` to derive the per-conference focus-paper floor so
    eccv-2024's 2024 focus papers aren't incorrectly flagged "too old"
    by a wall-clock default that has moved past the conference year.
    """
    if "themes" in path.parts:
        return None
    name = path.parent.name
    m = _CONF_DIR_YEAR_RE.match(name)
    if not m:
        return None
    return int(m.group("year"))


def _is_empty_stub(data: dict) -> bool:
    """True when the lineage has neither nodes nor edges — the ~290B
    scaffold files that ``scaffold_conference_page.py`` drops under
    ``docs/<conf>/lineage.json`` so the viewer's optional probe resolves
    200 instead of 404. These aren't broken lineages, they're "not
    generated yet" — audit should SKIP them, not FAIL them.
    """
    nodes = data.get("nodes") or []
    edges = data.get("edges") or []
    if not isinstance(nodes, list) or not isinstance(edges, list):
        # Non-list shapes are caught by structural checks — don't
        # silently SKIP them here.
        return False
    return len(nodes) == 0 and len(edges) == 0


def _effective_min_year(path: Path, explicit: int | None, fallback: int) -> int:
    """Compute the focus-paper floor for one lineage path.

    Resolution order:
      1. ``explicit`` (``--min-year`` on the CLI) — always wins so the
         operator knob stays authoritative for ad-hoc audits.
      2. Conference year derived from the directory name minus one
         (e.g. ``eccv-2024`` → 2023) so a 2024 conference's focus
         papers from 2024 pass the recency check.
      3. ``fallback`` — the legacy ``datetime.now().year - 1`` default,
         used when the dir name isn't parseable (themes, unknown slugs).
         The focus-year check is bypassed for themes inside
         ``_audit_structural`` anyway; this just picks a sane value.
    """
    if explicit is not None:
        return explicit
    conf_year = _conference_year_from_path(path)
    if conf_year is not None:
        return conf_year - 1
    return fallback


def _load_denylist_paper_ids() -> set[str]:
    """Pull the implementation-foundation paperId set from the shared
    file (same source build_theme_lineage uses, see CLAUDE.md §13.3)."""
    try:
        raw = json.loads(DENYLIST_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return set()
    ids = raw.get("paper_ids") or []
    return {pid for pid in ids if isinstance(pid, str)}


def _audit_structural(path: Path, data: dict, min_year: int) -> list[str]:
    """Return structural problems (focus papers, denylist, clusters).

    The "focus paper too old" check only fires for conference
    lineages (``docs/<conf>/lineage.json``) — themes legitimately
    seed on seminal 2017-2020 papers and would explode the failure
    list if we applied a recency filter to them. Denylist and
    cluster-consistency checks apply uniformly.
    """
    nodes = data.get("nodes") or []
    if not isinstance(nodes, list):
        return ["nodes field missing or non-list"]
    problems: list[str] = []
    focus_papers = [n for n in nodes if n.get("is_focus")]
    if not focus_papers:
        # Themes mark seeds with is_focus too — empty here means the
        # lineage truly has none, which we want to flag for any path.
        problems.append("no focus papers")
        return problems
    is_theme = "themes" in path.parts
    if not is_theme:
        for n in focus_papers:
            y = n.get("year")
            if isinstance(y, int) and y < min_year:
                problems.append(
                    f"focus paper too old (year={y}): "
                    f"{(n.get('title') or '')[:60]}"
                )
    denylist = _load_denylist_paper_ids()
    if denylist:
        for n in focus_papers:
            pid = n.get("id") or n.get("paperId")
            if pid in denylist:
                problems.append(
                    f"denylisted lib paper marked as focus: "
                    f"{(n.get('title') or '')[:60]}"
                )
    clusters = {
        c.get("id") for c in (data.get("clusters") or []) if isinstance(c, dict)
    }
    if clusters:
        for n in nodes:
            cid = n.get("cluster")
            if cid is not None and cid not in clusters:
                problems.append(
                    f"dangling cluster ref ({cid}) on paper "
                    f"{(n.get('title') or '')[:60]}"
                )
                break  # One sample is enough signal.
    return problems


def edge_metrics(data: dict) -> dict[str, int | float]:
    """Compute the four edge-level metrics for a lineage (#209).

    Returns a dict with keys: ``edge_count``, ``template_count``,
    ``template_ratio``, ``short_rationale_count``, ``short_rationale_ratio``,
    ``popularity_sinks``, ``year_reversals``.
    Empty / missing edges yields all-zeros so callers don't need to
    guard. Designed to also be importable by ad-hoc analysis scripts.
    """
    edges = data.get("edges") or []
    if not isinstance(edges, list) or not edges:
        return {
            "edge_count": 0,
            "template_count": 0,
            "template_ratio": 0.0,
            "short_rationale_count": 0,
            "short_rationale_ratio": 0.0,
            "popularity_sinks": 0,
            "year_reversals": 0,
        }
    nodes_by_id: dict[str, dict] = {}
    for n in data.get("nodes") or []:
        if isinstance(n, dict):
            nid = n.get("id") or n.get("paperId")
            if isinstance(nid, str):
                nodes_by_id[nid] = n

    template_count = 0
    short_rationale_count = 0
    incoming: Counter[str] = Counter()
    year_reversals = 0

    for e in edges:
        if not isinstance(e, dict):
            continue
        rationale = e.get("rationale")
        if isinstance(rationale, str) and rationale.strip() in _TEMPLATE_RATIONALES_SET:
            template_count += 1
        # #297: a non-empty but sub-floor rationale (e.g. "A") is a
        # degenerate tooltip. Empty rationales are dropped upstream, so
        # count only the 0 < len < floor band here.
        stripped = rationale.strip() if isinstance(rationale, str) else ""
        if 0 < len(stripped) < _MIN_RATIONALE_LEN:
            short_rationale_count += 1
        dst = e.get("dst")
        if isinstance(dst, str):
            incoming[dst] += 1
        src_node = nodes_by_id.get(e.get("src") or "")
        dst_node = nodes_by_id.get(dst or "")
        if src_node and dst_node:
            sy = src_node.get("year")
            dy = dst_node.get("year")
            if isinstance(sy, int) and isinstance(dy, int) and sy > dy + 1:
                year_reversals += 1

    popularity_sinks = sum(
        1 for cnt in incoming.values() if cnt >= _POPULARITY_SINK_INCOMING
    )
    return {
        "edge_count": len(edges),
        "template_count": template_count,
        "template_ratio": template_count / len(edges) if edges else 0.0,
        "short_rationale_count": short_rationale_count,
        "short_rationale_ratio": short_rationale_count / len(edges) if edges else 0.0,
        "popularity_sinks": popularity_sinks,
        "year_reversals": year_reversals,
    }


def _node_to_relevance_paper(node: dict) -> dict:
    """Adapt a persisted lineage.json node into the paper shape
    ``_is_topic_relevant`` expects (#298 Part 4).

    The generation-time predicate reads ``title`` + ``abstract``, but
    lineage.json never persists the full abstract (only a 1000-char
    ``short_abstract`` excerpt, with ``tldr`` as the legacy fallback).
    Map the longest available excerpt onto ``abstract`` so the audit's
    decision matches production as closely as the persisted data allows.
    This is strictly weaker than production (which sees the full
    abstract), which is the safe direction: a node the audit calls
    off-topic might be on-topic via abstract text past the excerpt, so
    the audit can only over-count — never under-count — off-topic nodes,
    and it is warn-only regardless.
    """
    return {
        "title": node.get("title") or "",
        "abstract": node.get("short_abstract") or node.get("tldr") or "",
    }


def offtopic_nonfocus_metric(data: dict) -> dict[str, object]:
    """Compute the off-topic-non-focus ratio for a theme lineage (#298 Part 4).

    DETECTION ONLY — this never removes a node; it surfaces the fraction of
    BFS-discovered (non-``is_focus``) nodes that are NOT topic-relevant to
    the theme, so an operator can decide whether a drifted seed contaminated
    the tree (and should be blacklisted / regenerated).

    Foundational-allowlist anchors are EXEMPT from the off-topic count: they
    are legitimately off-surface-topic (e.g. "Attention Is All You Need"
    carries no 'flash' but belongs in the Flash Attention lineage), so
    counting them would inflate the ratio on healthy deep trees.

    The theme comes from ``meta.theme`` (falling back to ``meta.slug``).
    Returns a dict with keys:
      * ``theme``            — the theme string used (``""`` if none)
      * ``nonfocus_count``   — non-focus nodes considered (after the
                               foundational exemption)
      * ``offtopic_count``   — of those, how many are NOT topic-relevant
      * ``offtopic_ratio``   — offtopic_count / nonfocus_count (0.0 if none)
      * ``offtopic_titles``  — up to ``_OFFTOPIC_EXAMPLE_LIMIT`` example
                               off-topic titles (for the warning message)
      * ``foundational_exempt`` — count of non-focus nodes skipped because
                               they are foundational anchors

    Non-theme lineages (no ``meta.theme`` / ``meta.slug``) and themes whose
    name is too short for the lexical gate (1 eligible word — predicate
    always returns ``True``) yield ``offtopic_ratio == 0.0`` so the caller
    never warns on them.
    """
    meta = data.get("meta") or {}
    theme = ""
    if isinstance(meta, dict):
        theme = str(meta.get("theme") or meta.get("slug") or "")
    nodes = data.get("nodes") or []
    empty = {
        "theme": theme,
        "nonfocus_count": 0,
        "offtopic_count": 0,
        "offtopic_ratio": 0.0,
        "offtopic_titles": [],
        "foundational_exempt": 0,
    }
    if not theme or not isinstance(nodes, list):
        return empty
    nonfocus = [
        n for n in nodes if isinstance(n, dict) and not n.get("is_focus")
    ]
    considered = 0
    offtopic_count = 0
    foundational_exempt = 0
    offtopic_titles: list[str] = []
    for n in nonfocus:
        # Foundational anchors are legitimately off-surface-topic — exempt.
        if _is_foundational_ancestor(n):
            foundational_exempt += 1
            continue
        considered += 1
        paper = _node_to_relevance_paper(n)
        if not _is_topic_relevant(paper, theme=theme):
            offtopic_count += 1
            title = (n.get("title") or n.get("id") or "").strip()
            if title and len(offtopic_titles) < _OFFTOPIC_EXAMPLE_LIMIT:
                offtopic_titles.append(title)
    ratio = offtopic_count / considered if considered else 0.0
    return {
        "theme": theme,
        "nonfocus_count": considered,
        "offtopic_count": offtopic_count,
        "offtopic_ratio": ratio,
        "offtopic_titles": offtopic_titles,
        "foundational_exempt": foundational_exempt,
    }


def _audit_offtopic_nonfocus(data: dict) -> list[str]:
    """Return WARN-only messages for the off-topic-non-focus metric (#298).

    Never returns a hard failure: a high ratio can mean either real
    contamination (flash-attention's lip-to-speech drift) OR a legitimately
    deep tree whose ancestors don't share the theme's surface terms
    (vision-transformer's "Going deeper with convolutions"). Only an
    operator can tell the two apart, so this just raises a flag — it does
    not block CI. Mirrors the warn-only treatment of ``short_rationale_ratio``.
    """
    m = offtopic_nonfocus_metric(data)
    # The metric dict is dict[str, object] (mixes counts/ratio with the
    # titles list), so guard the numeric reads for mypy + defensiveness.
    nonfocus_raw = m["nonfocus_count"]
    ratio_raw = m["offtopic_ratio"]
    nonfocus = int(nonfocus_raw) if isinstance(nonfocus_raw, (int, float)) else 0
    ratio = float(ratio_raw) if isinstance(ratio_raw, (int, float)) else 0.0
    if nonfocus == 0 or ratio <= _OFFTOPIC_NONFOCUS_RATIO_WARN:
        return []
    titles = m["offtopic_titles"]
    examples = ""
    if isinstance(titles, list) and titles:
        shown = "; ".join(t[:60] for t in titles)
        examples = f" e.g. {shown}"
    return [
        f"offtopic_nonfocus_ratio={ratio:.0%} "
        f"({m['offtopic_count']}/{nonfocus} BFS-discovered nodes are NOT "
        f"topic-relevant to theme {m['theme']!r}, foundational anchors "
        f"exempt);{examples}; warn above "
        f"{_OFFTOPIC_NONFOCUS_RATIO_WARN:.0%} (#298 — a drifted seed may have "
        f"dragged in an off-topic neighbourhood; inspect and blacklist/"
        f"regenerate. NOTE: deep legitimate lineages whose ancestors don't "
        f"share the theme's surface terms also score high here, so this is "
        f"DETECTION not a hard fail)"
    ]


def _audit_edges(data: dict) -> tuple[list[str], list[str]]:
    """Return (warnings, hard_failures) from the edge metrics."""
    m = edge_metrics(data)
    warnings: list[str] = []
    failures: list[str] = []
    if m["edge_count"] == 0:
        return warnings, failures
    ratio = float(m["template_ratio"])
    if ratio > _TEMPLATE_RATIO_FAIL:
        failures.append(
            f"template_rationale_ratio={ratio:.0%} "
            f"({m['template_count']}/{m['edge_count']}); "
            f"hard fail above {_TEMPLATE_RATIO_FAIL:.0%}"
        )
    elif ratio > _TEMPLATE_RATIO_WARN:
        warnings.append(
            f"template_rationale_ratio={ratio:.0%} "
            f"({m['template_count']}/{m['edge_count']}); "
            f"warn above {_TEMPLATE_RATIO_WARN:.0%}"
        )
    short_ratio = float(m["short_rationale_ratio"])
    # WARN-only (#297): hard-fail would red the data-audit job on the
    # already-published ~71%-degenerate iclr-2026 lineage, which can't be
    # cleaned without an LLM regen (Groq key rotate). Promote to a failure
    # (>_SHORT_RATIONALE_RATIO_PROMOTE_FAIL) once the data is regenerated.
    if short_ratio > _SHORT_RATIONALE_RATIO_WARN:
        warnings.append(
            f"short_rationale_ratio={short_ratio:.0%} "
            f"({m['short_rationale_count']}/{m['edge_count']} edges with "
            f"<{_MIN_RATIONALE_LEN}-char rationale, e.g. \"A\"); "
            f"warn above {_SHORT_RATIONALE_RATIO_WARN:.0%} (#297 — regenerate "
            f"the lineage to re-derive rationales)"
        )
    if int(m["popularity_sinks"]) > _POPULARITY_SINK_FAIL_COUNT:
        failures.append(
            f"popularity_sinks={m['popularity_sinks']} "
            f"(nodes with ≥{_POPULARITY_SINK_INCOMING} incoming); "
            f"hard fail above {_POPULARITY_SINK_FAIL_COUNT}"
        )
    elif int(m["popularity_sinks"]) > 0:
        warnings.append(
            f"popularity_sinks={m['popularity_sinks']} "
            f"(nodes with ≥{_POPULARITY_SINK_INCOMING} incoming)"
        )
    if int(m["year_reversals"]) > _YEAR_REVERSAL_FAIL_COUNT:
        failures.append(
            f"year_reversals={m['year_reversals']} "
            f"(parent.year > child.year+1); "
            f"hard fail above {_YEAR_REVERSAL_FAIL_COUNT}"
        )
    elif int(m["year_reversals"]) > 0:
        warnings.append(f"year_reversals={m['year_reversals']}")
    return warnings, failures


def _audit_lineage(
    path: Path, min_year: int, data: dict | None = None
) -> tuple[list[str], list[str]]:
    """Return (warnings, hard_failures) for one lineage.json path.

    Structural problems are always failures (broken focus papers /
    denylist hits can't be partial). Edge metrics have separate
    warn / fail thresholds so a regenerable theme that's still 70 %
    template doesn't block PRs. The off-topic-non-focus metric (#298) is
    warn-only — it detects theme contamination without blocking, since a
    high ratio can also describe a legitimately deep lineage.
    """
    if data is None:
        # Standalone callers (tests, ad-hoc use) can still pass just a path;
        # main() hands over its already-parsed dict so each lineage.json is
        # read exactly once (R2 review of #358).
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError) as e:
            return [], [f"unreadable: {e}"]
    structural = _audit_structural(path, data, min_year)
    edge_warn, edge_fail = _audit_edges(data)
    offtopic_warn = _audit_offtopic_nonfocus(data)
    return edge_warn + offtopic_warn, structural + edge_fail


def _collect_targets() -> list[Path]:
    """Glob both `docs/<slug>/lineage.json` and
    `docs/themes/<slug>/lineage.json`. Sorted by full path so output
    is deterministic across runs (CI summaries diff cleanly)."""
    targets = list(DOCS_DIR.glob("*/lineage.json")) + list(
        DOCS_DIR.glob("themes/*/lineage.json")
    )
    return sorted(set(targets), key=lambda p: str(p))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    # #358: default is now ``None`` so ``main`` can derive a per-conference
    # floor from the directory name (`<venue>-<year>` → year - 1). When
    # the operator passes ``--min-year`` explicitly it overrides everything
    # (ad-hoc audits, cross-conference sweeps). When neither the flag nor
    # the dir name yields a year, fall back to the legacy wall-clock
    # default — themes bypass the focus-year check inside
    # ``_audit_structural`` so the fallback only affects unparseable
    # conference dir names.
    wall_clock_fallback = datetime.now().year - 1
    parser.add_argument(
        "--min-year",
        type=int,
        default=None,
        help=(
            "Focus papers older than this trigger a structural error. "
            "Default: derived per conference from the directory name "
            "(<venue>-<year> → year - 1) so e.g. eccv-2024's 2024 focus "
            "papers pass. Pass explicitly to override every conference."
        ),
    )
    parser.add_argument(
        "--include-themes",
        action="store_true",
        help=(
            "Also audit docs/themes/<slug>/lineage.json files. "
            "Defaults to OFF (conferences only) so the data-audit CI "
            "doesn't fail on themes that still need regeneration after "
            "the #210 / #211 lineage-quality fixes — flip the flag in "
            "the workflow after the bulk re-dispatch lands clean."
        ),
    )
    parser.add_argument(
        "--themes-only",
        action="store_true",
        help="Only audit docs/themes/<slug>/lineage.json files (implies --include-themes).",
    )
    args = parser.parse_args()

    targets = _collect_targets()
    if args.themes_only:
        targets = [p for p in targets if "themes" in p.parts]
    elif not args.include_themes:
        targets = [p for p in targets if "themes" not in p.parts]
    if not targets:
        print("no lineage.json found.")
        return 0

    any_failed = False
    for path in targets:
        slug = (
            f"themes/{path.parent.name}"
            if "themes" in path.parts
            else path.parent.name
        )
        # #358: empty stubs (nodes=[], edges=[]) are "not generated yet"
        # scaffold files — SKIP them so the 8 conferences without a real
        # lineage don't red the data-audit job on every push. The site's
        # own stance is to keep the empty file so the viewer probe
        # returns 200 rather than 404; the audit should echo that.
        try:
            raw = path.read_text(encoding="utf-8")
            data = json.loads(raw)
        except (FileNotFoundError, json.JSONDecodeError) as e:
            # Unreadable is a real failure — don't SKIP it.
            print(f"\nFAIL  {slug}:")
            print(f"  - unreadable: {e}")
            any_failed = True
            continue
        if _is_empty_stub(data):
            print(f"SKIP  {slug} (no lineage generated yet)")
            continue
        effective = _effective_min_year(path, args.min_year, wall_clock_fallback)
        warnings, failures = _audit_lineage(path, effective, data)
        if not warnings and not failures:
            print(f"OK    {slug}")
            continue
        if failures:
            any_failed = True
            print(f"\nFAIL  {slug}:")
            for p in failures:
                print(f"  - {p}")
        if warnings:
            print(f"\nWARN  {slug}:")
            for p in warnings:
                print(f"  - {p}")

    if any_failed:
        print(
            "\nOperator action: investigate failures above. "
            "Themes failing the template_rationale_ratio threshold need "
            "regeneration via theme-on-demand.yml (the edge-fabrication "
            "fix in PR #210 + cache purge make follow-up runs converge "
            "well below the hard-fail threshold)."
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

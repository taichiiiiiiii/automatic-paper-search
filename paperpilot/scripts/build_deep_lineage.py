"""Build a depth-N family tree focused on a single paper.

Where `build_lineage.py` produces 12 shallow subtrees (one per Oral paper,
depth 1), this script produces ONE deep subtree for a single focus paper.

BFS strategy, bounded by depth and per-level width:
    ancestors:   focus → parents → grandparents → ...  (up to --depth)
    descendants: focus → children → grandchildren → ...

Each (parent, child) pair is classified via AbstractLLMProvider, same as
build_lineage.py, and the edge kept iff the relation is not `unrelated`.

Usage:
    python paperpilot/scripts/build_deep_lineage.py \\
        --arxiv-id 2602.18473 \\
        --depth 2 \\
        --output docs/iclr-2026/deep.json

Reuses the cache directory at paperpilot/data/lineage-cache/ so re-runs
after interruption resume from where they left off.

Per absolute rule §12 (family-tree exception): this script fetches the
S2 citation graph directly. It does NOT re-enrich the focus paper's
Stage 2 fields (venue / citation_count / github_stars) — those come
from the Stage 2 run that produced papers.json.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from paperpilot.llm.base import RelationClassification, build_classify_prompt  # noqa: E402
from paperpilot.scripts.build_lineage import (  # noqa: E402
    CACHE_DIR,
    build_provider,
    fetch_paper_by_arxiv,
    fetch_related,
    persist_classifications,
    select_top,
    to_node,
)
from paperpilot.utils.json_parser import parse_llm_response  # noqa: E402
from paperpilot.utils.logger import get_logger, setup_logging  # noqa: E402

logger = get_logger(__name__)

# Llama 3.3 70B on Groq has a habit of returning `"rationale": ""` for weak
# (depth-2+) edges — those get rejected by RelationClassification.from_dict
# and the edge disappears entirely, defeating the purpose of deep BFS. This
# table provides a templated fallback rationale keyed on the relation type
# so a thin-but-real edge survives instead of silently vanishing.
#
# #283: derive from paperpilot.llm.base.TEMPLATE_RATIONALES to close a
# byte-for-byte duplication flagged by the SSoT review. The mapping below
# is the relation-name ↔ heuristic-key bridge; an import-time KeyError
# guarantees we can't drift out of sync.
from paperpilot.llm.base import TEMPLATE_RATIONALES as _BASE_TEMPLATE_RATIONALES  # noqa: E402

_RELATION_TO_HEURISTIC_KEY: dict[str, str] = {
    "supersedes":    "supersedes_year_cite",
    "successor":     "successor_result",
    "extends":       "extends_methodology",
    # ablation + baseline_only: heuristic no longer emits these post-#283.
    # The fallback rationale is still needed because depth 2+ LLM calls
    # can still return these relations from the LLM itself — only the
    # heuristic emit was removed, not the relation enum.
    "ablation":      "ablation_year_cite",
    "baseline_only": "baseline_only_background",
    "contrasts":     "contrasts_year_cite",
}
_FALLBACK_RATIONALE: dict[str, str] = {
    relation: _BASE_TEMPLATE_RATIONALES[heuristic_key]
    for relation, heuristic_key in _RELATION_TO_HEURISTIC_KEY.items()
}


def _classify_cached_lenient(
    provider, a: dict, b: dict, *,
    cache_key: str,
    classifications: dict[str, dict],
    cache_path: Path,
    rate_delay: float,
) -> dict | None:
    """classify_relation + cache, but synthesize a rationale fallback when
    the LLM returns a non-unrelated relation with an empty rationale.

    This is a deliberate relaxation of build_lineage.py's strict policy
    ("empty rationale → drop edge"): at depth 2+ we'd rather show a weak
    edge with a templated tooltip than lose the entire deeper tree.
    """
    cached = classifications.get(cache_key)
    if cached is not None:
        return cached

    # Call LLM directly so we can inspect the raw relation before
    # `from_dict` kills it for an empty rationale.
    system, user = build_classify_prompt(a, b)
    text = provider._chat(system, user, json_mode=True)
    time.sleep(rate_delay)
    if text is None:
        return None

    parsed: dict
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # Fall back to base parser + from_dict (handles fenced markdown etc).
        rc = RelationClassification.from_dict(parse_llm_response(text))
        if rc is None:
            return None
        parsed = {"relation": rc.relation, "confidence": rc.confidence, "rationale": rc.rationale}

    rel = parsed.get("relation") if isinstance(parsed, dict) else None
    if not isinstance(rel, str):
        return None
    rationale = (parsed.get("rationale") or "").strip() if isinstance(parsed, dict) else ""
    if not rationale and rel != "unrelated":
        rationale = _FALLBACK_RATIONALE.get(rel, "論文 A と B の引用関係に意味的な連続性がある。")
    try:
        conf = float(parsed.get("confidence", 0.6))
    except (TypeError, ValueError):
        conf = 0.6
    conf = max(0.0, min(1.0, conf))

    entry = {"relation": rel, "confidence": conf, "rationale": rationale}
    classifications[cache_key] = entry
    # Use the same race-safe persist helper that build_lineage uses; without
    # it, parallel deep + theme runs can lose each other's contributions.
    persist_classifications(classifications, cache_path)
    return entry


# Alias so the BFS code below reads cleanly.
_classify_cached = _classify_cached_lenient


def fetch_related_by_id(s2_id: str, kind: str, top_n: int) -> list[dict]:
    """Wrapper: mirrors build_lineage.fetch_related + select_top."""
    items = fetch_related(s2_id, kind, top_n * 4)
    return select_top(items, top_n)


def build_deep(
    arxiv_id: str,
    *,
    depth: int = 2,
    top_parents: int = 20,
    top_children: int = 20,
    venue_override: str | None = None,
    tier_override: str | None = None,
) -> dict:
    """BFS from focus paper up to `depth` hops in each direction."""
    provider, rate_delay = build_provider()
    logger.info(
        "LLM provider: %s; focus arxiv=%s depth=%d", provider.name, arxiv_id, depth
    )

    focus = fetch_paper_by_arxiv(arxiv_id)
    if focus is None:
        sys.exit(f"S2 lookup failed for arXiv:{arxiv_id}")
    focus_id = focus["paperId"]
    logger.info("Focus resolved: %s — %s", focus_id, focus.get("title", "")[:80])

    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    nodes[focus_id] = to_node(
        focus,
        focus=True,
        kinds=["focus"],
        override_venue=venue_override,
        override_tier=tier_override,
    )

    classifications_path = CACHE_DIR / "classifications.json"
    classifications: dict[str, dict] = (
        json.loads(classifications_path.read_text())
        if classifications_path.exists() else {}
    )

    def expand(src_paper: dict, direction: str, top_n: int) -> list[tuple[dict, dict]]:
        """Returns list of (related_paper, edge_dict) for this hop."""
        s2_id = src_paper["paperId"]
        kind = "references" if direction == "up" else "citations"
        related = fetch_related_by_id(s2_id, kind, top_n)
        logger.info(
            "  %-60s %s → %d %s",
            src_paper.get("title", "")[:60], direction, len(related), kind,
        )
        out: list[tuple[dict, dict]] = []
        for rel in related:
            rel_id = rel["paperId"]
            # Issue #50: skip non-influential refs — same rationale as
            # build_theme_lineage. Missing flag (None) keeps the classify
            # path so existing caches don't regress.
            if rel.get("_is_influential") is False:
                continue
            if direction == "up":
                a, b = rel, src_paper       # parent → child
                edge_src, edge_dst = rel_id, s2_id
            else:
                a, b = src_paper, rel       # focus/self → child
                edge_src, edge_dst = s2_id, rel_id
            cache_key = f"{edge_src}->{edge_dst}"
            cls = _classify_cached(
                provider, a, b,
                cache_key=cache_key,
                classifications=classifications,
                cache_path=classifications_path,
                rate_delay=rate_delay,
            )
            if cls is None or cls["relation"] == "unrelated":
                continue
            edge = {
                "src": edge_src, "dst": edge_dst,
                "rel": cls["relation"],
                "conf": cls["confidence"],
                "rationale": cls["rationale"],
            }
            out.append((rel, edge))
        return out

    # Ancestor BFS
    frontier_up = [focus]
    for d in range(1, depth + 1):
        logger.info("== Ancestor depth %d (%d seed nodes) ==", d, len(frontier_up))
        next_frontier: list[dict] = []
        for seed in frontier_up:
            # Narrower fetch for deeper levels to control cost.
            width = top_parents if d == 1 else max(top_parents // 2, 6)
            for rel_paper, edge in expand(seed, direction="up", top_n=width):
                rid = rel_paper["paperId"]
                if rid not in nodes:
                    nodes[rid] = to_node(rel_paper)
                # Avoid duplicate edges (same src/dst pair)
                if not any(e["src"] == edge["src"] and e["dst"] == edge["dst"] for e in edges):
                    edges.append(edge)
                next_frontier.append(rel_paper)
        frontier_up = next_frontier

    # Descendant BFS
    frontier_down = [focus]
    for d in range(1, depth + 1):
        logger.info("== Descendant depth %d (%d seed nodes) ==", d, len(frontier_down))
        next_frontier = []
        for seed in frontier_down:
            width = top_children if d == 1 else max(top_children // 2, 6)
            for rel_paper, edge in expand(seed, direction="down", top_n=width):
                rid = rel_paper["paperId"]
                if rid not in nodes:
                    nodes[rid] = to_node(rel_paper)
                if not any(e["src"] == edge["src"] and e["dst"] == edge["dst"] for e in edges):
                    edges.append(edge)
                next_frontier.append(rel_paper)
        frontier_down = next_frontier

    # Drop zero-rationale edges (belt + braces vs. build_lineage.py).
    edges = [e for e in edges if (e.get("rationale") or "").strip()]

    return {
        "root": focus_id,
        "nodes": list(nodes.values()),
        "edges": edges,
        "meta": {
            "source": "build_deep_lineage.py",
            "arxiv_id": arxiv_id,
            "depth": depth,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arxiv-id", required=True,
                    help="arXiv id of the focus paper (e.g. 2602.18473)")
    ap.add_argument("--depth", type=int, default=2,
                    help="BFS depth in each direction (default: 2)")
    ap.add_argument("--top-parents", type=int, default=20,
                    help="Max references per seed at depth 1 (halved at deeper levels)")
    ap.add_argument("--top-children", type=int, default=20,
                    help="Max citations per seed at depth 1 (halved at deeper levels)")
    ap.add_argument("--venue-override", default="ICLR 2026",
                    help="Pretty venue label for the focus node")
    ap.add_argument("--tier-override", default="A+",
                    help="Venue tier override for the focus node")
    ap.add_argument("--output", default=None,
                    help="Output JSON path (default: docs/iclr-2026/deep-<arxiv_id>.json)")
    args = ap.parse_args()

    setup_logging()  # CLI mode: surface logger.info to stderr.

    result = build_deep(
        args.arxiv_id,
        depth=args.depth,
        top_parents=args.top_parents,
        top_children=args.top_children,
        venue_override=args.venue_override,
        tier_override=args.tier_override,
    )

    output = args.output or f"docs/iclr-2026/deep-{args.arxiv_id}.json"
    out = ROOT / output
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print()
    print(f"✓ Wrote {out}")
    print(f"  nodes: {len(result['nodes'])}")
    print(f"  edges: {len(result['edges'])}")
    rels: dict[str, int] = {}
    for e in result["edges"]:
        rels[e["rel"]] = rels.get(e["rel"], 0) + 1
    for k, v in sorted(rels.items(), key=lambda x: -x[1]):
        print(f"    {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

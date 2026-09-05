"""Build a depth-N family tree focused on a single paper.

Where `build_lineage.py` produces 12 shallow subtrees (one per Oral paper,
depth 1), this script produces ONE deep subtree for a single focus paper.

BFS strategy, bounded by depth and per-level width:
    ancestors:   focus → parents → grandparents → ...  (up to --depth)
    descendants: focus → children → grandchildren → ...

Each (parent, child) pair is classified via AbstractLLMProvider, same as
build_lineage.py, and the edge kept iff the relation is not `unrelated`.

Usage:
    uv run python -m paperpilot.scripts.build_deep_lineage \\
        --arxiv-id 2602.18473 \\
        --seed-paper-id 0123456789abcdef0123456789abcdef01234567 \\
        --depth 2 \\
        --output docs/iclr-2026/deep-2602.18473.json

The output filename must be ``deep-<arxiv_id>.json``: generate_deep_manifest.py
globs ``deep-*.json`` and recovers the id with ``^deep-(?P<id>[^/\\]+)\\.json$``,
so a file named ``deep.json`` is written successfully and then never appears in
the viewer (#369).

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
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from paperpilot.identity.source_ids import IdentityError, normalize_alias  # noqa: E402
from paperpilot.llm.base import (  # noqa: E402
    RelationClassification,
    build_classify_prompt,
    provider_model_tag,
)
from paperpilot.scripts._lineage_classify import _slot_fill_rationale  # noqa: E402
from paperpilot.scripts._lineage_contract import (  # noqa: E402
    ARXIV_ID_RE,
    LINEAGE_ARTIFACT_VERSION,
    canonical_json_sha256,
    make_provenance,
    require_paper_id,
    validate_lineage_artifact,
)
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

_PRODUCER_NAME = "paperpilot.scripts.build_deep_lineage"
_PRODUCER_VERSION = "p2-v1"
_PROMPT_VERSION = "relation-prompt-v1"
_CLASSIFICATION_SCHEMA_VERSION = "relation-classification-v1"
_CACHE_VERSION = "lineage-classification-cache-v2"
_CACHE_TTL = timedelta(days=30)

# Llama 3.3 70B on Groq has a habit of returning `"rationale": ""` for weak
# (depth-2+) edges — those get rejected by RelationClassification.from_dict
# and the edge disappears entirely, defeating the purpose of deep BFS. We
# synthesize a fallback rationale so a thin-but-real edge survives.
#
# #304: the fallback is now `_slot_fill_rationale` (embeds the actual
# parent/child titles + years), matching the #300 generalisation in
# _derive_relation_heuristic. This replaced a per-relation TEMPLATE_RATIONALES
# table — slot-filled output is paper-specific and is NEVER a
# `_TEMPLATE_RATIONALES_SET` member, so it stays consistent with the rest of
# the lineage pipeline (and won't be template-rejected if it ever flows
# through `_apply_llm_classification`).


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _cache_entry_is_fresh(entry: object, *, now: datetime) -> bool:
    if not isinstance(entry, dict) or entry.get("status") != "success":
        return False
    expires_at = entry.get("expires_at")
    if not isinstance(expires_at, str):
        return False
    try:
        parsed = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed > now


def _classify_cached_lenient(
    provider,
    a: dict,
    b: dict,
    *,
    src_id: str,
    dst_id: str,
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
    # Call LLM directly so we can inspect the raw relation before
    # `from_dict` kills it for an empty rationale.
    system, user = build_classify_prompt(a, b)
    evidence_sha256 = canonical_json_sha256(
        {"src": src_id, "dst": dst_id, "system": system, "user": user}
    )
    provider_name = str(getattr(provider, "name", "unknown"))
    model = provider_model_tag(provider)
    provenance = make_provenance(
        producer_name=_PRODUCER_NAME,
        producer_version=_PRODUCER_VERSION,
        evidence_source="semantic_scholar",
        evidence_kind="relation-input",
        evidence_sha256=evidence_sha256,
        method="llm",
        provider=provider_name,
        model=model,
        prompt_version=_PROMPT_VERSION,
        classification_schema_version=_CLASSIFICATION_SCHEMA_VERSION,
    )
    cache_identity = {
        "version": _CACHE_VERSION,
        "src": src_id,
        "dst": dst_id,
        "producer": {"name": _PRODUCER_NAME, "version": _PRODUCER_VERSION},
        "evidence_sha256": evidence_sha256,
        "provider": provider_name,
        "model": model,
        "prompt_version": _PROMPT_VERSION,
        "schema_version": _CLASSIFICATION_SCHEMA_VERSION,
    }
    cache_key = f"v2:{canonical_json_sha256(cache_identity)}"
    cached = classifications.get(cache_key)
    now = _utc_now()
    if (
        _cache_entry_is_fresh(cached, now=now)
        and cached.get("cache_identity") == cache_identity
        and cached.get("provenance") == provenance
    ):
        cached_classification = RelationClassification.from_dict(cached)
        if cached_classification is not None:
            return cached

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
        # #304: paper-specific slot-fill instead of a template fallback.
        rationale = _slot_fill_rationale(rel, a, b)
    parsed["rationale"] = rationale
    classification = RelationClassification.from_dict(parsed)
    if classification is None:
        return None
    entry = {
        "cache_identity": cache_identity,
        "status": "success",
        "expires_at": _iso_z(now + _CACHE_TTL),
        "src": src_id,
        "dst": dst_id,
        "relation": classification.relation,
        "confidence": classification.confidence,
        "rationale": classification.rationale,
        "model": model,
        "provenance": provenance,
    }
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


def _require_s2_focus_identity(focus: object, requested_arxiv_id: str) -> str:
    """Return the S2 paper ID only when its explicit arXiv alias matches."""

    if not isinstance(focus, dict):
        raise ValueError("Semantic Scholar focus response must be an object")
    paper_id = focus.get("paperId")
    external_ids = focus.get("externalIds")
    raw_arxiv_id = external_ids.get("ArXiv") if isinstance(external_ids, dict) else None
    if not isinstance(paper_id, str) or not paper_id.strip() or not isinstance(raw_arxiv_id, str):
        raise ValueError("Semantic Scholar focus is missing paperId or externalIds.ArXiv")
    try:
        _, resolved_arxiv_id = normalize_alias("arxiv", raw_arxiv_id)
    except IdentityError as exc:
        raise ValueError("Semantic Scholar returned an invalid arXiv identity") from exc
    if resolved_arxiv_id != requested_arxiv_id:
        raise ValueError("Semantic Scholar arXiv identity does not match the requested paper")
    return paper_id


def build_deep(
    arxiv_id: str,
    *,
    seed_paper_id: str,
    depth: int = 2,
    top_parents: int = 20,
    top_children: int = 20,
    venue_override: str | None = None,
    tier_override: str | None = None,
) -> dict:
    """BFS from focus paper up to `depth` hops in each direction."""
    seed_paper_id = require_paper_id(seed_paper_id, field="seed_paper_id")
    _, arxiv_id = normalize_alias("arxiv", arxiv_id)
    if ARXIV_ID_RE.fullmatch(arxiv_id) is None:
        raise ValueError("deep lineage requires a modern arXiv ID")

    focus = fetch_paper_by_arxiv(arxiv_id)
    if focus is None:
        sys.exit(f"S2 lookup failed for arXiv:{arxiv_id}")
    focus_id = _require_s2_focus_identity(focus, arxiv_id)
    provider, rate_delay = build_provider()
    logger.info("LLM provider: %s; focus arxiv=%s depth=%d", provider.name, arxiv_id, depth)
    aliases = [["arxiv", arxiv_id], ["semantic_scholar", focus_id]]
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
    nodes[focus_id]["seed_paper_id"] = seed_paper_id
    nodes[focus_id]["aliases"] = aliases

    classifications_path = CACHE_DIR / "classifications.json"
    classifications: dict[str, dict] = (
        json.loads(classifications_path.read_text()) if classifications_path.exists() else {}
    )

    def expand(src_paper: dict, direction: str, top_n: int) -> list[tuple[dict, dict]]:
        """Returns list of (related_paper, edge_dict) for this hop."""
        s2_id = src_paper["paperId"]
        kind = "references" if direction == "up" else "citations"
        related = fetch_related_by_id(s2_id, kind, top_n)
        logger.info(
            "  %-60s %s → %d %s",
            src_paper.get("title", "")[:60],
            direction,
            len(related),
            kind,
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
                a, b = rel, src_paper  # parent → child
                edge_src, edge_dst = rel_id, s2_id
            else:
                a, b = src_paper, rel  # focus/self → child
                edge_src, edge_dst = s2_id, rel_id
            cls = _classify_cached(
                provider,
                a,
                b,
                src_id=edge_src,
                dst_id=edge_dst,
                classifications=classifications,
                cache_path=classifications_path,
                rate_delay=rate_delay,
            )
            if cls is None or cls["relation"] == "unrelated":
                continue
            edge = {
                "src": edge_src,
                "dst": edge_dst,
                "rel": cls["relation"],
                "relation": cls["relation"],
                "conf": cls["confidence"],
                "confidence": cls["confidence"],
                "rationale": cls["rationale"],
                "provenance": cls["provenance"],
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

    for node in nodes.values():
        node.setdefault("is_focus", False)
    ordered_nodes = sorted(nodes.values(), key=lambda node: node["id"])
    ordered_edges = sorted(edges, key=lambda edge: (edge["src"], edge["dst"], edge["relation"]))
    result = {
        "schema_version": LINEAGE_ARTIFACT_VERSION,
        "root": focus_id,
        "nodes": ordered_nodes,
        "edges": ordered_edges,
        "clusters": [],
        "meta": {
            "source": "build_deep_lineage.py",
            "kind": "deep",
            "generator": _PRODUCER_NAME,
            "arxiv_id": arxiv_id,
            "seed_paper_id": seed_paper_id,
            "aliases": aliases,
            "depth": depth,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    }
    issues = validate_lineage_artifact(
        result,
        kind="deep",
        catalog_ids={seed_paper_id},
        expected_seed_paper_id=seed_paper_id,
    )
    if issues:
        detail = "; ".join(f"{issue.code}:{issue.path}" for issue in issues[:8])
        raise ValueError(f"generated lineage violates {LINEAGE_ARTIFACT_VERSION}: {detail}")
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--arxiv-id", required=True, help="arXiv id of the focus paper (e.g. 2602.18473)"
    )
    ap.add_argument(
        "--seed-paper-id",
        required=True,
        help="Canonical 40-hex paper_id from the conference catalog",
    )
    ap.add_argument("--depth", type=int, default=2, help="BFS depth in each direction (default: 2)")
    ap.add_argument(
        "--top-parents",
        type=int,
        default=20,
        help="Max references per seed at depth 1 (halved at deeper levels)",
    )
    ap.add_argument(
        "--top-children",
        type=int,
        default=20,
        help="Max citations per seed at depth 1 (halved at deeper levels)",
    )
    ap.add_argument(
        "--venue-override", default="ICLR 2026", help="Pretty venue label for the focus node"
    )
    ap.add_argument("--tier-override", default="A+", help="Venue tier override for the focus node")
    ap.add_argument(
        "--output",
        default=None,
        help="Output JSON path (default: docs/iclr-2026/deep-<arxiv_id>.json)",
    )
    args = ap.parse_args()

    setup_logging()  # CLI mode: surface logger.info to stderr.

    result = build_deep(
        args.arxiv_id,
        seed_paper_id=args.seed_paper_id,
        depth=args.depth,
        top_parents=args.top_parents,
        top_children=args.top_children,
        venue_override=args.venue_override,
        tier_override=args.tier_override,
    )

    output = args.output or f"docs/iclr-2026/deep-{result['meta']['arxiv_id']}.json"
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

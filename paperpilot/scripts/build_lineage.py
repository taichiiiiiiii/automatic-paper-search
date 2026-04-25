"""Build a real lineage graph for a conference's Oral papers.

For each Oral paper in docs/<conference>/papers.json:
  1. Resolve to a Semantic Scholar paperId via arXiv ID.
  2. Fetch top-N references (parents) and citations (children) from S2.
  3. Classify each (focus, related) pair via an AbstractLLMProvider into one of:
     supersedes / successor / extends / ablation / baseline_only / contrasts / unrelated.
  4. Persist results to docs/<conference>/lineage.json.

LLM providers are selected in this order (first key present wins):
    PAPERPILOT_GROQ_API_KEY  → GroqProvider (free, 30 RPM, default)
    PAPERPILOT_GEMINI_API_KEY → GeminiProvider (free tier 10 RPM)

Per absolute rule §11, LLM calls MUST go through `AbstractLLMProvider` —
never via urllib / requests directly. See CLAUDE.md.

Per absolute rule §12 (family-tree exception): S2 `references` / `citations`
fetches are allowed here because the citation graph is not in Stage 2
output. The focus paper's `venue` / `citation_count` / `github_stars`
still come from `papers.json` — we only use S2 for edge structure plus
neighbour titles/authors.

The script caches intermediate state (S2 lookups, classified edges) so re-runs
are fast and only fetch what's missing.

Usage (default --conference iclr-2026):
  python paperpilot/scripts/build_lineage.py
  python paperpilot/scripts/build_lineage.py --limit 3                  # smoke test
  python paperpilot/scripts/build_lineage.py --conference neurips-2025  # other venues
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, TypedDict


class ClusterEntry(TypedDict):
    id: str
    label: str
    focus_ids: list[str]

# Make `paperpilot.llm` importable when run as `python paperpilot/scripts/...`
# without editable-install-on-path.
ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from paperpilot.llm import (  # noqa: E402
    AbstractLLMProvider,
    GeminiProvider,
    GroqProvider,
    RelationClassification,
)
from paperpilot.scripts._common import slug_to_venue_label  # noqa: E402
from paperpilot.utils.http import request_with_retry  # noqa: E402
from paperpilot.utils.logger import get_logger, setup_logging  # noqa: E402

logger = get_logger(__name__)

DOCS_ROOT = ROOT / "docs"

# Legacy default path constants — kept so existing test monkeypatches keep
# working. New code should call resolve_paths(conference) instead.
PAPERS_PATH = DOCS_ROOT / "iclr-2026" / "papers.json"
OUTPUT_PATH = DOCS_ROOT / "iclr-2026" / "lineage.json"
CACHE_DIR = ROOT / "paperpilot" / "data" / "lineage-cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def resolve_paths(conference: str) -> tuple[Path, Path]:
    """Return (papers_json_path, lineage_json_path) for a conference slug."""
    conf_dir = DOCS_ROOT / conference
    return conf_dir / "papers.json", conf_dir / "lineage.json"


# Backwards compat: test_build_lineage imports derive_venue_label. Keep
# the name as a thin alias to the shared helper so the public surface
# of this module is unchanged.
derive_venue_label = slug_to_venue_label

# Knobs
TOP_PARENTS = 15
TOP_CHILDREN = 15
S2_RATE_DELAY = 3.5   # unauth quota is harsh; stay well under

# Cluster (topics view) constants. Focus papers missing any kind tag are
# bucketed into "uncategorized" so the gallery never hides them.
_UNCATEGORIZED_ID = "uncategorized"
_UNCATEGORIZED_LABEL = "その他"


def _cluster_slug(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    return slug or _UNCATEGORIZED_ID

# Per-provider cadence between classify calls. The provider itself already
# handles 429 backoff via request_with_retry; this is a baseline RPM limiter
# so we don't trigger retries in the first place.
LLM_RATE_DELAY = {
    "groq": 2.2,    # ~27 RPM (Groq free tier: 30 RPM)
    "gemini": 7.0,  # ~8 RPM (Gemini 2.5-flash free tier: 10 RPM)
}

# Match on S2's full venue names as lowercase substrings.
VENUE_TIER_MAP = [
    # Tier A+ (top ML / CV / NLP)
    ("neural information processing systems", "A+"),
    ("international conference on machine learning", "A+"),
    ("international conference on learning representations", "A+"),
    ("computer vision and pattern recognition", "A+"),
    ("european conference on computer vision", "A+"),
    ("international conference on computer vision", "A+"),
    ("annual meeting of the association for computational linguistics", "A+"),
    ("empirical methods in natural language processing", "A+"),
    # Abbreviated aliases (for rare papers where S2 uses short form)
    ("neurips", "A+"), ("icml", "A+"), ("iclr", "A+"),
    ("cvpr", "A+"), ("eccv", "A+"), ("iccv", "A+"),
    ("acl", "A+"), ("emnlp", "A+"),
    # Tier A
    ("north american chapter of the association for computational linguistics", "A"),
    ("aaai conference on artificial intelligence", "A"),
    ("conference on robot learning", "A"),
    ("robotics: science and systems", "A"),
    ("knowledge discovery and data mining", "A"),
    ("trans. mach. learn. res.", "A"),
    ("journal of machine learning research", "A"),
    ("naacl", "A"), ("aaai", "A"), ("kdd", "A"),
    ("tmlr", "A"), ("corl", "A"), ("sigir", "A"),
    ("www", "A"), ("ijcai", "A"),
]


# ---------- Provider selection ----------


def build_provider() -> tuple[AbstractLLMProvider, float]:
    """Pick the first available LLM provider and return (provider, rate_delay).

    Groq takes precedence because it has the most generous free tier for
    the classification workload (hundreds of calls per lineage build).

    Env lookup goes through `utils.config_loader.load_env` so the pipeline
    and scripts share one mapping from PAPERPILOT_* vars to the secrets
    dict. Tests can patch `load_env` directly to avoid relying on the
    ambient environment (and on whatever is in paperpilot/.env).
    """
    from paperpilot.utils.config_loader import load_env

    env = load_env(ROOT / "paperpilot" / ".env")
    # Unprefixed names are accepted as a convenience for users running
    # one-off scripts with ambient credentials (e.g. `GROQ_API_KEY=... python ...`).
    groq_key = env.get("groq_api_key") or os.environ.get("GROQ_API_KEY")
    gemini_key = env.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")

    # Annotate explicitly as the base class so mypy accepts either concrete
    # subclass on the way back out of the tuple.
    provider: AbstractLLMProvider
    if groq_key:
        model = env.get("groq_model") or "llama-3.3-70b-versatile"
        provider = GroqProvider(
            {"enabled": True, "model": model, "temperature": 0.1, "timeout_seconds": 30},
            api_key=groq_key,
        )
        return provider, LLM_RATE_DELAY["groq"]

    if gemini_key:
        model = env.get("gemini_model") or "gemini-2.5-flash"
        provider = GeminiProvider(
            {"enabled": True, "model": model, "temperature": 0.1, "timeout_seconds": 30},
            api_key=gemini_key,
        )
        return provider, LLM_RATE_DELAY["gemini"]

    sys.exit(
        "No LLM key found. Set PAPERPILOT_GROQ_API_KEY (preferred) "
        "or PAPERPILOT_GEMINI_API_KEY."
    )


# ---------- S2 helpers ----------

# Field lists sent to the S2 Graph API. Scoped to this block since they
# are implementation details of the two fetch helpers below — callers
# outside the module should never need them.
_S2_FIELDS_PAPER = (
    "paperId,title,year,venue,citationCount,referenceCount,authors,abstract,externalIds"
)
_S2_FIELDS_REL = "paperId,title,year,venue,citationCount,authors,abstract,externalIds"


def _s2_get(url: str) -> dict[str, Any] | None:
    """GET an S2 JSON endpoint, returning the parsed body or None.

    Delegates retry / backoff to utils.http.request_with_retry so the
    retry policy matches the rest of the pipeline (design doc §6.2
    Table 17). 404 is treated as "not found" (None); any other non-200
    is logged upstream and returned as None.
    """
    resp = request_with_retry(
        "GET",
        url,
        headers={"User-Agent": "PaperPilot/0.1"},
        timeout=20,
    )
    if resp is None:
        return None
    if resp.status_code == 200:
        try:
            payload = resp.json()
        except ValueError:
            return None
        # S2 always returns a JSON object for the endpoints we call; narrowing
        # here keeps the return type honest for mypy and guards against the
        # rare case of an error wrapper coming back as a top-level list.
        return payload if isinstance(payload, dict) else None
    # 404 / 4xx / non-retryable → treat as "not found", silently skip.
    return None


def fetch_paper_by_arxiv(arxiv_id: str) -> dict[str, Any] | None:
    cache = CACHE_DIR / f"paper_{arxiv_id}.json"
    if cache.exists():
        cached = json.loads(cache.read_text())
        return cached if isinstance(cached, dict) else None
    url = f"https://api.semanticscholar.org/graph/v1/paper/arXiv:{arxiv_id}?fields={_S2_FIELDS_PAPER}"
    data = _s2_get(url)
    if data:
        cache.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    time.sleep(S2_RATE_DELAY)
    return data


def fetch_related(s2_id: str, kind: str, limit: int) -> list[dict[str, Any]]:
    """kind = 'references' or 'citations'."""
    cache = CACHE_DIR / f"{kind}_{s2_id}.json"
    if cache.exists():
        cached = json.loads(cache.read_text())
        return cached if isinstance(cached, list) else []
    url = (
        f"https://api.semanticscholar.org/graph/v1/paper/{s2_id}/{kind}"
        f"?fields={_S2_FIELDS_REL}&limit={min(limit * 4, 100)}"
    )
    data = _s2_get(url) or {}
    items = []
    inner_key = "citedPaper" if kind == "references" else "citingPaper"
    # `or []` not just default arg: S2 occasionally returns {"data": null}
    # for papers whose neighbour list is empty — `.get("data", [])` would
    # then yield None and crash the loop.
    for entry in data.get("data") or []:
        p = entry.get(inner_key)
        if p and p.get("paperId") and p.get("title"):
            items.append(p)
    cache.write_text(json.dumps(items, ensure_ascii=False, indent=2))
    time.sleep(S2_RATE_DELAY)
    return items


def select_top(items: list[dict], n: int) -> list[dict]:
    """Sort by citationCount descending, take top n. Filter out items with no abstract."""
    scored = [it for it in items if it.get("abstract")]
    scored.sort(key=lambda x: x.get("citationCount") or 0, reverse=True)
    return scored[:n]


# ---------- Build pipeline ----------

def venue_tier_for(venue: str) -> str:
    if not venue:
        return "preprint"
    v = venue.lower()
    for substring, tier in VENUE_TIER_MAP:
        if substring in v:
            return tier
    return "preprint"


def to_node(
    paper: dict,
    *,
    focus: bool = False,
    trending: bool = False,
    kinds: list[str] | None = None,
    override_venue: str | None = None,
    override_tier: str | None = None,
    catalog_citations: int | None = None,
    catalog_stars: int | None = None,
) -> dict:
    venue = override_venue or (paper.get("venue") or "arXiv").strip() or "arXiv"
    tier = override_tier or venue_tier_for(paper.get("venue") or "")
    tldr = (paper.get("abstract") or "")[:140].strip()
    # Avoid cutting in the middle of a word
    if tldr and len(paper.get("abstract", "")) > 140:
        last_space = tldr.rfind(" ")
        if last_space > 80:
            tldr = tldr[:last_space] + "…"
    # Catalog (Stage 2) values win when provided; otherwise use S2's response
    # so related nodes still have citation counts for the viewer to size on.
    citation_count = (
        catalog_citations
        if catalog_citations is not None
        else (paper.get("citationCount") or 0)
    )
    github_stars = catalog_stars if catalog_stars is not None else 0
    return {
        "id": paper["paperId"],
        "title": paper["title"],
        "year": paper.get("year"),
        "venue": venue,
        "venue_tier": tier,
        "authors": [a.get("name", "") for a in (paper.get("authors") or [])][:5],
        "kinds": kinds or [],
        "citation_count": citation_count,
        "github_stars": github_stars,
        "tldr": tldr,
        **({"is_focus": True} if focus else {}),
        **({"is_trending": True} if trending else {}),
    }


def extract_arxiv_id(arxiv_url: str) -> str | None:
    m = re.search(r"arxiv\.org/abs/([\d\.]+)", arxiv_url or "")
    return m.group(1) if m else None


def _classify_cached(
    provider: AbstractLLMProvider,
    a: dict,
    b: dict,
    *,
    cache_key: str,
    classifications: dict[str, dict],
    cache_path: Path,
    rate_delay: float,
) -> dict | None:
    """Classify via provider with persistent cache keyed by (src, dst)."""
    if cache_key in classifications:
        return classifications[cache_key]
    rc: RelationClassification | None = provider.classify_relation(a, b)
    if rc is not None:
        entry = {
            "relation": rc.relation,
            "confidence": rc.confidence,
            "rationale": rc.rationale,
        }
        classifications[cache_key] = entry
        cache_path.write_text(
            json.dumps(classifications, ensure_ascii=False, indent=2)
        )
    time.sleep(rate_delay)
    return classifications.get(cache_key)


def build(
    *,
    limit: int | None = None,
    conference: str = "iclr-2026",
    venue_override: str | None = None,
) -> dict:
    provider, rate_delay = build_provider()
    logger.info("LLM provider: %s", provider.name)

    papers_path, _ = resolve_paths(conference)
    venue_label = venue_override or derive_venue_label(conference)

    papers = json.loads(papers_path.read_text())
    orals = [p for p in papers if p.get("type") == "Oral"]
    if limit:
        orals = orals[:limit]

    logger.info("Building lineage for %d Oral papers (%s)", len(orals), conference)

    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    classification_cache_path = CACHE_DIR / "classifications.json"
    classifications: dict[str, dict] = (
        json.loads(classification_cache_path.read_text())
        if classification_cache_path.exists()
        else {}
    )

    for idx, paper in enumerate(orals, 1):
        # Trust papers.json's structured arxiv_id (carried forward from
        # Stage 2 in C4) before falling back to regex-extracting it from
        # the URL — this keeps us resilient to URL format variations
        # ("/pdf/2404.00001v3") and is cheaper.
        arxiv_id = paper.get("arxiv_id") or extract_arxiv_id(paper.get("arxiv_url", ""))
        if not arxiv_id:
            logger.warning(
                "[%d/%d] SKIP (no arxiv_id): %s",
                idx, len(orals), paper["title"][:60],
            )
            continue

        logger.info(
            "[%d/%d] %s: %s",
            idx, len(orals), arxiv_id, paper["title"][:60],
        )
        focus_paper = fetch_paper_by_arxiv(arxiv_id)
        if not focus_paper:
            logger.warning("  S2 lookup failed for %s", arxiv_id)
            continue

        focus_id = focus_paper["paperId"]
        # Catalog says these are ICLR 2026 Oral — S2 only knows them as arXiv
        # preprints, so override for the focus nodes.
        catalog_kinds = paper.get("tags", [])[:3] or ["empirical"]
        # Forward Stage 2 signals (#23). S2's citation count on arXiv preprints
        # is often zero / stale for recently-accepted papers.
        catalog_citations = paper.get("citation_count")
        catalog_stars = paper.get("github_stars")
        nodes[focus_id] = to_node(
            focus_paper,
            focus=True,
            kinds=catalog_kinds,
            override_venue=venue_label,
            override_tier="A+",
            catalog_citations=catalog_citations if isinstance(catalog_citations, int) else None,
            catalog_stars=catalog_stars if isinstance(catalog_stars, int) else None,
        )

        parents = select_top(fetch_related(focus_id, "references", TOP_PARENTS * 4), TOP_PARENTS)
        children = select_top(fetch_related(focus_id, "citations", TOP_CHILDREN * 4), TOP_CHILDREN)
        logger.info("  parents=%d children=%d", len(parents), len(children))

        for parent in parents:
            pid = parent["paperId"]
            if pid not in nodes:
                nodes[pid] = to_node(parent)
            cls = _classify_cached(
                provider, parent, focus_paper,
                cache_key=f"{pid}->{focus_id}",
                classifications=classifications,
                cache_path=classification_cache_path,
                rate_delay=rate_delay,
            )
            if cls and cls["relation"] != "unrelated":
                edges.append({
                    "src": pid, "dst": focus_id,
                    "rel": cls["relation"],
                    "conf": cls["confidence"],
                    "rationale": cls["rationale"],
                })

        for child in children:
            cid = child["paperId"]
            if cid not in nodes:
                nodes[cid] = to_node(child)
            cls = _classify_cached(
                provider, focus_paper, child,
                cache_key=f"{focus_id}->{cid}",
                classifications=classifications,
                cache_path=classification_cache_path,
                rate_delay=rate_delay,
            )
            if cls and cls["relation"] != "unrelated":
                edges.append({
                    "src": focus_id, "dst": cid,
                    "rel": cls["relation"],
                    "conf": cls["confidence"],
                    "rationale": cls["rationale"],
                })

    # Root = focus paper with the most relationships (best default landing focus)
    edge_count: dict[str, int] = {}
    for e in edges:
        edge_count[e["src"]] = edge_count.get(e["src"], 0) + 1
        edge_count[e["dst"]] = edge_count.get(e["dst"], 0) + 1
    focus_ids = [nid for nid, n in nodes.items() if n.get("is_focus")]
    root_id = (
        max(focus_ids, key=lambda nid: edge_count.get(nid, 0))
        if focus_ids else (next(iter(nodes)) if nodes else None)
    )

    # Drop edges without a rationale — a silent empty tooltip is worse than no edge.
    # (RelationClassification.from_dict already rejects these, but belt-and-braces.)
    cleaned_edges = [e for e in edges if (e.get("rationale") or "").strip()]
    dropped = len(edges) - len(cleaned_edges)
    if dropped:
        logger.warning("dropped %d edges with empty rationale", dropped)

    clusters = build_clusters(list(nodes.values()))

    return {
        "root": root_id,
        "nodes": list(nodes.values()),
        "edges": cleaned_edges,
        "clusters": clusters,
    }


# Why: the viewer groups focus papers by primary subfield so readers can drill
# from "which areas dominate Oral" into individual per-paper family trees.
# Focus papers with multiple tags are placed in their first tag's cluster only
# to keep the taxonomy disjoint (simpler mental model than cross-listing).
def build_clusters(nodes: list[dict]) -> list[ClusterEntry]:
    """Group focus papers by their primary tag into subfield clusters.

    Returns a list of `ClusterEntry` sorted by member count descending,
    then alphabetically by label. Non-focus nodes are ignored — they
    belong to whatever tree their focus owns.

    Keyed internally by label (not slug) so labels that collapse to the
    same slug (e.g., "A+" and "A-" both → "a") remain separate clusters.
    Cluster `id`s are disambiguated with a numeric suffix on collision.
    """
    by_label: dict[str, list[str]] = {}
    for n in nodes:
        if not n.get("is_focus"):
            continue
        kinds = n.get("kinds") or []
        label = kinds[0] if kinds else _UNCATEGORIZED_LABEL
        by_label.setdefault(label, []).append(n["id"])

    entries: list[ClusterEntry] = []
    used_ids: set[str] = set()
    # Visit labels in sort order so id disambiguation is deterministic even
    # when focus_ids order varies between runs.
    for label in sorted(by_label, key=lambda lbl: (-len(by_label[lbl]), lbl)):
        base = _UNCATEGORIZED_ID if label == _UNCATEGORIZED_LABEL else _cluster_slug(label)
        cid = base
        suffix = 2
        while cid in used_ids:
            cid = f"{base}-{suffix}"
            suffix += 1
        used_ids.add(cid)
        entries.append(
            {
                "id": cid,
                "label": label,
                "focus_ids": sorted(by_label[label]),
            }
        )
    return entries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None,
                        help="Process only first N Oral papers (smoke test)")
    parser.add_argument("--conference", default="iclr-2026",
                        help="Conference slug under docs/ (default: iclr-2026)")
    parser.add_argument("--venue-override",
                        help="Pretty venue label for focus nodes "
                             "(default: upper-case slug, e.g. 'ICLR 2026')")
    args = parser.parse_args()

    setup_logging()  # CLI mode: surface logger.info to stderr.

    result = build(
        limit=args.limit,
        conference=args.conference,
        venue_override=args.venue_override,
    )
    _, output_path = resolve_paths(args.conference)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))

    print()
    print(f"✓ Wrote {output_path}")
    print(f"  conference: {args.conference}")
    print(f"  nodes: {len(result['nodes'])}")
    print(f"  edges: {len(result['edges'])}")
    rels: dict[str, int] = {}
    for e in result["edges"]:
        rels[e["rel"]] = rels.get(e["rel"], 0) + 1
    for k, v in sorted(rels.items(), key=lambda x: -x[1]):
        print(f"    {k}: {v}")


if __name__ == "__main__":
    main()

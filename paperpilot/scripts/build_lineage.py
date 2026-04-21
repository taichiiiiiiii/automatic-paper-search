"""Build a real lineage graph for ICLR 2026 Oral papers.

For each Oral paper:
  1. Resolve to a Semantic Scholar paperId via arXiv ID.
  2. Fetch top-N references (parents) and citations (children) from S2.
  3. Classify each (focus, related) pair via an AbstractLLMProvider into one of:
     supersedes / successor / extends / ablation / baseline_only / contrasts / unrelated.
  4. Persist results to docs/iclr-2026/lineage.json.

LLM providers are selected in this order (first key present wins):
    PAPERPILOT_GROQ_API_KEY  → GroqProvider (free, 30 RPM, default)
    PAPERPILOT_GEMINI_API_KEY → GeminiProvider (free tier 10 RPM)

Per absolute rule §11, LLM calls MUST go through `AbstractLLMProvider` —
never via urllib / requests directly. See CLAUDE.md.

The script caches intermediate state (S2 lookups, classified edges) so re-runs
are fast and only fetch what's missing.

Usage:
  python paperpilot/scripts/build_lineage.py
  python paperpilot/scripts/build_lineage.py --limit 3   # quick smoke test
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

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
from paperpilot.utils.http import request_with_retry  # noqa: E402

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


def derive_venue_label(conference: str) -> str:
    """Turn a conference slug ("iclr-2026") into a human-readable venue ("ICLR 2026").

    Slugs use kebab-case and lowercase acronyms; the viewer expects the
    upper-case year-separated form. Acronym casing is not preserved
    (neurips-2025 → NEURIPS 2025) — callers that need cased names can
    pass a --venue-override explicitly on the command line.
    """
    return conference.upper().replace("-", " ")

S2_FIELDS_PAPER = "paperId,title,year,venue,citationCount,referenceCount,authors,abstract,externalIds"
S2_FIELDS_REL = "paperId,title,year,venue,citationCount,authors,abstract,externalIds"

# Knobs
TOP_PARENTS = 15
TOP_CHILDREN = 15
S2_RATE_DELAY = 3.5   # unauth quota is harsh; stay well under

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

def _load_env() -> None:
    """Best-effort .env loader so keys flow from paperpilot/.env."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    env_path = ROOT / "paperpilot" / ".env"
    if env_path.exists():
        load_dotenv(env_path)


def build_provider() -> tuple[AbstractLLMProvider, float]:
    """Pick the first available LLM provider and return (provider, rate_delay).

    Groq takes precedence because it has the most generous free tier for
    the classification workload (hundreds of calls per lineage build).
    """
    _load_env()
    groq_key = os.environ.get("PAPERPILOT_GROQ_API_KEY") or os.environ.get("GROQ_API_KEY")
    gemini_key = os.environ.get("PAPERPILOT_GEMINI_API_KEY") or os.environ.get("GEMINI_API_KEY")

    if groq_key:
        model = os.environ.get("PAPERPILOT_GROQ_MODEL", "llama-3.3-70b-versatile")
        provider = GroqProvider(
            {"enabled": True, "model": model, "temperature": 0.1, "timeout_seconds": 30},
            api_key=groq_key,
        )
        return provider, LLM_RATE_DELAY["groq"]

    if gemini_key:
        model = os.environ.get("PAPERPILOT_GEMINI_MODEL", "gemini-2.5-flash")
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
            return resp.json()
        except ValueError:
            return None
    # 404 / 4xx / non-retryable → treat as "not found", silently skip.
    return None


def fetch_paper_by_arxiv(arxiv_id: str) -> dict[str, Any] | None:
    cache = CACHE_DIR / f"paper_{arxiv_id}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    url = f"https://api.semanticscholar.org/graph/v1/paper/arXiv:{arxiv_id}?fields={S2_FIELDS_PAPER}"
    data = _s2_get(url)
    if data:
        cache.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    time.sleep(S2_RATE_DELAY)
    return data


def fetch_related(s2_id: str, kind: str, limit: int) -> list[dict[str, Any]]:
    """kind = 'references' or 'citations'."""
    cache = CACHE_DIR / f"{kind}_{s2_id}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    url = (
        f"https://api.semanticscholar.org/graph/v1/paper/{s2_id}/{kind}"
        f"?fields={S2_FIELDS_REL}&limit={min(limit * 4, 100)}"
    )
    data = _s2_get(url) or {}
    items = []
    inner_key = "citedPaper" if kind == "references" else "citingPaper"
    for entry in data.get("data", []):
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
    print(f"LLM provider: {provider.name}")

    papers_path, _ = resolve_paths(conference)
    venue_label = venue_override or derive_venue_label(conference)

    papers = json.loads(papers_path.read_text())
    orals = [p for p in papers if p.get("type") == "Oral"]
    if limit:
        orals = orals[:limit]

    print(f"Building lineage for {len(orals)} Oral papers ({conference})")

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
            print(f"[{idx}/{len(orals)}] SKIP (no arxiv_id): {paper['title'][:60]}")
            continue

        print(f"[{idx}/{len(orals)}] {arxiv_id}: {paper['title'][:60]}")
        focus_paper = fetch_paper_by_arxiv(arxiv_id)
        if not focus_paper:
            print("  ⚠ S2 lookup failed")
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
        print(f"  parents={len(parents)}, children={len(children)}")

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
        print(f"  dropped {dropped} edges with empty rationale")

    return {
        "root": root_id,
        "nodes": list(nodes.values()),
        "edges": cleaned_edges,
    }


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

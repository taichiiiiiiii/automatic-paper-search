"""Build a chronological family tree for a free-text research theme.

Pipeline:
  1. Sanitise the theme (strip control chars, cap length).
  2. Expand the theme into related keywords via AbstractLLMProvider.
  3. For each keyword, GET S2 ``/paper/search`` → dedupe by paperId →
     filter by ``--since-year`` → sort by citationCount desc → take
     ``--seeds`` papers as the focus set.
  4. BFS ancestors for each seed up to ``--depth`` hops via
     ``build_lineage.fetch_related``.
  5. Classify each ``(parent, child)`` edge through
     ``provider.classify_relation``; drop ``unrelated`` and edges with
     empty rationale (silent tooltips are worse than no edge).
  6. Sort nodes by year ascending so the chronological viewer's
     rank-based Y axis renders deterministically.
  7. Write to ``docs/themes/<slug>/lineage.json`` (run
     ``generate_themes_manifest.py`` afterwards to refresh the picker).

Per CLAUDE.md absolute rules:
  - §11: All LLM calls go through ``AbstractLLMProvider`` (never
    urllib / requests directly to Groq / Gemini / Claude).
  - §14 (new): This script is the sole writer of
    ``docs/themes/<slug>/lineage.json``; the slug is derived from the
    theme via ``theme_slug()`` and is the only thing spliced into the
    output path. The raw ``--theme`` string never reaches a ``Path``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Make `paperpilot.*` importable when run as `python paperpilot/scripts/...`
ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from paperpilot.scripts._common import theme_slug  # noqa: E402
from paperpilot.scripts.build_lineage import (  # noqa: E402
    CACHE_DIR,
    _classify_cached,
    build_provider,
    fetch_related,
    to_node,
)
from paperpilot.utils.http import request_with_retry  # noqa: E402
from paperpilot.utils.keyword_expand import expand_keywords  # noqa: E402

DOCS_ROOT = ROOT / "docs"

_S2_FIELDS_SEARCH = (
    "paperId,title,year,venue,citationCount,authors,abstract,externalIds"
)
_S2_SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
_S2_SEARCH_LIMIT = 50

_THEME_MAX_LEN = 500
_KEYWORD_EXPANSIONS = 8


# ---------- Theme input ----------


def sanitize_theme(theme: str) -> str:
    """Strip control characters, trim whitespace, validate length.

    Why: ``--theme`` is free-form text that flows into the LLM prompt
    (``expand_keywords``), the S2 query string, and (after slug
    derivation) the filesystem path / URL param. Control chars enable
    prompt-injection tricks like fake instruction breaks; very long
    inputs trigger slow / 414-rejected S2 queries with noisy retries.

    Raises:
        ValueError: input is empty / whitespace-only after stripping
        control characters, or exceeds ``_THEME_MAX_LEN``.
    """
    if not theme:
        raise ValueError("theme must be non-empty")
    cleaned = "".join(c for c in theme if unicodedata.category(c)[0] != "C")
    cleaned = cleaned.strip()
    if not cleaned:
        raise ValueError("theme is empty after stripping control chars / whitespace")
    if len(cleaned) > _THEME_MAX_LEN:
        raise ValueError(
            f"theme exceeds {_THEME_MAX_LEN} chars (got {len(cleaned)})"
        )
    return cleaned


# ---------- Seed discovery ----------


def _seed_cache_path(keyword: str, since_year: int | None) -> Path:
    """Stable cache filename for a (keyword, since_year) pair.

    Uses a short SHA-1 prefix instead of slugifying the keyword so
    near-duplicates that collapse to the same slug stay distinct, and
    the filename is filesystem-safe regardless of unicode in the
    keyword.
    """
    digest = hashlib.sha1(keyword.lower().strip().encode("utf-8")).hexdigest()[:12]
    suffix = f"y{since_year}" if since_year is not None else "yany"
    return CACHE_DIR / f"search_{digest}_{suffix}.json"


def discover_seeds(
    *,
    keywords: list[str],
    top_n: int,
    since_year: int | None,
) -> list[dict[str, Any]]:
    """Find seed papers for the theme via S2 ``/paper/search``.

    Calls the search endpoint once per keyword, dedupes by paperId,
    filters by ``since_year``, sorts by citationCount desc, returns
    top ``top_n``. Each per-keyword call is cached to disk (mirrors
    ``fetch_related``'s cache pattern in build_lineage.py) so re-runs
    are cheap.

    Network failures (resp is None / non-200) are written as an empty
    cache entry — same fail-safe behaviour as the rest of the pipeline.
    """
    by_id: dict[str, dict[str, Any]] = {}

    for kw in keywords:
        if not kw or not kw.strip():
            continue
        cache = _seed_cache_path(kw, since_year)
        if cache.exists():
            try:
                cached = json.loads(cache.read_text())
            except json.JSONDecodeError:
                cached = []
            if isinstance(cached, list):
                for p in cached:
                    if isinstance(p, dict) and p.get("paperId"):
                        by_id.setdefault(p["paperId"], p)
            continue

        params = {
            "query": kw,
            "fields": _S2_FIELDS_SEARCH,
            "limit": _S2_SEARCH_LIMIT,
        }
        resp = request_with_retry(
            "GET",
            _S2_SEARCH_URL,
            params=params,
            headers={"User-Agent": "PaperPilot/0.1"},
            timeout=20,
        )
        cache.parent.mkdir(parents=True, exist_ok=True)
        if resp is None or resp.status_code != 200:
            cache.write_text("[]")
            continue
        try:
            payload = resp.json()
        except ValueError:
            payload = {}
        items: list[dict[str, Any]] = []
        for p in payload.get("data") or []:
            if isinstance(p, dict) and p.get("paperId") and p.get("title"):
                items.append(p)
                by_id.setdefault(p["paperId"], p)
        cache.write_text(json.dumps(items, ensure_ascii=False, indent=2))

    candidates = list(by_id.values())
    if since_year is not None:
        candidates = [
            p for p in candidates
            if isinstance(p.get("year"), int) and p["year"] >= since_year
        ]
    candidates.sort(key=lambda p: p.get("citationCount") or 0, reverse=True)
    return candidates[:top_n]


# ---------- Build pipeline ----------


def build_theme_lineage(
    *,
    theme: str,
    depth: int,
    seeds_count: int,
    width: int,
    since_year: int | None,
    output: Path | None = None,
) -> Path:
    """Run the full theme-to-family-tree pipeline; return the output path."""
    sanitised = sanitize_theme(theme)
    slug = theme_slug(sanitised)

    provider, rate_delay = build_provider()
    print(f"theme: {sanitised}")
    print(f"slug:  {slug}")
    print(f"provider: {provider.name}")

    # Stage 1: keyword expansion (returns originals if provider unavailable).
    keywords = expand_keywords(
        [sanitised], provider, max_expansions=_KEYWORD_EXPANSIONS
    )
    print(f"keywords ({len(keywords)}): {keywords}")

    # Stage 2: discover seeds.
    seeds = discover_seeds(
        keywords=keywords, top_n=seeds_count, since_year=since_year
    )
    print(f"seeds ({len(seeds)}): {[s.get('paperId') for s in seeds]}")

    # Stage 3: BFS ancestors via fetch_related (build_lineage's cache reused).
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    classification_cache_path = CACHE_DIR / "classifications.json"
    classifications: dict[str, dict] = (
        json.loads(classification_cache_path.read_text())
        if classification_cache_path.exists()
        else {}
    )

    seed_ids: list[str] = []
    frontier: list[tuple[dict, int]] = []
    for seed in seeds:
        sid = seed["paperId"]
        nodes[sid] = to_node(seed, focus=True)
        seed_ids.append(sid)
        frontier.append((seed, 0))

    visited: set[str] = set(seed_ids)
    while frontier:
        current, current_depth = frontier.pop(0)
        if current_depth >= depth:
            continue

        # Pull a wide pool, then narrow by citation count — same heuristic
        # build_deep_lineage uses to keep BFS cost bounded.
        parents = fetch_related(current["paperId"], "references", width * 4)
        parents = [p for p in parents if p.get("abstract")]
        parents.sort(key=lambda x: x.get("citationCount") or 0, reverse=True)
        parents = parents[:width]

        for parent in parents:
            pid = parent.get("paperId")
            if not pid:
                continue
            if pid not in nodes:
                nodes[pid] = to_node(parent)
            cls = _classify_cached(
                provider,
                parent,
                current,
                cache_key=f"{pid}->{current['paperId']}",
                classifications=classifications,
                cache_path=classification_cache_path,
                rate_delay=rate_delay,
            )
            if cls and cls["relation"] != "unrelated":
                edges.append(
                    {
                        "src": pid,
                        "dst": current["paperId"],
                        "rel": cls["relation"],
                        "conf": cls["confidence"],
                        "rationale": cls["rationale"],
                    }
                )
            if pid not in visited:
                visited.add(pid)
                frontier.append((parent, current_depth + 1))

    # Stage 4: drop edges with empty rationale (matches build_lineage policy).
    cleaned_edges = [e for e in edges if (e.get("rationale") or "").strip()]
    dropped = len(edges) - len(cleaned_edges)
    if dropped:
        print(f"  dropped {dropped} edges with empty rationale")

    # Stage 5: pick root = focus seed with most relations.
    root_id: str | None
    if seed_ids:
        edge_count: dict[str, int] = {}
        for e in cleaned_edges:
            edge_count[e["src"]] = edge_count.get(e["src"], 0) + 1
            edge_count[e["dst"]] = edge_count.get(e["dst"], 0) + 1
        root_id = max(seed_ids, key=lambda nid: edge_count.get(nid, 0))
    else:
        root_id = None

    # Stage 6: sort nodes by year ascending (None years sink to the bottom).
    sorted_nodes = sorted(
        nodes.values(),
        key=lambda n: (
            n.get("year") if isinstance(n.get("year"), int) else 9999,
            -(n.get("citation_count") or 0),
        ),
    )

    payload = {
        "root": root_id,
        "nodes": sorted_nodes,
        "edges": cleaned_edges,
        "meta": {
            "source": "build_theme_lineage.py",
            "theme": sanitised,
            "slug": slug,
            "keywords": keywords,
            "seeds": seed_ids,
            "depth": depth,
            "since_year": since_year,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
    }

    out_path = output if output is not None else (
        DOCS_ROOT / "themes" / slug / "lineage.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"✓ Wrote {out_path}")
    print(
        f"  nodes: {len(sorted_nodes)}, edges: {len(cleaned_edges)}, "
        f"root: {root_id}"
    )
    return out_path


# ---------- CLI ----------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--theme", required=True,
        help="Free-text research theme (e.g. 'Mixture of Experts').",
    )
    ap.add_argument(
        "--depth", type=int, default=2,
        help="BFS depth from each seed (default 2).",
    )
    ap.add_argument(
        "--seeds", type=int, default=8, dest="seeds_count",
        help="Number of seed papers from the theme search (default 8).",
    )
    ap.add_argument(
        "--width", type=int, default=8,
        help="Max parents fetched per BFS hop (default 8).",
    )
    ap.add_argument(
        "--since-year", type=int, default=None, dest="since_year",
        help="Only consider papers with year >= this value.",
    )
    ap.add_argument(
        "--output", default=None,
        help="Override output path (default docs/themes/<slug>/lineage.json). "
             "Intended for CI / tests — bypasses the theme_slug() gate, so do "
             "not use with untrusted input.",
    )
    args = ap.parse_args(argv)

    # Validate theme up-front so a bad CLI value fails fast with a clear
    # message — long pipelines that error out half-way are a bad UX.
    try:
        sanitize_theme(args.theme)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    output = Path(args.output) if args.output else None
    try:
        build_theme_lineage(
            theme=args.theme,
            depth=args.depth,
            seeds_count=args.seeds_count,
            width=args.width,
            since_year=args.since_year,
            output=output,
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

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
from collections.abc import Callable, Iterable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# Make `paperpilot.*` importable when run as `python paperpilot/scripts/...`
ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from paperpilot.scripts._common import theme_slug  # noqa: E402
from paperpilot.scripts.build_lineage import (  # noqa: E402
    CACHE_DIR,
    build_provider,
    fetch_related,
    to_node,
)
from paperpilot.utils.config_loader import load_env  # noqa: E402
from paperpilot.utils.github import (  # noqa: E402
    fetch_repo_stars,
    load_curated_map,
    parse_github_repo_url,
    search_repo_by_title,
)
from paperpilot.utils.http import request_with_retry  # noqa: E402
from paperpilot.utils.logger import get_logger, setup_logging  # noqa: E402

logger = get_logger(__name__)

DOCS_ROOT = ROOT / "docs"

_S2_FIELDS_SEARCH = (
    "paperId,title,year,venue,citationCount,authors,abstract,externalIds"
)
_S2_SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
_S2_SEARCH_LIMIT = 50

# OpenAlex fallback for seed discovery. /paper/search on S2's free tier
# is the steady-state failure point on GitHub Actions — the shared IP
# pool is throttled by S2 — so a 429 there nukes the entire build. We
# fall back to OpenAlex's /works (free, no key, much higher per-IP
# allowance) and resolve the DOIs through S2's /paper/batch endpoint,
# which has a separate budget from /paper/search.
_OPENALEX_WORKS_URL = "https://api.openalex.org/works"
_S2_BATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/batch"
_OPENALEX_PER_PAGE_MAX = 200
# /paper/batch caps at 500 ids per call (https://api.semanticscholar.org
# /api-docs/graph#tag/Paper-Data/operation/post_graph_get_papers); cap our
# own send to half of that so even a wide OpenAlex page can never overflow.
_S2_BATCH_MAX_IDS = 250

_THEME_MAX_LEN = 500
_KEYWORD_EXPANSIONS = 8

# Cross-node lookup (#54) only checks for in-graph hits, so 100 refs is
# more than enough to surface any cohort-internal citation. fetch_related
# already caps at 100 (S2's per-page max).
_CROSS_NODE_LIMIT = 100

# Trending threshold (#68): citations / year for *recent* papers.
# Limiting to the last 3 years keeps the badge meaning "fast-moving
# right now" — not "established classic". 200 cites/year for a 2024
# paper means ~600 cites by mid-2026, well above noise.
_TRENDING_VELOCITY_THRESHOLD = 200.0
_TRENDING_AGE_LIMIT_YEARS = 3


def _is_trending(paper: dict, current_year: int) -> bool:
    """True when citation velocity (cites/year) clears the threshold AND
    the paper is recent enough that "trending" makes sense. ResNet has
    a high velocity too, but it's a 10-year-old classic — calling it
    trending dilutes the signal for genuinely hot 2024–2026 papers.
    """
    cit = paper.get("citationCount") or 0
    year = paper.get("year")
    if not isinstance(year, int) or year > current_year:
        return False
    age = current_year - year
    if age > _TRENDING_AGE_LIMIT_YEARS:
        return False
    # 0.5y floor guards against same-year div; widen to float deliberately.
    age_years: float = max(float(age), 0.5)
    return (cit / age_years) >= _TRENDING_VELOCITY_THRESHOLD


# Issue #53: heuristic templates that mirror build_deep_lineage's lenient
# fallback rationales. derive_relation() picks one based on S2's intent
# array so we get a non-empty rationale for free (the stage-4 'drop empty
# rationale' filter would otherwise silently kill every derived edge).
_INTENT_RELATION_MAP: list[tuple[str, str, str]] = [
    # (intent name, relation enum, rationale template) — order matters:
    # methodology > result > background when an entry has multiple
    # intents, since methodology implies the citing paper actually built
    # on top of the referenced work.
    ("methodology", "extends",
     "論文 B は論文 A の手法を異なる領域・タスク・スケールに拡張している。"),
    ("result", "successor",
     "論文 B は論文 A の研究ラインを継承し自然に発展させている。"),
    ("background", "baseline_only",
     "論文 B は論文 A をベースライン比較にのみ用いている。"),
]
_DEFAULT_DERIVED = (
    "extends",
    "論文 B は論文 A の手法を異なる領域・タスク・スケールに拡張している。",
)
_DERIVED_CONFIDENCE = 0.7  # constant — heuristic, not LLM probability


def _add_cross_node_edges(
    nodes: dict[str, dict],
    edges: list[dict],
    *,
    seed_ids: set[str] | None = None,
    cohort_min_year: int | None = None,
) -> int:
    """Find citation links between nodes already in the graph.

    Issue #54 / #55: BFS only emits (parent → seed) edges, but the
    collected node set frequently contains intra-cohort citations — e.g.
    one 2024 paper citing another 2024 paper that's also a seed, or two
    parents where one cites the other.

    Issue #55 followup: when `seed_ids` and/or `cohort_min_year` are
    given, only emit edges where at least one endpoint is a seed *or* a
    paper from the requested cohort year. This stops foundational papers
    (ResNet ↔ U-Net) from polluting the view with many old-year arrows
    the user didn't ask for.

    Returns the number of edges added.
    """
    existing = {(e["src"], e["dst"]) for e in edges}
    node_ids = set(nodes.keys())
    seed_ids = seed_ids or set()
    added = 0

    def _is_anchor(nid: str) -> bool:
        if nid in seed_ids:
            return True
        if cohort_min_year is None:
            return True  # no constraint configured → accept all
        year = nodes.get(nid, {}).get("year")
        return isinstance(year, int) and year >= cohort_min_year

    for citing_id in list(node_ids):
        try:
            refs = fetch_related(citing_id, "references", _CROSS_NODE_LIMIT)
        except Exception as exc:  # pragma: no cover - S2 fail-safe
            logger.warning("cross-node: fetch_related failed for %s: %s", citing_id, exc)
            continue
        for ref in refs:
            ref_id = ref.get("paperId")
            if ref_id not in node_ids:
                continue
            if ref_id == citing_id:
                # S2 occasionally lists a paper among its own references
                # (data anomaly); a self-loop in the chronological tree
                # would render as a degenerate edge.
                continue
            # Anchor constraint: at least one endpoint must be a seed or
            # a cohort-year paper. Skip pure ancestor↔ancestor edges.
            if not (_is_anchor(citing_id) or _is_anchor(ref_id)):
                continue
            # Edge convention is parent → child. References = ancestors;
            # cited paper is the parent (= ref), citing paper is the
            # child (= node already in graph).
            edge_key = (ref_id, citing_id)
            if edge_key in existing:
                continue
            citing_node = nodes.get(citing_id)
            cls = derive_relation(ref, parent=ref, child=citing_node)
            if cls is None:
                continue
            edges.append({
                "src": ref_id,
                "dst": citing_id,
                "rel": cls["relation"],
                "conf": cls["confidence"],
                "rationale": cls["rationale"],
            })
            existing.add(edge_key)
            added += 1
    return added


def derive_relation(
    intent_record: dict,
    *,
    parent: dict | None = None,
    child: dict | None = None,
) -> dict | None:
    """Heuristic LLM-free relation classifier.

    ``intent_record`` is the S2 paper dict that carries the
    ``_is_influential`` / ``_intents`` fields lifted by ``fetch_related``.
    ``parent`` (older) and ``child`` (newer) are the two endpoints of
    the edge — used for the year / citation heuristic when intents
    don't pin down a category.

    Direction conventions:
      * BFS (references): the cited paper carries intents; parent =
        intent_record, child = the citing paper currently being processed.
      * Descendants (citations): the citing paper carries intents;
        parent = the seed, child = intent_record (the citer).
      * Cross-node: parent = intent_record (cited), child = the citing
        node already in the graph.

    Returns ``None`` when S2 flagged the citation as non-influential.

    #80: refines the previous default-everything-to-``extends`` path
    with a year + citation contrast pass that picks ``supersedes`` /
    ``successor`` / ``contrasts`` / ``ablation`` when intents are
    missing. Cuts the "all extends" appearance the user reported on
    the SemSeg tree.
    """
    if intent_record.get("_is_influential") is False:
        return None
    intents = intent_record.get("_intents") or []
    intents_set = {str(i).lower() for i in intents if isinstance(i, str)}
    for keyword, relation, rationale in _INTENT_RELATION_MAP:
        if keyword in intents_set:
            return _make_derived(relation, rationale)

    # No intents — try year + citation contrast.
    if parent is not None and child is not None:
        py = parent.get("year")
        cy = child.get("year")
        pc = parent.get("citationCount") or parent.get("citation_count") or 0
        cc = child.get("citationCount") or child.get("citation_count") or 0
        if isinstance(py, int) and isinstance(cy, int):
            delta = cy - py
            if delta >= 3 and pc > 100 and cc >= pc * 1.5:
                return _make_derived(
                    "supersedes",
                    "論文 B は論文 A の手法を置き換える改良版として提案されている。",
                )
            if delta <= 1 and pc > 100 and 0.5 <= cc / max(pc, 1) <= 2.0:
                return _make_derived(
                    "contrasts",
                    "論文 B は論文 A と根本的に異なるアプローチを提案している。",
                )
            if delta <= 2 and cc < 100 and pc > 1000:
                return _make_derived(
                    "ablation",
                    "論文 B は論文 A の構成要素を分析・ablation している。",
                )
            if 1 <= delta <= 5:
                return _make_derived(
                    "successor",
                    "論文 B は論文 A の研究ラインを継承し自然に発展させている。",
                )
    relation, rationale = _DEFAULT_DERIVED
    return _make_derived(relation, rationale)


def _make_derived(relation: str, rationale: str) -> dict:
    return {
        "relation": relation,
        "confidence": _DERIVED_CONFIDENCE,
        "rationale": rationale,
    }


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


_DOI_HOSTS = frozenset({"doi.org", "www.doi.org", "dx.doi.org"})


def _extract_doi(work: dict) -> str | None:
    """Pull the bare DOI (no URL prefix) out of an OpenAlex Work dict.

    OpenAlex returns DOIs as full URLs (``https://doi.org/10.x/y``) in
    both the top-level ``doi`` field and ``ids.doi``. Older records
    occasionally carry ``http://`` or ``dx.doi.org`` host variants.
    S2's ``/paper/batch`` expects the prefix ``DOI:10.x/y`` — passing
    the URL form yields a "No valid paper ids given" parser error
    (verified in branch commit history). Use ``urlparse`` so all
    scheme/host variants collapse to the bare DOI; if the input
    already arrives as a bare DOI (no scheme) it passes through.
    """
    raw = work.get("doi") or (work.get("ids") or {}).get("doi")
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    if not raw:
        return None
    parsed = urlparse(raw)
    # When the input is a doi.org URL (any scheme/case variant), pull the
    # path. Bare DOI ("10.x/y") or non-doi.org URLs pass through — S2
    # rejects truly malformed values downstream.
    bare = (
        parsed.path.lstrip("/")
        if parsed.scheme and parsed.netloc.lower() in _DOI_HOSTS
        else raw
    )
    bare = bare.strip()
    return bare or None


def discover_seeds_via_openalex(
    *,
    query: str,
    top_n: int,
    since_year: int | None,
    email: str | None = None,
) -> list[dict[str, Any]]:
    """Search OpenAlex ``/works`` for the theme; return raw Work dicts.

    OpenAlex is the primary fallback when S2 ``/paper/search`` throttles
    on shared CI runner IPs — its rate budget is independent and far
    more permissive (10 req/sec free, 100k/day in the polite pool).
    Returned works carry DOIs which the caller resolves through S2
    ``/paper/batch`` to obtain S2-shape paper dicts that the rest of
    the pipeline (BFS, classification) can consume unchanged.

    The ``mailto`` polite-pool query param is sent when ``email`` is
    provided. OpenAlex puts polite-pool requests on a separate, more
    reliable queue under load — required for batch CI runs.

    Returns ``[]`` on any error (None response / non-200 / parse fail)
    so callers degrade gracefully instead of crashing the pipeline.
    """
    if not query or not query.strip():
        return []
    # Pull a wider page than top_n so dedup against any S2 hits still
    # leaves headroom; the pipeline truncates to top_n at the end.
    page_size = max(top_n * 3, 25)
    page_size = min(page_size, _OPENALEX_PER_PAGE_MAX)

    params: dict[str, Any] = {
        "search": query,
        "per-page": page_size,
        "sort": "cited_by_count:desc",
    }
    if since_year is not None:
        params["filter"] = f"from_publication_date:{since_year}-01-01"
    if email:
        params["mailto"] = email

    resp = request_with_retry(
        "GET",
        _OPENALEX_WORKS_URL,
        params=params,
        headers={"User-Agent": "PaperPilot/0.1"},
        timeout=20,
    )
    if resp is None or resp.status_code != 200:
        logger.warning(
            "openalex search failed (status=%s) — fallback contributes 0 seeds",
            getattr(resp, "status_code", None),
        )
        return []
    try:
        payload = resp.json()
    except ValueError as exc:
        logger.warning("openalex JSON parse failed: %s", exc)
        return []
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, list):
        return []
    return [w for w in results if isinstance(w, dict)]


def _resolve_openalex_to_s2(works: list[dict]) -> list[dict[str, Any]]:
    """POST OpenAlex DOIs to S2 ``/paper/batch``; return S2-shape dicts.

    Uses ``/paper/batch`` (one request, up to 500 ids) instead of N
    parallel ``/paper/{id}`` lookups because batch counts as a single
    call against the shared-IP rate limit on GitHub Actions runners
    (S2's primary throttle vector for this pipeline). Works without a
    DOI are silently skipped — they cannot be resolved through this
    endpoint.

    Returns ``[]`` on error (None response, non-200, parse fail) so
    callers can fall through to whatever S2 search managed to surface.
    """
    ids: list[str] = []
    for work in works:
        doi = _extract_doi(work)
        if not doi:
            continue
        ids.append(f"DOI:{doi}")
        if len(ids) >= _S2_BATCH_MAX_IDS:
            break
    if not ids:
        return []

    resp = request_with_retry(
        "POST",
        _S2_BATCH_URL,
        params={"fields": _S2_FIELDS_SEARCH},
        json_body={"ids": ids},
        headers={"User-Agent": "PaperPilot/0.1"},
        timeout=30,
    )
    if resp is None or resp.status_code != 200:
        logger.warning(
            "S2 /paper/batch failed (status=%s) — OpenAlex DOIs unresolved",
            getattr(resp, "status_code", None),
        )
        return []
    try:
        data = resp.json()
    except ValueError as exc:
        logger.warning("S2 /paper/batch JSON parse failed: %s", exc)
        return []
    if not isinstance(data, list):
        return []
    # /paper/batch returns nulls in-place for unmatched ids; drop them.
    resolved: list[dict[str, Any]] = []
    for entry in data:
        if isinstance(entry, dict) and entry.get("paperId") and entry.get("title"):
            resolved.append(entry)
    return resolved


def discover_seeds(
    *,
    keywords: list[str],
    top_n: int,
    since_year: int | None,
    use_openalex_fallback: bool = True,
    openalex_email: str | None = None,
) -> list[dict[str, Any]]:
    """Find seed papers for the theme via S2 ``/paper/search``.

    Calls the search endpoint once per keyword, dedupes by paperId,
    filters by ``since_year``, sorts by citationCount desc, returns
    top ``top_n``. Each per-keyword call is cached to disk (mirrors
    ``fetch_related``'s cache pattern in build_lineage.py) so re-runs
    are cheap.

    Network failures (resp is None / non-200) are written as an empty
    cache entry — same fail-safe behaviour as the rest of the pipeline.

    OpenAlex fallback (``use_openalex_fallback=True``, default): when
    S2 yields fewer than ``top_n`` seeds — the steady-state failure
    mode on shared GitHub Actions runner IPs throttled by S2 — search
    OpenAlex for the theme, resolve the resulting DOIs through S2
    ``/paper/batch`` (separate rate budget from ``/paper/search``),
    and merge the new papers in (dedup by paperId). ``openalex_email``
    enables OpenAlex's polite pool for higher reliability under load.
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

    primary = _rank_and_truncate(by_id.values(), top_n=top_n, since_year=since_year)
    if not use_openalex_fallback or len(primary) >= top_n:
        return primary

    # Fallback path: top up the seed pool when S2 alone wasn't enough.
    # Build the OpenAlex query from all non-empty keywords; for the
    # current single-keyword default (theme as one keyword) this
    # collapses to the theme string itself.
    query = " ".join(k for k in keywords if k and k.strip())
    if not query:
        return primary
    logger.info(
        "S2 yielded %d/%d seeds; trying OpenAlex fallback (theme=%r)",
        len(primary), top_n, query,
    )
    works = discover_seeds_via_openalex(
        query=query,
        top_n=top_n,
        since_year=since_year,
        email=openalex_email,
    )
    if not works:
        return primary
    resolved = _resolve_openalex_to_s2(works)
    if not resolved:
        return primary

    for paper in resolved:
        pid = paper.get("paperId")
        if pid and pid not in by_id:
            by_id[pid] = paper

    merged = _rank_and_truncate(by_id.values(), top_n=top_n, since_year=since_year)
    logger.info(
        "OpenAlex fallback added %d new seeds (final=%d)",
        len(merged) - len(primary), len(merged),
    )
    return merged


def _rank_and_truncate(
    papers: Iterable[dict[str, Any]],
    *,
    top_n: int,
    since_year: int | None,
) -> list[dict[str, Any]]:
    """Apply since_year filter, sort by citationCount desc, return top_n.

    Extracted so the S2-only path and the merged-with-OpenAlex path
    share identical filtering and ranking semantics — otherwise the
    fallback could surface a paper that the primary path would have
    rejected, producing surprising before/after deltas in the seed list.
    """
    candidates = list(papers)
    if since_year is not None:
        candidates = [
            p for p in candidates
            if isinstance(p.get("year"), int) and p["year"] >= since_year
        ]
    candidates.sort(key=lambda p: p.get("citationCount") or 0, reverse=True)
    return candidates[:top_n]


# ---------- GitHub stars enrichment ----------

# Conference lineage gets stars from papers.json (Stage 2 catalog), but the
# theme pipeline crawls S2 directly so to_node() always sees stars=0.
# This post-pass resolves arxiv_id -> GitHub repo via two layers and then
# fetches the live star count from the GitHub API:
#
#   1. paperpilot/data/paper_repos.json — curated arxiv_id -> "owner/repo"
#      mapping. Hand-maintained, 100% accurate within coverage.
#   2. GitHub Search — paper title fed into /search/repositories with a
#      title-similarity filter so a "Segment Anything" paper does not
#      accidentally pick up a tutorial repo.
#
# Why not Papers with Code: PwC was permanently shut down in 2026 (every
# paperswithcode.com URL 302-redirects to huggingface.co/papers/trending,
# and the production-media data dumps return TLS errors / 404). The HF
# papers endpoint does not expose a githubRepo field, so we cannot just
# swap one third-party for another.
_GITHUB_CACHE_FILE = "github_stars.json"
_GITHUB_CACHE_TTL_DAYS = 7
# Default budget covers a typical theme (~50–60 nodes) without burning
# GitHub's hourly quota. Curated hits use 1 GitHub API call each; search
# fallbacks use 2 (search + repo). 80 lookups -> at most ~160 calls, well
# inside the 5000/h PAT limit. Without a PAT the unauthenticated cap is
# 60/h overall (10/min for search) so the operator should set
# PAPERPILOT_GITHUB_TOKEN for bulk regen.
_GITHUB_DEFAULT_BUDGET = 80


def _enrich_github_stars(
    nodes: dict[str, dict],
    *,
    max_lookups: int = _GITHUB_DEFAULT_BUDGET,
    github_token: str | None = None,
    curated: dict[str, str] | None = None,
    fetch_stars: Callable[..., int | None] | None = None,
    search_repo: Callable[..., str | None] | None = None,
) -> int:
    """Resolve GitHub stars for theme nodes that have an arxiv_id.

    Resolution order (per node, until a repo is found):
      1. ``curated[arxiv_id]`` — hand-maintained mapping in
         ``paperpilot/data/paper_repos.json``.
      2. ``search_repo(title)`` — GitHub Search by paper title with a
         title-similarity filter (``_TITLE_SIM_THRESHOLD``) to avoid
         false positives on common-word titles.

    Once a repo is resolved, ``fetch_stars`` returns the live stargazer
    count. The trio of resolvers is exposed as parameters for tests; the
    defaults wire up the real GitHub API.

    Side-effects: mutates ``nodes`` in-place, setting ``github_stars``
    and ``github_url`` on resolved entries. Persists a JSON cache at
    ``CACHE_DIR/github_stars.json`` so subsequent runs reuse fresh
    lookups (TTL = ``_GITHUB_CACHE_TTL_DAYS``).

    Returns the count of nodes whose final ``github_stars`` > 0
    (cache hits + freshly resolved).
    """
    cache_path = CACHE_DIR / _GITHUB_CACHE_FILE
    cache: dict[str, dict] = {}
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text())
        except (OSError, json.JSONDecodeError):
            cache = {}

    if curated is None:
        curated = load_curated_map()
    fetch = fetch_stars or fetch_repo_stars
    search = search_repo or search_repo_by_title

    fresh_cutoff = (
        datetime.now(timezone.utc) - timedelta(days=_GITHUB_CACHE_TTL_DAYS)
    ).isoformat()

    enriched = 0
    targets: list[tuple[dict, str]] = []  # (node, arxiv_id)
    for node in nodes.values():
        ax = node.get("arxiv_id")
        if not ax:
            continue
        cached = cache.get(ax)
        if cached and cached.get("fetched_at", "") >= fresh_cutoff:
            # A corrupted cache entry (e.g. stars="abc" or stars=[1,2])
            # would crash the enrichment loop here; fall back to 0 so
            # the run continues and the entry is refreshed on next pass.
            try:
                stars = int(cached.get("stars") or 0)
            except (ValueError, TypeError):
                stars = 0
            if stars > 0:
                node["github_stars"] = stars
                cached_url = cached.get("url")
                # Re-validate the cached URL through the same parser the
                # write path uses. A poisoned cache entry (corrupt file
                # or attacker-supplied) cannot inject ``javascript:`` /
                # ``data:`` / off-host URLs into the generated
                # lineage.json this way — only well-formed
                # ``https://github.com/owner/repo`` URLs survive.
                if cached_url and parse_github_repo_url(cached_url):
                    node["github_url"] = cached_url
                enriched += 1
            continue
        targets.append((node, ax))

    if not targets:
        return enriched

    # Slice to the lookup budget BEFORE issuing any API call. Papers past
    # the budget are NOT cached as 0 — they re-enter the queue on the
    # next run instead of being suppressed for the full TTL window.
    looked_up = targets[:max_lookups]

    fetched_ts = datetime.now(timezone.utc).isoformat()
    # Tally resolution paths separately from fetch outcomes:
    #   curated_hits / search_hits  → which layer found a repo
    #   stars_positive               → how many of those resolved repos
    #                                  ended up with stars > 0
    # Bookkeeping at resolution time (rather than inside a stars > 0
    # branch) means the log line stays correct even when a curated
    # repo turned out to be private / deleted / 0-starred.
    curated_hits = 0
    search_hits = 0
    stars_positive = 0
    for node, ax in looked_up:
        # 1. Curated map (authoritative).
        repo_full = curated.get(ax)
        if repo_full:
            curated_hits += 1
        else:
            # 2. GitHub Search fallback for everything else.
            try:
                repo_full = search(node.get("title") or "", github_token=github_token)
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug("search_repo failed for %s: %s", ax, exc)
                repo_full = None
            if repo_full:
                search_hits += 1

        stars = 0
        url: str | None = None
        if repo_full:
            try:
                fetched = fetch(repo_full, github_token=github_token)
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug("fetch_stars failed for %s: %s", repo_full, exc)
                fetched = None
            if fetched is not None and fetched > 0:
                stars = int(fetched)
                url = f"https://github.com/{repo_full}"
                stars_positive += 1

        # Cache the result regardless of stars value — caching 0 prevents
        # weekly re-querying for papers without a public GitHub repo.
        cache[ax] = {
            "stars": stars,
            "url": url,
            "fetched_at": fetched_ts,
        }
        if stars > 0:
            node["github_stars"] = stars
            if url:
                node["github_url"] = url
            enriched += 1

    if curated_hits or search_hits:
        logger.info(
            "github stars resolution: curated=%d, search=%d, stars>0=%d "
            "(of %d looked up)",
            curated_hits,
            search_hits,
            stars_positive,
            len(looked_up),
        )

    # Atomic write so concurrent theme runs don't tear the cache.
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=2))
        tmp.replace(cache_path)
    except OSError as exc:
        logger.warning("failed to persist github_stars cache: %s", exc)

    return enriched


# ---------- Build pipeline ----------


def build_theme_lineage(
    *,
    theme: str,
    depth: int,
    seeds_count: int,
    width: int,
    since_year: int | None,
    output: Path | None = None,
    use_openalex_fallback: bool = True,
) -> Path:
    """Run the full theme-to-family-tree pipeline; return the output path."""
    sanitised = sanitize_theme(theme)
    slug = theme_slug(sanitised)

    # Load env once at the top — both the seed-discovery fallback
    # (openalex_email) and the github-stars enrichment further down
    # (github_token) read from the same env dict.
    try:
        env = load_env()
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("load_env failed (continuing with empty env): %s", exc)
        env = {}
    openalex_email = (env or {}).get("openalex_email")

    # Issue #53: relation classification is now LLM-free (derive_relation),
    # but build_provider is still used downstream by other scripts; here
    # we no longer need it for the theme pipeline. Keep the call so the
    # provider is constructed (logs config errors etc.) but we won't ever
    # invoke .classify_relation / ._chat from this script.
    provider, _ = build_provider()
    logger.info("theme=%r slug=%r provider=%s (LLM-free path)",
                sanitised, slug, provider.name)

    # Stage 1: keyword expansion is skipped — the LLM call here was the
    # last reason this script needed a working provider. Use the raw
    # theme as the single search keyword. Multi-keyword expansion was
    # nice for seed diversity but is no longer worth a TPM-burdened
    # round-trip; the theme name itself is usually the strongest signal
    # (per the DPO experience where 1-keyword fallback still produced
    # good seeds when paired with citation-desc ranking).
    keywords = [sanitised]
    logger.info("using raw theme as single keyword: %r", keywords[0])

    # Stage 2: discover seeds.
    seeds = discover_seeds(
        keywords=keywords,
        top_n=seeds_count,
        since_year=since_year,
        use_openalex_fallback=use_openalex_fallback,
        openalex_email=openalex_email,
    )
    logger.info(
        "discovered %d seeds: %s",
        len(seeds),
        [s.get("paperId") for s in seeds],
    )

    # Stage 3: BFS ancestors via fetch_related (build_lineage's cache reused).
    nodes: dict[str, dict] = {}
    edges: list[dict] = []

    # #68: stamp the build year so _is_trending() can compute citation
    # velocity. Single fetch keeps every node's badge consistent.
    current_year = datetime.now(timezone.utc).year

    seed_ids: list[str] = []
    frontier: list[tuple[dict, int]] = []
    for seed in seeds:
        sid = seed["paperId"]
        nodes[sid] = to_node(
            seed, focus=True, trending=_is_trending(seed, current_year)
        )
        seed_ids.append(sid)
        frontier.append((seed, 0))

    # Issue #45: silent fallback masking (LLM quota / RPM throttling)
    # produced 0-edges themes during bulk runs. Track classify outcomes
    # so we can warn loudly at the end of the build.
    classify_attempted = 0
    classify_succeeded = 0

    visited: set[str] = set(seed_ids)
    while frontier:
        current, current_depth = frontier.pop(0)
        if current_depth >= depth:
            continue

        # Pull a wide pool, prioritise influential refs, then fall back to
        # citation-count desc — same heuristic build_deep_lineage uses to
        # keep BFS cost bounded.
        all_parents = fetch_related(current["paperId"], "references", width * 4)
        all_parents = [p for p in all_parents if p.get("abstract")]

        # Issue #50 (followup): the previous order — sort all by citationCount
        # then filter by isInfluential — let foundational papers (ResNet,
        # Transformer, etc.) dominate the top-N and crowd out the actually-
        # influential niche refs. Partition first so the LLM budget hits the
        # specific refs the citing paper built upon, then top-up with high-
        # citation candidates if there's room left.
        influential = [
            p for p in all_parents if p.get("_is_influential") is not False
        ]
        non_influential = [
            p for p in all_parents if p.get("_is_influential") is False
        ]
        influential.sort(key=lambda x: x.get("citationCount") or 0, reverse=True)
        non_influential.sort(key=lambda x: x.get("citationCount") or 0, reverse=True)
        parents = (influential + non_influential)[:width]

        for parent in parents:
            pid = parent.get("paperId")
            if not pid:
                continue
            if pid not in nodes:
                nodes[pid] = to_node(
                    parent, trending=_is_trending(parent, current_year)
                )
            # Issue #53: derive the relation from S2 intents instead of
            # firing an LLM classify call. derive_relation() returns None
            # when S2 says the parent is non-influential (we drop the
            # edge), and otherwise picks a relation enum + rationale by
            # mapping the intents array via _INTENT_RELATION_MAP.
            classify_attempted += 1
            # BFS: parent (cited) carries intents; current is the citing
            # child being processed (parent → current edge).
            cls = derive_relation(parent, parent=parent, child=current)
            if cls is not None:
                classify_succeeded += 1
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

    # Issue #55: descendants direction. BFS only goes UP (parents) so the
    # graph cuts off at the seed year — newer papers that cite the seeds
    # (and represent the field's *next* step) never appear. Fetch each
    # seed's top-N citing papers, add them as nodes, and emit seed → child
    # edges. derive_relation() handles the relation type from intents.
    desc_added = 0
    # Descendants intentionally use a tighter cap than parents (#56): a
    # popular seed paper has hundreds of citers and the chronological
    # viewer rendered them as a 26-paper-wide row. Keep the budget to
    # half the BFS width so the recent-year side of the tree stays
    # readable. Halve the parent width but keep at least 4.
    desc_width = max(width // 2, 4)
    for seed in seeds:
        sid = seed["paperId"]
        # Wide pool then influential-first, citation-count desc — mirrors
        # the parent partition above so descendants stay quality-anchored.
        all_children = fetch_related(sid, "citations", desc_width * 4)
        all_children = [c for c in all_children if c.get("abstract")]
        influential = [c for c in all_children if c.get("_is_influential") is not False]
        non_influential = [c for c in all_children if c.get("_is_influential") is False]
        influential.sort(key=lambda x: x.get("citationCount") or 0, reverse=True)
        non_influential.sort(key=lambda x: x.get("citationCount") or 0, reverse=True)
        children = (influential + non_influential)[:desc_width]

        for child in children:
            cid = child.get("paperId")
            if not cid or cid == sid:
                continue
            if cid not in nodes:
                nodes[cid] = to_node(
                    child, trending=_is_trending(child, current_year)
                )
            # Descendants direction: seed → child edge. The CHILD carries
            # intents (S2 citations endpoint annotates the citing paper).
            # parent=seed (older), child=child (newer) for year/cite logic.
            cls = derive_relation(child, parent=seed, child=child)
            if cls is None:
                continue
            if any(e["src"] == sid and e["dst"] == cid for e in edges):
                continue
            edges.append({
                "src": sid,
                "dst": cid,
                "rel": cls["relation"],
                "conf": cls["confidence"],
                "rationale": cls["rationale"],
            })
            desc_added += 1
    if desc_added:
        logger.info(
            "descendants pass added %d edges (seed → newer citing papers)",
            desc_added,
        )

    # Issue #54 / #57: cross-node edges. The BFS only adds (parent → seed)
    # edges, so two seeds that cite each other, or a parent that cites
    # another parent in the same graph, never produce a visible relation.
    # Scan the full collected node set against each node's references and
    # add any in-graph citation links we find — purely a cache + Python
    # operation (no LLM, references fetched from disk cache when present).
    #
    # Issue #57 reverted: the cohort-anchor constraint introduced earlier
    # was over-aggressive — it hid foundational-era cross-references the
    # user wanted visible ("全体的に矢印を作成して"). Re-enable the
    # full pass; volume is acceptable given the seeded influence filter
    # already culls non-influential refs upstream.
    cross_added = _add_cross_node_edges(nodes, edges)
    if cross_added:
        logger.info(
            "cross-node pass added %d edges (in-graph citations not seen by BFS)",
            cross_added,
        )

    # GitHub stars enrichment (issue #89). Conference lineage pulls stars
    # from papers.json; the theme pipeline crawls S2 directly so every
    # node had stars=0 — the ⭐ row in the viewer never rendered. Look up
    # via PwC + GitHub for nodes that carry an arxiv_id, with a 7-day
    # disk cache so the weekly cron doesn't re-query the whole graph.
    # `env` was loaded at the top of build_theme_lineage().
    github_token = (env or {}).get("github_token")
    github_added = _enrich_github_stars(nodes, github_token=github_token)
    if github_added:
        logger.info(
            "github stars: enriched %d nodes (cache + fresh)", github_added
        )

    # Stage 4: drop edges with empty rationale (matches build_lineage policy).
    cleaned_edges = [e for e in edges if (e.get("rationale") or "").strip()]
    dropped = len(edges) - len(cleaned_edges)
    if dropped:
        logger.warning("dropped %d edges with empty rationale", dropped)

    # Issue #45: surface LLM-failure rate so silent quota throttling
    # doesn't hide as a successful "0 edges" build in CI logs.
    classify_failed = classify_attempted - classify_succeeded
    fail_rate = classify_failed / classify_attempted if classify_attempted else 0.0
    logger.info(
        "classify summary: attempted=%d, success=%d, failed=%d (%.1f%% failure)",
        classify_attempted,
        classify_succeeded,
        classify_failed,
        fail_rate * 100,
    )
    if classify_attempted and fail_rate > 0.30:
        logger.warning(
            "high LLM failure rate (%.1f%%) — likely Groq RPM/daily quota; "
            "consider re-running after quota resets",
            fail_rate * 100,
        )
    # All parents skipped by the isInfluential filter (#50) — produces a
    # node-only graph that looks healthy but is structurally empty.
    # Surface this distinct from the LLM-quota path so the operator can
    # widen the seed pool / loosen the filter rather than wait for quota.
    if classify_attempted == 0 and len(nodes) > len(seed_ids):
        logger.warning(
            "no classify calls attempted — every parent was filtered out "
            "(non-influential per S2). Theme may be too narrow."
        )
    if not cleaned_edges:
        logger.warning(
            "produced 0 edges — data quality is degraded; the JSON is still "
            "written but the viewer will show nodes only. See issue #45."
        )

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
    logger.info(
        "wrote %s (nodes=%d edges=%d root=%s)",
        out_path,
        len(sorted_nodes),
        len(cleaned_edges),
        root_id,
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
    ap.add_argument(
        "--no-openalex-fallback",
        dest="use_openalex_fallback",
        action="store_false",
        default=True,
        help="Disable the OpenAlex fallback used when S2 /paper/search "
             "returns < seeds_count results (e.g. on throttled CI IPs). "
             "By default the fallback runs whenever S2 alone is short.",
    )
    args = ap.parse_args(argv)

    # CLI invocations need an explicit setup_logging() call (collector.py
    # does the same in its main); without it Python's root defaults to
    # WARNING and our logger.info progress messages would silently drop.
    setup_logging()

    # Validate theme up-front so a bad CLI value fails fast with a clear
    # message — long pipelines that error out half-way are a bad UX.
    try:
        sanitize_theme(args.theme)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    output = Path(args.output) if args.output else None
    try:
        out_path = build_theme_lineage(
            theme=args.theme,
            depth=args.depth,
            seeds_count=args.seeds_count,
            width=args.width,
            since_year=args.since_year,
            output=output,
            use_openalex_fallback=args.use_openalex_fallback,
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    # Issue #45: non-fatal exit code 3 distinguishes "ran cleanly but
    # produced no edges" from a normal success. CI / bulk scripts can
    # detect this and trigger an alert without having to grep logs.
    try:
        payload = json.loads(out_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        # The file was just written by build_theme_lineage(); failing to
        # read it back means a write race / disk error. Don't mask that
        # as success — let CI see exit 2 and surface the cause.
        print(
            f"error: cannot re-read just-written {out_path}: {exc}",
            file=sys.stderr,
        )
        return 2
    if not payload.get("edges"):
        print(
            "warning: 0 edges produced — output written but viewer will show "
            "nodes only. Re-run after LLM quota resets (see issue #45).",
            file=sys.stderr,
        )
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())

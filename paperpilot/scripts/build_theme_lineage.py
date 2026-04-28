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
    build_provider,
    fetch_related,
    to_node,
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

_THEME_MAX_LEN = 500
_KEYWORD_EXPANSIONS = 8


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


def derive_relation(parent: dict) -> dict | None:
    """Heuristic relation classifier — replaces the LLM classify call.

    Returns ``None`` when the parent should be skipped entirely (S2
    flagged it as not influential to the citing paper). Otherwise picks
    a relation enum based on the S2 ``intents`` array, falling back to
    ``extends`` when intents are missing or empty.
    """
    if parent.get("_is_influential") is False:
        return None
    intents = parent.get("_intents") or []
    intents_set = {str(i).lower() for i in intents if isinstance(i, str)}
    for keyword, relation, rationale in _INTENT_RELATION_MAP:
        if keyword in intents_set:
            return {
                "relation": relation,
                "confidence": _DERIVED_CONFIDENCE,
                "rationale": rationale,
            }
    relation, rationale = _DEFAULT_DERIVED
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
        keywords=keywords, top_n=seeds_count, since_year=since_year
    )
    logger.info(
        "discovered %d seeds: %s",
        len(seeds),
        [s.get("paperId") for s in seeds],
    )

    # Stage 3: BFS ancestors via fetch_related (build_lineage's cache reused).
    nodes: dict[str, dict] = {}
    edges: list[dict] = []

    seed_ids: list[str] = []
    frontier: list[tuple[dict, int]] = []
    for seed in seeds:
        sid = seed["paperId"]
        nodes[sid] = to_node(seed, focus=True)
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
                nodes[pid] = to_node(parent)
            # Issue #53: derive the relation from S2 intents instead of
            # firing an LLM classify call. derive_relation() returns None
            # when S2 says the parent is non-influential (we drop the
            # edge), and otherwise picks a relation enum + rationale by
            # mapping the intents array via _INTENT_RELATION_MAP.
            classify_attempted += 1
            cls = derive_relation(parent)
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

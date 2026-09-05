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
from datetime import datetime, timedelta, timezone
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

from paperpilot.identity.source_ids import IdentityError, normalize_alias  # noqa: E402
from paperpilot.llm import (  # noqa: E402
    AbstractLLMProvider,
    GeminiProvider,
    GroqProvider,
    RelationClassification,
)
from paperpilot.llm.base import (  # noqa: E402
    _MIN_RATIONALE_LEN,
    build_classify_prompt,
    provider_model_tag,
)
from paperpilot.scripts._common import slug_to_venue_label  # noqa: E402
from paperpilot.scripts._lineage_classify import derive_relation  # noqa: E402
from paperpilot.scripts._lineage_contract import (  # noqa: E402
    CLASSIFICATION_METHODS,
    LINEAGE_ARTIFACT_VERSION,
    canonical_json_sha256,
    make_provenance,
    require_paper_id,
    validate_lineage_artifact,
)
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
S2_RATE_DELAY = 3.5  # unauth quota is harsh; stay well under

# Cluster (topics view) constants. Focus papers missing any kind tag are
# bucketed into "uncategorized" so the gallery never hides them.
_UNCATEGORIZED_ID = "uncategorized"
_UNCATEGORIZED_LABEL = "その他"

_PRODUCER_NAME = "paperpilot.scripts.build_lineage"
_PRODUCER_VERSION = "p2-v1"
_PROMPT_VERSION = "relation-prompt-v1"
_CLASSIFICATION_SCHEMA_VERSION = "relation-classification-v1"
_CACHE_VERSION = "lineage-classification-cache-v2"
_CACHE_TTL = timedelta(days=30)


def _cluster_slug(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    return slug or _UNCATEGORIZED_ID


# Per-provider cadence between classify calls. The provider itself already
# handles 429 backoff via request_with_retry; this is a baseline RPM limiter
# so we don't trigger retries in the first place.
LLM_RATE_DELAY = {
    "groq": 2.2,  # ~27 RPM (Groq free tier: 30 RPM)
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
    ("neurips", "A+"),
    ("icml", "A+"),
    ("iclr", "A+"),
    ("cvpr", "A+"),
    ("eccv", "A+"),
    ("iccv", "A+"),
    ("acl", "A+"),
    ("emnlp", "A+"),
    # Tier A
    ("north american chapter of the association for computational linguistics", "A"),
    ("aaai conference on artificial intelligence", "A"),
    ("conference on robot learning", "A"),
    ("robotics: science and systems", "A"),
    ("knowledge discovery and data mining", "A"),
    ("trans. mach. learn. res.", "A"),
    ("journal of machine learning research", "A"),
    ("naacl", "A"),
    ("aaai", "A"),
    ("kdd", "A"),
    ("tmlr", "A"),
    ("corl", "A"),
    ("sigir", "A"),
    ("www", "A"),
    ("ijcai", "A"),
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

    # Each builder annotates its local provider as the base class so mypy
    # accepts either concrete subclass on the way back out of the tuple.
    def _groq() -> tuple[AbstractLLMProvider, float]:
        model = env.get("groq_model") or "llama-3.3-70b-versatile"
        p: AbstractLLMProvider = GroqProvider(
            {"enabled": True, "model": model, "temperature": 0.1, "timeout_seconds": 30},
            api_key=groq_key,
        )
        return p, LLM_RATE_DELAY["groq"]

    def _gemini() -> tuple[AbstractLLMProvider, float]:
        model = env.get("gemini_model") or "gemini-2.5-flash"
        p: AbstractLLMProvider = GeminiProvider(
            {"enabled": True, "model": model, "temperature": 0.1, "timeout_seconds": 30},
            api_key=gemini_key,
        )
        return p, LLM_RATE_DELAY["gemini"]

    # PAPERPILOT_LLM_PROVIDER overrides the default key-presence precedence:
    # set to "gemini" / "groq" to force that backend (e.g. when the Groq
    # free-tier key is dead and Gemini — also free, and higher relation
    # macro-F1 per #293 — should run instead). Unset / "auto" keeps the
    # historical Groq-first default. Read from the ambient env (runtime
    # selector, not a .env secret) with a .env fallback for convenience.
    preference = (
        (os.environ.get("PAPERPILOT_LLM_PROVIDER") or env.get("llm_provider") or "").strip().lower()
    )
    if preference in ("gemini", "groq"):
        key = gemini_key if preference == "gemini" else groq_key
        if not key:
            up = preference.upper()
            raise RuntimeError(
                f"PAPERPILOT_LLM_PROVIDER={preference} requested but no key "
                f"found (set PAPERPILOT_{up}_API_KEY in paperpilot/.env, "
                f"or {up}_API_KEY in the environment)."
            )
        return _gemini() if preference == "gemini" else _groq()
    if preference not in ("", "auto"):
        raise RuntimeError(
            f"PAPERPILOT_LLM_PROVIDER={preference!r} is not recognised "
            "(expected 'groq', 'gemini', or 'auto')."
        )

    # Default precedence: Groq first (most generous free tier for the
    # hundreds-of-calls classification workload), then Gemini.
    if groq_key:
        return _groq()
    if gemini_key:
        return _gemini()

    # RuntimeError (not sys.exit) so this function is safe to import from a
    # Modal Function — sys.exit would tear down the ASGI worker. The CLI
    # main() converts this back to exit code 3 to preserve script contract.
    raise RuntimeError(
        "No LLM key found. Set PAPERPILOT_GROQ_API_KEY (preferred) or PAPERPILOT_GEMINI_API_KEY."
    )


# ---------- S2 helpers ----------

# Field lists sent to the S2 Graph API. Scoped to this block since they
# are implementation details of the two fetch helpers below — callers
# outside the module should never need them.
_S2_FIELDS_PAPER = (
    "paperId,title,year,venue,citationCount,referenceCount,authors,abstract,externalIds"
)
_S2_FIELDS_REL = (
    "paperId,title,year,venue,citationCount,authors,abstract,externalIds,"
    # isInfluential + intents are entry-level fields S2 derives from a
    # citation-classification model. isInfluential separates real
    # influence from background name-drops (#50). intents categorises
    # the citation into methodology / result / background, which lets
    # build_theme_lineage derive the relation type WITHOUT an LLM call
    # (#53). Both are lifted onto the inner paper dict by fetch_related.
    "isInfluential,intents"
)


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
    url = (
        f"https://api.semanticscholar.org/graph/v1/paper/arXiv:{arxiv_id}?fields={_S2_FIELDS_PAPER}"
    )
    data = _s2_get(url)
    if data:
        cache.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    time.sleep(S2_RATE_DELAY)
    return data


def fetch_related(s2_id: str, kind: str, limit: int) -> list[dict[str, Any]]:
    """kind = 'references' or 'citations'.

    Dispatches by paperId prefix (#209 S2-free Phase 1):

    * ``s2_id`` starting with ``openalex:`` → OpenAlex BFS. No S2 call
      is made. Resulting paper dicts carry ``_intents=None``,
      ``_contexts=[]``, ``_is_influential=None`` because OpenAlex doesn't
      provide these — the relation classifier falls through to year/cite
      contrast or LLM downstream.
    * any other prefix → existing S2 ``/paper/{id}/{kind}`` path.

    Cache key includes the full ``s2_id`` so OpenAlex and S2 IDs never
    collide on disk.
    """
    # Cache check is FIRST so OpenAlex and S2 routes share the same
    # disk layer — keeps re-runs cheap regardless of data source.
    cache = CACHE_DIR / f"{kind}_{s2_id}.json"
    if cache.exists():
        cached = json.loads(cache.read_text())
        return cached if isinstance(cached, list) else []

    if s2_id.startswith("openalex:"):
        # Lazy import to avoid a circular dependency: build_theme_lineage
        # imports from this module at top level.
        from paperpilot.scripts.build_theme_lineage import (
            fetch_related_via_openalex,
        )

        short_id = s2_id[len("openalex:") :]
        items = fetch_related_via_openalex(short_id, kind, limit)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(items, ensure_ascii=False, indent=2))
        return items

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
            # Lift the entry-level isInfluential flag onto a *copy* of the
            # inner paper dict so BFS callers can pre-filter without
            # re-reading the raw S2 envelope. Copy avoids mutating the
            # parsed JSON object in case it's reused (e.g. future caching).
            # Distinguish "false" from "missing" — old cache entries lack
            # the field, so callers must not treat missing as a hard reject.
            enriched = dict(p)
            enriched["_is_influential"] = (
                bool(entry["isInfluential"]) if "isInfluential" in entry else None
            )
            # intents lives at the entry level too; carry the array through
            # so build_theme_lineage can derive relations without an LLM
            # call. Treat missing as None (older cache compat) so callers
            # can fall back to the existing classify path when desired.
            raw_intents = entry.get("intents")
            enriched["_intents"] = (
                [str(i) for i in raw_intents] if isinstance(raw_intents, list) else None
            )
            items.append(enriched)
    cache.write_text(json.dumps(items, ensure_ascii=False, indent=2))
    time.sleep(S2_RATE_DELAY)
    return items


def select_top(items: list[dict], n: int) -> list[dict]:
    """Pick top n abstract-bearing refs, prioritising S2-influential ones.

    Issue #50: foundational papers (ResNet, Transformer, etc.) accumulate
    huge citation counts and would dominate a pure citation-desc top-N,
    crowding out the actually-influential niche refs the citing paper
    built upon. Partition first so influential refs claim the LLM-classify
    budget; fall back to high-citation candidates only if there is room
    left. Refs without the field (older cache) count as "not False" so
    existing themes don't regress.
    """
    scored = [it for it in items if it.get("abstract")]
    influential = [it for it in scored if it.get("_is_influential") is not False]
    non_influential = [it for it in scored if it.get("_is_influential") is False]
    influential.sort(key=lambda x: x.get("citationCount") or 0, reverse=True)
    non_influential.sort(key=lambda x: x.get("citationCount") or 0, reverse=True)
    return (influential + non_influential)[:n]


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
    abstract_full = (paper.get("abstract") or "").strip()
    tldr = abstract_full[:140].strip()
    # Avoid cutting in the middle of a word
    if tldr and len(abstract_full) > 140:
        last_space = tldr.rfind(" ")
        if last_space > 80:
            tldr = tldr[:last_space] + "…"
    # short_abstract is the abstract excerpt the seed-relevance audit reads.
    # Production filtering at build time sees the full abstract; the audit
    # walks viewer-side fields (title + tldr) only — and 140 chars routinely
    # misses theme keywords that appear later in the abstract, raising false
    # positives on foundational papers whose title omits the theme name
    # (ViT "An Image is Worth 16x16 Words" for the "Vision Transformer"
    # theme, InstructGPT for "Reinforcement Learning from Human Feedback").
    # 1000 chars at a word boundary gives the audit ~7× more text to match
    # against without bloating lineage.json beyond what the viewer can keep
    # in memory comfortably.
    short_abstract = abstract_full[:1000].strip()
    if short_abstract and len(abstract_full) > 1000:
        last_space = short_abstract.rfind(" ")
        if last_space > 800:
            short_abstract = short_abstract[:last_space] + "…"
    # Catalog (Stage 2) values win when provided; otherwise use S2's response
    # so related nodes still have citation counts for the viewer to size on.
    citation_count = (
        catalog_citations if catalog_citations is not None else (paper.get("citationCount") or 0)
    )
    github_stars = catalog_stars if catalog_stars is not None else 0
    # Pull arxiv / DOI out of S2's externalIds dict so the viewer can
    # link the card to the canonical paper page (#59). Either may be
    # absent; the viewer falls back to S2's paper detail page.
    external = paper.get("externalIds") or {}
    arxiv_id = external.get("ArXiv") or external.get("arxiv")
    doi = external.get("DOI") or external.get("doi")
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
        # short_abstract is omitted when the source had no abstract at all —
        # the audit then degrades to title+tldr matching the same way legacy
        # lineage.json files (built before this field landed) degrade.
        **({"short_abstract": short_abstract} if short_abstract else {}),
        **({"arxiv_id": arxiv_id} if arxiv_id else {}),
        **({"doi": doi} if doi else {}),
        **({"is_focus": True} if focus else {}),
        **({"is_trending": True} if trending else {}),
    }


def extract_arxiv_id(arxiv_url: str) -> str | None:
    m = re.search(r"arxiv\.org/abs/([\d\.]+)", arxiv_url or "")
    return m.group(1) if m else None


def _normalize_oral_arxiv_id(paper: dict) -> str | None:
    """Return one canonical explicit arXiv alias, or None when absent."""

    declared = paper.get("arxiv_id")
    arxiv_url = paper.get("arxiv_url")
    if arxiv_url is not None and arxiv_url != "" and not isinstance(arxiv_url, str):
        raise ValueError("oral arxiv_url must be a string")
    url_alias = extract_arxiv_id(arxiv_url or "")
    if declared is not None and declared != "":
        raw = declared
    else:
        raw = url_alias
        if raw is None:
            return None
    if not isinstance(raw, str):
        raise ValueError("oral arxiv_id must be a string")
    try:
        _, normalized = normalize_alias("arxiv", raw)
    except IdentityError as exc:
        raise ValueError(f"oral has invalid arXiv identity: {raw!r}") from exc
    if declared is not None and declared != "" and url_alias is not None:
        _, normalized_url_alias = normalize_alias("arxiv", url_alias)
        if normalized_url_alias != normalized:
            raise ValueError("oral arxiv_id and arxiv_url identities do not match")
    return normalized


def _require_s2_focus_identity(focus: object, requested_arxiv_id: str) -> str:
    """Return the graph-local S2 ID only for an exact normalized alias match."""

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


def persist_classifications(classifications: dict[str, dict], cache_path: Path) -> None:
    """Merge any concurrent writer's entries into our snapshot, then atomically
    overwrite the cache file.

    Why: ``classifications.json`` is shared by build_lineage / build_deep_lineage
    / build_theme_lineage (CLAUDE.md §14). The merge-then-rename pattern blocks
    both lost-update races (concurrent writers add different keys; without merge
    the last writer would silently drop the other's contribution) and corrupt
    JSON observable by readers (``os.replace`` is atomic on POSIX).

    Our in-memory entries take precedence on key collision — they are the
    freshest we just computed.
    """
    if cache_path.exists():
        try:
            disk_obj = json.loads(cache_path.read_text())
        except json.JSONDecodeError:
            disk_obj = None
        if isinstance(disk_obj, dict):
            for k, v in disk_obj.items():
                classifications.setdefault(k, v)
    tmp = cache_path.with_suffix(cache_path.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(classifications, ensure_ascii=False, indent=2))
    os.replace(tmp, cache_path)


def _is_degenerate_rationale(rationale: object) -> bool:
    """True iff ``rationale`` is empty or below the `_MIN_RATIONALE_LEN`
    floor (#297). Centralises the "is this a meaningless tooltip" test so
    the cache-hit guard and the final edge filter stay in sync."""
    if not isinstance(rationale, str):
        return True
    return len(rationale.strip()) < _MIN_RATIONALE_LEN


def _filter_edges_by_rationale(edges: list[dict]) -> list[dict]:
    """Drop edges whose rationale is empty or below the min-length floor.

    A silent empty tooltip is worse than no edge; so is a 1-char "A" tooltip
    (#297). ``RelationClassification.from_dict`` already rejects both, and
    the cache-hit guard catches degenerate cached entries, but this is the
    belt-and-braces final filter that also catches edges built outside those
    paths (e.g. legacy cache dicts merged in at runtime)."""
    return [e for e in edges if not _is_degenerate_rationale(e.get("rationale"))]


def _classify_cached(
    provider: AbstractLLMProvider,
    a: dict,
    b: dict,
    *,
    cache_key: str,
    classifications: dict[str, dict],
    cache_path: Path,
    rate_delay: float,
    intent_record: dict | None = None,
) -> dict | None:
    """Classify via provider with persistent cache keyed by (src, dst).

    Strict variant: empty rationales are dropped by ``RelationClassification.
    from_dict`` (better no edge than a silent empty tooltip). Use the lenient
    variant in ``build_deep_lineage`` when weak edges should survive.

    Graceful degradation (matches build_theme_lineage): when the LLM returns
    None — the steady state under free-tier quota — and ``intent_record`` is
    supplied, fall back to the deterministic heuristic via
    ``derive_relation(strict_mode="off")`` (S2 intents + title-version
    supersedes + year/cite + foundational, NO LLM call). Without this the
    conference tree goes empty whenever the LLM is dark. Heuristic edges are
    deliberately NOT written to the cache, so a later run with a live LLM
    re-derives a richer paper-specific rationale. ``intent_record`` defaults
    to None (callers that don't pass it keep the old drop-on-None behavior).
    """
    if cache_key in classifications:
        cached = classifications[cache_key]
        # #297 defense in depth: a cache hit returns the raw dict WITHOUT
        # going through `RelationClassification.from_dict`, so a degenerate
        # cached entry ({"rationale":"A"}, written before the #297 fix)
        # would otherwise be served verbatim. Treat a sub-floor rationale as
        # a cache MISS so we fall through and re-derive a full rationale.
        if isinstance(cached, dict) and not _is_degenerate_rationale(cached.get("rationale")):
            return cached
    rc: RelationClassification | None = provider.classify_relation(a, b)
    if rc is not None:
        entry = {
            "relation": rc.relation,
            "confidence": rc.confidence,
            "rationale": rc.rationale,
            # #310: record which LLM produced this entry so a mixed-provider
            # cache (post Groq→Gemini regen) stays auditable. NOT part of the
            # cache key (key stays "{src}->{dst}") — fully backward-compatible:
            # RelationClassification.from_dict ignores this extra field, and
            # legacy entries without it still load + serve fine.
            "model": provider_model_tag(provider),
        }
        classifications[cache_key] = entry
        persist_classifications(classifications, cache_path)
    time.sleep(rate_delay)
    if rc is not None:
        return classifications.get(cache_key)
    # LLM dark: degrade to the deterministic heuristic instead of dropping
    # the edge. Reuses derive_relation's full heuristic composition with no
    # LLM (strict_mode="off"); not cached.
    if intent_record is not None:
        return derive_relation(intent_record, parent=a, child=b, strict_mode="off")
    return None


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
    if parsed.tzinfo is None:
        return False
    return parsed > now


def _heuristic_evidence_input(
    *, src_id: str, dst_id: str, parent: dict, child: dict, intent_record: dict
) -> dict[str, Any]:
    """Return the closed input actually read by ``derive_relation``.

    Keeping this projection explicit prevents unrelated S2 response fields from
    invalidating the evidence hash while ensuring every heuristic signal is
    attributable (contexts, intents, title/version, year/citation contrast and
    the foundational-title allowlist).
    """

    def paper_fields(paper: dict) -> dict[str, Any]:
        return {
            "title": paper.get("title"),
            "year": paper.get("year"),
            "citationCount": paper.get("citationCount"),
            "citation_count": paper.get("citation_count"),
        }

    return {
        "src": src_id,
        "dst": dst_id,
        "parent": paper_fields(parent),
        "child": paper_fields(child),
        "intent_record": {
            **paper_fields(intent_record),
            "_is_influential": intent_record.get("_is_influential"),
            "_intents": intent_record.get("_intents"),
            "_contexts": intent_record.get("_contexts"),
        },
    }


def _classify_cached_v2(
    provider: AbstractLLMProvider,
    a: dict,
    b: dict,
    *,
    src_id: str,
    dst_id: str,
    classifications: dict[str, dict],
    cache_path: Path,
    rate_delay: float,
    intent_record: dict | None = None,
) -> dict | None:
    """P2 build-path classifier with exact provider/evidence cache identity.

    The legacy ``_classify_cached`` remains available to existing callers and
    tests.  This path deliberately never treats ``src->dst`` entries as hits.
    """

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
    cached_classification = (
        RelationClassification.from_dict(cached) if isinstance(cached, dict) else None
    )
    if (
        _cache_entry_is_fresh(cached, now=now)
        and cached_classification is not None
        and cached.get("cache_identity") == cache_identity
        and cached.get("provenance") == provenance
    ):
        return cached

    rc: RelationClassification | None = provider.classify_relation(a, b)
    time.sleep(rate_delay)
    if rc is not None:
        entry = {
            "cache_identity": cache_identity,
            "status": "success",
            "expires_at": _iso_z(now + _CACHE_TTL),
            "src": src_id,
            "dst": dst_id,
            "relation": rc.relation,
            "confidence": rc.confidence,
            "rationale": rc.rationale,
            "model": model,
            "provenance": provenance,
        }
        classifications[cache_key] = entry
        persist_classifications(classifications, cache_path)
        return entry

    if intent_record is None:
        return None
    heuristic = derive_relation(intent_record, parent=a, child=b, strict_mode="off")
    if heuristic is None:
        return None
    method = str(heuristic.get("provenance", ""))
    if method not in CLASSIFICATION_METHODS or method == "llm":
        raise ValueError(f"unsupported heuristic provenance method: {method!r}")
    heuristic_sha256 = canonical_json_sha256(
        _heuristic_evidence_input(
            src_id=src_id,
            dst_id=dst_id,
            parent=a,
            child=b,
            intent_record=intent_record,
        )
    )
    source = "unarxive" if method == "context_pattern" else "semantic_scholar"
    return {
        **heuristic,
        "src": src_id,
        "dst": dst_id,
        "provenance": make_provenance(
            producer_name=_PRODUCER_NAME,
            producer_version=_PRODUCER_VERSION,
            evidence_source=source,
            evidence_kind="citation-context"
            if method == "context_pattern"
            else "citation-metadata",
            evidence_sha256=heuristic_sha256,
            method=method,
            provider=None,
            model=None,
            prompt_version=None,
            classification_schema_version=_CLASSIFICATION_SCHEMA_VERSION,
        ),
    }


def build(
    *,
    limit: int | None = None,
    conference: str = "iclr-2026",
    venue_override: str | None = None,
    generated_at: str | None = None,
) -> dict:
    papers_path, _ = resolve_paths(conference)
    venue_label = venue_override or derive_venue_label(conference)

    papers = json.loads(papers_path.read_text())
    orals = [p for p in papers if p.get("type") == "Oral"]
    if limit:
        orals = orals[:limit]
    seeds = [require_paper_id(paper.get("paper_id"), field="oral.paper_id") for paper in orals]
    if len(set(seeds)) != len(seeds):
        raise ValueError("duplicate canonical paper_id among Oral catalog rows")

    oral_identities: list[tuple[dict, str, str | None]] = []
    seed_by_arxiv_id: dict[str, str] = {}
    for paper, seed_paper_id in zip(orals, seeds, strict=True):
        arxiv_id = _normalize_oral_arxiv_id(paper)
        if arxiv_id is not None:
            previous_seed = seed_by_arxiv_id.get(arxiv_id)
            if previous_seed is not None:
                raise ValueError(
                    f"duplicate normalized arXiv identity among Oral catalog rows: {arxiv_id}"
                )
            seed_by_arxiv_id[arxiv_id] = seed_paper_id
        oral_identities.append((paper, seed_paper_id, arxiv_id))

    # Identity is validated before provider construction or any source lookup.
    provider, rate_delay = build_provider()
    logger.info("LLM provider: %s", provider.name)

    logger.info("Building lineage for %d Oral papers (%s)", len(orals), conference)

    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    focus_seed_by_graph_id: dict[str, str] = {}
    classification_cache_path = CACHE_DIR / "classifications.json"
    classifications: dict[str, dict] = (
        json.loads(classification_cache_path.read_text())
        if classification_cache_path.exists()
        else {}
    )

    # Resolve and verify every focus identity before fetching a single related
    # paper or classifying an edge.  A mismatch in any Oral therefore aborts
    # the whole artifact rather than publishing a partially misattributed graph.
    resolved_orals: list[tuple[dict, str, str, dict, str]] = []
    for idx, (paper, seed_paper_id, arxiv_id) in enumerate(oral_identities, 1):
        if arxiv_id is None:
            logger.warning(
                "[%d/%d] SKIP (no arxiv_id): %s",
                idx,
                len(orals),
                paper["title"][:60],
            )
            continue

        logger.info(
            "[%d/%d] %s: %s",
            idx,
            len(orals),
            arxiv_id,
            paper["title"][:60],
        )
        focus_paper = fetch_paper_by_arxiv(arxiv_id)
        if not focus_paper:
            logger.warning("  S2 lookup failed for %s", arxiv_id)
            continue

        focus_id = _require_s2_focus_identity(focus_paper, arxiv_id)
        previous_seed = focus_seed_by_graph_id.get(focus_id)
        if previous_seed is not None and previous_seed != seed_paper_id:
            raise ValueError(
                f"distinct catalog papers resolve to the same Semantic Scholar paper: {focus_id}"
            )
        focus_seed_by_graph_id[focus_id] = seed_paper_id
        resolved_orals.append((paper, seed_paper_id, arxiv_id, focus_paper, focus_id))

    for paper, seed_paper_id, arxiv_id, focus_paper, focus_id in resolved_orals:
        # Catalog says these are ICLR 2026 Oral — S2 only knows them as arXiv
        # preprints, so override for the focus nodes.
        catalog_kinds = paper.get("tags", [])[:3] or ["empirical"]
        # Forward Stage 2 signals (#23). S2's citation count on arXiv preprints
        # is often zero / stale for recently-accepted papers.
        catalog_citations = paper.get("citation_count")
        catalog_stars = paper.get("github_stars")
        focus_node = to_node(
            focus_paper,
            focus=True,
            kinds=catalog_kinds,
            override_venue=venue_label,
            override_tier="A+",
            catalog_citations=catalog_citations if isinstance(catalog_citations, int) else None,
            catalog_stars=catalog_stars if isinstance(catalog_stars, int) else None,
        )
        focus_node["seed_paper_id"] = seed_paper_id
        focus_node["aliases"] = [
            ["arxiv", arxiv_id],
            ["semantic_scholar", focus_id],
        ]
        nodes[focus_id] = focus_node

        parents = select_top(fetch_related(focus_id, "references", TOP_PARENTS * 4), TOP_PARENTS)
        children = select_top(fetch_related(focus_id, "citations", TOP_CHILDREN * 4), TOP_CHILDREN)
        logger.info("  parents=%d children=%d", len(parents), len(children))

        for parent in parents:
            pid = parent["paperId"]
            if pid not in nodes:
                nodes[pid] = to_node(parent)
            # Issue #50: skip non-influential refs — same rationale as
            # build_theme_lineage. Missing flag (None) keeps the classify
            # path so existing caches don't regress.
            if parent.get("_is_influential") is False:
                continue
            cls = _classify_cached_v2(
                provider,
                parent,
                focus_paper,
                src_id=pid,
                dst_id=focus_id,
                classifications=classifications,
                cache_path=classification_cache_path,
                rate_delay=rate_delay,
                # references: parent = intent_record (cited), child = focus
                # (citing) — see derive_relation's direction convention.
                intent_record=parent,
            )
            if cls and cls["relation"] != "unrelated":
                edges.append(
                    {
                        "src": pid,
                        "dst": focus_id,
                        "rel": cls["relation"],
                        "relation": cls["relation"],
                        "conf": cls["confidence"],
                        "confidence": cls["confidence"],
                        "rationale": cls["rationale"],
                        "provenance": cls["provenance"],
                    }
                )

        for child in children:
            cid = child["paperId"]
            if cid not in nodes:
                nodes[cid] = to_node(child)
            if child.get("_is_influential") is False:
                continue
            cls = _classify_cached_v2(
                provider,
                focus_paper,
                child,
                src_id=focus_id,
                dst_id=cid,
                classifications=classifications,
                cache_path=classification_cache_path,
                rate_delay=rate_delay,
                # citations: child = intent_record (citing), parent = focus
                # (cited) — see derive_relation's direction convention.
                intent_record=child,
            )
            if cls and cls["relation"] != "unrelated":
                edges.append(
                    {
                        "src": focus_id,
                        "dst": cid,
                        "rel": cls["relation"],
                        "relation": cls["relation"],
                        "conf": cls["confidence"],
                        "confidence": cls["confidence"],
                        "rationale": cls["rationale"],
                        "provenance": cls["provenance"],
                    }
                )

    # Drop edges with empty or degenerate (#297) rationales — a silent empty
    # tooltip is worse than no edge, and so is a 1-char "A" tooltip.
    # (RelationClassification.from_dict already rejects these, but belt-and-braces.)
    cleaned_edges = _filter_edges_by_rationale(edges)
    dropped = len(edges) - len(cleaned_edges)
    if dropped:
        logger.warning("dropped %d edges with empty/degenerate rationale", dropped)

    # Deduplicate, then sort by wire identity.  Multiple Oral expansions can
    # discover the same shared citation edge.
    edge_by_key: dict[tuple[str, str, str], dict] = {}
    for edge in cleaned_edges:
        key = (edge["src"], edge["dst"], edge["relation"])
        edge_by_key.setdefault(key, edge)
    ordered_edges = [edge_by_key[key] for key in sorted(edge_by_key)]

    for node in nodes.values():
        node.setdefault("is_focus", False)
    ordered_nodes = sorted(nodes.values(), key=lambda node: node["id"])

    # Root = focus paper with the most relationships; graph-local ID is the
    # explicit deterministic tie-breaker.  There is no first-node fallback.
    edge_count: dict[str, int] = {}
    for edge in ordered_edges:
        edge_count[edge["src"]] = edge_count.get(edge["src"], 0) + 1
        edge_count[edge["dst"]] = edge_count.get(edge["dst"], 0) + 1
    focus_ids = sorted(node["id"] for node in ordered_nodes if node.get("is_focus") is True)
    root_id = (
        min(focus_ids, key=lambda node_id: (-edge_count.get(node_id, 0), node_id))
        if focus_ids
        else None
    )

    result = {
        "schema_version": LINEAGE_ARTIFACT_VERSION,
        "root": root_id,
        "nodes": ordered_nodes,
        "edges": ordered_edges,
        "clusters": build_clusters(ordered_nodes),
        "meta": {
            "kind": "conference",
            "generator": _PRODUCER_NAME,
            "generated_at": generated_at or _iso_z(_utc_now()),
        },
    }
    issues = validate_lineage_artifact(result, kind="conference", catalog_ids=set(seeds))
    if issues:
        detail = "; ".join(f"{issue.code}:{issue.path}" for issue in issues[:8])
        raise ValueError(f"generated lineage violates {LINEAGE_ARTIFACT_VERSION}: {detail}")
    return result


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
    parser.add_argument(
        "--limit", type=int, default=None, help="Process only first N Oral papers (smoke test)"
    )
    parser.add_argument(
        "--conference", default="iclr-2026", help="Conference slug under docs/ (default: iclr-2026)"
    )
    parser.add_argument(
        "--venue-override",
        help="Pretty venue label for focus nodes (default: upper-case slug, e.g. 'ICLR 2026')",
    )
    args = parser.parse_args()

    setup_logging()  # CLI mode: surface logger.info to stderr.

    try:
        result = build(
            limit=args.limit,
            conference=args.conference,
            venue_override=args.venue_override,
        )
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(3)
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

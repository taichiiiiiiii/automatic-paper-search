"""Build a citation-graph lineage for a conference's Oral papers — OpenAlex only.

A free-tier, S2-free, LLM-free path to a conference family tree. build_lineage.py
resolves papers via arXiv -> Semantic Scholar, which (a) needs an arxiv_id our
OpenReview/CVF/ACL papers don't carry and (b) is hard rate-limited without a key.
This builder instead resolves each Oral paper through an exact strong external
alias exposed by OpenAlex, then takes its top references (ancestors) and top citing works
(descendants) to form a structural family tree.

Edges are heuristic — a citation is rendered as a `successor` relationship
(newer builds on older). This is NOT the LLM-classified relation graph
build_lineage.py produces (supersedes / extends / ablation / ...); it is a
structural demo / fallback. The output schema matches the shared lineage viewer
(docs/<conf>/lineage.html): {root, nodes, edges, clusters}.

Usage:
    uv run python -m paperpilot.scripts.build_conference_lineage \\
        --conference eccv-2024 --max-orals 14 --refs 4 --citers 2
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..identity.source_ids import IdentityError, identity_from_url, normalize_alias
from ..utils.http import request_with_retry
from ._lineage_contract import (
    LINEAGE_ARTIFACT_VERSION,
    canonical_json_sha256,
    make_provenance,
    require_paper_id,
    validate_lineage_artifact,
)

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
OPENALEX = "https://api.openalex.org/works"
_PRODUCER_NAME = "paperpilot.scripts.build_conference_lineage"
_PRODUCER_VERSION = "1"
_CLASSIFICATION_SCHEMA_VERSION = "citation-successor-v1"
_OPENALEX_ID_RE = re.compile(r"^W[0-9]+$")
_NATIVE_ALIAS_SOURCES = frozenset({"arxiv", "openreview", "acl_anthology", "cvf"})
_RESOLVE_PAGE_SIZE = 25

_TAG_RULES: dict[str, list[str]] = {
    "Vision": [r"\bimage", r"\bvideo", r"\b3d\b", r"detection", r"segmentation", r"\bvisual"],
    "Diffusion": [r"diffusion", r"generat"],
    "VLM": [r"vision[- ]language", r"multimodal", r"\bvlm\b"],
    "LLM": [r"\bllm\b", r"language model"],
    "Transformer": [r"transformer", r"attention"],
    "3D": [r"\b3d\b", r"nerf", r"gaussian", r"point cloud", r"mesh"],
    "Detection": [r"detection", r"segmentation"],
}


def _short_id(work_url: str) -> str:
    """'https://openalex.org/W123' -> 'W123'."""
    return (work_url or "").rstrip("/").split("/")[-1]


def _normalize_openalex_id(value: str) -> str:
    candidate = value.strip().rstrip("/").rsplit("/", 1)[-1]
    if not _OPENALEX_ID_RE.fullmatch(candidate):
        raise ValueError(f"invalid OpenAlex work ID: {value!r}")
    return candidate


def _normalize_title(title: str) -> str:
    """Normalize representation differences without doing fuzzy matching."""
    return " ".join(unicodedata.normalize("NFKC", title).casefold().split())


def _catalog_aliases(oral: dict[str, Any]) -> frozenset[tuple[str, str]]:
    """Return validated strong aliases present on one catalog row."""
    aliases: set[tuple[str, str]] = set()

    source = oral.get("source")
    source_id = oral.get("source_id")
    if isinstance(source, str) and source.strip().lower() in _NATIVE_ALIAS_SOURCES:
        if not isinstance(source_id, str) or not source_id.strip():
            raise ValueError(f"catalog source {source!r} requires a non-empty source_id")
        try:
            aliases.add(normalize_alias(source, source_id))
        except IdentityError as exc:
            raise ValueError(f"invalid catalog source alias: {exc}") from exc

    for field, namespace in (("arxiv_id", "arxiv"), ("doi", "doi")):
        value = oral.get(field)
        if value in (None, ""):
            continue
        if not isinstance(value, str):
            raise ValueError(f"oral.{field} must be a string")
        try:
            aliases.add(normalize_alias(namespace, value))
        except IdentityError as exc:
            raise ValueError(f"invalid oral.{field}: {exc}") from exc

    openalex_id = oral.get("openalex_id")
    if openalex_id not in (None, ""):
        if not isinstance(openalex_id, str):
            raise ValueError("oral.openalex_id must be a string")
        aliases.add(("openalex", _normalize_openalex_id(openalex_id)))

    return frozenset(aliases)


def _work_aliases(work: dict[str, Any]) -> frozenset[tuple[str, str]]:
    """Extract exact external aliases exposed by one OpenAlex Work response."""
    aliases: set[tuple[str, str]] = set()
    ids = work.get("ids") if isinstance(work.get("ids"), dict) else {}
    for value in (work.get("id"), ids.get("openalex")):
        if isinstance(value, str):
            with suppress(ValueError):
                aliases.add(("openalex", _normalize_openalex_id(value)))

    for value in (work.get("doi"), ids.get("doi")):
        if not isinstance(value, str):
            continue
        with suppress(IdentityError):
            doi_alias = normalize_alias("doi", value)
            aliases.add(doi_alias)
            arxiv_doi_prefix = "10.48550/arxiv."
            if doi_alias[1].startswith(arxiv_doi_prefix):
                aliases.add(normalize_alias("arxiv", doi_alias[1][len(arxiv_doi_prefix) :]))
    for key in ("arxiv", "arxiv_id"):
        value = ids.get(key)
        if not isinstance(value, str):
            continue
        with suppress(IdentityError):
            aliases.add(normalize_alias("arxiv", value))
    for key in ("openreview", "openreview_id"):
        value = ids.get(key)
        if not isinstance(value, str):
            continue
        with suppress(IdentityError):
            aliases.add(normalize_alias("openreview", value))

    locations: list[dict[str, Any]] = []
    primary = work.get("primary_location")
    if isinstance(primary, dict):
        locations.append(primary)
    if isinstance(work.get("locations"), list):
        locations.extend(item for item in work["locations"] if isinstance(item, dict))
    for location in locations:
        for key in ("landing_page_url", "pdf_url"):
            value = location.get(key)
            if not isinstance(value, str):
                continue
            try:
                identity = identity_from_url(value)
            except IdentityError:
                continue
            aliases.add((identity.source, identity.source_id))
    return frozenset(aliases)


def _select_openalex_match(
    results: list[Any], *, title: str, aliases: frozenset[tuple[str, str]]
) -> dict[str, Any] | None:
    """Select exactly one result by strong aliases; title is never identity."""
    candidates: dict[str, dict[str, Any]] = {}
    if not aliases:
        return None
    for result in results:
        if not isinstance(result, dict):
            continue
        work_id = _short_id(result.get("id", ""))
        if not _OPENALEX_ID_RE.fullmatch(work_id):
            continue
        matches = aliases.issubset(_work_aliases(result))
        if matches:
            candidates[work_id] = result
    return next(iter(candidates.values())) if len(candidates) == 1 else None


def _authors(work: dict[str, Any], limit: int = 4) -> list[str]:
    out = []
    for a in (work.get("authorships") or [])[:limit]:
        name = (a.get("author") or {}).get("display_name")
        if name:
            out.append(name)
    return out


def _kinds(title: str) -> list[str]:
    t = title.lower()
    return [tag for tag, pats in _TAG_RULES.items() if any(re.search(p, t) for p in pats)]


def _venue_of(work: dict[str, Any]) -> str:
    src = (work.get("primary_location") or {}).get("source") or {}
    return src.get("display_name") or ""


def _get(params: dict[str, Any], *, email: str | None = None) -> dict[str, Any] | None:
    if email:
        params = {**params, "mailto": email}
    resp = request_with_retry("GET", OPENALEX, params=params, timeout=20.0)
    if resp is None or resp.status_code != 200:
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def resolve_oral(
    title: str,
    *,
    aliases: frozenset[tuple[str, str]],
    email: str | None = None,
) -> dict[str, Any] | None:
    """Resolve only a unique strong-alias match; title-only lookup is forbidden."""
    if not aliases:
        return None
    data = _get(
        {
            "filter": f"title.search:{title}",
            "per-page": _RESOLVE_PAGE_SIZE,
            "select": "id,title,publication_year,authorships,primary_location,locations,ids,doi,referenced_works,cited_by_count",
        },
        email=email,
    )
    results = (data or {}).get("results") or []
    if not isinstance(results, list):
        return None
    return _select_openalex_match(results, title=title, aliases=aliases)


def fetch_meta(ids: list[str], *, email: str | None = None) -> dict[str, dict[str, Any]]:
    """Batch-fetch title/year/authors for OpenAlex work ids (50 per request)."""
    out: dict[str, dict[str, Any]] = {}
    for i in range(0, len(ids), 50):
        chunk = ids[i : i + 50]
        data = _get(
            {
                "filter": f"ids.openalex:{'|'.join(chunk)}",
                "per-page": 50,
                "select": "id,title,publication_year,authorships,primary_location",
            },
            email=email,
        )
        for w in (data or {}).get("results") or []:
            out[_short_id(w.get("id", ""))] = w
    return out


def fetch_citers(work_id: str, k: int, *, email: str | None = None) -> list[dict[str, Any]]:
    """Top-k most-cited works that cite work_id (the descendants)."""
    data = _get(
        {
            "filter": f"cites:{work_id}",
            "sort": "cited_by_count:desc",
            "per-page": k,
            "select": "id,title,publication_year,authorships,primary_location",
        },
        email=email,
    )
    return (data or {}).get("results") or []


def _node(
    work: dict[str, Any],
    *,
    venue: str,
    tier: str,
    is_focus: bool,
    seed_paper_id: str | None = None,
) -> dict[str, Any]:
    title = work.get("title") or ""
    node = {
        "id": _short_id(work.get("id", "")),
        "title": title,
        "year": work.get("publication_year"),
        "venue": venue or _venue_of(work),
        "venue_tier": tier,
        "authors": _authors(work),
        "kinds": _kinds(title),
        "github_stars": 0,
        "is_focus": is_focus,
    }
    if is_focus:
        node["seed_paper_id"] = require_paper_id(seed_paper_id, field="seed_paper_id")
    return node


def _edge(src: str, dst: str, src_year: int | None, dst_year: int | None) -> dict[str, Any]:
    # Heuristic: a citation is a successor link (newer builds on older). No LLM.
    evidence_sha256 = canonical_json_sha256(
        {
            "cited_work_id": src,
            "citing_work_id": dst,
            "cited_year": src_year,
            "citing_year": dst_year,
            "kind": "citation",
            "source": "openalex",
        }
    )
    return {
        "src": src,
        "dst": dst,
        "rel": "successor",
        "relation": "successor",
        "conf": 0.4,
        "confidence": 0.4,
        "rationale": "引用関係から導出（後継）。LLM 分類前のヒューリスティック。",
        "provenance": make_provenance(
            producer_name=_PRODUCER_NAME,
            producer_version=_PRODUCER_VERSION,
            evidence_source="openalex",
            evidence_kind="citation",
            evidence_sha256=evidence_sha256,
            method="citation_heuristic",
            provider=None,
            model=None,
            prompt_version=None,
            classification_schema_version=_CLASSIFICATION_SCHEMA_VERSION,
        ),
    }


def _deterministic_root(
    nodes: dict[str, dict[str, Any]], edges: list[dict[str, Any]]
) -> str | None:
    degree: dict[str, int] = {}
    for edge in edges:
        degree[edge["src"]] = degree.get(edge["src"], 0) + 1
        degree[edge["dst"]] = degree.get(edge["dst"], 0) + 1
    focus_ids = sorted(node_id for node_id, node in nodes.items() if node.get("is_focus") is True)
    return (
        min(focus_ids, key=lambda node_id: (-degree.get(node_id, 0), node_id))
        if focus_ids
        else None
    )


def _generated_at() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def build_graph(
    orals: list[dict[str, Any]],
    *,
    display: str,
    refs_per: int,
    citers_per: int,
    email: str | None = None,
    generated_at: str | None = None,
) -> dict[str, Any]:
    """Resolve orals -> works, attach top references + citers, emit lineage graph."""
    if not isinstance(orals, list):
        raise ValueError("orals must be a list")
    if not isinstance(display, str) or not display.strip():
        raise ValueError("display must be a non-empty string")
    for field, value in (("refs_per", refs_per), ("citers_per", citers_per)):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"{field} must be a non-negative integer")
    if email is not None and not isinstance(email, str):
        raise ValueError("email must be a string or None")
    if generated_at is not None and (not isinstance(generated_at, str) or not generated_at.strip()):
        raise ValueError("generated_at must be a non-empty string or None")

    prepared: list[tuple[dict[str, Any], str, str, frozenset[tuple[str, str]]]] = []
    seed_ids: set[str] = set()
    alias_owners: dict[tuple[str, str], str] = {}
    for index, oral in enumerate(orals):
        if not isinstance(oral, dict):
            raise ValueError(f"orals[{index}] must be an object")
        seed = require_paper_id(oral.get("paper_id"), field=f"orals[{index}].paper_id")
        if seed in seed_ids:
            raise ValueError(f"duplicate catalog paper_id: {seed}")
        seed_ids.add(seed)
        title = oral.get("title")
        if not isinstance(title, str) or not _normalize_title(title):
            raise ValueError(f"orals[{index}].title must be a non-empty string")
        aliases = _catalog_aliases(oral)
        for alias in aliases:
            owner = alias_owners.setdefault(alias, seed)
            if owner != seed:
                raise ValueError(f"strong alias belongs to multiple catalog papers: {alias!r}")
        prepared.append((oral, seed, title, aliases))

    seeds = [record[1] for record in prepared]
    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    ref_ids_needed: set[str] = set()
    oral_records: list[tuple[dict[str, Any], list[str], str]] = []

    for _oral, seed_paper_id, title, aliases in prepared:
        work = resolve_oral(title, aliases=aliases, email=email)
        if not work:
            continue
        oid = _short_id(work.get("id", ""))
        if not oid:
            continue
        if oid in nodes:
            if nodes[oid].get("seed_paper_id") != seed_paper_id:
                raise ValueError(
                    f"distinct catalog papers resolve to the same OpenAlex work: {oid}"
                )
            continue
        nodes[oid] = _node(
            work,
            venue=display,
            tier="A",
            is_focus=True,
            seed_paper_id=seed_paper_id,
        )
        refs = [_short_id(r) for r in (work.get("referenced_works") or [])][:refs_per]
        oral_records.append((work, refs, seed_paper_id))
        ref_ids_needed.update(refs)

    ref_meta = fetch_meta(sorted(ref_ids_needed), email=email) if ref_ids_needed else {}

    for work, refs, _seed_paper_id in oral_records:
        oid = _short_id(work.get("id", ""))
        oyear = nodes[oid]["year"]
        # ancestors (references)
        for rid in refs:
            rw = ref_meta.get(rid)
            if not rw:
                continue
            if rid not in nodes:
                nodes[rid] = _node(rw, venue=_venue_of(rw), tier="", is_focus=False)
            edges.append(_edge(rid, oid, nodes[rid]["year"], oyear))
        # descendants (citers)
        for cw in fetch_citers(_short_id(work.get("id", "")), citers_per, email=email):
            cid = _short_id(cw.get("id", ""))
            if not cid:
                continue
            if cid not in nodes:
                nodes[cid] = _node(cw, venue=_venue_of(cw), tier="", is_focus=False)
            edges.append(_edge(oid, cid, oyear, nodes[cid]["year"]))

    # dedup edges
    seen: set[tuple[str, str]] = set()
    uniq_edges = []
    for e in edges:
        key = (e["src"], e["dst"])
        if e["src"] != e["dst"] and key not in seen:
            seen.add(key)
            uniq_edges.append(e)

    ordered = sorted(nodes.values(), key=lambda node: node["id"])
    ordered_edges = sorted(
        uniq_edges, key=lambda edge: (edge["src"], edge["dst"], edge["relation"])
    )
    graph = {
        "schema_version": LINEAGE_ARTIFACT_VERSION,
        "root": _deterministic_root(nodes, ordered_edges),
        "nodes": ordered,
        "edges": ordered_edges,
        "clusters": _clusters(ordered),
        "meta": {
            "kind": "conference",
            "generator": _PRODUCER_NAME,
            "generated_at": generated_at or _generated_at(),
        },
    }
    issues = validate_lineage_artifact(graph, kind="conference", catalog_ids=set(seeds))
    if issues:
        detail = "; ".join(f"{issue.code}:{issue.path}" for issue in issues[:8])
        raise ValueError(f"generated lineage violates {LINEAGE_ARTIFACT_VERSION}: {detail}")
    return graph


def _clusters(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group the focus (Oral) papers by topic kind for the viewer's Topics mode.

    A multi-kind oral joins each of its kind clusters; orals with no detected
    kind fall into "Other". Matches the {id, label, focus_ids} schema.
    """
    buckets: dict[str, list[str]] = {}
    labels: dict[str, str] = {}
    for n in nodes:
        if not n.get("is_focus"):
            continue
        kinds = n.get("kinds") or ["Other"]
        for k in kinds:
            buckets.setdefault(k, []).append(n["id"])
            labels[k] = k
    return [
        {"id": k.lower(), "label": labels[k], "focus_ids": ids}
        for k, ids in sorted(buckets.items(), key=lambda kv: (-len(kv[1]), kv[0].lower()))
    ]


def load_orals(conference: str, max_orals: int) -> list[dict[str, Any]]:
    papers = json.loads((DOCS / conference / "papers.json").read_text(encoding="utf-8"))
    orals = [p for p in papers if p.get("type") == "Oral"]
    return orals[:max_orals] if max_orals else orals


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--conference", required=True, help="slug, e.g. eccv-2024")
    ap.add_argument("--display", default=None, help='display name, e.g. "ECCV 2024"')
    ap.add_argument("--max-orals", type=int, default=20)
    ap.add_argument("--refs", type=int, default=4, help="references (ancestors) per oral")
    ap.add_argument("--citers", type=int, default=2, help="citing works (descendants) per oral")
    ap.add_argument("--email", default=None, help="OpenAlex polite-pool email")
    args = ap.parse_args()

    display = args.display or args.conference.upper().replace("-", " ")
    orals = load_orals(args.conference, args.max_orals)
    if not orals:
        print(f"⚠️  no Oral papers in docs/{args.conference}/papers.json")
        return 1

    graph = build_graph(
        orals, display=display, refs_per=args.refs, citers_per=args.citers, email=args.email
    )
    out = DOCS / args.conference / "lineage.json"
    out.write_text(json.dumps(graph, ensure_ascii=False, indent=0), encoding="utf-8")
    focus = sum(1 for n in graph["nodes"] if n.get("is_focus"))
    print(f"✅ {len(graph['nodes'])} nodes ({focus} orals), {len(graph['edges'])} edges -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

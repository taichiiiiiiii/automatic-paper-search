"""Build a citation-graph lineage for a conference's Oral papers — OpenAlex only.

A free-tier, S2-free, LLM-free path to a conference family tree. build_lineage.py
resolves papers via arXiv -> Semantic Scholar, which (a) needs an arxiv_id our
OpenReview/CVF/ACL papers don't carry and (b) is hard rate-limited without a key.
This builder instead resolves each Oral paper's TITLE to its published OpenAlex
work, then takes its top references (ancestors) and top citing works
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
from pathlib import Path
from typing import Any

from ..utils.http import request_with_retry

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
OPENALEX = "https://api.openalex.org/works"

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


def resolve_oral(title: str, *, email: str | None = None) -> dict[str, Any] | None:
    """title.search -> the best-matching published OpenAlex work (with references)."""
    data = _get(
        {"filter": f"title.search:{title}", "per-page": 1,
         "select": "id,title,publication_year,authorships,primary_location,referenced_works,cited_by_count"},
        email=email,
    )
    results = (data or {}).get("results") or []
    return results[0] if results else None


def fetch_meta(ids: list[str], *, email: str | None = None) -> dict[str, dict[str, Any]]:
    """Batch-fetch title/year/authors for OpenAlex work ids (50 per request)."""
    out: dict[str, dict[str, Any]] = {}
    for i in range(0, len(ids), 50):
        chunk = ids[i : i + 50]
        data = _get(
            {"filter": f"ids.openalex:{'|'.join(chunk)}", "per-page": 50,
             "select": "id,title,publication_year,authorships,primary_location"},
            email=email,
        )
        for w in (data or {}).get("results") or []:
            out[_short_id(w.get("id", ""))] = w
    return out


def fetch_citers(work_id: str, k: int, *, email: str | None = None) -> list[dict[str, Any]]:
    """Top-k most-cited works that cite work_id (the descendants)."""
    data = _get(
        {"filter": f"cites:{work_id}", "sort": "cited_by_count:desc", "per-page": k,
         "select": "id,title,publication_year,authorships,primary_location"},
        email=email,
    )
    return (data or {}).get("results") or []


def _node(work: dict[str, Any], *, venue: str, tier: str, is_focus: bool) -> dict[str, Any]:
    title = work.get("title") or ""
    return {
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


def _edge(src: str, dst: str, src_year: int | None, dst_year: int | None) -> dict[str, Any]:
    # Heuristic: a citation is a successor link (newer builds on older). No LLM.
    return {
        "src": src,
        "dst": dst,
        "rel": "successor",
        "conf": 0.4,
        "rationale": "引用関係から導出（後継）。LLM 分類前のヒューリスティック。",
    }


def build_graph(
    orals: list[dict[str, str]],
    *,
    display: str,
    refs_per: int,
    citers_per: int,
    email: str | None = None,
) -> dict[str, Any]:
    """Resolve orals -> works, attach top references + citers, emit lineage graph."""
    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    ref_ids_needed: set[str] = set()
    oral_records: list[tuple[dict[str, Any], list[str]]] = []

    for o in orals:
        work = resolve_oral(o["title"], email=email)
        if not work:
            continue
        oid = _short_id(work.get("id", ""))
        if not oid or oid in nodes:
            continue
        nodes[oid] = _node(work, venue=display, tier="A", is_focus=True)
        refs = [_short_id(r) for r in (work.get("referenced_works") or [])][:refs_per]
        oral_records.append((work, refs))
        ref_ids_needed.update(refs)

    ref_meta = fetch_meta(sorted(ref_ids_needed), email=email) if ref_ids_needed else {}

    for work, refs in oral_records:
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

    ordered = sorted(nodes.values(), key=lambda n: (n.get("year") or 0))
    return {"root": None, "nodes": ordered, "edges": uniq_edges, "clusters": _clusters(ordered)}


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
        for k, ids in sorted(buckets.items(), key=lambda kv: -len(kv[1]))
    ]


def load_orals(conference: str, max_orals: int) -> list[dict[str, str]]:
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

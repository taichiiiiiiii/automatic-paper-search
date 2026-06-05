"""Multi-dimensional quality evaluation, revised grading.

Grade rubric (focus on what users actually feel):
- A: template_ratio <=10% AND title_ref_ratio >=50%  (paper-specific)
- B: template_ratio <=30% AND title_ref_ratio >=25%  (mostly specific)
- C: template_ratio <=70% AND title_ref_ratio >=10%  (mixed)
- D: otherwise                                       (generic / heuristic)

Year reversals demote 1 grade if > 10% of edges.
"""
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

from paperpilot.llm.base import TEMPLATE_RATIONALES
from paperpilot.scripts.audit_theme_seeds import _is_on_topic

TPL = frozenset(TEMPLATE_RATIONALES.values())

def evaluate(slug: str) -> dict:
    p = Path(f"docs/themes/{slug}/lineage.json")
    if not p.exists():
        return {"error": "lineage.json missing"}
    d = json.loads(p.read_text())
    nodes = d.get("nodes", [])
    edges = d.get("edges", [])
    meta = d.get("meta", {})
    theme = meta.get("theme", "")
    by_id = {n["id"]: n for n in nodes if isinstance(n, dict) and "id" in n}
    tc = sum(1 for e in edges if (e.get("rationale", "") or "").strip() in TPL)
    tpl_ratio = tc / len(edges) if edges else 0
    title_tokens: set[str] = set()
    for n in nodes:
        t = n.get("title") or ""
        for tok in re.findall(r"\b[A-Z][A-Za-z0-9-]{3,}", t):
            title_tokens.add(tok.lower())
    title_ref = sum(
        1
        for e in edges
        if any(tok in (e.get("rationale", "") or "").lower() for tok in title_tokens)
    )
    title_ratio = title_ref / len(edges) if edges else 0
    rel_counts = Counter(e.get("rel", "") for e in edges)
    total = sum(rel_counts.values())
    entropy = (
        -sum((c / total) * math.log2(c / total) for c in rel_counts.values() if c > 0)
        if total
        else 0
    )
    year_rev = sum(
        1
        for e in edges
        if (by_id.get(e.get("src", "")) or {}).get("year") is not None
        and (by_id.get(e.get("dst", "")) or {}).get("year") is not None
        and (by_id[e.get("src", "")].get("year") or 0)
        > (by_id[e.get("dst", "")].get("year") or 0) + 1
    )
    focus = [n for n in nodes if isinstance(n, dict) and n.get("is_focus")]
    off_topic = sum(1 for f in focus if theme and not _is_on_topic(theme, f))
    rats = [r for r in (e.get("rationale", "") for e in edges) if r]
    avg_len = sum(len(r) for r in rats) / len(rats) if rats else 0
    return {
        "theme": theme,
        "slug": slug,
        "nodes": len(nodes),
        "focus": len(focus),
        "off_topic_focus": off_topic,
        "edges": len(edges),
        "template_count": tc,
        "template_ratio": tpl_ratio,
        "title_ref_ratio": title_ratio,
        "relation_distribution": dict(rel_counts),
        "relation_entropy_bits": round(entropy, 2),
        "year_reversals": year_rev,
        "avg_rationale_len_chars": round(avg_len, 1),
    }


def grade(r: dict) -> str:
    tpl = r.get("template_ratio", 1)
    title = r.get("title_ref_ratio", 0)
    base = "D"
    if tpl <= 0.10 and title >= 0.50:
        base = "A"
    elif tpl <= 0.30 and title >= 0.25:
        base = "B"
    elif tpl <= 0.70 and title >= 0.10:
        base = "C"
    yr_pct = r["year_reversals"] / r["edges"] if r["edges"] else 0
    if yr_pct > 0.10 and base in "AB":
        base = chr(ord(base) + 1)
    return base

if __name__ == "__main__":
    slug = sys.argv[1]
    r = evaluate(slug)
    g = grade(r)
    print(f"\n=== {r['theme']} ({slug}) — Grade {g} ===")
    print(f"  Coverage:        {r['nodes']} nodes, {r['focus']} focus seeds, off_topic={r['off_topic_focus']}")
    print(f"  Edges:           {r['edges']}")
    print(f"  Template ratio:  {r['template_ratio']:>6.0%}  ({r['template_count']}/{r['edges']})  ← 低いほど良")
    print(f"  Title-ref ratio: {r['title_ref_ratio']:>6.0%}  rationale が論文タイトル含む  ← 高いほど良")
    print(f"  Year reversals:  {r['year_reversals']}/{r['edges']}")
    print(f"  Avg rat. length: {r['avg_rationale_len_chars']:.0f} chars")
    print(f"  Relations:       {r['relation_distribution']}")

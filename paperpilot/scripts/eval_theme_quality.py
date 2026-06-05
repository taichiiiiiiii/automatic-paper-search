"""Multi-dimensional quality evaluation for a single theme lineage.

Used by Step B (after each on-demand regen) to score the regenerated
theme A/B/C/D from signals that complement each other instead of
double-counting. The earlier two-axis version (template_ratio +
title_ref_ratio) over-rewarded themes whose rationales were
paper-specific *but* repeated nearly verbatim across many edges (Mamba
edges 1 / 2 / 4 all read 'B の State Space Models は A の U-Net
アーキテクチャを拡張…' with minor punctuation drift). This revision
adds two more axes:

  - rationale uniqueness: fraction of edges whose normalised rationale
    appears NO MORE than threshold times across the theme. Catches
    'one generic comparison reused for every parent' (Mamba ablation
    risk) without flagging genuine repetition like 'this seed always
    extends its parents in the same direction'.

  - both-end reference: fraction of edges whose rationale references
    AT LEAST one capitalised title-token from BOTH the src and dst
    paper. The earlier title_ref_ratio could pass an edge that
    mentions only one of the two papers, which feels paper-specific
    but actually describes only half the citation.

Grade rubric (all four signals must clear the tier's bar):

  A:  template_ratio <= 10%
      AND title_ref_ratio   >= 50%
      AND uniqueness        >= 80%
      AND both_ref_ratio    >= 40%

  B:  template_ratio <= 30%
      AND title_ref_ratio   >= 25%
      AND uniqueness        >= 60%
      AND both_ref_ratio    >= 20%

  C:  template_ratio <= 70% AND title_ref_ratio >= 10%
  D:  otherwise

Year-reversal rate > 10% demotes one grade (A->B etc.). Off-topic
seeds aren't a grade factor — they're a separate audit signal already.
"""
from __future__ import annotations

import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

from paperpilot.llm.base import TEMPLATE_RATIONALES
from paperpilot.scripts.audit_theme_seeds import _is_on_topic

TPL = frozenset(TEMPLATE_RATIONALES.values())

# Tokens shorter than this routinely match noise / shared method words
# across many papers ('the', 'and' obviously, but also 'cnn', 'gan').
# 4-character cap matches the capitalised-token title extractor below
# so the two pieces of the pipeline stay symmetric.
_MIN_TOKEN_LEN = 4
_TITLE_TOKEN_RE = re.compile(r"\b[A-Z][A-Za-z0-9-]{" + str(_MIN_TOKEN_LEN - 1) + r",}")
# Repeated-rationale threshold. A rationale that shows up more than this
# many times is folded into the duplicate bucket. 2 is intentionally
# strict — anything beyond 2 identical-after-normalisation edges starts
# to feel templated even when the source string itself isn't on the
# TEMPLATE_RATIONALES denylist.
_MAX_REPETITION = 2


def _normalize_rationale(text: str) -> str:
    """Collapse a rationale to its uniqueness signature.

    Lowercases, replaces all whitespace runs with a single space, and
    strips ASCII / fullwidth punctuation so '論文 B は…' and '論文B
    は…' fold together. This is deliberately lossy: we want
    paraphrase-resilient grouping, not byte-perfect dedup.
    """
    t = (text or "").lower()
    t = re.sub(r"\s+", " ", t)
    # Strip ASCII punct + common fullwidth Japanese punct.
    t = re.sub(r"[、。，．,.!?！？:;:;\"'　`~]+", "", t)
    return t.strip()


def _title_tokens_for(node: dict) -> set[str]:
    """Capitalised 4+-char tokens from a single node's title.

    Returns lowercased tokens so the rationale match is case-insensitive
    while still anchored to recognisable paper-specific terms (method
    names, acronyms, dataset names).
    """
    if not isinstance(node, dict):
        return set()
    title = node.get("title") or ""
    return {tok.lower() for tok in _TITLE_TOKEN_RE.findall(title)}


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
    n_edges = len(edges)

    # 1. Template ratio — byte-for-byte match against the production
    # heuristic-template denylist.
    tc = sum(1 for e in edges if (e.get("rationale", "") or "").strip() in TPL)
    tpl_ratio = tc / n_edges if n_edges else 0

    # 2. Title-ref ratio — at least one capitalised 4+-char token from
    # ANY node's title appears in the rationale. Symmetric with the
    # bidirectional check below: this is the union, that one is the
    # intersection.
    all_title_tokens: set[str] = set()
    for n in nodes:
        all_title_tokens |= _title_tokens_for(n)
    title_ref = sum(
        1
        for e in edges
        if any(tok in (e.get("rationale", "") or "").lower() for tok in all_title_tokens)
    )
    title_ratio = title_ref / n_edges if n_edges else 0

    # 3. Uniqueness — each rationale appears at most _MAX_REPETITION
    # times across the theme (normalised). Catches the 'same generic
    # comparison reused for every parent' failure mode that the binary
    # template-string test misses.
    norm_rationales = [_normalize_rationale(e.get("rationale", "") or "") for e in edges]
    rationale_counts = Counter(r for r in norm_rationales if r)
    duplicate_edges = sum(
        cnt for cnt in rationale_counts.values() if cnt > _MAX_REPETITION
    )
    uniqueness = 1 - (duplicate_edges / n_edges if n_edges else 0)

    # 4. Both-end reference — the rationale mentions a capitalised
    # title token from the src paper AND a token from the dst paper.
    # Empty intersection on either side disqualifies the edge.
    both_ref = 0
    for e in edges:
        rationale_lower = (e.get("rationale", "") or "").lower()
        src_tokens = _title_tokens_for(by_id.get(e.get("src", "")) or {})
        dst_tokens = _title_tokens_for(by_id.get(e.get("dst", "")) or {})
        has_src = any(tok in rationale_lower for tok in src_tokens)
        has_dst = any(tok in rationale_lower for tok in dst_tokens)
        if has_src and has_dst:
            both_ref += 1
    both_ref_ratio = both_ref / n_edges if n_edges else 0

    # 5. Relation distribution + entropy — informational. Low entropy
    # CAN mean heuristic collapse but more often just means the theme
    # naturally has one dominant relation type, so it's not a grade
    # factor.
    rel_counts = Counter(e.get("rel", "") for e in edges)
    total = sum(rel_counts.values())
    entropy = (
        -sum((c / total) * math.log2(c / total) for c in rel_counts.values() if c > 0)
        if total
        else 0
    )

    # 6. Year reversals — src (parent) newer than dst (child) by > 1
    # year. Usually a wrong-direction edge from a misclassified relation.
    year_rev = sum(
        1
        for e in edges
        if (by_id.get(e.get("src", "")) or {}).get("year") is not None
        and (by_id.get(e.get("dst", "")) or {}).get("year") is not None
        and (by_id[e.get("src", "")].get("year") or 0)
        > (by_id[e.get("dst", "")].get("year") or 0) + 1
    )

    # 7. Coverage + off-topic — coverage is the headline 'is this
    # lineage useful' number; off-topic seeds reuse audit_theme_seeds.
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
        "edges": n_edges,
        "template_count": tc,
        "template_ratio": tpl_ratio,
        "title_ref_ratio": title_ratio,
        "uniqueness_ratio": uniqueness,
        "both_ref_ratio": both_ref_ratio,
        "duplicate_edges": duplicate_edges,
        "relation_distribution": dict(rel_counts),
        "relation_entropy_bits": round(entropy, 2),
        "year_reversals": year_rev,
        "avg_rationale_len_chars": round(avg_len, 1),
    }


def grade(r: dict) -> str:
    tpl = r.get("template_ratio", 1)
    title = r.get("title_ref_ratio", 0)
    uniq = r.get("uniqueness_ratio", 0)
    both = r.get("both_ref_ratio", 0)
    base = "D"
    if tpl <= 0.10 and title >= 0.50 and uniq >= 0.80 and both >= 0.40:
        base = "A"
    elif tpl <= 0.30 and title >= 0.25 and uniq >= 0.60 and both >= 0.20:
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
    print(
        f"  Coverage:        {r['nodes']} nodes, {r['focus']} focus seeds, off_topic={r['off_topic_focus']}"
    )
    print(f"  Edges:           {r['edges']}")
    print(
        f"  Template ratio:  {r['template_ratio']:>6.0%}  ({r['template_count']}/{r['edges']})  ← 低いほど良"
    )
    print(
        f"  Title-ref ratio: {r['title_ref_ratio']:>6.0%}  rationale が論文 title 単語含む (union)  ← 高いほど良"
    )
    print(
        f"  Uniqueness:      {r['uniqueness_ratio']:>6.0%}  ({r['duplicate_edges']} edges 重複 > {_MAX_REPETITION} times)  ← 高いほど良"
    )
    print(
        f"  Both-end ref:    {r['both_ref_ratio']:>6.0%}  rationale が src AND dst の title 単語両方含む  ← 高いほど良"
    )
    print(f"  Year reversals:  {r['year_reversals']}/{r['edges']}")
    print(f"  Avg rat. length: {r['avg_rationale_len_chars']:.0f} chars")
    print(f"  Relations:       {r['relation_distribution']}")

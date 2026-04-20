#!/usr/bin/env python3
"""Build techmap-data.json by joining lineage.json with papers.json and
assigning primary research theme per node.

Historical papers (non-ICLR 2026) get theme inferred from title keywords.
"""
from __future__ import annotations
import json
import re
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent.parent
DOCS = ROOT / "docs" / "iclr-2026"

LINEAGE_PATH = DOCS / "lineage.json"
PAPERS_PATH = DOCS / "papers.json"
OUT_PATH = DOCS / "techmap-data.json"

THEME_ORDER = [
    "Attention",
    "MoE",
    "VLM",
    "Vision",
    "Diffusion",
    "RL",
    "Agent",
    "Theory",
    "Optim",
    "TimeSeries",
    "Medical",
    "Eval",
    "LLM",
    "Other",
]

KEYWORD_RULES = [
    ("Attention", [r"\battention\b", r"flashatt", r"transformer", r"mamba",
                   r"attention is all you need", r"reformer", r"performer",
                   r"linear transformer", r"ring attention", r"sparse attention",
                   r"longformer", r"linformer"]),
    ("MoE", [r"\bmoe\b", r"mixture.of.experts", r"expert(s)?", r"routing",
             r"sparse model", r"switch transformer"]),
    ("VLM", [r"\bclip\b", r"blip", r"visual language", r"vision.language",
             r"\bvlm\b", r"multimodal", r"llava"]),
    ("Vision", [r"\bcnn\b", r"resnet", r"segmentation", r"detection",
                r"imagenet", r"vit\b", r"vision transformer", r"image",
                r"semantic seg", r"dino"]),
    ("Diffusion", [r"diffusion", r"score.based", r"ddpm", r"ddim", r"noise",
                   r"flow matching"]),
    ("RL", [r"reinforcement", r"\brl\b", r"policy gradient", r"ppo", r"sac",
            r"q.learning", r"reward"]),
    ("Agent", [r"\bagent(s)?\b", r"tool use", r"react", r"planning"]),
    ("Theory", [r"theorem", r"convergence", r"bound", r"analysis",
                r"generalization", r"pac"]),
    ("Optim", [r"optim", r"sgd", r"adam", r"lion", r"gradient descent",
               r"second.order", r"learning rate"]),
    ("TimeSeries", [r"time.series", r"forecasting", r"temporal", r"sequence"]),
    ("Medical", [r"medical", r"clinical", r"diagnosis", r"biomed"]),
    ("Eval", [r"benchmark", r"evaluation", r"metric"]),
    ("LLM", [r"\bllm\b", r"language model", r"gpt", r"bert", r"llama",
             r"instruction", r"chat"]),
]


def infer_theme(title: str) -> str:
    t = title.lower()
    for theme, patterns in KEYWORD_RULES:
        if any(re.search(p, t) for p in patterns):
            return theme
    return "Other"


def pick_primary_tag(tags: List[str]) -> str:
    for theme in THEME_ORDER:
        if theme in tags:
            return theme
    return tags[0] if tags else "Other"


def main() -> int:
    lineage = json.loads(LINEAGE_PATH.read_text())
    papers = json.loads(PAPERS_PATH.read_text())

    title_to_tags: Dict[str, List[str]] = {}
    for p in papers:
        key = p["title"].lower().strip()
        title_to_tags[key] = p.get("tags", [])

    nodes_by_theme: Dict[str, int] = {t: 0 for t in THEME_ORDER}
    augmented_nodes = []
    for n in lineage["nodes"]:
        title_key = n["title"].lower().strip()
        tags = title_to_tags.get(title_key)
        if tags:
            theme = pick_primary_tag(tags)
        else:
            theme = infer_theme(n["title"])
        n_out = dict(n)
        n_out["theme"] = theme
        nodes_by_theme[theme] = nodes_by_theme.get(theme, 0) + 1
        augmented_nodes.append(n_out)

    theme_stats = [(t, c) for t, c in nodes_by_theme.items() if c > 0]
    theme_stats.sort(key=lambda x: -x[1])

    # Drop themes with < 2 nodes into "Other"
    kept_themes = {t for t, c in theme_stats if c >= 2}
    for n in augmented_nodes:
        if n["theme"] not in kept_themes:
            n["theme"] = "Other"

    # Compute theme order by count (descending) for lane ordering
    final_counts: Dict[str, int] = {}
    for n in augmented_nodes:
        final_counts[n["theme"]] = final_counts.get(n["theme"], 0) + 1
    lane_order = [t for t, _ in sorted(final_counts.items(), key=lambda x: -x[1])]

    out = {
        "root": lineage.get("root"),
        "nodes": augmented_nodes,
        "edges": lineage["edges"],
        "lanes": lane_order,
        "lane_counts": final_counts,
    }

    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"Wrote {OUT_PATH} — {len(augmented_nodes)} nodes, {len(lineage['edges'])} edges")
    print("Lane counts:")
    for t in lane_order:
        print(f"  {t}: {final_counts[t]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

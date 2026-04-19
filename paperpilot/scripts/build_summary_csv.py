"""Build a lightweight, human-friendly summary CSV from PaperPilot output.

Input : output/iclr-2026/papers_2026-04-18.csv  (full pipeline output)
Output: output/iclr-2026/summary.csv             (8 columns, sortable)

Columns: title, type, tags, venue, authors, arxiv_url, pdf_url, abstract
- type: Oral / Spotlight / Poster (matched by title against oral_summaries_ja.md)
- tags: auto-classified topic labels (LLM/CV/RL/...) joined with " "
"""

from __future__ import annotations

import csv
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_CSV = ROOT / "output" / "iclr-2026" / "papers_2026-04-18.csv"
ORAL_MD = ROOT / "output" / "iclr-2026" / "oral_summaries_ja.md"
DST_CSV = ROOT / "output" / "iclr-2026" / "summary.csv"


TOPIC_RULES: dict[str, list[str]] = {
    "LLM": [r"\bllm\b", r"large language model", r"language model"],
    "VLM": [r"\bvlm\b", r"vision[- ]language", r"multimodal"],
    "Vision": [r"\bvision\b", r"image", r"video", r"3d", r"rendering", r"gaussian splatting"],
    "Diffusion": [r"diffusion", r"score[- ]based", r"flow matching"],
    "RL": [r"reinforcement learning", r"\brl\b", r"policy gradient", r"q[- ]learning"],
    "Theory": [r"theorem", r"convergence", r"theoretical", r"information[- ]theoretic", r"pac[- ]"],
    "Transformer": [r"transformer", r"attention", r"self[- ]attention"],
    "MoE": [r"mixture[- ]of[- ]experts", r"\bmoe\b"],
    "Graph": [r"graph neural", r"\bgnn\b", r"message passing"],
    "TimeSeries": [r"time series", r"forecast", r"temporal"],
    "Medical": [r"medical", r"clinical", r"ehr", r"protein", r"drug", r"biology"],
    "Robotics": [r"robot", r"manipulation", r"locomotion"],
    "RAG": [r"\brag\b", r"retrieval[- ]augmented"],
    "Agent": [r"\bagent\b", r"tool use"],
    "Causal": [r"causal", r"counterfactual"],
    "SSL": [r"self[- ]supervised", r"contrastive"],
    "Optim": [r"optimization", r"optimizer", r"adam", r"sgd"],
    "Eval": [r"benchmark", r"evaluation", r"\bevals?\b"],
}


def load_oral_titles() -> set[str]:
    text = ORAL_MD.read_text(encoding="utf-8")
    titles = re.findall(r"^## \d+\.\s+(.+)$", text, flags=re.MULTILINE)
    return {normalize(t) for t in titles}


def normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


def classify_tags(title: str, abstract: str) -> list[str]:
    text = f"{title} {abstract}".lower()
    return [tag for tag, patterns in TOPIC_RULES.items() if any(re.search(p, text) for p in patterns)]


def main() -> None:
    oral_titles = load_oral_titles()
    rows_out: list[dict[str, str]] = []

    with SRC_CSV.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            title = row.get("title", "").strip()
            if not title:
                continue
            paper_type = "Oral" if normalize(title) in oral_titles else "Poster"
            tags = classify_tags(title, row.get("abstract", ""))
            rows_out.append(
                {
                    "title": title,
                    "type": paper_type,
                    "tags": " ".join(tags) if tags else "Other",
                    "venue": row.get("venue", ""),
                    "authors": row.get("authors", ""),
                    "arxiv_url": row.get("url", ""),
                    "pdf_url": row.get("pdf_url", ""),
                    "abstract": row.get("abstract", "").replace("\n", " ").strip(),
                }
            )

    rows_out.sort(key=lambda r: (0 if r["type"] == "Oral" else 1, r["title"].lower()))

    with DST_CSV.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["title", "type", "tags", "venue", "authors", "arxiv_url", "pdf_url", "abstract"],
        )
        writer.writeheader()
        writer.writerows(rows_out)

    oral_count = sum(1 for r in rows_out if r["type"] == "Oral")
    print(f"Wrote {len(rows_out)} papers to {DST_CSV}")
    print(f"  Oral: {oral_count}")
    print(f"  Poster: {len(rows_out) - oral_count}")

    tag_counts: dict[str, int] = {}
    for r in rows_out:
        for t in r["tags"].split():
            tag_counts[t] = tag_counts.get(t, 0) + 1
    print("  Top tags:")
    for tag, n in sorted(tag_counts.items(), key=lambda x: -x[1])[:10]:
        print(f"    {tag}: {n}")


if __name__ == "__main__":
    main()

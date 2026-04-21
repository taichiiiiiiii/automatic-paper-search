"""Build a lightweight, human-friendly summary CSV from PaperPilot output.

Input : paperpilot/output/<conference>/papers_YYYY-MM-DD.csv  (pipeline output)
Output: paperpilot/output/<conference>/summary.csv            (8 columns, sortable)

Columns: title, type, tags, venue, authors, arxiv_url, pdf_url, abstract
- type: Oral / Poster (matched by title against oral_summaries_ja.md if present)
- tags: auto-classified topic labels (LLM/CV/RL/...) joined with " "

The source CSV is auto-discovered (latest papers_*.csv in the conference
directory) unless --input is given. This avoids the previous hardcoded
"papers_2026-04-18.csv" that broke whenever the pipeline produced a new
dated file.
"""

from __future__ import annotations

import argparse
import csv
import re
from dataclasses import dataclass
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
_PAPERS_NAME_RE = re.compile(r"^papers_\d{4}-\d{2}-\d{2}\.csv$")


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


@dataclass
class BuildResult:
    rows_written: int
    oral_count: int
    source_csv: Path
    summary_csv: Path
    tag_counts: dict[str, int]


# ---- helpers ----


def find_latest_csv(conference_dir: Path) -> Path:
    """Pick the most recent `papers_YYYY-MM-DD.csv` under the given dir.

    Date is parsed from the filename rather than mtime so the result is
    deterministic across check-outs / CI re-clones.
    """
    candidates = sorted(
        (p for p in conference_dir.iterdir() if p.is_file() and _PAPERS_NAME_RE.match(p.name)),
        key=lambda p: p.name,  # YYYY-MM-DD is lexicographically sortable
    )
    if not candidates:
        raise FileNotFoundError(
            f"No papers_YYYY-MM-DD.csv found under {conference_dir}"
        )
    return candidates[-1]


def load_oral_titles(oral_md: Path) -> set[str]:
    """Extract paper titles from `oral_summaries_ja.md` (looking for `## 1. Title` headers).

    Returns an empty set when the file is absent — the viewer still works,
    all papers just get labeled Poster.
    """
    if not oral_md.exists():
        return set()
    text = oral_md.read_text(encoding="utf-8")
    titles = re.findall(r"^## \d+\.\s+(.+)$", text, flags=re.MULTILINE)
    return {normalize(t) for t in titles}


def normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


def classify_tags(title: str, abstract: str) -> list[str]:
    text = f"{title} {abstract}".lower()
    return [tag for tag, patterns in TOPIC_RULES.items() if any(re.search(p, text) for p in patterns)]


# ---- main entry point ----


def build(
    *,
    conference_dir: Path,
    input_csv: Path | None = None,
) -> BuildResult:
    """Generate summary.csv for the given conference directory."""
    src_csv = input_csv if input_csv is not None else find_latest_csv(conference_dir)
    oral_md = conference_dir / "oral_summaries_ja.md"
    dst_csv = conference_dir / "summary.csv"

    oral_titles = load_oral_titles(oral_md)
    rows_out: list[dict[str, str]] = []

    with src_csv.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            title = (row.get("title") or "").strip()
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
                    "abstract": (row.get("abstract") or "").replace("\n", " ").strip(),
                }
            )

    rows_out.sort(key=lambda r: (0 if r["type"] == "Oral" else 1, r["title"].lower()))

    dst_csv.parent.mkdir(parents=True, exist_ok=True)
    with dst_csv.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["title", "type", "tags", "venue", "authors", "arxiv_url", "pdf_url", "abstract"],
        )
        writer.writeheader()
        writer.writerows(rows_out)

    tag_counts: dict[str, int] = {}
    for r in rows_out:
        for t in r["tags"].split():
            tag_counts[t] = tag_counts.get(t, 0) + 1

    oral_count = sum(1 for r in rows_out if r["type"] == "Oral")
    return BuildResult(
        rows_written=len(rows_out),
        oral_count=oral_count,
        source_csv=src_csv,
        summary_csv=dst_csv,
        tag_counts=tag_counts,
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--conference",
        default="iclr-2026",
        help="Conference directory name under paperpilot/output/ (default: iclr-2026)",
    )
    ap.add_argument(
        "--input",
        help="Explicit path to papers_*.csv (defaults to the latest one in the conference dir)",
    )
    args = ap.parse_args()

    conf_dir = PROJECT / "output" / args.conference
    input_csv = Path(args.input) if args.input else None

    result = build(conference_dir=conf_dir, input_csv=input_csv)

    print(f"Source: {result.source_csv}")
    print(f"Wrote {result.rows_written} papers to {result.summary_csv}")
    print(f"  Oral: {result.oral_count}")
    print(f"  Poster: {result.rows_written - result.oral_count}")
    print("  Top tags:")
    for tag, n in sorted(result.tag_counts.items(), key=lambda x: -x[1])[:10]:
        print(f"    {tag}: {n}")


if __name__ == "__main__":
    main()

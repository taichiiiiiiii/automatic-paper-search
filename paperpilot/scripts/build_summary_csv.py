"""Build a lightweight, human-friendly summary CSV from PaperPilot output.

Input : paperpilot/output/<conference>/papers_YYYY-MM-DD.csv  (pipeline output)
Output: paperpilot/output/<conference>/summary.csv            (14 columns, sortable)

Columns: title, type, tags, venue, authors, arxiv_url, pdf_url, abstract,
         arxiv_id, citation_count, venue_tier, github_stars, source, source_id
- type: Oral / Poster (matched by title against oral_summaries_ja.md if present)
- tags: auto-classified topic labels (LLM/CV/RL/...) joined with " "
- arxiv_id / citation_count / venue_tier / github_stars carry forward
  Stage 2 signal output so build_lineage.py and the viewer don't need to
  re-query S2 or GitHub (absolute rule §12).

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

from paperpilot.identity import IdentityError, identity_from_url, normalize_alias

PROJECT = Path(__file__).resolve().parents[1]
_PAPERS_NAME_RE = re.compile(r"^papers_\d{4}-\d{2}-\d{2}\.csv$")


# Fine-grained topic taxonomy. A paper gets EVERY tag whose pattern matches
# its title+abstract, so categories overlap freely. Patterns are deliberately
# SPECIFIC — the old coarse "Vision" caught ~80% of CV papers (useless as a
# filter), so it is split into concrete tasks, and greedy words ("evaluation",
# bare "efficient"/"bias") are dropped in favour of discriminative phrases.
# The viewer surfaces only each conference's top-18 tags, so a large taxonomy
# self-adapts per venue (CV venues show CV tasks, NLP venues show NLP tasks).
TOPIC_RULES: dict[str, list[str]] = {
    # ---- Model families / architectures ----
    "LLM": [r"\bllms?\b", r"large language model", r"language model"],
    "VLM": [r"\bvlms?\b", r"\bmllms?\b", r"vision[- ]language", r"multimodal"],
    "Diffusion": [
        r"diffusion model",
        r"\bdiffusion\b",
        r"score[- ]based",
        r"flow matching",
        r"\bddpm\b",
    ],
    "Transformer": [r"\btransformers?\b", r"self[- ]attention", r"attention mechanism"],
    "MoE": [r"mixture[- ]of[- ]experts", r"\bmoe\b"],
    "GAN": [r"\bgans?\b", r"generative adversarial"],
    "SSM": [r"state[- ]space model", r"\bmamba\b", r"\bssms?\b"],
    "GNN": [r"graph neural", r"\bgnns?\b", r"message passing"],
    # ---- Computer-vision tasks (the old "Vision" bucket, split) ----
    "Detection": [r"object detection", r"\bdetection\b", r"\bdetector"],
    "Segmentation": [r"segmentation", r"\bsegment\b"],
    "3D": [
        r"\b3d\b",
        r"\bnerf\b",
        r"gaussian splat",
        r"point cloud",
        r"\bmesh\b",
        r"depth estimation",
        r"\bslam\b",
        r"novel view",
    ],
    "ImageGen": [r"image generation", r"image synthesis", r"text[- ]to[- ]image", r"\bt2i\b"],
    "VideoGen": [r"video generation", r"text[- ]to[- ]video", r"\bt2v\b"],
    "Pose": [r"pose estimation", r"keypoint", r"human pose", r"6[- ]?dof"],
    "Tracking": [r"object tracking", r"\bmot\b", r"re[- ]identification", r"\bre[- ]id\b"],
    "Restoration": [
        r"super[- ]resolution",
        r"denois",
        r"deblur",
        r"inpaint",
        r"image restoration",
        r"dehaz",
    ],
    # #356: bare \bface\b matched the English verb ("methods face the
    # challenge of ...") — 60.6% of 1,322 hits were certain verb-only false
    # positives. Require face-domain context instead. Bare "deepfake" is NOT a
    # face signal (audio deepfakes exist), so it stays out.
    "Face": [
        # R2 review additions: word boundaries (\bfacial\b not "maxillofacial",
        # \bface not "surface/interface"), and the face-domain categories the
        # first replacement missed (talking head, head avatar, face forgery,
        # face clustering, portrait animation).
        r"\bfacial\b",
        r"\bface (?:recognition|verification|identification|detection|generation"
        r"|synthesis|swap(?:ping)?|reenactment|editing|restoration"
        r"|anti-spoofing|alignment|parsing|attributes?|landmarks?"
        r"|forgery|clustering|images?|videos?)",
        r"(?:human|3d|talking) faces?\b",
        r"\bfaces? (?:datasets?|benchmarks?)",
        r"talking[ -]head",
        r"head[ -]avatars?\b",
        r"portrait (?:animation|generation)",
    ],
    "OCR": [r"\bocr\b", r"text recognition", r"document understanding", r"scene text"],
    "VideoUnderstanding": [
        r"action recognition",
        r"video understanding",
        r"temporal action",
        r"video question",
    ],
    "Rendering": [r"rendering", r"radiance field", r"neural render"],
    # ---- NLP tasks ----
    "QA": [r"question answering", r"\bvqa\b", r"\bqa\b"],
    "Summarization": [r"summari[sz]"],
    "Translation": [r"machine translation", r"\bnmt\b", r"multilingual"],
    "Dialogue": [r"\bdialog", r"conversational", r"chatbot"],
    "IE": [r"named entity", r"\bner\b", r"information extraction", r"relation extraction"],
    "Reasoning": [r"reasoning", r"chain[- ]of[- ]thought", r"\bcot\b"],
    "Code": [r"code generation", r"program synthesis", r"code model", r"\bcoding\b"],
    "RAG": [r"\brag\b", r"retrieval[- ]augmented"],
    "Agent": [r"\bagents?\b", r"tool use", r"tool[- ]calling"],
    # ---- Learning paradigms / techniques ----
    "RL": [r"reinforcement learning", r"\brl\b", r"policy gradient", r"\brlhf\b"],
    "SSL": [r"self[- ]supervised", r"contrastive learning"],
    "FewShot": [r"few[- ]shot", r"zero[- ]shot", r"in[- ]context learning"],
    "Meta": [r"meta[- ]learning"],
    "Continual": [
        r"continual",
        r"lifelong learning",
        r"catastrophic forgetting",
        r"incremental learning",
    ],
    "Transfer": [r"transfer learning", r"domain adaptation", r"domain generalization"],
    "Distillation": [r"knowledge distillation", r"\bdistillation\b"],
    "Quantization": [r"quantiz", r"low[- ]bit", r"\bint8\b", r"\bint4\b"],
    "Pruning": [r"\bpruning\b", r"sparsit"],
    "NAS": [r"neural architecture search", r"\bnas\b"],
    "Federated": [r"federated"],
    # ---- Trustworthy / safety ----
    "Robustness": [
        r"\brobustness\b",
        r"out[- ]of[- ]distribution",
        r"\bood\b",
        r"distribution shift",
    ],
    "Adversarial": [r"adversarial (attack|example|robust|perturbation|training)"],
    "Fairness": [r"\bfairness\b", r"debias"],
    "Privacy": [r"\bprivacy\b", r"differential privacy"],
    "Interpretability": [r"interpretab", r"explainab", r"\bxai\b"],
    "Safety": [
        r"\bsafety\b",
        r"jailbreak",
        r"hallucinat",
        r"harmful",
        r"\btoxic",
        r"guardrail",
        r"preference align",
        r"value align",
    ],
    "Uncertainty": [r"uncertainty", r"calibrat", r"\bbayesian\b"],
    # ---- Domains ----
    "Medical": [r"medical", r"clinical", r"\behr\b", r"radiolog", r"patholog", r"diagnosis"],
    "Bio": [r"\bprotein", r"molecul", r"drug discovery", r"genomic"],
    "Audio": [r"\baudio\b", r"\bspeech\b", r"\basr\b", r"\btts\b", r"\bmusic\b"],
    "Robotics": [r"\brobot", r"manipulation", r"locomotion", r"navigation"],
    "Autonomous": [r"autonomous driving", r"self[- ]driving"],
    # #356: bare "recommend" matched the prose verb ("we recommend careful
    # evaluation"). Noun forms cover every recommender-systems paper in the
    # corpus (168 -> 163 measured 2026-08-23 via classify_tags itself; the 5 lost hits are verb usage or marginal).
    "Recommendation": [r"recommendation", r"recommender", r"collaborative filtering"],
    "TimeSeries": [r"time series", r"forecast"],
    "Graph": [r"graph representation", r"graph learning"],
    # ---- Theory / optimization / data ----
    "Theory": [r"theorem", r"convergence", r"theoretical", r"\bpac[- ]", r"generalization bound"],
    "Optim": [r"\boptimizer\b", r"\badam\b", r"\bsgd\b", r"optimization algorithm"],
    "Causal": [r"causal", r"counterfactual"],
    # benchmark/dataset only when the paper INTRODUCES one (not the ubiquitous
    # "we benchmark …" verb or "on the X dataset" mention).
    "Benchmark": [
        r"new benchmark",
        r"\bbenchmark (dataset|suite|for)",
        r"comprehensive benchmark",
        r"\bbenchmarking\b",
        r"leaderboard",
    ],
    "Dataset": [
        r"new dataset",
        r"large[- ]scale dataset",
        r"(introduce|present|construct|collect|curat)\w*\s+(a\s+)?(new\s+)?dataset",
        r"data curation",
    ],
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
        raise FileNotFoundError(f"No papers_YYYY-MM-DD.csv found under {conference_dir}")
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


# Invisible zero-width characters (ZWSP/ZWNJ/ZWJ/BOM) leak in from arXiv
# metadata and otherwise survive verbatim into papers.json and
# search-index.json (#371: a U+200C led a real neurips-2025 title).
_ZERO_WIDTH_RE = re.compile("[\u200b\u200c\u200d\ufeff]")


def strip_zero_width(s: str) -> str:
    return _ZERO_WIDTH_RE.sub("", s)


def normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


def classify_tags(title: str, abstract: str) -> list[str]:
    text = f"{title} {abstract}".lower()
    return [
        tag for tag, patterns in TOPIC_RULES.items() if any(re.search(p, text) for p in patterns)
    ]


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
            title = strip_zero_width(row.get("title") or "").strip()
            if not title:
                continue
            abstract = strip_zero_width(row.get("abstract") or "")
            identity = identity_from_url(row.get("url") or "")
            declared_source = (row.get("source") or "").strip()
            declared_source_id = (row.get("source_id") or "").strip()
            if bool(declared_source) != bool(declared_source_id):
                raise IdentityError("source and source_id must be present together")
            if declared_source:
                normalized = normalize_alias(declared_source, declared_source_id)
                if normalized != (identity.source, identity.source_id):
                    raise IdentityError(
                        "declared source/source_id does not match the native source URL"
                    )
            paper_type = "Oral" if normalize(title) in oral_titles else "Poster"
            tags = classify_tags(title, abstract)
            rows_out.append(
                {
                    "title": title,
                    "type": paper_type,
                    "tags": " ".join(tags) if tags else "Other",
                    "venue": row.get("venue", ""),
                    "authors": row.get("authors", ""),
                    "arxiv_url": row.get("url", ""),
                    "pdf_url": row.get("pdf_url", ""),
                    "abstract": abstract.replace("\n", " ").strip(),
                    # Stage 2 signal outputs — empty string when the upstream
                    # pipeline ran without them (legacy CSVs).
                    "arxiv_id": row.get("arxiv_id", ""),
                    "citation_count": row.get("citation_count", ""),
                    "venue_tier": row.get("venue_tier", ""),
                    "github_stars": row.get("github_stars", ""),
                    "source": identity.source,
                    "source_id": identity.source_id,
                }
            )

    rows_out.sort(key=lambda r: (0 if r["type"] == "Oral" else 1, r["title"].lower()))

    dst_csv.parent.mkdir(parents=True, exist_ok=True)
    with dst_csv.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "title",
                "type",
                "tags",
                "venue",
                "authors",
                "arxiv_url",
                "pdf_url",
                "abstract",
                "arxiv_id",
                "citation_count",
                "venue_tier",
                "github_stars",
                "source",
                "source_id",
            ],
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

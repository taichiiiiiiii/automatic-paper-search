"""Tests for paperpilot/scripts/build_summary_csv.py.

The old version hardcoded SRC_CSV = "papers_2026-04-18.csv"; the tests
here enforce that the script now (1) auto-discovers the latest
`papers_YYYY-MM-DD.csv` under a conference directory and (2) accepts
--conference / --input CLI flags so it can be reused beyond ICLR 2026.
"""

from __future__ import annotations

import csv
from pathlib import Path

import pytest

from paperpilot.scripts import build_summary_csv as bsc


def _write_papers_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "title",
        "authors",
        "abstract",
        "url",
        "pdf_url",
        "venue",
        "arxiv_id",
        "citation_count",
        "venue_tier",
        "github_stars",
        "source",
        "source_id",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def _write_oral_md(path: Path, titles: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"## {i}. {t}" for i, t in enumerate(titles, start=1)]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---- find_latest_csv ----


def test_find_latest_csv_picks_newest_date(tmp_path: Path):
    conf = tmp_path / "iclr-2026"
    conf.mkdir()
    (conf / "papers_2026-04-01.csv").write_text("")
    (conf / "papers_2026-04-18.csv").write_text("")
    (conf / "papers_2026-03-10.csv").write_text("")

    latest = bsc.find_latest_csv(conf)
    assert latest.name == "papers_2026-04-18.csv"


def test_find_latest_csv_ignores_other_files(tmp_path: Path):
    conf = tmp_path / "iclr-2026"
    conf.mkdir()
    (conf / "summary.csv").write_text("")
    (conf / "papers_2026-04-01.csv").write_text("")
    (conf / "oral_summaries_ja.md").write_text("")
    (conf / "run_history.jsonl").write_text("")

    latest = bsc.find_latest_csv(conf)
    assert latest.name == "papers_2026-04-01.csv"


def test_find_latest_csv_errors_when_missing(tmp_path: Path):
    conf = tmp_path / "empty"
    conf.mkdir()
    with pytest.raises(FileNotFoundError):
        bsc.find_latest_csv(conf)


# ---- build() end-to-end ----


def test_build_generates_summary_with_auto_discovery(tmp_path: Path):
    conf = tmp_path / "iclr-2026"
    _write_papers_csv(
        conf / "papers_2026-04-18.csv",
        [
            {
                "title": "Scaling Language Models",
                "authors": "Alice; Bob",
                "abstract": "We train a large language model.",
                "url": "http://arxiv.org/abs/2404.00001",
                "pdf_url": "http://arxiv.org/pdf/2404.00001",
                "venue": "ICLR 2026 Oral",
            },
            {
                "title": "Diffusion Baseline",
                "authors": "Carol",
                "abstract": "A diffusion-based image generator.",
                "url": "http://arxiv.org/abs/2404.00002",
                "pdf_url": "http://arxiv.org/pdf/2404.00002",
                "venue": "ICLR 2026",
            },
            {
                "title": "",  # must be dropped
                "authors": "",
                "abstract": "",
                "url": "",
                "pdf_url": "",
                "venue": "",
            },
        ],
    )
    _write_oral_md(conf / "oral_summaries_ja.md", ["Scaling Language Models"])

    result = bsc.build(conference_dir=conf)
    assert result.rows_written == 2
    assert result.oral_count == 1

    summary = conf / "summary.csv"
    assert summary.exists()
    with summary.open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    # Sorted: Oral first, then alphabetical
    assert rows[0]["title"] == "Scaling Language Models"
    assert rows[0]["type"] == "Oral"
    assert "LLM" in rows[0]["tags"]
    assert rows[1]["title"] == "Diffusion Baseline"
    assert rows[1]["type"] == "Poster"
    assert "Diffusion" in rows[1]["tags"]


def test_build_with_explicit_input_csv(tmp_path: Path):
    conf = tmp_path / "neurips-2025"
    _write_papers_csv(
        conf / "papers_2025-12-01.csv",
        [
            {
                "title": "Explicit Input Paper",
                "authors": "A",
                "abstract": "x",
                "url": "https://arxiv.org/abs/2404.00004",
                "pdf_url": "p",
                "venue": "",
            }
        ],
    )
    _write_oral_md(conf / "oral_summaries_ja.md", [])

    # Caller can point at any CSV path, bypassing auto-discovery
    result = bsc.build(conference_dir=conf, input_csv=conf / "papers_2025-12-01.csv")
    assert result.rows_written == 1
    assert result.oral_count == 0


def test_build_preserves_structured_ids_from_pipeline_csv(tmp_path: Path):
    """arxiv_id / citation_count / venue_tier / github_stars round-trip to summary.csv.

    build_lineage.py relies on arxiv_id being present directly rather than
    re-parsing it out of the URL, and the viewer uses citation_count / stars
    for sizing node bubbles.
    """
    conf = tmp_path / "iclr-2026"
    _write_papers_csv(
        conf / "papers_2026-04-18.csv",
        [
            {
                "title": "Paper With IDs",
                "authors": "A",
                "abstract": "x",
                "url": "http://arxiv.org/abs/2404.00001",
                "pdf_url": "p",
                "venue": "ICLR",
                "arxiv_id": "2404.00001",
                "citation_count": "42",
                "venue_tier": "3",
                "github_stars": "120",
            }
        ],
    )

    bsc.build(conference_dir=conf)
    with (conf / "summary.csv").open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    assert rows[0]["arxiv_id"] == "2404.00001"
    assert rows[0]["citation_count"] == "42"
    assert rows[0]["venue_tier"] == "3"
    assert rows[0]["github_stars"] == "120"


def test_build_handles_pipeline_csv_without_ids(tmp_path: Path):
    """Old pipeline output without arxiv_id etc. still works — fields are empty."""
    conf = tmp_path / "legacy"
    # Write a CSV that only has the original columns, no arxiv_id.
    conf.mkdir()
    csv_path = conf / "papers_2024-01-01.csv"
    with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=["title", "authors", "abstract", "url", "pdf_url", "venue"]
        )
        writer.writeheader()
        writer.writerow(
            {
                "title": "Legacy Paper",
                "authors": "Z",
                "abstract": "abs",
                "url": "https://arxiv.org/abs/2404.00005",
                "pdf_url": "p",
                "venue": "",
            }
        )

    bsc.build(conference_dir=conf)
    with (conf / "summary.csv").open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    assert rows[0]["title"] == "Legacy Paper"
    assert rows[0]["arxiv_id"] == ""
    assert rows[0]["citation_count"] == ""
    assert rows[0]["source"] == "arxiv"
    assert rows[0]["source_id"] == "2404.00005"


def test_build_strips_zero_width_characters(tmp_path: Path):
    """U+200B/200C/200D/FEFF は title・abstract から除去して出力する。

    実データ由来: neurips-2025 の1論文 title 先頭に U+200C が混入し、
    papers.json と search-index.json まで伝播していた (#371)。
    """
    conf = tmp_path / "neurips-2025"
    _write_papers_csv(
        conf / "papers_2026-06-28.csv",
        [
            {
                "title": "\u200cNavigating the Trade-Off",
                "authors": "Dave",
                "abstract": "Flexible\u200d pooling with\ufeff attention.\u200b",
                "url": "http://arxiv.org/abs/2404.00003",
                "pdf_url": "http://arxiv.org/pdf/2404.00003",
                "venue": "NeurIPS 2025",
            },
        ],
    )

    result = bsc.build(conference_dir=conf)
    assert result.rows_written == 1

    with (conf / "summary.csv").open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    assert rows[0]["title"] == "Navigating the Trade-Off"
    assert rows[0]["abstract"] == "Flexible pooling with attention."


def test_build_tolerates_missing_oral_md(tmp_path: Path):
    # When oral_summaries_ja.md is missing, every paper should be "Poster"
    # rather than crashing — the pipeline-layer CSV is the source of truth.
    conf = tmp_path / "iclr-2027"
    _write_papers_csv(
        conf / "papers_2027-01-01.csv",
        [
            {
                "title": "Solo Paper",
                "authors": "X",
                "abstract": "graph neural network",
                "url": "https://arxiv.org/abs/2404.00006",
                "pdf_url": "p",
                "venue": "",
            }
        ],
    )

    result = bsc.build(conference_dir=conf)
    assert result.rows_written == 1
    assert result.oral_count == 0

    with (conf / "summary.csv").open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    assert rows[0]["type"] == "Poster"
    # "graph neural network" now maps to the more specific GNN tag
    assert "GNN" in rows[0]["tags"]


# ---- classify_tags: fine-grained taxonomy ----


def test_classify_tags_specific_cv_tasks():
    assert "3D" in bsc.classify_tags("3D Object Detection via NeRF", "point cloud")
    assert "Detection" in bsc.classify_tags("3D Object Detection via NeRF", "")
    assert "Segmentation" in bsc.classify_tags("Panoptic Segmentation", "")
    assert "Restoration" in bsc.classify_tags("Image Super-Resolution", "")
    # the old coarse "Vision" mega-tag no longer exists
    assert "Vision" not in bsc.TOPIC_RULES


def test_classify_tags_specific_nlp_tasks():
    assert "QA" in bsc.classify_tags("Visual Question Answering", "")
    assert "Translation" in bsc.classify_tags("Neural Machine Translation", "")
    assert "Summarization" in bsc.classify_tags("Abstractive Summarization", "")
    assert "Reasoning" in bsc.classify_tags("Chain-of-Thought Reasoning", "")


def test_classify_tags_greedy_patterns_tightened():
    # "we benchmark our method" (verb) must NOT tag Benchmark
    assert "Benchmark" not in bsc.classify_tags(
        "A Fast Detector", "We benchmark our method on COCO."
    )
    # but a benchmark-introducing paper does
    assert "Benchmark" in bsc.classify_tags("MMBench: A New Benchmark for VLMs", "")
    # "on the X dataset" (mention) must NOT tag Dataset
    assert "Dataset" not in bsc.classify_tags("A Method", "Evaluated on the ImageNet dataset.")
    assert "Dataset" in bsc.classify_tags("We introduce a new dataset for driving", "")
    # CV "feature alignment" must NOT tag Safety (AI-safety sense only)
    assert "Safety" not in bsc.classify_tags("Cross-Modal Feature Alignment", "")
    assert "Safety" in bsc.classify_tags("Jailbreak Attacks on LLMs", "")


def test_classify_tags_multiple_and_empty():
    tags = bsc.classify_tags("Efficient Diffusion Models for Text-to-Image Generation", "")
    assert "Diffusion" in tags and "ImageGen" in tags
    assert bsc.classify_tags("A purely abstract note", "with no topical keywords") == []


# --------------------------------------------------------------------------- #
# Issue #356 — TOPIC_RULES must not fire on ordinary English prose            #
# --------------------------------------------------------------------------- #
#
# The `Face` rule used to be [r"\bface\b", r"\bfaces\b", r"facial"], which
# tagged every abstract saying "these methods face the challenge of ..." as a
# face-recognition paper. Measured on the shipped catalogue (28,300 papers)
# that was 1,322 hits of which 60.6% were certain verb-only false positives.
# The replacement demands face-domain context and measures 0 verb-only hits,
# 0 lost face-domain papers.

VERB_PROSE = [
    # Real openers from mis-tagged abstracts (verbatim patterns, not invented).
    "however, these methods face the challenge of scalability.",
    "existing approaches face significant limitations in practice.",
    "large language models face increasing complexity at inference time.",
    "policies trained purely offline face a dilemma.",
    "we face several obstacles when deploying such systems.",
    "the community faces numerous issues with reproducibility.",
]

FACE_DOMAIN = [
    ("face recognition under occlusion", True),
    ("facial landmark detection", True),
    ("talking face generation from audio", True),
    ("3d face reconstruction", True),
    ("a new large-scale faces dataset", True),
    ("face swapping with diffusion models", True),
    # Audio deepfakes are NOT face papers — the rule must not use bare
    # "deepfake" as a face signal.
    ("detect all-type deepfake audio with wavelet prompt tuning", False),
    # R2 review: the first replacement lacked word boundaries, so
    # "Surface Detection" matched "face detection" and "maxillofacial"
    # matched "facial". Both shipped as false positives.
    ("neural surface detection for unsigned distance fields", False),
    ("maxillofacial bone segmentation benchmark", False),
    ("interface generation for embedded systems", False),
    # R2 review: face-domain categories the first replacement missed —
    # papers that legitimately lost their tag. My own "0 papers lost"
    # verifier shared the same blind spot as the rule (its face-domain
    # regex also lacked these), which is how the claim survived.
    ("dualtalk: 3d talking head conversations", True),
    ("gaussian head avatar from monocular video", True),
    ("face forgery detection in the wild", True),
    ("deep face clustering at scale", True),
    ("portrait animation with audio-driven motion", True),
]


def test_face_rule_ignores_verb_usage() -> None:
    for prose in VERB_PROSE:
        tags = bsc.classify_tags(prose, "")
        assert "Face" not in tags, f"Face fired on ordinary prose: {prose!r}"


def test_face_rule_still_catches_face_domain() -> None:
    for text, expect in FACE_DOMAIN:
        tags = bsc.classify_tags(text, "")
        assert ("Face" in tags) is expect, (text, tags)


def test_no_rule_fires_on_generic_prose() -> None:
    """The generalised #356 guard: an abstract of ordinary academic filler
    must produce no tags at all. Every word here is common English that a
    keyword rule could plausibly over-match.
    """
    generic = (
        "in this paper we present a novel approach. we recommend careful "
        "evaluation. our method addresses the problem and we face the "
        "challenge of scale. results demonstrate the effectiveness of the "
        "proposed approach on standard settings."
    )
    tags = bsc.classify_tags("", generic)
    assert tags == [], f"rules fired on generic prose: {tags}"

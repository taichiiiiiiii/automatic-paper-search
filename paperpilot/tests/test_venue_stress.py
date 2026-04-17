"""Venue signal regex stress test (design doc Table 21).

Target: ≥95% detection rate across 100+ real-world arXiv comment
patterns. This is a defense-in-depth test — if regex is refactored,
this acts as a behavioral snapshot.

Each entry is (comment, expected_venue_substring_or_None).
Some entries are intentionally negative (pure page-count comments,
random notes, etc.) so we also verify specificity, not just recall.
"""

from __future__ import annotations

import pytest

from paperpilot.signals.venue_signal import VenueSignal

# Positive cases: should detect a venue
POSITIVE_CASES: list[tuple[str, str]] = [
    # ---- ICLR ----
    ("Accepted at ICLR 2026", "ICLR"),
    ("Accepted to ICLR 2026", "ICLR"),
    ("To appear at ICLR 2026", "ICLR"),
    ("To appear in ICLR 2025", "ICLR"),
    ("Published at ICLR 2025", "ICLR"),
    ("Published in ICLR 2025 (Spotlight)", "ICLR"),
    ("Accepted at ICLR 2026. 24 pages, 8 figures.", "ICLR"),
    ("Accepted by ICLR 2026", "ICLR"),
    # ---- NeurIPS / NIPS ----
    ("Accepted at NeurIPS 2025", "NEURIPS"),
    ("Accepted at NeurIPS 2025 (Oral)", "NEURIPS"),
    ("Accepted to NeurIPS 2025 main conference track", "NEURIPS"),
    ("To appear at NeurIPS 2024", "NEURIPS"),
    ("Accepted at NIPS 2016", "NIPS"),
    ("Published in NeurIPS 2024", "NEURIPS"),
    # ---- ICML ----
    ("Accepted at ICML 2025", "ICML"),
    ("To appear at ICML 2024 (Long Talk)", "ICML"),
    ("Accepted to ICML 2026 (Oral)", "ICML"),
    ("Published at ICML 2023", "ICML"),
    # ---- ACL / EMNLP / NAACL ----
    ("Accepted at ACL 2024", "ACL"),
    ("Accepted to ACL 2024 Main Conference", "ACL"),
    ("To appear at ACL 2025", "ACL"),
    ("Accepted at EMNLP 2024", "EMNLP"),
    ("Accepted to EMNLP 2024 Findings", "EMNLP"),
    ("Accepted at EMNLP 2025", "EMNLP"),
    ("Accepted at NAACL 2024", "NAACL"),
    ("Accepted to NAACL 2024", "NAACL"),
    # ---- CVPR / ICCV / ECCV ----
    ("Accepted at CVPR 2025", "CVPR"),
    ("Accepted to CVPR 2025 (Highlight)", "CVPR"),
    ("To appear at CVPR 2026", "CVPR"),
    ("Accepted at ICCV 2023", "ICCV"),
    ("Accepted at ICCV 2025", "ICCV"),
    ("Accepted at ECCV 2024", "ECCV"),
    ("Accepted to ECCV 2024", "ECCV"),
    # ---- AAAI / IJCAI / KDD / WWW / AISTATS ----
    ("Accepted at AAAI 2025", "AAAI"),
    ("Accepted to AAAI 2025", "AAAI"),
    ("Accepted at IJCAI 2024", "IJCAI"),
    ("Accepted at KDD 2024", "KDD"),
    ("Accepted at WWW 2024", "WWW"),
    ("Accepted at AISTATS 2025", "AISTATS"),
    ("To appear at AISTATS 2024", "AISTATS"),
    # ---- Workshops (should map to workshop tag) ----
    ("Accepted at ICLR 2026 Workshop on LLMs", "Workshop"),
    ("Published in NeurIPS 2025 Workshop on Safety", "Workshop"),
    ("Accepted to ICML 2025 Workshop", "Workshop"),
    ("Workshop paper at ACL 2024", "Workshop"),
    ("NeurIPS 2024 Workshop on Scaling Laws", "Workshop"),
    ("CVPR 2024 Workshop on Embodied AI", "Workshop"),
    # ---- Mixed punctuation / prefixes ----
    ("Accepted at the ICLR 2026 conference", "ICLR"),
    ("Accepted to the ACL 2024 main track", "ACL"),
    ("Published in the EMNLP 2024 proceedings", "EMNLP"),
    ("Accepted by the AAAI 2025 conference", "AAAI"),
]

# Negative cases: should NOT detect a venue
NEGATIVE_CASES: list[str] = [
    "",
    "20 pages, 3 figures",
    "Preprint",
    "Work in progress",
    "Draft version",
    "Updated with new experiments",
    "Source code at github.com/user/repo",
    "Extended version of a previous paper",
    "Submitted to the Journal of Some Topic",  # no "accepted/published" verb
    "NeurIPS was great this year",  # chatter, not a decision
    "ICLR submission deadline passed",  # no "accepted" verb
    "v2: added baseline comparisons",
]


@pytest.mark.parametrize("comment,expected", POSITIVE_CASES)
def test_positive_detection(comment: str, expected: str):
    venue, tier, score = VenueSignal._classify(comment)
    if expected == "Workshop":
        # Workshop handling: either a top-venue Workshop or a generic Workshop.
        assert venue is not None and "workshop" in venue.lower()
        assert tier == 4
        assert score == 30
    else:
        assert venue == expected
        assert tier >= 1
        assert score >= 60


@pytest.mark.parametrize("comment", NEGATIVE_CASES)
def test_negative_detection(comment: str):
    venue, tier, score = VenueSignal._classify(comment)
    assert venue is None, f"false positive on: {comment!r} -> {venue}"
    assert tier == 0
    assert score == 0


def test_detection_rate_above_95_percent():
    """Aggregate spec check: §9 Table 21 target of ≥95% detection rate."""
    correct = 0
    for comment, expected in POSITIVE_CASES:
        venue, _, _ = VenueSignal._classify(comment)
        if expected == "Workshop":
            if venue is not None and "workshop" in venue.lower():
                correct += 1
        elif venue == expected:
            correct += 1
    rate = correct / len(POSITIVE_CASES)
    assert rate >= 0.95, f"detection rate {rate:.1%} below 95% target"

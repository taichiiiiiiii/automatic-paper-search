"""VenueSignal regex classifier tests."""

from __future__ import annotations

import pytest

from paperpilot.signals.venue_signal import VenueSignal


@pytest.mark.parametrize(
    "comment,expected_venue,expected_tier,expected_score",
    [
        ("Accepted at ICLR 2026", "ICLR", 1, 100),
        ("Accepted to NeurIPS 2025", "NEURIPS", 1, 100),
        ("To appear at ACL 2026", "ACL", 2, 80),
        ("Published in CVPR 2025", "CVPR", 2, 80),
        ("Accepted at EMNLP 2025 (Main)", "EMNLP", 2, 80),
        ("Accepted at AISTATS 2026", "AISTATS", 3, 60),
        ("Accepted at ICLR 2026 Workshop", "ICLR Workshop", 4, 30),
        ("Published in NeurIPS 2025 Workshop on Safety", "NEURIPS Workshop", 4, 30),
        ("Some random workshop paper", "Workshop", 4, 30),
        ("", None, 0, 0),
        ("20 pages, 3 figures", None, 0, 0),
    ],
)
def test_classify(comment, expected_venue, expected_tier, expected_score):
    venue, tier, score = VenueSignal._classify(comment)
    assert venue == expected_venue
    assert tier == expected_tier
    assert score == expected_score


def test_enrich_one_sets_fields(sample_paper):
    signal = VenueSignal({"enabled": True})
    enriched = signal.enrich_one(sample_paper)
    assert enriched.venue == "ICLR"
    assert enriched.venue_tier == 1
    assert enriched.venue_score == 100.0


def test_enrich_one_no_comment(sample_paper):
    sample_paper.comment = None
    signal = VenueSignal({"enabled": True})
    enriched = signal.enrich_one(sample_paper)
    assert enriched.venue is None
    assert enriched.venue_tier == 0

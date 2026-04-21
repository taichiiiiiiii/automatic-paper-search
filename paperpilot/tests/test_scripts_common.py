"""Tests for shared helpers used by paperpilot/scripts/*."""

from __future__ import annotations

from paperpilot.scripts._common import slug_to_venue_label


def test_slug_to_venue_label_iclr():
    assert slug_to_venue_label("iclr-2026") == "ICLR 2026"


def test_slug_to_venue_label_preserves_year():
    assert slug_to_venue_label("neurips-2025") == "NEURIPS 2025"


def test_slug_to_venue_label_handles_multiple_dashes():
    # "emnlp-findings-2025" -> "EMNLP FINDINGS 2025"
    assert slug_to_venue_label("emnlp-findings-2025") == "EMNLP FINDINGS 2025"


def test_slug_to_venue_label_empty_input():
    assert slug_to_venue_label("") == ""

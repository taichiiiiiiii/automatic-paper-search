"""GitHubSignal — log-scale star normalization tests."""

from __future__ import annotations

import math

from paperpilot.signals.github_signal import MAX_STARS, _stars_to_score


def test_zero_stars():
    assert _stars_to_score(0) == 0.0


def test_negative_stars_is_zero():
    assert _stars_to_score(-1) == 0.0


def test_max_stars_is_100():
    assert _stars_to_score(MAX_STARS) == 100.0


def test_above_max_still_100():
    assert _stars_to_score(MAX_STARS * 10) == 100.0


def test_log_curve_monotonic():
    scores = [_stars_to_score(s) for s in (1, 10, 100, 1000, 5000, 10000)]
    assert scores == sorted(scores)
    assert len(set(scores)) == len(scores)  # all distinct


def test_1000_stars_matches_formula():
    expected = math.log(1001) / math.log(MAX_STARS + 1) * 100
    assert _stars_to_score(1000) == expected

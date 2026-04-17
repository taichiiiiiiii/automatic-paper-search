"""KeywordSignal tests — match_count based normalization."""

from __future__ import annotations

from paperpilot.signals.keyword_signal import KeywordSignal, _normalize


def test_normalize_collapses_hyphens():
    assert _normalize("Retrieval-Augmented Generation") == "retrieval augmented generation"
    assert _normalize("MULTI_task/LEARNING") == "multi task learning"


def test_zero_matches(sample_paper):
    sig = KeywordSignal({"enabled": True}, keywords=["quantum computing"])
    p = sig.enrich_one(sample_paper)
    assert p.keyword_match_count == 0
    assert p.keyword_score == 0.0


def test_title_match_normalizes_hyphens(sample_paper):
    # "retrieval augmented generation" should match "Retrieval-Augmented Generation"
    sig = KeywordSignal({"enabled": True}, keywords=["retrieval augmented generation"])
    p = sig.enrich_one(sample_paper)
    assert p.keyword_match_count == 1
    assert p.keyword_score == pytest_approx(100 / 3, tol=0.01)


def test_saturation_at_three_matches(sample_paper):
    keywords = ["retrieval", "language models", "augmented"]
    sig = KeywordSignal({"enabled": True}, keywords=keywords)
    p = sig.enrich_one(sample_paper)
    assert p.keyword_match_count == 3
    assert p.keyword_score == 100.0


def test_capped_at_100(sample_paper):
    keywords = ["retrieval", "augmented", "language", "models", "generation"]
    sig = KeywordSignal({"enabled": True}, keywords=keywords)
    p = sig.enrich_one(sample_paper)
    assert p.keyword_match_count == 5
    assert p.keyword_score == 100.0


def pytest_approx(expected: float, tol: float = 0.001):
    # Lightweight local approx helper to keep the test free of pytest.approx wrapping clutter.
    class _Approx:
        def __init__(self, v: float, t: float) -> None:
            self.v, self.t = v, t

        def __eq__(self, other: float) -> bool:  # type: ignore[override]
            return abs(other - self.v) < self.t

        def __repr__(self) -> str:
            return f"~{self.v}±{self.t}"

    return _Approx(expected, tol)

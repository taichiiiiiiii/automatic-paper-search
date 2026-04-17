"""Stage 4 rerank — tests with a fake provider."""

from __future__ import annotations

from datetime import date

from paperpilot.llm.base import AbstractLLMProvider, PaperEvaluation
from paperpilot.models import Paper
from paperpilot.pipeline.stage_llm_rank import llm_rerank


class FakeProvider(AbstractLLMProvider):
    """Returns pre-canned evaluations (or None) per paper, in order."""

    name = "fake"

    def __init__(self, evaluations: list[PaperEvaluation | None], batch_size: int = 5):
        super().__init__({"enabled": True, "batch_size": batch_size})
        self._queue = list(evaluations)

    def evaluate_batch(self, papers, profile):
        taken = self._queue[: len(papers)]
        self._queue = self._queue[len(papers) :]
        # Pad if fewer canned results than papers.
        while len(taken) < len(papers):
            taken.append(None)
        return taken


def _mk(title: str, score: float = 0.0) -> Paper:
    return Paper(
        title=title,
        authors=["A"],
        abstract="abs",
        url=f"http://x/{title}",
        published_date=date.today(),
        source="arxiv",
        total_score=score,
    )


def test_rerank_sorts_by_relevance_desc():
    papers = [_mk("A", score=10), _mk("B", score=20), _mk("C", score=30)]
    evaluations = [
        PaperEvaluation(relevance=2, summary_ja="s1", reason="r1", tags=[]),
        PaperEvaluation(relevance=5, summary_ja="s2", reason="r2", tags=[]),
        PaperEvaluation(relevance=3, summary_ja="s3", reason="r3", tags=[]),
    ]
    provider = FakeProvider(evaluations, batch_size=10)

    out = llm_rerank(papers, provider=provider, profile="x", top_n=3)
    # Order: rel=5 (B), rel=3 (C), rel=2 (A)
    assert [p.title for p in out] == ["B", "C", "A"]
    assert out[0].llm_relevance == 5
    assert out[0].llm_summary_ja == "s2"


def test_rerank_batches_correctly():
    papers = [_mk(f"P{i}") for i in range(7)]
    evaluations = [
        PaperEvaluation(relevance=i % 5 + 1, summary_ja="", reason="", tags=[])
        for i in range(7)
    ]
    provider = FakeProvider(evaluations, batch_size=3)

    out = llm_rerank(papers, provider=provider, profile="", top_n=7)
    assert len(out) == 7
    # All papers should have llm_relevance set
    assert all(p.llm_relevance is not None for p in out)


def test_rerank_unevaluated_rank_after_evaluated():
    # A evaluated rel=2, B evaluated None, C evaluated rel=5
    papers = [_mk("A", score=100), _mk("B", score=200), _mk("C", score=10)]
    evaluations = [
        PaperEvaluation(relevance=2, summary_ja="", reason="", tags=[]),
        None,
        PaperEvaluation(relevance=5, summary_ja="", reason="", tags=[]),
    ]
    provider = FakeProvider(evaluations, batch_size=10)

    out = llm_rerank(papers, provider=provider, profile="", top_n=3)
    # Order: evaluated (C rel=5, A rel=2) then unevaluated (B)
    assert [p.title for p in out] == ["C", "A", "B"]
    assert out[2].llm_relevance is None


def test_rerank_no_provider_returns_top_n():
    papers = [_mk(f"P{i}", score=float(i)) for i in range(5)]
    out = llm_rerank(papers, provider=None, profile="", top_n=3)
    assert len(out) == 3


def test_rerank_disabled_provider_returns_top_n():
    papers = [_mk(f"P{i}", score=float(i)) for i in range(5)]
    provider = FakeProvider([], batch_size=5)
    provider.enabled = False
    out = llm_rerank(papers, provider=provider, profile="", top_n=2)
    assert len(out) == 2

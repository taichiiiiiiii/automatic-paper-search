"""Direct tests for stage_collect and stage_metric_score."""

from __future__ import annotations

import asyncio
from datetime import date, timedelta

from paperpilot.models import Paper
from paperpilot.pipeline.stage_collect import collect
from paperpilot.pipeline.stage_metric_score import metric_score
from paperpilot.signals.base import AbstractSignal
from paperpilot.sources.base import AbstractSource


class _FakeSource(AbstractSource):
    name = "fake"

    def __init__(self, papers: list[Paper], fail: bool = False, enabled: bool = True):
        super().__init__({"enabled": enabled})
        self._papers = papers
        self._fail = fail

    def fetch(self, *args, **kwargs):
        if self._fail:
            raise RuntimeError("boom")
        return self._papers


class _TagSignal(AbstractSignal):
    """Test signal that writes a known value into keyword_score."""

    name = "tag"

    def __init__(self, score: float, fail: bool = False):
        super().__init__({"enabled": True})
        self._score = score
        self._fail = fail

    def enrich_one(self, paper: Paper) -> Paper:
        if self._fail:
            raise RuntimeError("signal failure")
        paper.keyword_score = self._score
        return paper


def _mk_paper(suffix: str, pub: date | None = None) -> Paper:
    return Paper(
        title=f"Paper {suffix}",
        authors=["A"],
        abstract="abs",
        url=f"http://x/{suffix}",
        published_date=pub or date.today(),
        source="fake",
        arxiv_id=f"2604.{suffix}",
    )


# -------- stage_collect --------


def test_collect_aggregates_enabled_sources_only():
    papers1 = [_mk_paper("a"), _mk_paper("b")]
    papers2 = [_mk_paper("c")]
    s1 = _FakeSource(papers1)
    s2 = _FakeSource(papers2, enabled=False)  # should be skipped

    result, since, status = asyncio.run(
        collect([s1, s2], keywords=["x"], categories=[], days_back=7, max_results_per_keyword=10)
    )
    assert len(result) == 2
    assert since == date.today() - timedelta(days=7)
    assert "fake" in status
    assert status["fake"]["ok"] is True


def test_collect_dedups_across_sources():
    shared = _mk_paper("same")
    s1 = _FakeSource([shared])
    s2 = _FakeSource([_mk_paper("same")])  # same arxiv_id
    result, _, _ = asyncio.run(
        collect([s1, s2], keywords=["x"], categories=[], days_back=7, max_results_per_keyword=10)
    )
    assert len(result) == 1


def test_collect_records_source_failure_in_status():
    good = _FakeSource([_mk_paper("1")])
    bad = _FakeSource([], fail=True)
    bad.name = "bad"

    result, _, status = asyncio.run(
        collect([good, bad], keywords=["x"], categories=[], days_back=7, max_results_per_keyword=10)
    )
    assert len(result) == 1  # only good source's paper
    assert status["fake"]["ok"] is True
    assert status["bad"]["ok"] is False
    assert "boom" in (status["bad"].get("error") or "")


def test_collect_no_enabled_sources_returns_empty():
    s = _FakeSource([_mk_paper("1")], enabled=False)
    result, _, status = asyncio.run(
        collect([s], keywords=["x"], categories=[], days_back=7, max_results_per_keyword=10)
    )
    assert result == []
    assert status == {}


# -------- stage_metric_score --------


def test_metric_score_enriches_and_sorts():
    papers = [_mk_paper("1"), _mk_paper("2"), _mk_paper("3")]
    # Manually seed scores to verify sort. Signal just overrides keyword_score.
    for p, s in zip(papers, [10.0, 50.0, 30.0]):
        p.keyword_score = s

    out = metric_score(
        papers=papers,
        signals=[],  # no signals, just scoring+sort
        weights={"keyword": 1.0},
        top_n=5,
    )
    # Sorted desc by total_score; ties broken by Python's stable sort
    totals = [p.total_score for p in out]
    assert totals == sorted(totals, reverse=True)
    assert out[0].title == "Paper 2"


def test_metric_score_handles_signal_failure_gracefully():
    papers = [_mk_paper("1"), _mk_paper("2")]
    good = _TagSignal(score=50.0)
    bad = _TagSignal(score=0.0, fail=True)
    # Signals run in order; a failing signal must not abort the stage.
    out = metric_score(
        papers=papers,
        signals=[bad, good],
        weights={"keyword": 1.0},
        top_n=10,
    )
    # Good signal still ran → keyword_score set to 50
    for p in out:
        assert p.keyword_score == 50.0
        assert p.total_score == 50.0


def test_metric_score_skips_disabled_signals():
    papers = [_mk_paper("1")]
    enabled_sig = _TagSignal(score=75.0)
    disabled_sig = _TagSignal(score=9999.0)
    disabled_sig.enabled = False

    out = metric_score(
        papers=papers,
        signals=[disabled_sig, enabled_sig],
        weights={"keyword": 1.0},
        top_n=10,
    )
    # Disabled signal must not override the enabled one
    assert out[0].keyword_score == 75.0


def test_metric_score_top_n_truncation():
    papers = [_mk_paper(str(i)) for i in range(10)]
    for i, p in enumerate(papers):
        p.keyword_score = float(i)
    out = metric_score(papers, signals=[], weights={"keyword": 1.0}, top_n=3)
    assert len(out) == 3
    # Top 3 are highest scoring
    assert {p.title for p in out} == {"Paper 9", "Paper 8", "Paper 7"}


def test_metric_score_top_n_zero_keeps_all():
    papers = [_mk_paper(str(i)) for i in range(5)]
    out = metric_score(papers, signals=[], weights={}, top_n=0)
    assert len(out) == 5


def test_metric_score_empty_input():
    assert metric_score([], signals=[], weights={}, top_n=10) == []


def test_metric_score_weights_combine_signals():
    papers = [_mk_paper("1")]
    p = papers[0]
    p.venue_score = 100.0
    p.github_score = 50.0
    p.keyword_score = 20.0
    out = metric_score(
        papers,
        signals=[],  # scores already set manually
        weights={"venue": 3.0, "github": 2.0, "keyword": 0.5},
        top_n=1,
    )
    # 100*3 + 50*2 + 20*0.5 = 410
    assert out[0].total_score == 410.0

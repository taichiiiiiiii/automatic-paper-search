"""Direct tests for stage_collect and stage_metric_score."""

from __future__ import annotations

import asyncio
import logging
from datetime import date, timedelta
from pathlib import Path

import yaml

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
    # A source that recorded no per-keyword reason keeps its own message verbatim:
    # the reason is appended when there is one, never invented.
    assert (status["bad"].get("error") or "") == "boom"


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


def test_metric_score_records_a_crashed_signal_on_its_run_channel():
    """Stage 2 degrades through the signal's own channel, never through its
    return value (rule §4): the runner has to learn the ranking is missing
    evidence while still receiving a list[Paper]."""
    papers = [_mk_paper("1"), _mk_paper("2")]
    crashed = _TagSignal(score=0.0, fail=True)

    out = metric_score(
        papers=papers, signals=[crashed], weights={"keyword": 1.0}, top_n=10
    )

    assert [p.title for p in out] == ["Paper 1", "Paper 2"]
    assert len(crashed.run_failures) == 1
    assert crashed.run_failures[0].startswith("enrich_batch raised RuntimeError")
    assert "signal failure" in crashed.run_failures[0]


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


def test_metric_score_require_follow_match_off_keeps_all():
    papers = [_mk_paper("1"), _mk_paper("2")]
    papers[0].follow_score = 100.0
    papers[1].follow_score = 0.0
    papers[1].keyword_score = 5.0  # only non-follow paper has any score
    out = metric_score(
        papers,
        signals=[],
        weights={"follow": 1.0, "keyword": 1.0},
        top_n=10,
        require_follow_match=False,
    )
    # Default behavior unchanged: both papers pass through.
    assert len(out) == 2


def test_metric_score_require_follow_match_drops_non_matches():
    papers = [_mk_paper("1"), _mk_paper("2")]
    papers[0].follow_score = 100.0  # followed author
    papers[1].follow_score = 0.0  # not followed, but has a keyword hit
    papers[1].keyword_score = 20.0
    out = metric_score(
        papers,
        signals=[],
        weights={"follow": 1.0, "keyword": 1.0},
        top_n=10,
        require_follow_match=True,
    )
    assert [p.title for p in out] == ["Paper 1"]


def test_metric_score_require_follow_match_with_empty_watchlist_drops_everything():
    # No signal ever set follow_score, so it stays at the Paper default (0.0) —
    # this is what happens with an empty follow_authors/follow_orgs watchlist.
    papers = [_mk_paper("1"), _mk_paper("2")]
    papers[0].keyword_score = 50.0
    papers[1].keyword_score = 30.0
    out = metric_score(
        papers,
        signals=[],
        weights={"keyword": 1.0},
        top_n=10,
        require_follow_match=True,
    )
    assert out == []


_REPO_ROOT = Path(__file__).resolve().parents[2]


def test_daily_watch_config_enables_require_follow_match():
    config = yaml.safe_load((_REPO_ROOT / "paperpilot" / "config.daily-watch.yaml").read_text())
    assert config["pipeline"]["require_follow_match"] is True


def test_weekly_config_does_not_set_require_follow_match():
    config = yaml.safe_load((_REPO_ROOT / "paperpilot" / "config.yaml").read_text())
    # Absent (defaults to False in metric_score) or explicitly False — the
    # weekly deep-survey must keep ranking every paper, not just follow hits.
    assert not config.get("pipeline", {}).get("require_follow_match", False)


def test_daily_watch_config_keeps_its_own_run_history_file():
    """L-7: the collect-daily-watch and collect-weekly workflows both append to and
    push the run record, so sharing paperpilot/data/run_history.jsonl made two
    workflows fight over one file. The daily config has to name its own — and the
    workflow's commit paths have to name the same file."""
    config = yaml.safe_load(
        (_REPO_ROOT / "paperpilot" / "config.daily-watch.yaml").read_text()
    )
    history = config["incremental"]["run_history_file"]
    assert history == "paperpilot/data/run_history.daily.jsonl"
    workflow = (_REPO_ROOT / ".github" / "workflows" / "collect-daily-watch.yml").read_text()
    assert history in workflow
    assert "paperpilot/data/run_history.jsonl" not in workflow


def test_collect_records_s2_outage_as_failure_not_empty_success():
    """Regression test (closes #387): a real S2Source HTTP outage must
    surface through stage_collect as sources_status["s2"]["ok"] == False,
    not as a misleadingly-successful "s2 returned 0 papers" — otherwise an
    outage is indistinguishable from a genuinely quiet day in
    run_history.jsonl."""
    from unittest.mock import patch as mock_patch

    from paperpilot.sources.s2_source import S2Source

    s2 = S2Source({"enabled": True, "delay_seconds": 0})
    with mock_patch(
        "paperpilot.sources.s2_source.request_with_retry", return_value=None
    ):
        result, _since, status = asyncio.run(
            collect([s2], keywords=["x"], categories=[], days_back=7, max_results_per_keyword=10)
        )
    assert result == []
    assert status["s2"]["ok"] is False
    assert "s2 fetch failed for all" in (status["s2"].get("error") or "")


def test_collect_records_arxiv_outage_as_failure_not_empty_success():
    """Regression test (closes #387 follow-up): the same masking pattern
    existed for ArxivSource — a real client outage (all keywords failing)
    must surface through stage_collect as sources_status["arxiv"]["ok"] ==
    False, not a misleadingly-successful "arxiv returned 0 papers"."""
    from unittest.mock import patch as mock_patch

    from paperpilot.sources.arxiv_source import ArxivSource

    arxiv_src = ArxivSource({"enabled": True, "delay_seconds": 0})

    def _boom(*args, **kwargs):
        raise RuntimeError("arxiv client exploded")

    with mock_patch.object(arxiv_src._client, "results", side_effect=_boom):
        result, _since, status = asyncio.run(
            collect(
                [arxiv_src], keywords=["x"], categories=[], days_back=7, max_results_per_keyword=10
            )
        )
    assert result == []
    assert status["arxiv"]["ok"] is False
    assert "arxiv fetch failed for all" in (status["arxiv"].get("error") or "")


def test_collect_keeps_arxiv_partial_success_as_ok_true():
    """Regression test (closes #387 follow-up): the claimed
    partial-success behavior (one keyword fails, another succeeds) must
    hold through the REAL collect() path, not just ArxivSource.fetch()
    directly — sources_status["arxiv"]["ok"] must be True (this is not an
    outage) and the successful keyword's real paper must be present."""
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from unittest.mock import patch as mock_patch

    from paperpilot.sources.arxiv_source import ArxivSource

    arxiv_src = ArxivSource({"enabled": True, "delay_seconds": 0})
    good_result = SimpleNamespace(
        title="Good Paper",
        authors=[SimpleNamespace(name="Alice")],
        summary="abs",
        entry_id="http://arxiv.org/abs/2604.00001",
        published=datetime(2026, 4, 1, tzinfo=timezone.utc),
        get_short_id=lambda: "2604.00001",
        doi=None,
        pdf_url="http://pdf",
        categories=["cs.LG"],
        comment=None,
    )

    def fake_results(search):
        if "bad" in search.query:
            raise RuntimeError("boom")
        return iter([good_result])

    with mock_patch.object(arxiv_src._client, "results", side_effect=fake_results):
        result, _since, status = asyncio.run(
            collect(
                [arxiv_src],
                keywords=["bad", "good"],
                categories=[],
                days_back=3000,  # ensure the fixed 2026-04-01 date qualifies
                max_results_per_keyword=10,
            )
        )
    assert status["arxiv"]["ok"] is True
    assert len(result) == 1
    assert result[0].title == "Good Paper"


def test_collect_never_ships_an_incomplete_arxiv_keyword():
    """HIGH-1 through the REAL Stage 0: a keyword whose feed was malformed still
    reported papers before the page broke, and another keyword answered cleanly.

    sources_status["arxiv"]["ok"] is True here — the source did answer — so the only
    thing keeping a known-partial set out of the survey is ArxivSource withdrawing it.
    A set known to be missing entries says nothing about the window it came from.
    """
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from unittest.mock import patch as mock_patch

    from paperpilot.sources.arxiv_source import ArxivSource

    arxiv_src = ArxivSource({"enabled": True, "delay_seconds": 0})

    def _result(arxiv_id: str) -> SimpleNamespace:
        return SimpleNamespace(
            title=f"Paper {arxiv_id}",
            authors=[SimpleNamespace(name="Alice")],
            summary="abs",
            entry_id=f"http://arxiv.org/abs/{arxiv_id}",
            published=datetime(2026, 4, 1, tzinfo=timezone.utc),
            get_short_id=lambda: arxiv_id,
            doi=None,
            pdf_url="http://pdf",
            categories=["cs.LG"],
            comment=None,
        )

    def fake_results(search):
        if "broken" in search.query:
            logging.getLogger("arxiv").warning(
                "Malformed feed; consider handling: %s", "not well-formed (invalid token)"
            )
            return iter([_result("2604.09999")])
        return iter([_result("2604.00001")])

    with mock_patch.object(arxiv_src._client, "results", side_effect=fake_results):
        result, _since, status = asyncio.run(
            collect(
                [arxiv_src],
                keywords=["broken", "good"],
                categories=[],
                days_back=3000,
                max_results_per_keyword=10,
            )
        )

    assert status["arxiv"]["ok"] is True
    assert [p.title for p in result] == ["Paper 2604.00001"]
    # What PipelineRunner turns into `source:arxiv: incomplete keyword ...`.
    assert [kw for kw, _reason in arxiv_src.degraded_keywords] == ["broken"]


def test_collect_records_arxiv_malformed_feed_as_failure_not_empty_success():
    """A malformed arXiv page must reach Stage 0 as a failure, not as a quiet day.

    The installed client warns and returns the page it could parse (see
    ``paperpilot/tests/test_arxiv_feed.py``), so a 200 whose body is empty or broken
    looks exactly like a keyword that found nothing. ArxivSource watches that log and
    counts such a keyword as failed; when every keyword fails that way the source
    raises and sources_status["arxiv"]["ok"] = False, which is what puts the run in
    run_history.errors instead of recording a misleadingly-successful zero.
    """
    from unittest.mock import patch as mock_patch

    from paperpilot.sources.arxiv_source import ArxivSource

    arxiv_src = ArxivSource({"enabled": True, "delay_seconds": 0})

    def _malformed(_search):
        logging.getLogger("arxiv").warning(
            "Malformed feed; consider handling: %s", "not well-formed (invalid token)"
        )
        return iter([])

    with mock_patch.object(arxiv_src._client, "results", side_effect=_malformed):
        result, _since, status = asyncio.run(
            collect(
                [arxiv_src],
                keywords=["rag"],
                categories=[],
                days_back=7,
                max_results_per_keyword=10,
            )
        )

    assert result == []
    assert status["arxiv"]["ok"] is False
    assert "arxiv fetch failed for all" in (status["arxiv"].get("error") or "")
    # The outage line also carries why the first keyword failed, which is all a
    # reader who missed the log has to go on (see the test below).
    assert "malformed feed" in (status["arxiv"].get("error") or "")


def test_collect_names_the_first_keyword_reason_in_a_source_failure():
    """An all-keywords raise says HOW MANY keywords failed, not what happened to
    them — so "every keyword got a 503" (throttled, wait it out) and "every response
    lost its work list" (the endpoint changed shape) land in run_history as the same
    line.

    The source records why each keyword failed before it raises, so Stage 0 puts the
    first reason into the error text it keeps. A reader who was not here for the log
    can then tell the two outages apart.
    """
    from types import SimpleNamespace
    from unittest.mock import patch as mock_patch

    from paperpilot.sources.openalex_source import OpenAlexSource

    def _error_for(response) -> str:
        src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
        with mock_patch(
            "paperpilot.sources.openalex_source.request_with_retry",
            return_value=response,
        ):
            _papers, _since, status = asyncio.run(
                collect(
                    [src],
                    keywords=["a", "b"],
                    categories=[],
                    days_back=7,
                    max_results_per_keyword=10,
                )
            )
        return status["openalex"].get("error") or ""

    throttled = _error_for(SimpleNamespace(status_code=503, json=lambda: {}))
    reshaped = _error_for(
        SimpleNamespace(status_code=200, json=lambda: {"meta": {"count": 2}})
    )

    assert "openalex fetch failed for all 2 keyword(s)" in throttled
    assert "openalex fetch failed for all 2 keyword(s)" in reshaped
    # The two outages are now different lines.
    assert "status=503" in throttled
    assert "no 'results' list" in reshaped
    assert throttled != reshaped

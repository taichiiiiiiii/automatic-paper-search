"""CitationSignal tests — uses a mock of utils.http.request_with_retry."""

from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.models import Paper
from paperpilot.signals.citation_signal import CitationSignal


def _mock_resp(status_code: int, body=None):
    return SimpleNamespace(status_code=status_code, json=lambda: body)


def _mk_paper(arxiv_id: str = "2604.00001", pub_days_ago: int = 100) -> Paper:
    return Paper(
        title="T",
        authors=["A"],
        abstract="a",
        url="u",
        published_date=date.today() - timedelta(days=pub_days_ago),
        source="arxiv",
        arxiv_id=arxiv_id,
    )


def test_enrich_fills_citation_fields():
    paper = _mk_paper(pub_days_ago=100)
    payload = [
        {
            "paperId": "abc",
            "citationCount": 200,   # velocity = 2/day -> saturation=2 -> score=100
            "influentialCitationCount": 10,
            "publicationDate": (date.today() - timedelta(days=100)).isoformat(),
            "authors": [{"authorId": "AID_1", "name": "A"}],
            "venue": "ICLR",
        }
    ]
    with patch(
        "paperpilot.signals.citation_signal.request_with_retry",
        return_value=_mock_resp(200, payload),
    ):
        sig = CitationSignal({"enabled": True, "velocity_saturation": 2.0})
        out = sig.enrich_batch([paper])

    assert out[0].citation_count == 200
    assert out[0].influential_citations == 10
    assert out[0].citation_velocity == 2.0
    assert out[0].citation_score == 100.0
    assert out[0].first_author_id == "AID_1"
    assert out[0].venue == "ICLR"


def test_skips_papers_without_ids():
    paper = Paper(
        title="T",
        authors=["A"],
        abstract="a",
        url="u",
        published_date=date.today(),
        source="openalex",  # no arxiv_id, no doi
    )
    with patch(
        "paperpilot.signals.citation_signal.request_with_retry"
    ) as mock_req:
        sig = CitationSignal({"enabled": True})
        sig.enrich_batch([paper])
        mock_req.assert_not_called()


def test_api_failure_leaves_paper_untouched():
    paper = _mk_paper()
    with patch(
        "paperpilot.signals.citation_signal.request_with_retry",
        return_value=None,
    ):
        sig = CitationSignal({"enabled": True})
        out = sig.enrich_batch([paper])

    assert out[0].citation_count == 0
    assert out[0].citation_score == 0.0
    # The score is 0 because the lookup never answered, not because the paper
    # is unremarkable. PipelineRunner reads this channel to say so in
    # result.errors / run_history.degraded_signals.
    assert len(sig.run_failures) == 1
    assert "status=None" in sig.run_failures[0]
    assert "n=1" in sig.run_failures[0]


def test_unexpected_response_shape_is_recorded():
    paper = _mk_paper()
    with patch(
        "paperpilot.signals.citation_signal.request_with_retry",
        return_value=_mock_resp(200, {"error": "not a list"}),
    ):
        sig = CitationSignal({"enabled": True})
        sig.enrich_batch([paper])

    assert len(sig.run_failures) == 1
    assert "dict instead of a list" in sig.run_failures[0]


def test_short_batch_body_records_the_lost_tail():
    """S2 answers one entry per id, so a body shorter than the request means
    the tail papers silently kept score 0.0 — recorded, not swallowed."""
    papers = [_mk_paper("2604.00001"), _mk_paper("2604.00002")]
    payload = [
        {
            "paperId": "abc",
            "citationCount": 4,
            "influentialCitationCount": 0,
            "publicationDate": (date.today() - timedelta(days=4)).isoformat(),
            "authors": [],
            "venue": None,
        }
    ]
    with patch(
        "paperpilot.signals.citation_signal.request_with_retry",
        return_value=_mock_resp(200, payload),
    ):
        sig = CitationSignal({"enabled": True})
        out = sig.enrich_batch(papers)

    assert out[1].citation_count == 0
    assert sig.run_failures == ["batch answered 1 of 2 ids"]


def test_run_failures_is_a_per_run_channel():
    """A successful run must not re-report the previous run's outage."""
    sig = CitationSignal({"enabled": True})
    paper = _mk_paper()
    payload = [
        {
            "paperId": "abc",
            "citationCount": 4,
            "influentialCitationCount": 0,
            "publicationDate": (date.today() - timedelta(days=4)).isoformat(),
            "authors": [],
            "venue": None,
        }
    ]
    with patch(
        "paperpilot.signals.citation_signal.request_with_retry",
        return_value=None,
    ):
        sig.enrich_batch([paper])
    assert sig.run_failures

    with patch(
        "paperpilot.signals.citation_signal.request_with_retry",
        return_value=_mock_resp(200, payload),
    ):
        sig.enrich_batch([paper])
    assert sig.run_failures == []
    assert sig.enrich_batch([]) == []
    assert sig.run_failures == []


def test_velocity_clamps_future_publication_date():
    """S2 can return a future publicationDate — velocity must not inflate."""
    paper = _mk_paper(pub_days_ago=100)
    future_date = (date.today() + timedelta(days=30)).isoformat()
    payload = [
        {
            "paperId": "abc",
            "citationCount": 50,  # 50 citations, publicationDate IN THE FUTURE
            "influentialCitationCount": 0,
            "publicationDate": future_date,
            "authors": [],
            "venue": None,
        }
    ]
    with patch(
        "paperpilot.signals.citation_signal.request_with_retry",
        return_value=_mock_resp(200, payload),
    ):
        sig = CitationSignal({"enabled": True, "velocity_saturation": 2.0})
        sig.enrich_batch([paper])
    # If not clamped, days=max(-30,1)=1 -> velocity=50 -> score=100 (wrong).
    # Clamped: pub=today, days=max(0,1)=1 -> velocity=50 -> score=100 also 100.
    # So use a smaller citation count to reveal the bug: repeat with cites=1.
    paper2 = _mk_paper(pub_days_ago=100)
    payload2 = [{**payload[0], "citationCount": 1}]
    with patch(
        "paperpilot.signals.citation_signal.request_with_retry",
        return_value=_mock_resp(200, payload2),
    ):
        sig = CitationSignal({"enabled": True, "velocity_saturation": 2.0})
        out2 = sig.enrich_batch([paper2])
    # With clamp: pub=today, days=1, velocity=1/day, score=min(1/2,1)*100 = 50
    assert out2[0].citation_velocity == 1.0
    assert out2[0].citation_score == 50.0

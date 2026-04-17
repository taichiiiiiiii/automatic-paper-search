"""CitationSignal tests — uses a mock of utils.http.request_with_retry."""

from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.models import Paper
from paperpilot.signals.citation_signal import CitationSignal


def _mock_resp(status_code: int, body):
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

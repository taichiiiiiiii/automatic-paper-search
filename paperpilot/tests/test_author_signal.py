"""AuthorSignal — h-index lookup tests (mocked)."""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.models import Paper
from paperpilot.signals.author_signal import AuthorSignal


def _resp(body):
    return SimpleNamespace(status_code=200, json=lambda: body)


def _mk(aid: str | None, uid_suffix: str) -> Paper:
    return Paper(
        title=f"T{uid_suffix}",
        authors=["A"],
        abstract="a",
        url=f"http://x/{uid_suffix}",
        published_date=date.today(),
        source="arxiv",
        arxiv_id=f"2604.000{uid_suffix}",
        first_author_id=aid,
    )


def test_enrich_fills_h_index():
    paper = _mk("AID_1", "1")
    payload = [{"authorId": "AID_1", "hIndex": 25, "name": "X"}]
    with patch(
        "paperpilot.signals.author_signal.request_with_retry",
        return_value=_resp(payload),
    ):
        sig = AuthorSignal({"enabled": True})
        out = sig.enrich_batch([paper])
    assert out[0].author_h_index == 25
    assert out[0].author_score == 50.0  # 25/50 * 100


def test_saturation_at_h_50():
    paper = _mk("AID_1", "1")
    payload = [{"authorId": "AID_1", "hIndex": 80, "name": "X"}]
    with patch(
        "paperpilot.signals.author_signal.request_with_retry",
        return_value=_resp(payload),
    ):
        sig = AuthorSignal({"enabled": True})
        out = sig.enrich_batch([paper])
    assert out[0].author_score == 100.0


def test_paper_without_author_id_skipped():
    paper = _mk(None, "1")
    with patch("paperpilot.signals.author_signal.request_with_retry") as mock:
        sig = AuthorSignal({"enabled": True})
        sig.enrich_batch([paper])
        mock.assert_not_called()


def test_dedup_author_ids():
    # Two papers share the same first_author_id -> single batch entry
    p1 = _mk("AID_1", "1")
    p2 = _mk("AID_1", "2")
    payload = [{"authorId": "AID_1", "hIndex": 10, "name": "X"}]
    with patch(
        "paperpilot.signals.author_signal.request_with_retry",
        return_value=_resp(payload),
    ) as mock:
        sig = AuthorSignal({"enabled": True})
        out = sig.enrich_batch([p1, p2])
    # Called exactly once with 1 unique id
    _args, kwargs = mock.call_args
    assert kwargs["json_body"]["ids"] == ["AID_1"]
    assert out[0].author_h_index == 10
    assert out[1].author_h_index == 10

"""AuthorSignal — h-index lookup tests (mocked)."""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.models import Paper
from paperpilot.signals.author_signal import AuthorSignal


def _resp(body):
    return SimpleNamespace(status_code=200, json=lambda: body)


def _resp_with_status(status_code: int):
    """A response carrying a status but no usable body (throttle / outage)."""
    return SimpleNamespace(status_code=status_code, json=lambda: None)


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
    # Nothing was queryable, so nothing failed — an empty channel is the
    # difference between "no followed author" and "h-index lookup lost".
    assert sig.run_failures == []


def test_batch_failure_is_recorded_on_the_run_channel():
    """author_score 0.0 after a lost batch must be distinguishable from a
    genuinely low h-index (H-2)."""
    paper = _mk("AID_1", "1")
    with patch(
        "paperpilot.signals.author_signal.request_with_retry",
        return_value=_resp_with_status(429),
    ):
        sig = AuthorSignal({"enabled": True})
        out = sig.enrich_batch([paper])

    assert out[0].author_score == 0.0
    assert out[0].author_h_index == 0
    assert len(sig.run_failures) == 1
    assert "status=429" in sig.run_failures[0]
    assert "n=1" in sig.run_failures[0]


def test_short_batch_records_the_unanswered_tail():
    """M-4: /author/batch answers one entry per id (null for unknown ids), so a body
    shorter than the request means the tail ids were never answered and their papers
    keep author_score 0.0 for a reason unrelated to the author.

    CitationSignal already recorded this; without the same check here an h-index
    lookup that silently stopped answering read as a quiet run.
    """
    p1 = _mk("AID_1", "1")
    p2 = _mk("AID_2", "2")
    payload = [{"authorId": "AID_1", "hIndex": 20, "name": "X"}]
    with patch(
        "paperpilot.signals.author_signal.request_with_retry",
        return_value=_resp(payload),
    ):
        sig = AuthorSignal({"enabled": True})
        out = sig.enrich_batch([p1, p2])

    assert out[0].author_h_index == 20
    assert out[0].author_score == 40.0
    assert out[1].author_score == 0.0
    assert sig.run_failures == ["batch answered 1 of 2 ids"]


def test_full_batch_leaves_the_channel_empty():
    """The check is about a short body, not about unknown ids: one entry per
    requested id is a complete answer."""
    p1 = _mk("AID_1", "1")
    payload = [{"authorId": "AID_1", "hIndex": None, "name": "X"}]
    with patch(
        "paperpilot.signals.author_signal.request_with_retry",
        return_value=_resp(payload),
    ):
        sig = AuthorSignal({"enabled": True})
        out = sig.enrich_batch([p1])

    assert out[0].author_h_index == 0
    assert sig.run_failures == []


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


def test_payload_missing_author_id_is_recorded_as_a_failure():
    """M-1: a non-null payload with no usable authorId can never be matched back
    to a paper. Before the fix this looked identical to a clean 200 OK run with
    every author_score silently staying 0.0 as if no senior author existed."""
    paper = _mk("AID_1", "1")
    payload = [{"name": "X", "hIndex": 25}]
    with patch(
        "paperpilot.signals.author_signal.request_with_retry",
        return_value=_resp(payload),
    ):
        sig = AuthorSignal({"enabled": True})
        out = sig.enrich_batch([paper])

    assert out[0].author_score == 0.0
    assert out[0].author_h_index == 0
    assert sig.run_failures == ["batch returned 1 of 1 entries without a usable authorId"]


def test_mixed_chunk_scores_the_good_entry_and_records_the_bad_one():
    """A chunk with one matchable entry and one unmatchable entry must still
    score the good paper, while flagging the loss for the other."""
    p1 = _mk("AID_1", "1")
    p2 = _mk("AID_2", "2")
    payload = [
        {"authorId": "AID_1", "hIndex": 20, "name": "X"},
        {"name": "Y", "hIndex": 10},  # missing authorId
    ]
    with patch(
        "paperpilot.signals.author_signal.request_with_retry",
        return_value=_resp(payload),
    ):
        sig = AuthorSignal({"enabled": True})
        out = sig.enrich_batch([p1, p2])

    assert out[0].author_h_index == 20
    assert out[0].author_score == 40.0
    assert out[1].author_score == 0.0
    assert sig.run_failures == ["batch returned 1 of 2 entries without a usable authorId"]


def test_blank_and_non_string_author_ids_are_recorded_as_one_failure():
    """L-1: a whitespace-only authorId and a non-string authorId are both
    unusable and must be counted together as one run_failures entry, not two."""
    p1 = _mk("AID_1", "1")
    p2 = _mk("AID_2", "2")
    payload = [{"authorId": " ", "hIndex": 10}, {"authorId": 123, "hIndex": 10}]
    with patch(
        "paperpilot.signals.author_signal.request_with_retry",
        return_value=_resp(payload),
    ):
        sig = AuthorSignal({"enabled": True})
        out = sig.enrich_batch([p1, p2])

    assert out[0].author_score == 0.0
    assert out[1].author_score == 0.0
    assert sig.run_failures == ["batch returned 2 of 2 entries without a usable authorId"]


def test_null_entry_for_one_id_is_not_a_failure():
    """L-1: `[None]` answering a single requested id is a definitive "author not
    found", not a lost lookup — run_failures must stay empty."""
    paper = _mk("AID_1", "1")
    payload = [None]
    with patch(
        "paperpilot.signals.author_signal.request_with_retry",
        return_value=_resp(payload),
    ):
        sig = AuthorSignal({"enabled": True})
        out = sig.enrich_batch([paper])

    assert out[0].author_score == 0.0
    assert out[0].author_h_index == 0
    assert sig.run_failures == []


def test_missing_h_index_key_is_recorded_as_a_failure():
    """L-3: a non-null payload with a usable authorId but no `hIndex` key at all
    is not an answer. Unlike an explicit `"hIndex": null` (a legitimate 0), a
    missing key must not silently read as a confirmed h-index of 0."""
    paper = _mk("AID_1", "1")
    payload = [{"authorId": "AID_1", "name": "X"}]  # no hIndex key at all
    with patch(
        "paperpilot.signals.author_signal.request_with_retry",
        return_value=_resp(payload),
    ):
        sig = AuthorSignal({"enabled": True})
        out = sig.enrich_batch([paper])

    assert out[0].author_score == 0.0
    assert out[0].author_h_index == 0
    assert sig.run_failures == ["batch returned 1 of 1 entries without a usable hIndex"]


def test_explicit_null_h_index_stays_a_legitimate_zero():
    """L-3 counterpart: an explicit `"hIndex": null` (key present, value null) is
    a legitimate answer of 0, unlike a missing key — run_failures must stay empty."""
    paper = _mk("AID_1", "1")
    payload = [{"authorId": "AID_1", "hIndex": None, "name": "X"}]
    with patch(
        "paperpilot.signals.author_signal.request_with_retry",
        return_value=_resp(payload),
    ):
        sig = AuthorSignal({"enabled": True})
        out = sig.enrich_batch([paper])

    assert out[0].author_h_index == 0
    assert out[0].author_score == 0.0
    assert sig.run_failures == []


def test_requested_fields_include_every_key_the_parser_reads():
    """`/author/batch` answers with only the fields the request named, and
    enrich_batch keys its lookup by payload["authorId"]. Ask without `authorId` and
    every entry comes back unidentifiable: 200 OK, no run_failures entry, and every
    paper silently keeps author_score 0.0 — indistinguishable from "no senior author
    on this paper". Pin the request against the keys the parser actually reads."""
    paper = _mk("AID_1", "1")
    payload = [{"authorId": "AID_1", "hIndex": 25, "name": "X", "citationCount": 100}]
    with patch(
        "paperpilot.signals.author_signal.request_with_retry",
        return_value=_resp(payload),
    ) as mock:
        sig = AuthorSignal({"enabled": True})
        out = sig.enrich_batch([paper])

    requested = set(mock.call_args.kwargs["params"]["fields"].split(","))
    assert {"authorId", "hIndex"} <= requested
    assert out[0].author_h_index == 25
    assert sig.run_failures == []

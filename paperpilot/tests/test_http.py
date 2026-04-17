"""utils/http.request_with_retry tests."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import requests

from paperpilot.utils import http as http_mod


def _resp(status: int, body=None):
    return SimpleNamespace(status_code=status, json=lambda: body or {})


def test_success_first_try():
    with patch.object(http_mod.requests, "request", return_value=_resp(200, {"a": 1})) as m:
        r = http_mod.request_with_retry("GET", "http://x")
    assert r.status_code == 200
    assert m.call_count == 1


def test_429_exponential_backoff_retries(monkeypatch):
    responses = [_resp(429), _resp(429), _resp(200)]
    sleeps: list[float] = []
    monkeypatch.setattr(http_mod.time, "sleep", lambda s: sleeps.append(s))
    with patch.object(http_mod.requests, "request", side_effect=responses):
        r = http_mod.request_with_retry("GET", "http://x")
    assert r.status_code == 200
    # Two backoffs: 2s then 4s
    assert sleeps == [2.0, 4.0]


def test_429_gives_up_after_max_retries(monkeypatch):
    monkeypatch.setattr(http_mod.time, "sleep", lambda s: None)
    always_429 = [_resp(429)] * 10
    with patch.object(http_mod.requests, "request", side_effect=always_429):
        r = http_mod.request_with_retry("GET", "http://x")
    assert r.status_code == 429


def test_5xx_retry(monkeypatch):
    responses = [_resp(503), _resp(200)]
    monkeypatch.setattr(http_mod.time, "sleep", lambda s: None)
    with patch.object(http_mod.requests, "request", side_effect=responses):
        r = http_mod.request_with_retry("GET", "http://x")
    assert r.status_code == 200


def test_timeout_retry_once(monkeypatch):
    # First call raises Timeout, second succeeds.
    calls: list = []

    def _req(*a, **kw):
        calls.append(1)
        if len(calls) == 1:
            raise requests.Timeout()
        return _resp(200)

    monkeypatch.setattr(http_mod.time, "sleep", lambda s: None)
    with patch.object(http_mod.requests, "request", side_effect=_req):
        r = http_mod.request_with_retry("GET", "http://x")
    assert r.status_code == 200
    assert len(calls) == 2


def test_request_exception_returns_none():
    with patch.object(
        http_mod.requests, "request", side_effect=requests.ConnectionError("boom")
    ):
        r = http_mod.request_with_retry("GET", "http://x")
    assert r is None


def test_404_passes_through_no_retry():
    with patch.object(http_mod.requests, "request", return_value=_resp(404)) as m:
        r = http_mod.request_with_retry("GET", "http://x")
    assert r.status_code == 404
    assert m.call_count == 1


def test_overall_deadline_exceeded_returns_none(monkeypatch):
    """If retries stack past the deadline, bail out rather than continuing."""
    # Freeze monotonic clock, advance on each sleep.
    now = [0.0]
    monkeypatch.setattr(http_mod.time, "monotonic", lambda: now[0])

    def _sleep(s):
        now[0] += s

    monkeypatch.setattr(http_mod.time, "sleep", _sleep)

    # Always return 429 so the loop keeps backing off.
    with patch.object(
        http_mod.requests, "request", side_effect=[_resp(429)] * 20
    ):
        # Deadline 5s, first 429 sleeps 2s, second 4s (total 6s > 5s deadline)
        r = http_mod.request_with_retry(
            "GET", "http://x", timeout=1.0, overall_deadline=5.0
        )
    assert r is None


def test_overall_deadline_defaults_to_3x_timeout(monkeypatch):
    """overall_deadline defaults to timeout * 3 when not specified."""
    now = [0.0]
    monkeypatch.setattr(http_mod.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(http_mod.time, "sleep", lambda s: now.__setitem__(0, now[0] + s))

    # timeout=1s -> default deadline=3s. 429 sleeps: 2, 4 (exceeds 3s on 2nd try).
    with patch.object(http_mod.requests, "request", side_effect=[_resp(429)] * 5):
        r = http_mod.request_with_retry("GET", "http://x", timeout=1.0)
    assert r is None

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
    assert r is not None
    assert r.status_code == 200
    assert m.call_count == 1


def test_429_exponential_backoff_retries(monkeypatch):
    responses = [_resp(429), _resp(429), _resp(200)]
    sleeps: list[float] = []
    monkeypatch.setattr(http_mod.time, "sleep", lambda s: sleeps.append(s))
    with patch.object(http_mod.requests, "request", side_effect=responses):
        r = http_mod.request_with_retry("GET", "http://x")
    assert r is not None
    assert r.status_code == 200
    # Two backoffs: 2s then 4s
    assert sleeps == [2.0, 4.0]


def test_429_gives_up_after_max_retries(monkeypatch):
    monkeypatch.setattr(http_mod.time, "sleep", lambda s: None)
    always_429 = [_resp(429)] * 10
    with patch.object(http_mod.requests, "request", side_effect=always_429):
        r = http_mod.request_with_retry("GET", "http://x")
    assert r is not None
    assert r.status_code == 429


def test_5xx_retry(monkeypatch):
    responses = [_resp(503), _resp(200)]
    monkeypatch.setattr(http_mod.time, "sleep", lambda s: None)
    with patch.object(http_mod.requests, "request", side_effect=responses):
        r = http_mod.request_with_retry("GET", "http://x")
    assert r is not None
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
    assert r is not None
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
    assert r is not None
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


def test_429_backoff_sleep_is_clamped_to_remaining_deadline_budget(monkeypatch):
    """Regression test (closes #394): the backoff sleep duration itself must
    be clamped to whatever budget remains, not the full un-clamped backoff
    value — otherwise a single sleep can overshoot overall_deadline by a
    large margin (e.g. sleeping the full 30s cap when only 1s remained)."""
    now = [0.0]
    monkeypatch.setattr(http_mod.time, "monotonic", lambda: now[0])
    sleeps: list[float] = []

    def _sleep(s):
        sleeps.append(s)
        now[0] += s

    monkeypatch.setattr(http_mod.time, "sleep", _sleep)

    with patch.object(http_mod.requests, "request", side_effect=[_resp(429)] * 5):
        r = http_mod.request_with_retry(
            "GET", "http://x", timeout=1.0, overall_deadline=3.0
        )
    assert r is None
    # First backoff is the full 2s (budget was ~3s). Second backoff would
    # naturally be 4s, but only ~1s of budget remains — must be clamped down
    # to that, never sleep the full un-clamped 4s.
    assert sleeps[0] == 2.0
    assert sleeps[1] < 4.0
    assert sleeps[1] <= 1.0 + 1e-9
    # Total elapsed time must not blow far past the declared deadline.
    assert now[0] <= 3.0 + 1e-9


def test_request_timeout_param_is_clamped_to_remaining_deadline_budget(monkeypatch):
    """Regression test (closes #394): the per-attempt socket `timeout` fed
    to requests.request must itself be clamped to the remaining budget on a
    retry, not always the full per-call `timeout` — otherwise a single slow
    attempt can by itself carry elapsed time well past overall_deadline
    before the next deadline check runs."""
    now = [0.0]
    monkeypatch.setattr(http_mod.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(http_mod.time, "sleep", lambda s: now.__setitem__(0, now[0] + s))

    captured_timeouts: list[float] = []

    def _fake_request(*args, **kwargs):
        captured_timeouts.append(kwargs["timeout"])
        return _resp(429)

    with patch.object(http_mod.requests, "request", side_effect=_fake_request):
        http_mod.request_with_retry("GET", "http://x", timeout=10.0, overall_deadline=3.0)

    # timeout=10 > overall_deadline=3, so even the FIRST attempt must
    # already be clamped down to the remaining budget, not the full 10s.
    assert captured_timeouts[0] <= 3.0 + 1e-9


def test_safe_url_for_log_strips_path_and_query():
    """Regression test (closes #385): logged URL must be host-only."""
    masked = http_mod._safe_url_for_log(
        "https://hooks.slack.com/services/T000/B000/SUPERSECRETTOKEN?x=1"
    )
    assert masked == "https://hooks.slack.com"
    assert "SUPERSECRETTOKEN" not in masked
    assert "T000" not in masked


def test_request_failure_log_does_not_leak_secret_url(monkeypatch, caplog):
    """A failing request (e.g. Slack webhook) must never log the secret URL."""
    secret_url = "https://hooks.slack.com/services/T000/B000/SUPERSECRETTOKEN"
    with patch.object(
        http_mod.requests, "request", side_effect=requests.ConnectionError("boom")
    ):
        with caplog.at_level("WARNING"):
            r = http_mod.request_with_retry("POST", secret_url)
    assert r is None
    assert "SUPERSECRETTOKEN" not in caplog.text
    assert "T000" not in caplog.text
    assert "hooks.slack.com" in caplog.text


def test_request_failure_exception_message_embedding_url_is_not_logged(caplog):
    """A urllib3-style exception whose *message* embeds the raw secret URL
    (e.g. "Max retries exceeded with url: /services/T000/...") must not leak
    it either — only the exception class name may be logged, not str(e)."""
    secret_url = "https://hooks.slack.com/services/T000/B000/SUPERSECRETTOKEN"
    exc = requests.ConnectionError(
        f"Max retries exceeded with url: {secret_url} (Caused by ...)"
    )
    with patch.object(http_mod.requests, "request", side_effect=exc):
        with caplog.at_level("WARNING"):
            r = http_mod.request_with_retry("POST", secret_url)
    assert r is None
    assert "SUPERSECRETTOKEN" not in caplog.text
    assert "T000" not in caplog.text
    assert "ConnectionError" in caplog.text


def test_safe_url_for_log_strips_userinfo_credentials():
    """Credentials embedded as userinfo (user:pass@host) must not leak."""
    masked = http_mod._safe_url_for_log("https://user:SUPERSECRET@example.com/path")
    assert masked == "https://example.com"
    assert "SUPERSECRET" not in masked
    assert "user" not in masked


def test_safe_url_for_log_handles_malformed_url_without_raising():
    """Malformed input must degrade gracefully, never raise from the logger
    helper itself (that would be worse than the leak it prevents)."""
    assert http_mod._safe_url_for_log("http://[") == "<unparseable-url>"
    assert http_mod._safe_url_for_log("not a url") == "<url>"


def test_safe_url_for_log_handles_invalid_port_without_raising():
    """`.port` raises ValueError for a non-numeric or out-of-range port —
    that must be caught too, not just urlsplit()'s own parse errors."""
    assert http_mod._safe_url_for_log("http://example.com:notaport/path") == "<unparseable-url>"
    assert http_mod._safe_url_for_log("http://example.com:99999/path") == "<unparseable-url>"


def test_safe_url_for_log_formats_ipv6_host_with_brackets():
    """An IPv6 literal must round-trip as a syntactically valid host:port,
    not the ambiguous bare `::1:8443` (host colon vs. port separator)."""
    masked = http_mod._safe_url_for_log("https://[::1]:8443/path?token=SECRET")
    assert masked == "https://[::1]:8443"
    assert "SECRET" not in masked


def test_request_with_retry_malformed_url_still_raises_from_requests():
    """A malformed URL should fail via requests' own exception handling
    (existing behavior), not via _safe_url_for_log raising early."""
    with patch.object(
        http_mod.requests, "request", side_effect=requests.exceptions.InvalidURL("bad url")
    ):
        r = http_mod.request_with_retry("GET", "http://[")
    assert r is None


def test_request_with_retry_invalid_port_url_still_raises_from_requests(caplog):
    """Same as above but for an invalid-port URL, through the full retry
    path with caplog (not just calling the helper directly)."""
    with patch.object(
        http_mod.requests, "request", side_effect=requests.exceptions.InvalidURL("bad port")
    ):
        with caplog.at_level("WARNING"):
            r = http_mod.request_with_retry("GET", "http://example.com:notaport/path")
    assert r is None
    assert "notaport" not in caplog.text


def test_request_failure_log_strips_userinfo_through_full_retry_path(caplog):
    """Userinfo stripping exercised end-to-end via request_with_retry +
    caplog, not just by calling the helper directly."""
    secret_url = "https://user:SUPERSECRET@example.com/path"
    with patch.object(
        http_mod.requests, "request", side_effect=requests.ConnectionError("boom")
    ):
        with caplog.at_level("WARNING"):
            r = http_mod.request_with_retry("GET", secret_url)
    assert r is None
    assert "SUPERSECRET" not in caplog.text
    assert "user" not in caplog.text
    assert "example.com" in caplog.text


def test_overall_deadline_log_does_not_leak_secret_url(monkeypatch, caplog):
    """The overall-deadline-exceeded log path must also mask the URL."""
    now = [0.0]
    monkeypatch.setattr(http_mod.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(http_mod.time, "sleep", lambda s: now.__setitem__(0, now[0] + s))
    secret_url = "https://hooks.slack.com/services/T000/B000/SUPERSECRETTOKEN"

    with patch.object(http_mod.requests, "request", side_effect=[_resp(429)] * 20):
        with caplog.at_level("WARNING"):
            r = http_mod.request_with_retry(
                "POST", secret_url, timeout=1.0, overall_deadline=5.0
            )
    assert r is None
    assert "SUPERSECRETTOKEN" not in caplog.text
    assert "T000" not in caplog.text

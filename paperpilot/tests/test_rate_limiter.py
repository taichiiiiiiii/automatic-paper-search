"""RateLimiter tests."""

from __future__ import annotations

from paperpilot.utils.rate_limiter import RateLimiter


def test_zero_delay_is_nop(monkeypatch):
    slept: list[float] = []
    monkeypatch.setattr("paperpilot.utils.rate_limiter.time.sleep", lambda s: slept.append(s))
    lim = RateLimiter(0)
    lim.wait()
    lim.wait()
    assert slept == []


def test_sleeps_when_interval_too_short(monkeypatch):
    # Freeze monotonic clock.
    now = [1000.0]
    monkeypatch.setattr(
        "paperpilot.utils.rate_limiter.time.monotonic", lambda: now[0]
    )
    slept: list[float] = []

    def _sleep(s):
        slept.append(s)
        now[0] += s

    monkeypatch.setattr("paperpilot.utils.rate_limiter.time.sleep", _sleep)

    lim = RateLimiter(1.0)
    lim.wait()  # first call — no prior timestamp, no sleep
    assert slept == []
    # Advance 0.3s, next wait should sleep ~0.7s
    now[0] += 0.3
    lim.wait()
    assert slept and abs(slept[0] - 0.7) < 1e-6

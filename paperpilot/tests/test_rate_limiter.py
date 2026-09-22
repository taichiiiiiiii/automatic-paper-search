"""RateLimiter tests."""

from __future__ import annotations

import threading
import time

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


def test_wait_is_thread_safe_under_concurrent_callers():
    """Regression test (closes #395): a single RateLimiter shared across
    worker threads (e.g. collect_cvf.py's ThreadPoolExecutor) must
    serialize the read-modify-write of `_last_call` — otherwise a race lets
    multiple threads compute `elapsed` against a stale `_last_call` and
    slip through with far less spacing than `delay_seconds`, defeating the
    throttle under exactly the concurrent load it exists to smooth.

    Uses real time.sleep/monotonic (not mocked) with a small delay so this
    stays fast (<1s) while still exercising genuine thread contention.
    """
    delay = 0.05
    n_threads = 8
    lim = RateLimiter(delay)
    call_times: list[float] = []
    call_lock = threading.Lock()

    def _call():
        lim.wait()
        with call_lock:
            call_times.append(time.monotonic())

    threads = [threading.Thread(target=_call) for _ in range(n_threads)]
    start = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    total_elapsed = time.monotonic() - start

    # If wait() were not thread-safe, all 8 calls could race through with
    # ~0 total spacing. Serialized, (n_threads - 1) gaps of `delay` must
    # have elapsed overall (allow slack for scheduling jitter).
    assert total_elapsed >= (n_threads - 1) * delay * 0.7
    assert len(call_times) == n_threads

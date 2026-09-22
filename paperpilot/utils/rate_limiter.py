"""Trivial sleep-based rate limiter for polite API usage."""

from __future__ import annotations

import threading
import time


class RateLimiter:
    """Ensures at least `delay_seconds` elapses between calls.

    Thread-safe: a single instance may be shared across worker threads
    (e.g. a ThreadPoolExecutor fetching pages concurrently) so the combined
    call rate across all threads — not just each thread individually — is
    throttled. Without the lock, concurrent read-modify-write of
    `_last_call` could let multiple threads slip through with an
    under-counted `elapsed`, defeating the throttle under exactly the
    concurrent load it exists to smooth out.
    """

    def __init__(self, delay_seconds: float) -> None:
        self.delay = max(0.0, float(delay_seconds))
        self._last_call = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        if self.delay <= 0:
            return
        with self._lock:
            elapsed = time.monotonic() - self._last_call
            remaining = self.delay - elapsed
            if remaining > 0:
                time.sleep(remaining)
            self._last_call = time.monotonic()

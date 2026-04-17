"""Trivial sleep-based rate limiter for polite API usage."""

from __future__ import annotations

import time


class RateLimiter:
    """Ensures at least `delay_seconds` elapses between calls."""

    def __init__(self, delay_seconds: float) -> None:
        self.delay = max(0.0, float(delay_seconds))
        self._last_call = 0.0

    def wait(self) -> None:
        if self.delay <= 0:
            return
        elapsed = time.monotonic() - self._last_call
        remaining = self.delay - elapsed
        if remaining > 0:
            time.sleep(remaining)
        self._last_call = time.monotonic()

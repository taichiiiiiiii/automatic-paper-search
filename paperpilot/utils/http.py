"""HTTP helper with retry + exponential backoff.

Retry policy (design doc §6.2, Table 17):
  - HTTP 429         : exponential backoff (2s, 4s, 8s, ... cap 30s), max 3 retries
  - HTTP 5xx         : fixed 3s wait, max 2 retries
  - Timeout          : log and retry once
  - HTTP 404 / other : return the response without retry (caller handles)

Returns None only when the request ultimately fails after retries.
"""

from __future__ import annotations

import time
from typing import Any

import requests

from .logger import get_logger

logger = get_logger(__name__)

_BACKOFF_429_INITIAL = 2.0
_BACKOFF_429_MAX = 30.0
_MAX_RETRIES_429 = 3

_BACKOFF_5XX = 3.0
_MAX_RETRIES_5XX = 2

_MAX_RETRIES_TIMEOUT = 1


def request_with_retry(
    method: str,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    json_body: dict[str, Any] | None = None,
    timeout: float = 10.0,
) -> requests.Response | None:
    """Execute an HTTP request with the retry policy described above."""
    attempts_429 = 0
    attempts_5xx = 0
    attempts_timeout = 0
    backoff_429 = _BACKOFF_429_INITIAL

    while True:
        try:
            resp = requests.request(
                method,
                url,
                params=params,
                headers=headers,
                json=json_body,
                timeout=timeout,
            )
        except requests.Timeout:
            if attempts_timeout >= _MAX_RETRIES_TIMEOUT:
                logger.warning("http: timeout after %d retries: %s", attempts_timeout, url)
                return None
            attempts_timeout += 1
            logger.warning("http: timeout, retry %d: %s", attempts_timeout, url)
            continue
        except requests.RequestException as e:
            logger.warning("http: request failed: %s (%s)", url, e)
            return None

        if resp.status_code == 429:
            if attempts_429 >= _MAX_RETRIES_429:
                logger.warning("http: 429 after %d retries: %s", attempts_429, url)
                return resp
            logger.warning(
                "http: 429 throttled, sleeping %.1fs (retry %d): %s",
                backoff_429,
                attempts_429 + 1,
                url,
            )
            time.sleep(backoff_429)
            attempts_429 += 1
            backoff_429 = min(backoff_429 * 2, _BACKOFF_429_MAX)
            continue

        if 500 <= resp.status_code < 600:
            if attempts_5xx >= _MAX_RETRIES_5XX:
                logger.warning("http: %d after %d retries: %s", resp.status_code, attempts_5xx, url)
                return resp
            logger.warning(
                "http: %d, sleeping %.1fs (retry %d): %s",
                resp.status_code,
                _BACKOFF_5XX,
                attempts_5xx + 1,
                url,
            )
            time.sleep(_BACKOFF_5XX)
            attempts_5xx += 1
            continue

        return resp

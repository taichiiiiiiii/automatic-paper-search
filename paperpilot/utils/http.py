"""HTTP helper with retry + exponential backoff.

Retry policy (design doc §6.2, Table 17):
  - HTTP 429         : exponential backoff (2s, 4s, 8s, ... cap 30s), max 3 retries
  - HTTP 5xx         : fixed 3s wait, max 2 retries
  - Timeout          : log and retry once
  - HTTP 404 / other : return the response without retry (caller handles)

Overall deadline: the accumulated wall-clock time (including backoff sleeps
and socket timeouts) is capped by `overall_deadline` so a single call can
never stack retries to ~90s and derail Stage-0 timing estimates.

Returns None only when the request ultimately fails after retries or the
overall deadline elapses.
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlsplit

import requests

from .logger import get_logger

logger = get_logger(__name__)


def _safe_url_for_log(url: str) -> str:
    """Redact a URL down to scheme://host for logging.

    Some callers (e.g. Slack Incoming Webhooks) embed a secret token in the
    URL path/query, or credentials in the userinfo component; logs are
    retained for days (see logger.py), so nothing but scheme + hostname[:port]
    must ever be written there (absolute rule §1). Uses `.hostname`/`.port`
    (never raw `.netloc`, which would include a leaked `user:pass@`) and
    tolerates unparseable input instead of raising.
    """
    try:
        parts = urlsplit(url)
        hostname = parts.hostname
        port = parts.port  # also raises ValueError for e.g. ":notaport" / ":99999"
    except ValueError:
        return "<unparseable-url>"
    if not hostname:
        return "<url>"
    host = f"[{hostname}]" if ":" in hostname else hostname  # IPv6 literal
    if port:
        host = f"{host}:{port}"
    return f"{parts.scheme or 'http'}://{host}"


_BACKOFF_429_INITIAL = 2.0
_BACKOFF_429_MAX = 30.0
_MAX_RETRIES_429 = 3

_BACKOFF_5XX = 3.0
_MAX_RETRIES_5XX = 2

_MAX_RETRIES_TIMEOUT = 1

_DEFAULT_DEADLINE_MULTIPLIER = 3.0  # overall_deadline default = timeout * 3


def request_with_retry(
    method: str,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    json_body: dict[str, Any] | None = None,
    timeout: float = 10.0,
    overall_deadline: float | None = None,
) -> requests.Response | None:
    """Execute an HTTP request with retry + exponential backoff.

    `timeout` is the per-socket timeout. `overall_deadline` caps the total
    wall-clock time including backoff sleeps; defaults to timeout * 3.
    """
    if overall_deadline is None:
        overall_deadline = timeout * _DEFAULT_DEADLINE_MULTIPLIER
    start = time.monotonic()
    attempts_429 = 0
    attempts_5xx = 0
    attempts_timeout = 0
    backoff_429 = _BACKOFF_429_INITIAL
    safe_url = _safe_url_for_log(url)

    while True:
        remaining = overall_deadline - (time.monotonic() - start)
        if remaining <= 0:
            logger.warning("http: overall deadline %.1fs exceeded: %s", overall_deadline, safe_url)
            return None
        try:
            resp = requests.request(
                method,
                url,
                params=params,
                headers=headers,
                json=json_body,
                # Clamp the per-attempt socket timeout to whatever budget is
                # left, so a single slow attempt can't by itself carry the
                # total elapsed time past overall_deadline before the next
                # deadline check even runs.
                timeout=min(timeout, remaining),
            )
        except requests.Timeout:
            if attempts_timeout >= _MAX_RETRIES_TIMEOUT:
                logger.warning("http: timeout after %d retries: %s", attempts_timeout, safe_url)
                return None
            attempts_timeout += 1
            logger.warning("http: timeout, retry %d: %s", attempts_timeout, safe_url)
            continue
        except requests.RequestException as e:
            # e's message often embeds the raw URL (e.g. urllib3's "Max
            # retries exceeded with url: ..."), so only its class name is
            # safe to log — the formatted message could re-leak the secret
            # safe_url was constructed to hide.
            logger.warning("http: request failed: %s (%s)", safe_url, type(e).__name__)
            return None

        if resp.status_code == 429:
            if attempts_429 >= _MAX_RETRIES_429:
                logger.warning("http: 429 after %d retries: %s", attempts_429, safe_url)
                return resp
            # Clamp the backoff sleep to whatever budget remains after the
            # request itself — otherwise a 30s backoff can blow well past a
            # small overall_deadline before the top-of-loop check runs again.
            sleep_for = max(0.0, min(backoff_429, overall_deadline - (time.monotonic() - start)))
            logger.warning(
                "http: 429 throttled, sleeping %.1fs (retry %d): %s",
                sleep_for,
                attempts_429 + 1,
                safe_url,
            )
            time.sleep(sleep_for)
            attempts_429 += 1
            backoff_429 = min(backoff_429 * 2, _BACKOFF_429_MAX)
            continue

        if 500 <= resp.status_code < 600:
            if attempts_5xx >= _MAX_RETRIES_5XX:
                logger.warning("http: %d after %d retries: %s", resp.status_code, attempts_5xx, safe_url)
                return resp
            sleep_for = max(0.0, min(_BACKOFF_5XX, overall_deadline - (time.monotonic() - start)))
            logger.warning(
                "http: %d, sleeping %.1fs (retry %d): %s",
                resp.status_code,
                sleep_for,
                attempts_5xx + 1,
                safe_url,
            )
            time.sleep(sleep_for)
            attempts_5xx += 1
            continue

        return resp

"""Gemini LLM provider — Google's generative-language API.

Uses the REST `generateContent` endpoint with `responseMimeType=application/json`
so the model returns a parseable JSON payload. Falls back to the 3-step
json_parser for resilience.

Config:
    llm:
      provider: gemini
      model: gemini-2.5-flash      # or gemini-2.5-pro / gemini-2.0-*
      rate_limit_rpm: 250          # 250 RPM = 240ms spacing; safe for paid
                                   # Tier 1 (300 RPM). Drop to 8 for free tier.
      batch_size: 5
      temperature: 0.2
      timeout_seconds: 60

Auth: requires PAPERPILOT_GEMINI_API_KEY in .env (free tier available at
https://aistudio.google.com/apikey; production-grade rate limits start at
paid Tier 1 with no minimum spend).

When no API key is available, `.enabled` evaluates to False so Stage 4
is skipped automatically.

Rate-limit + circuit-breaker design mirrors GroqProvider (#130 / #191):
``_throttle_for_rate_limit`` sleeps just enough between calls to stay
under ``rate_limit_rpm``; ``_quota_exhausted`` latches after
``QUOTA_EXHAUSTED_THRESHOLD`` consecutive failures so a fully-throttled
key short-circuits to ``None`` and the heuristic fallback completes the
build in finite time.
"""

from __future__ import annotations

import time

from ..models import Paper
from ..utils.http import request_with_retry
from ..utils.json_parser import parse_llm_response
from ..utils.logger import get_logger
from .base import (
    AbstractLLMProvider,
    PaperEvaluation,
    RelationClassification,
    build_classify_prompt,
    build_evaluation_prompt,
)

logger = get_logger(__name__)

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
DEFAULT_MODEL = "gemini-2.5-flash"
# Paid Tier 1 (no minimum spend) for gemini-2.5-flash is 300 RPM /
# 2M TPM / 1500 RPD (verified at https://ai.google.dev/gemini-api/docs/rate-limits
# 2026-05-27). 250 RPM keeps a 17 % headroom against transient bursts.
# Free-tier operators must lower this to 8 in config.yaml — the free
# tier is 10 RPM / 250 RPD which makes lineage classification
# impractical for any non-toy workflow.
DEFAULT_RATE_LIMIT_RPM = 250
# Same circuit-breaker semantics as GroqProvider: latch after N
# consecutive failures so a fully-throttled key doesn't burn the 15-min
# workflow timeout on retry storms (see groq_provider.py:50-60 for the
# motivating Groq incident). 3 is conservative — paid Tier 1 should
# never reach this; tripping it means quota exhausted or API outage.
QUOTA_EXHAUSTED_THRESHOLD = 3


class GeminiProvider(AbstractLLMProvider):
    name = "gemini"

    def __init__(self, config: dict, api_key: str | None = None) -> None:
        super().__init__(config)
        self._api_key = api_key
        self.model = str(self.config.get("model", DEFAULT_MODEL))
        self.temperature = float(self.config.get("temperature", 0.2))
        # Rate limiter: ``None`` sentinel for "no prior call" so we
        # don't sleep on the first call. Mirrors GroqProvider's design
        # in #129 — a 0.0 default would race with monkeypatched test
        # clocks that legitimately return 0.0.
        rpm = int(self.config.get("rate_limit_rpm", DEFAULT_RATE_LIMIT_RPM))
        self._min_call_interval_s = (
            60.0 / rpm if rpm > 0 else 60.0 / DEFAULT_RATE_LIMIT_RPM
        )
        self._last_call_ts: float | None = None
        # Circuit breaker: counts consecutive failed _generate() returns
        # to None; resets on the first 200. Once it crosses
        # QUOTA_EXHAUSTED_THRESHOLD the provider stops issuing requests
        # and returns None until the process restarts.
        self._consecutive_failures = 0
        self._quota_exhausted = False

    @property
    def enabled(self) -> bool:
        """Disabled automatically when the API key is missing."""
        return bool(self._enabled) and bool(self._api_key)

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = bool(value)

    def evaluate_batch(
        self, papers: list[Paper], profile: str
    ) -> list[PaperEvaluation | None]:
        if not papers:
            return []

        system, user = build_evaluation_prompt(papers, profile)
        text = self._generate(system, user)
        if text is None:
            return [None] * len(papers)

        parsed = parse_llm_response(text)
        if not isinstance(parsed, list):
            logger.warning(
                "gemini: response was not a JSON array (type=%s)", type(parsed).__name__
            )
            return [None] * len(papers)

        evaluations: list[PaperEvaluation | None] = []
        for i in range(len(papers)):
            if i < len(parsed):
                evaluations.append(PaperEvaluation.from_dict(parsed[i]))
            else:
                evaluations.append(None)
        return evaluations

    # ---- Lineage classification ----

    def classify_relation(
        self, a: dict, b: dict
    ) -> RelationClassification | None:
        system, user = build_classify_prompt(a, b)
        # `responseMimeType: application/json` already forces the model to
        # emit valid JSON; build_classify_prompt asks for a single object,
        # which parse_llm_response handles via its object-extraction fallback.
        text = self._generate(system, user)
        if text is None:
            return None
        parsed = parse_llm_response(text)
        return RelationClassification.from_dict(parsed)

    # ---- helpers ----

    def _throttle_for_rate_limit(self) -> None:
        """Sleep just enough since the last call to honour ``rate_limit_rpm``.

        Mirrors GroqProvider's per-call gate. On the first call
        (``_last_call_ts is None``) returns immediately. Uses
        ``time.monotonic`` so wall-clock jumps (NTP sync) don't break
        the spacing.
        """
        if self._last_call_ts is None:
            self._last_call_ts = time.monotonic()
            return
        elapsed = time.monotonic() - self._last_call_ts
        wait = self._min_call_interval_s - elapsed
        if wait > 0:
            time.sleep(wait)
        self._last_call_ts = time.monotonic()

    def _generate(self, system: str, user: str) -> str | None:
        # Quota circuit breaker — short-circuit to None without calling
        # the API. Caller (build_theme_lineage's _CachedClassifyProvider)
        # then falls back to the heuristic, letting the build complete.
        if self._quota_exhausted:
            return None
        self._throttle_for_rate_limit()

        url = f"{GEMINI_BASE}/{self.model}:generateContent"
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "temperature": self.temperature,
                "responseMimeType": "application/json",
            },
        }
        # Send the API key in the x-goog-api-key header rather than a query
        # param so it never lands in proxy / server access logs.
        resp = request_with_retry(
            "POST",
            url,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": self._api_key or "",
            },
            json_body=body,
            timeout=self.timeout_seconds,
        )
        if resp is None or resp.status_code != 200:
            logger.warning(
                "gemini: generateContent failed (status=%s)",
                getattr(resp, "status_code", None),
            )
            self._consecutive_failures += 1
            if self._consecutive_failures >= QUOTA_EXHAUSTED_THRESHOLD:
                self._quota_exhausted = True
                logger.warning(
                    "gemini: %d consecutive failures — latching quota_exhausted; "
                    "subsequent calls short-circuit to None until process restart",
                    self._consecutive_failures,
                )
            return None
        # Success — reset the failure counter.
        self._consecutive_failures = 0
        data = resp.json() or {}
        candidates = data.get("candidates") or []
        if not candidates:
            logger.warning("gemini: empty candidates in response")
            return None
        parts = (candidates[0].get("content") or {}).get("parts") or []
        if not parts:
            return None
        text = parts[0].get("text")
        return text if isinstance(text, str) and text.strip() else None

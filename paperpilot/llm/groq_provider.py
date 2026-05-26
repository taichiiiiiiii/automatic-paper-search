"""Groq LLM provider — OpenAI-compatible Chat Completions API.

Groq serves Llama 3.3 70B (and other open-weight models) at very high speed
with a generous free tier (30 RPM / 14,400 RPD at the time of writing),
making it the default backend for the lineage family-tree view's relation
classification where we issue one LLM call per candidate edge.

This provider covers both LLM use-cases in PaperPilot:
    - evaluate_batch  : Stage 4 reranking (same contract as Gemini / Claude)
    - classify_relation : per-edge relation classification for build_lineage.py

Config:
    llm:
      provider: groq
      model: llama-3.3-70b-versatile   # any model from https://console.groq.com/docs/models
      batch_size: 5
      temperature: 0.2
      timeout_seconds: 60

Auth: requires `PAPERPILOT_GROQ_API_KEY` in `.env`
(get one at https://console.groq.com/keys, free tier is enough for weekly runs).
When missing, `.enabled` evaluates to False so callers skip this provider.
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

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = "llama-3.3-70b-versatile"
# Conservative default below the 30 RPM free tier so a burst of
# classify_relation calls from build_theme_lineage(--llm-strict=all)
# doesn't silently 429 the back half of the burst. Operators on a paid
# plan can raise this via `llm.rate_limit_rpm` in config.yaml.
DEFAULT_RATE_LIMIT_RPM = 25
# After this many consecutive Groq /chat/completions failures we treat
# the daily / TPM quota as exhausted and short-circuit further calls to
# return None instead of hammering the API for another 14s-each retry
# burst. Without this, a build_theme_lineage run on a fully-throttled
# Groq quota burns its workflow timeout-minutes (15) rotating through
# 429-after-3-retries on every edge — verified on the 2026-05-26 SSM
# regen which got cancelled at 15 min with 0 classifications completed.
# Caller code (_CachedClassifyProvider) already falls back to the S2
# intent-based heuristic on None, so the result is "graceful degrade"
# rather than "data missing".
QUOTA_EXHAUSTED_THRESHOLD = 3


class GroqProvider(AbstractLLMProvider):
    name = "groq"

    def __init__(self, config: dict, api_key: str | None = None) -> None:
        super().__init__(config)
        self._api_key = api_key
        self.model = str(self.config.get("model", DEFAULT_MODEL))
        self.temperature = float(self.config.get("temperature", 0.2))
        # Rate-limit state: track the timestamp of the last call so the
        # next _chat() can sleep just enough to keep us under the RPM
        # budget. ``None`` is the sentinel for "no prior call" — using
        # 0.0 would be ambiguous against monkeypatched test clocks that
        # legitimately return 0.0. See DEFAULT_RATE_LIMIT_RPM and #129.
        rpm = int(self.config.get("rate_limit_rpm", DEFAULT_RATE_LIMIT_RPM))
        # Guard against pathological config values (0 or negative would
        # divide by zero / sleep forever). Fall through to the default.
        self._min_call_interval_s = 60.0 / rpm if rpm > 0 else 60.0 / DEFAULT_RATE_LIMIT_RPM
        self._last_call_ts: float | None = None
        # Circuit-breaker state for the quota-exhausted short-circuit.
        # Counts consecutive failed _chat() returns; resets on the first
        # successful call. Once it crosses QUOTA_EXHAUSTED_THRESHOLD the
        # provider stops issuing requests and returns None until the
        # process restarts.
        self._consecutive_failures = 0
        self._quota_exhausted = False

    @property
    def enabled(self) -> bool:
        """Auto-disable when the API key is missing."""
        return bool(self._enabled) and bool(self._api_key)

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = bool(value)

    # ---- Stage 4 ----

    def evaluate_batch(
        self, papers: list[Paper], profile: str
    ) -> list[PaperEvaluation | None]:
        if not papers:
            return []

        system, user = build_evaluation_prompt(papers, profile)
        text = self._chat(system, user, json_mode=False)
        if text is None:
            return [None] * len(papers)

        parsed = parse_llm_response(text)
        if not isinstance(parsed, list):
            logger.warning(
                "groq: response was not a JSON array (type=%s)", type(parsed).__name__
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
        # Groq's `response_format: json_object` reliably avoids markdown
        # fences or stray prose — critical because we issue hundreds of
        # classifications per lineage build.
        text = self._chat(system, user, json_mode=True)
        if text is None:
            return None
        parsed = parse_llm_response(text)
        return RelationClassification.from_dict(parsed)

    # ---- helpers ----

    def _throttle_for_rate_limit(self) -> None:
        """Sleep just enough to keep this call under the RPM budget.

        Idempotent on first invocation (``_last_call_ts is None``). Uses
        ``time.monotonic`` so a wall-clock jump (NTP correction, container
        clock skew) can't push the next call into a stuck-asleep state
        the way ``time.time`` would.
        """
        if self._last_call_ts is None:
            self._last_call_ts = time.monotonic()
            return
        elapsed = time.monotonic() - self._last_call_ts
        wait = self._min_call_interval_s - elapsed
        if wait > 0:
            time.sleep(wait)
        # Stamp AFTER sleeping so the next call measures interval from
        # the actual return time, not from when we entered the throttle.
        self._last_call_ts = time.monotonic()

    def _chat(self, system: str, user: str, *, json_mode: bool = False) -> str | None:
        # Circuit-breaker short-circuit: once we've hit the quota-
        # exhausted threshold, every further call returns None without
        # touching the API or sleeping for the RPM throttle. The caller
        # (_CachedClassifyProvider in build_theme_lineage / build_lineage)
        # already treats None as "fall back to S2-intent heuristic", so
        # the data still gets a sensible classification.
        if self._quota_exhausted:
            return None
        self._throttle_for_rate_limit()
        body: dict = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": self.temperature,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}

        resp = request_with_retry(
            "POST",
            GROQ_URL,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._api_key or ''}",
            },
            json_body=body,
            timeout=self.timeout_seconds,
        )
        if resp is None or resp.status_code != 200:
            logger.warning(
                "groq: chat/completions failed (status=%s)",
                getattr(resp, "status_code", None),
            )
            self._consecutive_failures += 1
            if self._consecutive_failures >= QUOTA_EXHAUSTED_THRESHOLD:
                self._quota_exhausted = True
                logger.warning(
                    "groq: %d consecutive failures — assuming daily / TPM "
                    "quota exhausted, short-circuiting further LLM calls "
                    "to heuristic-only for the rest of this run",
                    self._consecutive_failures,
                )
            return None
        data = resp.json() or {}
        choices = data.get("choices") or []
        if not choices:
            logger.warning("groq: empty choices in response")
            self._consecutive_failures += 1
            return None
        content = (choices[0].get("message") or {}).get("content")
        if not (isinstance(content, str) and content.strip()):
            self._consecutive_failures += 1
            return None
        # Success — reset the failure counter so a transient blip doesn't
        # latch the circuit breaker open.
        self._consecutive_failures = 0
        return content

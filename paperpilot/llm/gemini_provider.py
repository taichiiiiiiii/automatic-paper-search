"""Gemini LLM provider — Google's generative-language API.

Uses the REST `generateContent` endpoint with `responseMimeType=application/json`
so the model returns a parseable JSON payload. Falls back to the 3-step
json_parser for resilience.

Config:
    llm:
      provider: gemini
      model: gemini-1.5-flash      # or gemini-1.5-pro / gemini-2.0-*
      batch_size: 5
      temperature: 0.2
      timeout_seconds: 60

Auth: requires PAPERPILOT_GEMINI_API_KEY in .env (free tier available at
https://aistudio.google.com/apikey).

When no API key is available, `.enabled` evaluates to False so Stage 4
is skipped automatically.
"""

from __future__ import annotations

from ..models import Paper
from ..utils.http import request_with_retry
from ..utils.json_parser import parse_llm_response
from ..utils.logger import get_logger
from .base import AbstractLLMProvider, PaperEvaluation, build_evaluation_prompt

logger = get_logger(__name__)

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
DEFAULT_MODEL = "gemini-1.5-flash"


class GeminiProvider(AbstractLLMProvider):
    name = "gemini"

    def __init__(self, config: dict, api_key: str | None = None) -> None:
        super().__init__(config)
        self._api_key = api_key
        self.model = str(self.config.get("model", DEFAULT_MODEL))
        self.temperature = float(self.config.get("temperature", 0.2))

    @property
    def enabled(self) -> bool:  # type: ignore[override]
        """Disabled automatically when the API key is missing."""
        return bool(self._enabled) and bool(self._api_key)

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = bool(value)

    # AbstractLLMProvider.__init__ set `self.enabled` via setter above
    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)

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

    # ---- helpers ----

    def _generate(self, system: str, user: str) -> str | None:
        url = f"{GEMINI_BASE}/{self.model}:generateContent"
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "temperature": self.temperature,
                "responseMimeType": "application/json",
            },
        }
        resp = request_with_retry(
            "POST",
            url,
            params={"key": self._api_key},
            headers={"Content-Type": "application/json"},
            json_body=body,
            timeout=self.timeout_seconds,
        )
        if resp is None or resp.status_code != 200:
            logger.warning(
                "gemini: generateContent failed (status=%s)",
                getattr(resp, "status_code", None),
            )
            return None
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

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
from .base import (
    AbstractLLMProvider,
    PaperEvaluation,
    RelationClassification,
    build_classify_prompt,
    build_evaluation_prompt,
    map_batch_evaluations,
    safe_json_response,
)

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

        return map_batch_evaluations(papers, parsed)

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

    def complete_json(self, system: str, user: str) -> str | None:
        # `responseMimeType: application/json` is already set by _generate,
        # so there is no separate json_mode flag to pass here.
        return self._generate(system, user)

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
            return None
        data = safe_json_response(resp)
        if data is None:
            logger.warning("gemini: generateContent response was not valid JSON")
            return None
        candidates = data.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            logger.warning("gemini: empty/invalid candidates in response")
            return None
        first_candidate = candidates[0]
        content_obj = (
            first_candidate.get("content") if isinstance(first_candidate, dict) else None
        )
        parts = content_obj.get("parts") if isinstance(content_obj, dict) else None
        if not isinstance(parts, list) or not parts:
            return None
        first_part = parts[0]
        text = first_part.get("text") if isinstance(first_part, dict) else None
        return text if isinstance(text, str) and text.strip() else None

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


class GroqProvider(AbstractLLMProvider):
    name = "groq"

    def __init__(self, config: dict, api_key: str | None = None) -> None:
        super().__init__(config)
        self._api_key = api_key
        self.model = str(self.config.get("model", DEFAULT_MODEL))
        self.temperature = float(self.config.get("temperature", 0.2))

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

    def _chat(self, system: str, user: str, *, json_mode: bool = False) -> str | None:
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
            return None
        data = resp.json() or {}
        choices = data.get("choices") or []
        if not choices:
            logger.warning("groq: empty choices in response")
            return None
        content = (choices[0].get("message") or {}).get("content")
        return content if isinstance(content, str) and content.strip() else None

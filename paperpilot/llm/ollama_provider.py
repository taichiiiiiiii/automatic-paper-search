"""Ollama LLM provider — local, free, spec-mentioned fallback (§8 Table 20).

Uses Ollama's /api/chat endpoint with format=json so the model emits
structured output directly. If the model occasionally produces invalid
JSON, the 3-step fallback in utils.json_parser recovers it.

Setup:
    1. Install Ollama: https://ollama.com
    2. Pull a model:   ollama pull qwen2.5:7b
    3. (Ollama serves on http://localhost:11434 by default)

Config:
    llm:
      provider: ollama
      model: qwen2.5:7b
      host: http://localhost:11434
      batch_size: 5
      timeout_seconds: 120
"""

from __future__ import annotations

from ..models import Paper
from ..utils.http import request_with_retry
from ..utils.json_parser import parse_llm_response
from ..utils.logger import get_logger
from .base import AbstractLLMProvider, PaperEvaluation, build_evaluation_prompt

logger = get_logger(__name__)

DEFAULT_HOST = "http://localhost:11434"
DEFAULT_MODEL = "qwen2.5:7b"


class OllamaProvider(AbstractLLMProvider):
    name = "ollama"

    def __init__(self, config: dict) -> None:
        super().__init__(config)
        self.host = str(self.config.get("host", DEFAULT_HOST)).rstrip("/")
        self.model = str(self.config.get("model", DEFAULT_MODEL))
        self.temperature = float(self.config.get("temperature", 0.2))

    def evaluate_batch(
        self, papers: list[Paper], profile: str
    ) -> list[PaperEvaluation | None]:
        if not papers:
            return []

        system, user = build_evaluation_prompt(papers, profile)
        text = self._chat(system, user)
        if text is None:
            return [None] * len(papers)

        parsed = parse_llm_response(text)
        if not isinstance(parsed, list):
            logger.warning(
                "ollama: response was not a JSON array (type=%s)", type(parsed).__name__
            )
            return [None] * len(papers)

        # Map results by index; pad/truncate defensively.
        evaluations: list[PaperEvaluation | None] = []
        for i in range(len(papers)):
            if i < len(parsed):
                evaluations.append(PaperEvaluation.from_dict(parsed[i]))
            else:
                evaluations.append(None)
        return evaluations

    # ---- helpers ----

    def _chat(self, system: str, user: str) -> str | None:
        url = f"{self.host}/api/chat"
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": False,
            "format": "json",
            "options": {"temperature": self.temperature},
        }
        resp = request_with_retry(
            "POST",
            url,
            json_body=body,
            headers={"Content-Type": "application/json"},
            timeout=self.timeout_seconds,
        )
        if resp is None or resp.status_code != 200:
            logger.warning(
                "ollama: /api/chat failed (status=%s)",
                getattr(resp, "status_code", None),
            )
            return None
        data = resp.json() or {}
        message = data.get("message") or {}
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            logger.warning("ollama: empty response body")
            return None
        return content

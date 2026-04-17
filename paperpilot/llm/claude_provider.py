"""Claude LLM provider — Anthropic's Messages API.

Uses the direct HTTP endpoint (no SDK dependency) so the existing
`utils.http.request_with_retry` handles 429 / 5xx retry uniformly.

Claude does not expose a JSON-only output mode, so we rely on the
structured system prompt (see `llm.base.SYSTEM_PROMPT`) plus the 3-step
fallback in `utils.json_parser`.

Config:
    llm:
      provider: claude
      model: claude-sonnet-4-20250514      # or claude-opus-4-*, claude-haiku-4-*
      batch_size: 5
      temperature: 0.2
      max_tokens: 2048
      timeout_seconds: 60

Auth: requires `PAPERPILOT_CLAUDE_API_KEY` in `.env`. When missing,
`.enabled` evaluates to False so Stage 4 is skipped automatically.
"""

from __future__ import annotations

from ..models import Paper
from ..utils.http import request_with_retry
from ..utils.json_parser import parse_llm_response
from ..utils.logger import get_logger
from .base import AbstractLLMProvider, PaperEvaluation, build_evaluation_prompt

logger = get_logger(__name__)

CLAUDE_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_MODEL = "claude-sonnet-4-20250514"


class ClaudeProvider(AbstractLLMProvider):
    name = "claude"

    def __init__(self, config: dict, api_key: str | None = None) -> None:
        super().__init__(config)
        self._api_key = api_key
        self.model = str(self.config.get("model", DEFAULT_MODEL))
        self.temperature = float(self.config.get("temperature", 0.2))
        self.max_tokens = int(self.config.get("max_tokens", 2048))

    @property
    def enabled(self) -> bool:
        """Auto-disable when the API key is missing."""
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
        text = self._messages(system, user)
        if text is None:
            return [None] * len(papers)

        parsed = parse_llm_response(text)
        if not isinstance(parsed, list):
            logger.warning(
                "claude: response was not a JSON array (type=%s)", type(parsed).__name__
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

    def _messages(self, system: str, user: str) -> str | None:
        body = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        # API key goes in x-api-key header (never in URL / query params).
        resp = request_with_retry(
            "POST",
            CLAUDE_URL,
            headers={
                "Content-Type": "application/json",
                "x-api-key": self._api_key or "",
                "anthropic-version": ANTHROPIC_VERSION,
            },
            json_body=body,
            timeout=self.timeout_seconds,
        )
        if resp is None or resp.status_code != 200:
            logger.warning(
                "claude: /v1/messages failed (status=%s)",
                getattr(resp, "status_code", None),
            )
            return None
        data = resp.json() or {}
        content = data.get("content") or []
        if not content:
            logger.warning("claude: empty content array")
            return None
        # Find the first text block; ignore tool_use / other types.
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                text = part.get("text")
                if isinstance(text, str) and text.strip():
                    return text
        logger.warning("claude: no text part found in content array")
        return None

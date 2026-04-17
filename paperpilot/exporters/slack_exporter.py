"""Slack exporter — posts the top-K papers via Incoming Webhook.

Reads the webhook URL from config['env']['slack_webhook_url'] (loaded
from PAPERPILOT_SLACK_WEBHOOK_URL). If the URL is absent, the exporter
no-ops with a log message rather than failing the pipeline.
"""

from __future__ import annotations

from datetime import date

from ..models import Paper
from ..utils.http import request_with_retry
from ..utils.logger import get_logger
from .base import AbstractExporter

logger = get_logger(__name__)


class SlackExporter(AbstractExporter):
    name = "slack"

    def __init__(self, config: dict, webhook_url: str | None = None) -> None:
        super().__init__(config)
        self._webhook_url = webhook_url
        self.max_items = int(self.config.get("max_items", 10))

    def export(self, papers: list[Paper]) -> str | None:
        if not self._webhook_url:
            logger.info("slack: webhook URL not configured; skipping")
            return None
        if not papers:
            logger.info("slack: no papers to send")
            return None

        top = papers[: self.max_items]
        text = self._format(top)
        resp = request_with_retry(
            "POST",
            self._webhook_url,
            headers={"Content-Type": "application/json"},
            json_body={"text": text},
        )
        if resp is None or resp.status_code >= 300:
            logger.warning(
                "slack: post failed (status=%s)", getattr(resp, "status_code", None)
            )
            return None
        logger.info("slack: posted %d papers", len(top))
        return "slack"

    @staticmethod
    def _format(papers: list[Paper]) -> str:
        lines = [f"*📚 PaperPilot — {date.today().isoformat()} ({len(papers)}件)*"]
        for rank, p in enumerate(papers, start=1):
            venue = f" [{p.venue}]" if p.venue else ""
            stars = f" ⭐{p.github_stars}" if p.github_stars else ""
            cites = f" 引用{p.citation_count}" if p.citation_count else ""
            lines.append(
                f"{rank}. <{p.url}|{p.title}> — score {p.total_score:.1f}"
                f"{venue}{stars}{cites}"
            )
        return "\n".join(lines)

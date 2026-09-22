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

_ALLOWED_URL_SCHEMES = ("http://", "https://")


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
            status = getattr(resp, "status_code", None)
            logger.warning("slack: post failed (status=%s)", status)
            # Raise (rather than swallow) so the pipeline runner's
            # per-exporter try/except records this in run_history.errors —
            # this is a real failure, not the "not configured" no-op above.
            raise RuntimeError(f"slack post failed (status={status})")
        logger.info("slack: posted %d papers", len(top))
        return "slack"

    @staticmethod
    def _escape_mrkdwn(text: str) -> str:
        """Escape Slack mrkdwn special characters (`&`, `<`, `>`, in that
        order per Slack's own escaping rule). Untrusted paper titles/URLs
        must not be able to break the `<url|text>` link syntax or inject
        fake links/formatting."""
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    @classmethod
    def _format(cls, papers: list[Paper]) -> str:
        lines = [f"*📚 PaperPilot — {date.today().isoformat()} ({len(papers)}件)*"]
        for rank, p in enumerate(papers, start=1):
            title = cls._escape_mrkdwn(p.title)
            venue = f" [{cls._escape_mrkdwn(p.venue)}]" if p.venue else ""
            stars = f" ⭐{p.github_stars}" if p.github_stars else ""
            cites = f" 引用{p.citation_count}" if p.citation_count else ""
            if p.url.lower().startswith(_ALLOWED_URL_SCHEMES):
                link = f"<{cls._escape_mrkdwn(p.url)}|{title}>"
            else:
                # Escaping &/</> does not neutralize Slack's <...|...> control
                # sequences: the first character inside the brackets (e.g.
                # "!", "@", "#") selects @here/user-mention/channel-mention
                # syntax regardless of escaping. A non-http(s) url must never
                # occupy that position — fall back to plain (already-escaped)
                # text instead of building a link at all.
                logger.warning(
                    "slack: paper %r has a non-http(s) url; omitting link", p.title
                )
                link = title
            lines.append(f"{rank}. {link} — score {p.total_score:.1f}{venue}{stars}{cites}")
        return "\n".join(lines)

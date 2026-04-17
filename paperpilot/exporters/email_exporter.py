"""Email exporter — delivers the top-K papers via SMTP.

Configuration mixes the config.yaml `output.email` section (knobs like
max_items) with SMTP credentials loaded from environment variables
(`PAPERPILOT_SMTP_*`). Missing credentials make the exporter no-op
rather than fail the pipeline.

Supports:
    - STARTTLS (default) or plain SMTP
    - Optional auth (login skipped when user/password are empty)
"""

from __future__ import annotations

import contextlib
import html
import smtplib
from datetime import date
from email.message import EmailMessage

from ..models import Paper
from ..utils.logger import get_logger
from .base import AbstractExporter

logger = get_logger(__name__)

DEFAULT_PORT = 587
DEFAULT_TIMEOUT = 30


class EmailExporter(AbstractExporter):
    name = "email"

    def __init__(self, config: dict, smtp_settings: dict | None = None) -> None:
        super().__init__(config)
        self.max_items = int(self.config.get("max_items", 10))
        self._smtp = dict(smtp_settings or {})

    def export(self, papers: list[Paper]) -> str | None:
        if not papers:
            logger.info("email: no papers to send")
            return None

        server = self._smtp.get("server")
        to_addr = self._smtp.get("to")
        if not server or not to_addr:
            logger.info("email: SMTP server/to not configured; skipping")
            return None

        top = papers[: self.max_items]
        msg = self._build_message(top, to_addr)

        try:
            client = smtplib.SMTP(
                str(server),
                int(self._smtp.get("port") or DEFAULT_PORT),
                timeout=DEFAULT_TIMEOUT,
            )
        except OSError as e:
            logger.warning("email: connect failed: %s", e)
            return None

        try:
            if self._smtp.get("use_tls", True):
                client.starttls()
            user = self._smtp.get("user")
            password = self._smtp.get("password")
            if user and password:
                client.login(str(user), str(password))
            client.send_message(msg)
        except (smtplib.SMTPException, OSError) as e:
            # OSError covers ssl.SSLError / socket errors from starttls() and
            # DNS-level failures, which are NOT subclasses of SMTPException.
            logger.warning("email: send failed: %s", e)
            return None
        finally:
            with contextlib.suppress(Exception):  # best-effort cleanup
                client.quit()

        logger.info("email: sent %d papers to %s", len(top), to_addr)
        return "email"

    # ---- helpers ----

    def _build_message(self, papers: list[Paper], to_addr: str) -> EmailMessage:
        today = date.today().isoformat()
        msg = EmailMessage()
        msg["Subject"] = f"📚 PaperPilot — {today} ({len(papers)} papers)"
        msg["To"] = to_addr
        sender = self._smtp.get("user") or f"paperpilot@{today}"
        msg["From"] = str(sender)

        text_body = self._text_body(papers, today)
        html_body = self._html_body(papers, today)

        msg.set_content(text_body)
        msg.add_alternative(html_body, subtype="html")
        return msg

    @staticmethod
    def _text_body(papers: list[Paper], today: str) -> str:
        lines = [f"PaperPilot — {today}", ""]
        for rank, p in enumerate(papers, start=1):
            bits = [f"{rank}. {p.title}", f"   score: {p.total_score:.1f}"]
            if p.venue:
                bits.append(f"   venue: {p.venue}")
            if p.github_stars:
                bits.append(f"   stars: {p.github_stars}")
            bits.append(f"   url: {p.url}")
            if p.llm_summary_ja:
                bits.append(f"   要約: {p.llm_summary_ja}")
            lines.extend(bits)
            lines.append("")
        return "\n".join(lines)

    @staticmethod
    def _html_body(papers: list[Paper], today: str) -> str:
        rows = []
        for rank, p in enumerate(papers, start=1):
            venue = html.escape(p.venue) if p.venue else ""
            summary = html.escape(p.llm_summary_ja) if p.llm_summary_ja else ""
            rows.append(
                f"<tr>"
                f"<td>{rank}</td>"
                f"<td><a href='{html.escape(p.url)}'>{html.escape(p.title)}</a></td>"
                f"<td>{p.total_score:.1f}</td>"
                f"<td>{venue}</td>"
                f"<td>{p.github_stars}</td>"
                f"<td>{summary}</td>"
                f"</tr>"
            )
        return (
            f"<html><body>"
            f"<h2>📚 PaperPilot — {today}</h2>"
            f"<table border='1' cellpadding='4'>"
            f"<tr><th>#</th><th>Title</th><th>Score</th><th>Venue</th>"
            f"<th>Stars</th><th>Summary</th></tr>"
            + "".join(rows)
            + "</table></body></html>"
        )

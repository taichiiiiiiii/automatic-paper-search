"""Email exporter tests with mocked smtplib.SMTP."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

import pytest

from paperpilot.exporters.email_exporter import EmailExporter
from paperpilot.models import Paper


def _mk_paper(title: str, score: float = 50.0) -> Paper:
    return Paper(
        title=title,
        authors=["A"],
        abstract="abs",
        url="http://x",
        published_date=date.today(),
        source="arxiv",
        total_score=score,
    )


def _build_settings(**overrides) -> dict:
    base = {
        "server": "smtp.example.com",
        "port": 587,
        "user": "me",
        "password": "pass",
        "to": "inbox@example.com",
        "use_tls": True,
    }
    base.update(overrides)
    return base


def test_no_papers_returns_none():
    exp = EmailExporter({"enabled": True}, smtp_settings=_build_settings())
    assert exp.export([]) is None


def test_missing_settings_no_op():
    # Server missing → skip gracefully (like Slack without webhook).
    exp = EmailExporter({"enabled": True}, smtp_settings={"to": "a@b.c"})
    assert exp.export([_mk_paper("A")]) is None


def test_send_invokes_smtp_with_tls():
    papers = [_mk_paper("Paper A"), _mk_paper("Paper B")]
    exp = EmailExporter({"enabled": True, "max_items": 10}, smtp_settings=_build_settings())

    fake_smtp = MagicMock()
    with patch("paperpilot.exporters.email_exporter.smtplib.SMTP", return_value=fake_smtp) as smtp_cls:
        result = exp.export(papers)

    assert result == "email"
    smtp_cls.assert_called_once_with("smtp.example.com", 587, timeout=30)
    fake_smtp.starttls.assert_called_once()
    fake_smtp.login.assert_called_once_with("me", "pass")
    fake_smtp.send_message.assert_called_once()
    fake_smtp.quit.assert_called_once()

    # Inspect the actual message
    msg = fake_smtp.send_message.call_args.args[0]
    assert msg["To"] == "inbox@example.com"
    assert "PaperPilot" in (msg["Subject"] or "")
    # Body contains the titles
    body = _extract_body(msg)
    assert "Paper A" in body
    assert "Paper B" in body


def test_respects_max_items():
    import re

    papers = [_mk_paper(f"P{i}") for i in range(30)]
    exp = EmailExporter({"enabled": True, "max_items": 3}, smtp_settings=_build_settings())
    fake_smtp = MagicMock()
    with patch("paperpilot.exporters.email_exporter.smtplib.SMTP", return_value=fake_smtp):
        exp.export(papers)
    msg = fake_smtp.send_message.call_args.args[0]
    body = _extract_body(msg)
    # Use word-boundary regex so "P0" doesn't falsely match "P10"/"P20"/"P29".
    titles_seen = set(re.findall(r"\bP\d+\b", body))
    assert {"P0", "P1", "P2"} <= titles_seen
    assert not (titles_seen & {f"P{i}" for i in range(3, 30)})


def test_no_tls_branch():
    papers = [_mk_paper("Solo")]
    exp = EmailExporter(
        {"enabled": True}, smtp_settings=_build_settings(use_tls=False, port=25)
    )
    fake_smtp = MagicMock()
    with patch("paperpilot.exporters.email_exporter.smtplib.SMTP", return_value=fake_smtp):
        exp.export(papers)
    fake_smtp.starttls.assert_not_called()
    fake_smtp.login.assert_called_once()


def test_no_auth_branch():
    papers = [_mk_paper("Solo")]
    settings = _build_settings(user="", password="")
    exp = EmailExporter({"enabled": True}, smtp_settings=settings)
    fake_smtp = MagicMock()
    with patch("paperpilot.exporters.email_exporter.smtplib.SMTP", return_value=fake_smtp):
        exp.export(papers)
    # No user -> no login call
    fake_smtp.login.assert_not_called()
    fake_smtp.send_message.assert_called_once()


def test_smtp_exception_returns_none():
    """A connect failure is a real error: export() raises so the pipeline
    runner records it in run_history.errors (closes #386), rather than
    silently swallowing it and returning None."""
    papers = [_mk_paper("x")]
    exp = EmailExporter({"enabled": True}, smtp_settings=_build_settings())
    with patch(
        "paperpilot.exporters.email_exporter.smtplib.SMTP",
        side_effect=OSError("connection refused"),
    ):
        with pytest.raises(OSError, match="connection refused"):
            exp.export(papers)


def test_starttls_ssl_error_quits_connection():
    """OSError / ssl.SSLError raised during starttls must not leak the
    client, and (closes #386) must propagate rather than be swallowed."""
    import ssl

    papers = [_mk_paper("x")]
    exp = EmailExporter({"enabled": True}, smtp_settings=_build_settings())
    fake_smtp = MagicMock()
    fake_smtp.starttls.side_effect = ssl.SSLError("tls handshake failed")
    with patch("paperpilot.exporters.email_exporter.smtplib.SMTP", return_value=fake_smtp):
        with pytest.raises(ssl.SSLError):
            exp.export(papers)
    fake_smtp.quit.assert_called_once()


def test_login_authentication_error_quits_connection():
    """SMTPAuthenticationError propagates (closes #386) and quit is still
    called via the finally block."""
    import smtplib as _smtp

    papers = [_mk_paper("x")]
    exp = EmailExporter({"enabled": True}, smtp_settings=_build_settings())
    fake_smtp = MagicMock()
    fake_smtp.login.side_effect = _smtp.SMTPAuthenticationError(535, b"bad creds")
    with patch("paperpilot.exporters.email_exporter.smtplib.SMTP", return_value=fake_smtp):
        with pytest.raises(_smtp.SMTPAuthenticationError):
            exp.export(papers)
    fake_smtp.quit.assert_called_once()


def test_html_body_omits_link_for_non_http_scheme_url():
    """Regression test (closes #403): html.escape() neutralizes markup
    injection but does nothing about the URL SCHEME itself —
    href='javascript:...' still executes regardless of escaping (same
    class of gap fixed for Slack in #397). A non-http(s) url must fall
    back to plain text instead of being placed in an href."""
    paper = _mk_paper("Malicious Paper")
    paper.url = "javascript:alert(1)"
    html_out = EmailExporter._html_body([paper], date.today().isoformat())
    assert "<a href=" not in html_out
    assert "javascript:" not in html_out
    assert "Malicious Paper" in html_out


def test_html_body_keeps_link_for_https_url():
    """A normal https url must still produce an <a href> link."""
    paper = _mk_paper("Legit Paper")
    paper.url = "https://arxiv.org/abs/2604.00001"
    html_out = EmailExporter._html_body([paper], date.today().isoformat())
    assert "<a href='https://arxiv.org/abs/2604.00001'>Legit Paper</a>" in html_out


def test_html_body_omits_link_for_data_scheme_url():
    """`data:` URLs are another classic non-http(s) injection vector and
    must be treated the same as `javascript:`."""
    paper = _mk_paper("Data URI Paper")
    paper.url = "data:text/html,<script>alert(1)</script>"
    html_out = EmailExporter._html_body([paper], date.today().isoformat())
    assert "<a href=" not in html_out
    assert "data:text/html" not in html_out


def _extract_body(msg) -> str:
    """Return the concatenated text of all parts."""
    if msg.is_multipart():
        parts = msg.get_payload()
        return "\n".join(
            p.get_payload(decode=True).decode("utf-8", errors="ignore") if p.get_payload(decode=True) else ""
            for p in parts
        )
    payload = msg.get_payload(decode=True)
    if payload is not None:
        return str(payload.decode("utf-8", errors="ignore"))
    return str(msg.get_payload())

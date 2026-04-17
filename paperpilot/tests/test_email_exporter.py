"""Email exporter tests with mocked smtplib.SMTP."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

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
    papers = [_mk_paper(f"P{i}") for i in range(30)]
    exp = EmailExporter({"enabled": True, "max_items": 3}, smtp_settings=_build_settings())
    fake_smtp = MagicMock()
    with patch("paperpilot.exporters.email_exporter.smtplib.SMTP", return_value=fake_smtp):
        exp.export(papers)
    msg = fake_smtp.send_message.call_args.args[0]
    body = _extract_body(msg)
    assert body.count("P0") + body.count("P1") + body.count("P2") >= 3
    assert "P28" not in body and "P29" not in body


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
    papers = [_mk_paper("x")]
    exp = EmailExporter({"enabled": True}, smtp_settings=_build_settings())
    with patch(
        "paperpilot.exporters.email_exporter.smtplib.SMTP",
        side_effect=OSError("connection refused"),
    ):
        assert exp.export(papers) is None


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
        return payload.decode("utf-8", errors="ignore")
    return str(msg.get_payload())

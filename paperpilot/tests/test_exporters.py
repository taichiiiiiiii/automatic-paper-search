"""CSV / JSON / Slack exporter tests."""

from __future__ import annotations

import csv
import json
import smtplib
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from paperpilot.exporters import CSVExporter, JSONExporter, SlackExporter
from paperpilot.models import Paper


def _sample_papers() -> list[Paper]:
    return [
        Paper(
            title="T1",
            authors=["A"],
            abstract="abs",
            url="http://x/1",
            published_date=date.today(),
            source="arxiv",
            arxiv_id="2604.001",
            total_score=100.0,
            venue="ICLR",
            venue_tier=1,
            venue_score=100.0,
            github_stars=500,
            github_score=73.0,
        ),
        Paper(
            title="T2",
            authors=["B", "C"],
            abstract="abs2",
            url="http://x/2",
            published_date=date.today(),
            source="s2",
            arxiv_id="2604.002",
            total_score=50.0,
        ),
    ]


def test_csv_writes_header_and_rows(tmp_path: Path):
    exp = CSVExporter({"enabled": True, "dir": str(tmp_path), "encoding": "utf-8"})
    path = exp.export(_sample_papers())
    assert path is not None
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    assert len(rows) == 2
    assert rows[0]["rank"] == "1"
    assert rows[0]["title"] == "T1"
    assert rows[0]["venue"] == "ICLR"
    assert rows[0]["venue_tier"] == "1"


def test_csv_no_papers_returns_none(tmp_path: Path):
    exp = CSVExporter({"enabled": True, "dir": str(tmp_path), "encoding": "utf-8"})
    assert exp.export([]) is None


# ---- CSV identity-column contract (uid / doi are additive, appended last) ----

_CSV_LEGACY_HEADER = [
    "rank",
    "total_score",
    "llm_relevance",
    "llm_summary_ja",
    "llm_reason",
    "llm_tags",
    "follow_score",
    "follow_reason",
    "title",
    "authors",
    "affiliations",
    "venue",
    "venue_tier",
    "venue_score",
    "citation_count",
    "influential_citations",
    "citation_velocity",
    "citation_score",
    "author_h_index",
    "author_score",
    "embedding_similarity",
    "github_stars",
    "github_score",
    "has_code",
    "is_official_repo",
    "keyword_match_count",
    "keyword_score",
    "matched_keywords",
    "categories",
    "published_date",
    "url",
    "pdf_url",
    "github_url",
    "arxiv_id",
    "source",
    "abstract",
]


def _identity_papers() -> list[Paper]:
    """Fixed synthetic records (fictional titles, example.invalid URLs, test-only DOIs)."""
    return [
        # DOI only -> uid falls back to doi alias.
        Paper(
            title="Fictional Marker Retrieval Study Alpha",
            authors=["Yamada Testonly"],
            abstract="Synthetic abstract alpha.",
            url="https://example.invalid/alpha",
            published_date=date(2026, 4, 1),
            source="s2",
            doi="10.5555/testonly.alpha.0001",
            total_score=88.5,
        ),
        # arXiv + DOI -> arXiv wins the uid alias order.
        Paper(
            title="Fictional Marker Lineage Beta",
            authors=["Sato Testonly", "Tanaka Testonly"],
            abstract="Synthetic abstract beta.",
            url="https://example.invalid/beta",
            published_date=date(2026, 4, 2),
            source="arxiv",
            arxiv_id="2604.99999",
            doi="10.5555/testonly.beta.0002",
            pdf_url="https://example.invalid/beta.pdf",
            total_score=77.25,
        ),
        # No strong identifiers -> url fallback uid, DOI stays empty.
        Paper(
            title="Fictional Marker Survey Gamma",
            authors=["Nazuna Testonly"],
            abstract="Synthetic abstract gamma.",
            url="https://example.invalid/gamma",
            published_date=date(2026, 4, 3),
            source="openalex",
            total_score=10.0,
        ),
        # Duplicate title with a distinct DOI must not collapse identifiers.
        Paper(
            title="Fictional Marker Retrieval Study Alpha",
            authors=["Doi Testonly"],
            abstract="Synthetic abstract delta.",
            url="https://example.invalid/delta",
            published_date=date(2026, 4, 4),
            source="s2",
            doi="10.5555/testonly.delta.0004",
            total_score=5.0,
        ),
    ]


def _read_csv_rows(path: str) -> tuple[list[str], list[dict[str, str]]]:
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return list(reader.fieldnames or []), list(reader)


def test_csv_appends_uid_and_doi_columns(tmp_path: Path):
    exp = CSVExporter({"enabled": True, "dir": str(tmp_path), "encoding": "utf-8"})
    path = exp.export(_identity_papers())
    assert path is not None
    header, rows = _read_csv_rows(path)
    # Existing columns keep their exact order as a prefix; uid / doi are appended.
    assert header[: len(_CSV_LEGACY_HEADER)] == _CSV_LEGACY_HEADER
    assert header[len(_CSV_LEGACY_HEADER) :] == ["uid", "doi"]
    assert [r["uid"] for r in rows] == [
        "doi:10.5555/testonly.alpha.0001",
        "arxiv:2604.99999",
        "url:https://example.invalid/gamma",
        "doi:10.5555/testonly.delta.0004",
    ]
    assert [r["doi"] for r in rows] == [
        "10.5555/testonly.alpha.0001",
        "10.5555/testonly.beta.0002",
        "",
        "10.5555/testonly.delta.0004",
    ]
    # Row order / rank and existing identifier columns are unchanged.
    assert [(r["rank"], r["title"], r["arxiv_id"], r["url"], r["source"]) for r in rows] == [
        ("1", "Fictional Marker Retrieval Study Alpha", "", "https://example.invalid/alpha", "s2"),
        (
            "2",
            "Fictional Marker Lineage Beta",
            "2604.99999",
            "https://example.invalid/beta",
            "arxiv",
        ),
        (
            "3",
            "Fictional Marker Survey Gamma",
            "",
            "https://example.invalid/gamma",
            "openalex",
        ),
        ("4", "Fictional Marker Retrieval Study Alpha", "", "https://example.invalid/delta", "s2"),
    ]
    assert rows[1]["published_date"] == "2026-04-02"
    assert rows[1]["pdf_url"] == "https://example.invalid/beta.pdf"


def test_csv_identity_output_is_deterministic(tmp_path: Path):
    exp = CSVExporter({"enabled": True, "dir": tmp_path, "encoding": "utf-8"})
    first = exp.export(_identity_papers())
    assert first is not None
    first_header, first_rows = _read_csv_rows(first)
    second = exp.export(_identity_papers())
    assert second is not None
    second_header, second_rows = _read_csv_rows(second)
    assert first_header == second_header
    assert first_rows == second_rows


def test_csv_does_not_mutate_input_papers(tmp_path: Path):
    papers = _identity_papers()
    before = [p.to_dict() for p in papers]
    exp = CSVExporter({"enabled": True, "dir": tmp_path, "encoding": "utf-8"})
    assert exp.export(papers) is not None
    assert [p.to_dict() for p in papers] == before


def test_json_writes_list(tmp_path: Path):
    exp = JSONExporter({"enabled": True, "dir": str(tmp_path)})
    path = exp.export(_sample_papers())
    assert path is not None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    assert len(data) == 2
    assert data[0]["uid"] == "arxiv:2604.001"
    assert data[0]["published_date"] == date.today().isoformat()


def test_json_no_papers_returns_none(tmp_path: Path):
    exp = JSONExporter({"enabled": True, "dir": str(tmp_path)})
    assert exp.export([]) is None


def test_slack_no_webhook_is_noop():
    exp = SlackExporter({"enabled": True}, webhook_url=None)
    assert exp.export(_sample_papers()) is None


def test_slack_posts_formatted_message():
    exp = SlackExporter({"enabled": True}, webhook_url="http://hook")
    resp = SimpleNamespace(status_code=200, json=lambda: {})
    with patch(
        "paperpilot.exporters.slack_exporter.request_with_retry", return_value=resp
    ) as mock:
        result = exp.export(_sample_papers())
    assert result == "slack"
    _args, kwargs = mock.call_args
    body = kwargs["json_body"]
    assert "PaperPilot" in body["text"]
    assert "T1" in body["text"]
    assert "T2" in body["text"]


def test_slack_handles_failure():
    """A non-2xx webhook response is a real failure: export() raises so the
    pipeline runner records it in run_history.errors (closes #386), rather
    than silently swallowing it and returning None."""
    exp = SlackExporter({"enabled": True}, webhook_url="http://hook")
    resp = SimpleNamespace(status_code=500, json=lambda: {})
    with patch(
        "paperpilot.exporters.slack_exporter.request_with_retry", return_value=resp
    ):
        with pytest.raises(RuntimeError, match="slack post failed"):
            exp.export(_sample_papers())


def test_slack_respects_max_items():
    papers = _sample_papers() * 10  # 20 papers
    exp = SlackExporter({"enabled": True, "max_items": 3}, webhook_url="http://hook")
    resp = SimpleNamespace(status_code=200, json=lambda: {})
    with patch(
        "paperpilot.exporters.slack_exporter.request_with_retry", return_value=resp
    ) as mock:
        exp.export(papers)
    body = mock.call_args.kwargs["json_body"]["text"]
    # Count numbered lines
    assert body.count("\n1. ") == 1
    assert body.count("\n2. ") == 1
    assert body.count("\n3. ") == 1
    assert body.count("\n4. ") == 0


# ---- the delivered count the runner reads (M-6) ----


def test_slack_reports_the_count_it_actually_delivered():
    """PipelineRunner must not re-derive max_items truncation by slicing the
    list again — the exporter reports what it posted."""
    papers = _sample_papers() * 10  # 20 papers
    exp = SlackExporter({"enabled": True, "max_items": 3}, webhook_url="http://hook")
    resp = SimpleNamespace(status_code=200, json=lambda: {})
    with patch(
        "paperpilot.exporters.slack_exporter.request_with_retry", return_value=resp
    ):
        assert exp.export(papers) == "slack"
    assert exp.last_delivered == 3


def test_slack_never_reports_a_delivery_that_did_not_happen():
    """A failed post or an unconfigured webhook delivers nothing, so the count
    must not keep the previous call's value (the runner reads it as a
    truncation otherwise)."""
    papers = _sample_papers()
    exp = SlackExporter({"enabled": True, "max_items": 1}, webhook_url="http://hook")
    ok = SimpleNamespace(status_code=200, json=lambda: {})
    with patch(
        "paperpilot.exporters.slack_exporter.request_with_retry", return_value=ok
    ):
        exp.export(papers)
    assert exp.last_delivered == 1

    bad = SimpleNamespace(status_code=500, json=lambda: {})
    with patch(
        "paperpilot.exporters.slack_exporter.request_with_retry", return_value=bad
    ):
        with pytest.raises(RuntimeError, match="slack post failed"):
            exp.export(papers)
    assert exp.last_delivered == 0

    unconfigured = SlackExporter({"enabled": True}, webhook_url=None)
    assert unconfigured.export(papers) is None
    assert unconfigured.last_delivered == 0


def test_email_reports_the_count_it_actually_delivered():
    from paperpilot.exporters.email_exporter import EmailExporter

    papers = _sample_papers() * 4  # 8 papers
    exp = EmailExporter(
        {"enabled": True, "max_items": 2},
        smtp_settings={
            "server": "smtp.example.com",
            "port": 587,
            "user": "me",
            "password": "pass",
            "to": "inbox@example.com",
        },
    )
    fake_smtp = MagicMock()
    with patch(
        "paperpilot.exporters.email_exporter.smtplib.SMTP", return_value=fake_smtp
    ):
        assert exp.export(papers) == "email"
    assert exp.last_delivered == 2


def test_email_reports_no_delivery_when_smtp_fails():
    from paperpilot.exporters.email_exporter import EmailExporter

    papers = _sample_papers()
    exp = EmailExporter(
        {"enabled": True, "max_items": 10},
        smtp_settings={
            "server": "smtp.example.com",
            "to": "inbox@example.com",
        },
    )
    fake_smtp = MagicMock()
    fake_smtp.send_message.side_effect = smtplib.SMTPException("rejected")
    with patch(
        "paperpilot.exporters.email_exporter.smtplib.SMTP", return_value=fake_smtp
    ):
        with pytest.raises(smtplib.SMTPException):
            exp.export(papers)
    assert exp.last_delivered == 0


def test_file_exporters_do_not_report_a_truncated_delivery(tmp_path):
    """CSV/JSON write every paper, so they leave the tally unset (None) — a 0
    there would make the runner warn about papers it actually exported."""
    exp = CSVExporter({"enabled": True, "dir": str(tmp_path), "encoding": "utf-8"})
    assert exp.export(_sample_papers()) is not None
    assert exp.last_delivered is None

    json_exp = JSONExporter({"enabled": True, "dir": str(tmp_path)})
    assert json_exp.export(_sample_papers()) is not None
    assert json_exp.last_delivered is None


def test_slack_escapes_mrkdwn_special_chars_in_title_and_venue():
    """Regression test (closes #397): a paper title/venue containing Slack
    mrkdwn special characters must not break the <url|text> link syntax or
    inject formatting/fake links."""
    malicious = [
        Paper(
            title="A <malicious|link> & <https://evil.example|click here>",
            authors=["A"],
            abstract="abs",
            url="http://x/1?a=1&b=2",
            published_date=date.today(),
            source="arxiv",
            arxiv_id="2604.001",
            total_score=100.0,
            venue="<Fake Venue>",
        )
    ]
    exp = SlackExporter({"enabled": True}, webhook_url="http://hook")
    resp = SimpleNamespace(status_code=200, json=lambda: {})
    with patch(
        "paperpilot.exporters.slack_exporter.request_with_retry", return_value=resp
    ) as mock:
        exp.export(malicious)
    body = mock.call_args.kwargs["json_body"]["text"]
    assert "<malicious|link>" not in body
    assert "<https://evil.example|click here>" not in body
    assert "<Fake Venue>" not in body
    assert "&lt;malicious|link&gt;" in body
    assert "&lt;Fake Venue&gt;" in body
    assert "&amp;" in body  # the raw "&" in the title/url got escaped too


def test_slack_url_control_sequence_injection_is_neutralized():
    """Regression test (closes #397 follow-up): escaping &/</> alone does
    not stop Slack's <...|...> control-sequence syntax — the FIRST
    character inside the brackets (!, @, #) selects @here / user-mention /
    channel-mention regardless of escaping. A non-http(s) paper.url must
    never be placed in that position; the exporter must fall back to plain
    text instead of building a link."""
    malicious_urls = ["!here", "@U0123456789", "#C0123456789", "javascript:alert(1)"]
    papers = [
        Paper(
            title=f"Paper {i}",
            authors=["A"],
            abstract="abs",
            url=u,
            published_date=date.today(),
            source="arxiv",
            arxiv_id=f"2604.00{i}",
            total_score=100.0,
        )
        for i, u in enumerate(malicious_urls)
    ]
    exp = SlackExporter({"enabled": True}, webhook_url="http://hook")
    resp = SimpleNamespace(status_code=200, json=lambda: {})
    with patch(
        "paperpilot.exporters.slack_exporter.request_with_retry", return_value=resp
    ) as mock:
        exp.export(papers)
    body = mock.call_args.kwargs["json_body"]["text"]
    for u in malicious_urls:
        assert f"<{u}|" not in body
    # Titles must still render as plain text (no link wrapper at all).
    for i in range(len(malicious_urls)):
        assert f"Paper {i}" in body


def test_slack_legitimate_https_url_still_renders_as_link():
    """A normal http(s) url must still produce the <url|title> link."""
    papers = [
        Paper(
            title="Legit Paper",
            authors=["A"],
            abstract="abs",
            url="https://arxiv.org/abs/2604.00001",
            published_date=date.today(),
            source="arxiv",
            arxiv_id="2604.00001",
            total_score=100.0,
        )
    ]
    exp = SlackExporter({"enabled": True}, webhook_url="http://hook")
    resp = SimpleNamespace(status_code=200, json=lambda: {})
    with patch(
        "paperpilot.exporters.slack_exporter.request_with_retry", return_value=resp
    ) as mock:
        exp.export(papers)
    body = mock.call_args.kwargs["json_body"]["text"]
    assert "<https://arxiv.org/abs/2604.00001|Legit Paper>" in body


def test_csv_neutralizes_spreadsheet_formula_payloads(tmp_path):
    """CSV quoting does not stop Excel/LibreOffice from evaluating a cell
    that starts with = + - @ — paper metadata is untrusted upstream text,
    so those cells get an OWASP single-quote prefix."""
    import csv as _csv

    from paperpilot.exporters.csv_exporter import CSVExporter

    papers = _sample_papers()
    papers[0].title = '=HYPERLINK("http://evil.example","click")'
    papers[0].abstract = "@SUM(1+1)*cmd"

    exp = CSVExporter({"enabled": True, "dir": str(tmp_path), "encoding": "utf-8"})
    path = exp.export(papers)

    with open(path, encoding="utf-8", newline="") as f:
        rows = list(_csv.DictReader(f))
    assert rows[0]["title"].startswith("'=HYPERLINK")
    assert rows[0]["abstract"].startswith("'@SUM")


def test_csv_leaves_ordinary_text_untouched(tmp_path):
    """Only cells that actually begin with a trigger are rewritten, so the
    downstream readers (build_summary_csv / build_pages) still see the
    original strings for normal papers."""
    import csv as _csv

    from paperpilot.exporters.csv_exporter import CSVExporter

    papers = _sample_papers()
    papers[0].title = "Retrieval-Augmented Generation for Knowledge Tasks"
    papers[0].abstract = "We propose a method."

    exp = CSVExporter({"enabled": True, "dir": str(tmp_path), "encoding": "utf-8"})
    path = exp.export(papers)

    with open(path, encoding="utf-8", newline="") as f:
        rows = list(_csv.DictReader(f))
    assert rows[0]["title"] == "Retrieval-Augmented Generation for Knowledge Tasks"
    assert rows[0]["abstract"] == "We propose a method."


# ---- crash-safe replacement of the published files ----


def test_csv_export_failure_leaves_the_existing_file_untouched(tmp_path, monkeypatch):
    """Regression test: building the CSV must not truncate yesterday's output.

    ``open(path, "w")`` empties the destination before the first row is written, so
    any failure mid-export left a partial or empty papers_<date>.csv behind — and
    build_summary_csv / build_pages read that file next. The rows are now rendered
    in memory and the file is replaced by rename, so a failing row leaves the
    published bytes alone.
    """
    import paperpilot.exporters.csv_exporter as csv_module

    exp = CSVExporter({"enabled": True, "dir": str(tmp_path), "encoding": "utf-8"})
    path = exp.export(_sample_papers())
    assert path is not None
    original_bytes = Path(path).read_bytes()

    def _boom(*_args, **_kwargs):
        raise OSError("row build failed")

    monkeypatch.setattr(csv_module, "neutralize_row", _boom)
    with pytest.raises(OSError, match="row build failed"):
        exp.export(_sample_papers())

    assert Path(path).read_bytes() == original_bytes
    assert [p.name for p in tmp_path.iterdir()] == [Path(path).name]


def test_json_export_failure_leaves_the_existing_file_untouched(tmp_path, monkeypatch):
    """Same contract for the JSON side: a record that cannot be serialised must
    not cost the run its previously published papers_<date>.json."""
    import paperpilot.exporters.json_exporter as json_module

    exp = JSONExporter({"enabled": True, "dir": str(tmp_path)})
    path = exp.export(_sample_papers())
    assert path is not None
    original_bytes = Path(path).read_bytes()

    def _boom(*_args, **_kwargs):
        raise OSError("serializing failed")

    monkeypatch.setattr(json_module.json, "dumps", _boom)
    with pytest.raises(OSError, match="serializing failed"):
        exp.export(_sample_papers())

    assert Path(path).read_bytes() == original_bytes
    assert [p.name for p in tmp_path.iterdir()] == [Path(path).name]


def test_json_export_survives_a_failed_rename(tmp_path, monkeypatch):
    """The rename is the last step, so a failure there is the one that used to
    leave a torn file: the temp must be cleaned up and the original kept."""
    import paperpilot.utils.atomic as atomic_module

    exp = JSONExporter({"enabled": True, "dir": str(tmp_path)})
    path = exp.export(_sample_papers())
    assert path is not None
    original_bytes = Path(path).read_bytes()

    def _boom(*_args, **_kwargs):
        raise OSError("rename failed")

    monkeypatch.setattr(atomic_module.os, "replace", _boom)
    with pytest.raises(OSError, match="rename failed"):
        exp.export(_sample_papers())

    assert Path(path).read_bytes() == original_bytes
    assert [p.name for p in tmp_path.iterdir()] == [Path(path).name]


# ---- same-day re-export must not clobber an earlier same-day export (M-2) ----


def _papers_with_titles(*titles: str) -> list[Paper]:
    papers = []
    for i, title in enumerate(titles):
        papers.append(
            Paper(
                title=title,
                authors=["A"],
                abstract="abs",
                url=f"http://x/{i}",
                published_date=date.today(),
                source="arxiv",
                arxiv_id=f"2604.{i:03d}",
                total_score=float(i),
            )
        )
    return papers


def test_csv_first_export_of_the_day_uses_the_plain_name(tmp_path: Path):
    exp = CSVExporter({"enabled": True, "dir": str(tmp_path), "encoding": "utf-8"})
    path = exp.export(_papers_with_titles("H1"))
    assert path is not None
    assert Path(path).name == f"papers_{date.today().isoformat()}.csv"


def test_csv_second_same_day_export_with_disjoint_papers_keeps_both_files(
    tmp_path: Path,
):
    """Regression test (M-2): a same-day re-dispatch after a red
    `--fail-on-errors` run must not overwrite the first run's CSV — both
    runs' papers must stay readable on disk."""
    exp = CSVExporter({"enabled": True, "dir": str(tmp_path), "encoding": "utf-8"})
    first_path = exp.export(_papers_with_titles("H1"))
    second_path = exp.export(_papers_with_titles("H2"))
    assert first_path is not None
    assert second_path is not None
    assert first_path != second_path

    _, first_rows = _read_csv_rows(first_path)
    _, second_rows = _read_csv_rows(second_path)
    assert [r["title"] for r in first_rows] == ["H1"]
    assert [r["title"] for r in second_rows] == ["H2"]

    # Both files are still on disk, independently of each other.
    assert Path(first_path).exists()
    assert Path(second_path).exists()
    assert {p.name for p in tmp_path.iterdir()} == {
        Path(first_path).name,
        Path(second_path).name,
    }


def test_csv_third_same_day_export_does_not_clobber_the_second(
    tmp_path: Path, monkeypatch
):
    """Even if two re-exports land in the same wall-clock second (so the
    HHMMSS stamp collides too), the second re-export must get its own name
    rather than overwrite the first re-export.

    (L-3) The fixed clock is naive local time, not UTC: the date and the
    HHMMSS suffix now both come from the SAME `datetime.now()` call, so even
    the plain (first) export's date is pinned to this fixed clock, and the
    suffix carries no trailing `Z` since it is no longer UTC.
    """
    import paperpilot.exporters.csv_exporter as csv_module

    fixed_now = datetime(2026, 1, 1, 12, 0, 0)

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed_now

    monkeypatch.setattr(csv_module, "datetime", _FixedDatetime)

    exp = CSVExporter({"enabled": True, "dir": str(tmp_path), "encoding": "utf-8"})
    first_path = exp.export(_papers_with_titles("H1"))
    second_path = exp.export(_papers_with_titles("H2"))
    third_path = exp.export(_papers_with_titles("H3"))

    assert first_path is not None and second_path is not None and third_path is not None
    assert len({first_path, second_path, third_path}) == 3
    assert Path(first_path).name == "papers_2026-01-01.csv"
    assert Path(second_path).name == "papers_2026-01-01-120000.csv"
    assert Path(third_path).name == "papers_2026-01-01-120000-2.csv"

    for p in (first_path, second_path, third_path):
        assert Path(p).exists()


def test_csv_export_return_value_is_the_path_actually_written(tmp_path: Path):
    """The runner uses the return value as the delivery signal (M-6 /
    pipeline/runner.py), so it must name the file that was really written,
    not a stale/plain guess."""
    exp = CSVExporter({"enabled": True, "dir": str(tmp_path), "encoding": "utf-8"})
    exp.export(_papers_with_titles("H1"))
    second_path = exp.export(_papers_with_titles("H2"))
    assert second_path is not None
    assert Path(second_path).read_bytes()  # the returned path is readable
    _, rows = _read_csv_rows(second_path)
    assert [r["title"] for r in rows] == ["H2"]


def test_json_first_export_of_the_day_uses_the_plain_name(tmp_path: Path):
    exp = JSONExporter({"enabled": True, "dir": str(tmp_path)})
    path = exp.export(_papers_with_titles("H1"))
    assert path is not None
    assert Path(path).name == f"papers_{date.today().isoformat()}.json"


def test_json_second_same_day_export_with_disjoint_papers_keeps_both_files(
    tmp_path: Path,
):
    exp = JSONExporter({"enabled": True, "dir": str(tmp_path)})
    first_path = exp.export(_papers_with_titles("H1"))
    second_path = exp.export(_papers_with_titles("H2"))
    assert first_path is not None
    assert second_path is not None
    assert first_path != second_path

    with open(first_path, encoding="utf-8") as f:
        first_data = json.load(f)
    with open(second_path, encoding="utf-8") as f:
        second_data = json.load(f)
    assert [r["title"] for r in first_data] == ["H1"]
    assert [r["title"] for r in second_data] == ["H2"]
    assert Path(first_path).exists()
    assert Path(second_path).exists()


def test_json_third_same_day_export_does_not_clobber_the_second(
    tmp_path: Path, monkeypatch
):
    """(L-3) Same fixed-clock contract as the CSV counterpart: one naive local
    `datetime.now()` drives both the date and the HHMMSS suffix, so the first
    export's date is pinned too, and the suffix carries no trailing `Z`."""
    import paperpilot.exporters.json_exporter as json_module

    fixed_now = datetime(2026, 1, 1, 12, 0, 0)

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed_now

    monkeypatch.setattr(json_module, "datetime", _FixedDatetime)

    exp = JSONExporter({"enabled": True, "dir": str(tmp_path)})
    first_path = exp.export(_papers_with_titles("H1"))
    second_path = exp.export(_papers_with_titles("H2"))
    third_path = exp.export(_papers_with_titles("H3"))

    assert first_path is not None and second_path is not None and third_path is not None
    assert len({first_path, second_path, third_path}) == 3
    assert Path(first_path).name == "papers_2026-01-01.json"
    assert Path(second_path).name == "papers_2026-01-01-120000.json"
    assert Path(third_path).name == "papers_2026-01-01-120000-2.json"
    for p in (first_path, second_path, third_path):
        assert Path(p).exists()


def test_csv_export_keeps_the_utf8_sig_bom(tmp_path):
    """The default encoding is utf-8-sig (Excel needs the BOM) and the bytes must
    stay identical now that the text is encoded from a StringIO buffer."""
    exp = CSVExporter({"enabled": True, "dir": str(tmp_path)})
    path = exp.export(_sample_papers())
    assert path is not None
    raw = Path(path).read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")
    assert raw.endswith(b"\r\n")
    lines = raw[len(b"\xef\xbb\xbf") :].decode("utf-8").splitlines()
    assert lines[0].startswith("rank,total_score,")
    assert lines[1].startswith("1,100.0,")

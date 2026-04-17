"""CSV / JSON / Slack exporter tests."""

from __future__ import annotations

import csv
import json
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

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
    args, kwargs = mock.call_args
    body = kwargs["json_body"]
    assert "PaperPilot" in body["text"]
    assert "T1" in body["text"]
    assert "T2" in body["text"]


def test_slack_handles_failure():
    exp = SlackExporter({"enabled": True}, webhook_url="http://hook")
    resp = SimpleNamespace(status_code=500, json=lambda: {})
    with patch(
        "paperpilot.exporters.slack_exporter.request_with_retry", return_value=resp
    ):
        result = exp.export(_sample_papers())
    assert result is None


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

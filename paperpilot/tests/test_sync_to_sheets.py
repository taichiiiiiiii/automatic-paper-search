"""Tests for paperpilot/scripts/sync_to_sheets.py.

All Google API calls are mocked — the tests never talk to the network
or require gspread / google-auth to be installed.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from paperpilot.scripts import sync_to_sheets as s2s


# ---- load_rows ----


def test_load_rows_splits_header_and_data(tmp_path: Path):
    csv_path = tmp_path / "summary.csv"
    csv_path.write_text(
        "title,type,tags\nPaper A,Oral,LLM\nPaper B,Poster,RL\n",
        encoding="utf-8",
    )
    header, rows = s2s.load_rows(csv_path)
    assert header == ["title", "type", "tags"]
    assert rows == [["Paper A", "Oral", "LLM"], ["Paper B", "Poster", "RL"]]


def test_load_rows_empty_body(tmp_path: Path):
    csv_path = tmp_path / "summary.csv"
    csv_path.write_text("title,type,tags\n", encoding="utf-8")
    header, rows = s2s.load_rows(csv_path)
    assert header == ["title", "type", "tags"]
    assert rows == []


# ---- open_or_create_sheet ----


def test_open_or_create_sheet_reuses_existing_by_id():
    client = MagicMock()
    existing = MagicMock()
    client.open_by_key.return_value = existing
    client.create.side_effect = AssertionError("create must not be called")

    sh = s2s.open_or_create_sheet(client, sheet_id="abc123", title="ignored", share_email=None)
    assert sh is existing
    client.open_by_key.assert_called_once_with("abc123")


def test_open_or_create_sheet_creates_when_id_missing():
    client = MagicMock()
    new_sheet = MagicMock()
    client.create.return_value = new_sheet

    sh = s2s.open_or_create_sheet(client, sheet_id=None, title="PaperPilot X", share_email=None)
    assert sh is new_sheet
    client.create.assert_called_once_with("PaperPilot X")
    # Share not called when email is absent
    new_sheet.share.assert_not_called()


def test_open_or_create_sheet_shares_when_email_given():
    client = MagicMock()
    new_sheet = MagicMock()
    client.create.return_value = new_sheet

    s2s.open_or_create_sheet(client, sheet_id=None, title="T", share_email="me@example.com")
    new_sheet.share.assert_called_once_with(
        "me@example.com", perm_type="user", role="writer"
    )


# ---- get_or_create_worksheet ----


def test_get_or_create_worksheet_reuses_and_clears_existing():
    sh = MagicMock()
    ws = MagicMock()
    sh.worksheet.return_value = ws

    out = s2s.get_or_create_worksheet(sh, "summary", rows=10, cols=3)
    assert out is ws
    ws.clear.assert_called_once()
    ws.resize.assert_called_once_with(rows=10, cols=3)
    sh.add_worksheet.assert_not_called()


def test_get_or_create_worksheet_adds_when_missing():
    sh = MagicMock()
    sh.worksheet.side_effect = Exception("not found")
    added = MagicMock()
    sh.add_worksheet.return_value = added

    out = s2s.get_or_create_worksheet(sh, "summary", rows=10, cols=3)
    assert out is added
    sh.add_worksheet.assert_called_once_with(title="summary", rows=10, cols=3)


def test_get_or_create_worksheet_enforces_minimum_dims():
    sh = MagicMock()
    sh.worksheet.side_effect = Exception("missing")

    s2s.get_or_create_worksheet(sh, "x", rows=0, cols=0)
    # Google Sheets refuses 0x0 sheets; helper must bump to at least 2x1.
    call = sh.add_worksheet.call_args
    assert call.kwargs["rows"] >= 2
    assert call.kwargs["cols"] >= 1


# ---- apply_formatting ----


def test_apply_formatting_sets_header_and_freezes_row():
    ws = MagicMock()
    header = ["title", "type", "tags"]
    rows = [["A", "Oral", "LLM"], ["B", "Poster", "RL"]]

    s2s.apply_formatting(ws, header, rows)

    # Header format call has bold + gray background
    header_call = ws.format.call_args_list[0]
    assert header_call.args[0] == "A1:C1"
    assert header_call.args[1]["textFormat"]["bold"] is True
    ws.freeze.assert_called_once_with(rows=1)


def test_apply_formatting_highlights_oral_rows():
    ws = MagicMock()
    header = ["title", "type", "tags"]
    rows = [
        ["A", "Oral", "LLM"],     # row 2
        ["B", "Poster", "RL"],    # row 3 — not highlighted
        ["C", "Oral", "Vision"],  # row 4
    ]

    s2s.apply_formatting(ws, header, rows)

    formatted_ranges = [call.args[0] for call in ws.format.call_args_list]
    # First call is header. Remaining are Oral rows.
    assert "A2:C2" in formatted_ranges
    assert "A4:C4" in formatted_ranges
    assert "A3:C3" not in formatted_ranges


def test_apply_formatting_no_type_column_skips_highlight():
    ws = MagicMock()
    header = ["title", "tags"]
    rows = [["A", "LLM"]]

    s2s.apply_formatting(ws, header, rows)
    # Only the header format call — no row highlights
    assert ws.format.call_count == 1

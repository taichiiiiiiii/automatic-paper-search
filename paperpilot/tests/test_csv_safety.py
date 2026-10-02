"""Tests for paperpilot/utils/csv_safety.py.

The prefix that stops a formula-looking cell from executing in a spreadsheet is not
part of the text, and these CSVs are read back — collector CSV -> summary.csv ->
papers.json — so the pair has to round-trip. These tests cover:
    - neutralize prefixes only a cell that opens with a trigger character
    - unneutralize is the exact inverse for whatever neutralize produced
    - a genuine leading apostrophe survives both steps
    - only one prefix is ever removed
    - neutralize_row leaves non-string cells alone
"""

from __future__ import annotations

import pytest

from paperpilot.utils.csv_safety import FORMULA_TRIGGERS, neutralize, neutralize_row, unneutralize

# One value per trigger, plus ordinary catalog text, an URL, the empty cell a short CSV
# row produces, and a title that really does open with an apostrophe.
SAMPLES = [
    "-Deep nets",
    '=SUM(1,2),"http://evil"',
    "+44 7700 900000",
    "@SUM(1)",
    "\ttabbed title",
    "\rCR title",
    "Attention Is All You Need",
    "https://arxiv.org/abs/2404.00001",
    "2026-04-18",
    "",
    "'Deep nets revisited",
]


@pytest.mark.parametrize("value", SAMPLES)
def test_unneutralize_inverts_neutralize(value: str) -> None:
    assert unneutralize(neutralize(value)) == value


@pytest.mark.parametrize("trigger", FORMULA_TRIGGERS)
def test_every_trigger_is_prefixed_and_removed(trigger: str) -> None:
    value = f"{trigger}cell"
    assert neutralize(value) == f"'{value}"
    assert unneutralize(f"'{value}") == value


def test_neutralize_leaves_ordinary_cells_exactly_as_read() -> None:
    for value in ("Attention Is All You Need", "https://arxiv.org/abs/2404.00001", "", "2026"):
        assert neutralize(value) == value


def test_a_genuine_leading_apostrophe_survives_both_steps() -> None:
    """A title may open with an apostrophe; that is content, not a guard.

    Only a quote followed by a trigger is the shape neutralize writes, so
    "'Deep nets" is neither prefixed nor stripped.
    """
    title = "'Deep nets"
    assert neutralize(title) == title
    assert unneutralize(title) == title


def test_only_one_prefix_is_removed() -> None:
    # neutralize never prefixes a value that already opens with "'", so a doubled quote
    # is content — and stripping one prefix cannot uncover a second formula prefix.
    assert unneutralize("''=SUM(1)") == "''=SUM(1)"
    assert unneutralize(neutralize(neutralize("=x"))) == "=x"


def test_an_apostrophe_anywhere_else_is_untouched() -> None:
    assert unneutralize("Don't - stop") == "Don't - stop"
    assert unneutralize("'") == "'"
    assert unneutralize("") == ""


def test_a_quote_followed_by_a_trigger_is_read_as_a_guard_prefix() -> None:
    """The one ambiguity in the scheme, resolved in the direction neutralize writes.

    A cell starting "'=..." is what neutralize produces from "=...", so a reader that
    had to keep it would re-publish the guard as part of the title.
    """
    assert unneutralize("'=SUM(1)") == "=SUM(1)"


def test_neutralize_row_leaves_non_string_cells_alone() -> None:
    row = {"title": "-Deep nets", "citation_count": 3, "missing": None}
    assert neutralize_row(row) == {
        "title": "'-Deep nets",
        "citation_count": 3,
        "missing": None,
    }

"""Spreadsheet-formula neutralization for CSV output.

Excel, LibreOffice and Google Sheets evaluate a cell as a formula when its
text begins with one of a few characters, no matter how the CSV itself is
quoted. Paper titles, abstracts, author lists and comments are untrusted
upstream text (arXiv, OpenReview, CVF, ACL Anthology, S2, OpenAlex), so a
title like ``=HYPERLINK("http://attacker","click")`` would execute in the
recipient's spreadsheet session — CWE-1236.

This lives in one place on purpose. The exporter and the conference
collectors write different CSVs from the same untrusted fields, and fixing
only one of them is how the gap was introduced in the first place.

These CSVs are also read back — ``build_summary_csv`` turns the collector CSV into
summary.csv and ``build_pages`` turns that into the published catalog — so
:func:`unneutralize` is the matching removal step: the prefix guards the
spreadsheet and must never become catalog text.
"""

from __future__ import annotations

from typing import TypeVar

# A leading tab or CR also lets a spreadsheet re-interpret the cell.
FORMULA_TRIGGERS = ("=", "+", "-", "@", "\t", "\r")

T = TypeVar("T")


def neutralize(value: str) -> str:
    """Prefix a single quote when a cell would otherwise start a formula.

    Only values that actually begin with a trigger are touched, so ordinary
    titles, abstracts and URLs are written exactly as they were read; a
    neutralized cell is NOT the original text any more and needs
    :func:`unneutralize` to round-trip back through the readers that parse
    these files (build_summary_csv / build_pages).
    """
    return f"'{value}" if value.startswith(FORMULA_TRIGGERS) else value


def unneutralize(value: str) -> str:
    """Drop the guard prefix :func:`neutralize` added — its exact inverse.

    ``neutralize`` only ever prefixes a value that opens with a trigger, so a
    leading quote followed by a trigger is exactly what neutralize produced and
    is not part of the text: a cell ``"'-Deep nets"`` is the paper called
    ``"-Deep nets"``. The prefix belongs to the spreadsheet; the readers that
    feed papers.json, paper-links.html and the search index must not publish it
    as part of a title.

    A quote followed by anything else is genuine content ("'Deep nets
    revisited") and is left alone. Only one prefix is ever removed. A value that
    already opened with a quote and then a trigger ("'=SUM(1)") is
    indistinguishable from a neutralized cell and loses its quote — the one
    ambiguity the scheme has, resolved in favour of the shape only
    ``neutralize`` writes.
    """
    if value.startswith("'") and value[1:2].startswith(FORMULA_TRIGGERS):
        return value[1:]
    return value


def neutralize_row(row: dict[str, T]) -> dict[str, T | str]:
    """Apply :func:`neutralize` to every string cell of a CSV row."""
    return {k: neutralize(v) if isinstance(v, str) else v for k, v in row.items()}

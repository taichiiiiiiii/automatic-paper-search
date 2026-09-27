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
"""

from __future__ import annotations

from typing import TypeVar

# A leading tab or CR also lets a spreadsheet re-interpret the cell.
FORMULA_TRIGGERS = ("=", "+", "-", "@", "\t", "\r")

T = TypeVar("T")


def neutralize(value: str) -> str:
    """Prefix a single quote when a cell would otherwise start a formula.

    Only values that actually begin with a trigger are touched, so ordinary
    titles, abstracts and URLs round-trip byte-for-byte through the readers
    that parse these files back (build_summary_csv / build_pages).
    """
    return f"'{value}" if value.startswith(FORMULA_TRIGGERS) else value


def neutralize_row(row: dict[str, T]) -> dict[str, T | str]:
    """Apply :func:`neutralize` to every string cell of a CSV row."""
    return {k: neutralize(v) if isinstance(v, str) else v for k, v in row.items()}

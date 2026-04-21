"""Shared helpers for paperpilot/scripts/*.

Kept deliberately small: this module exists so build_lineage.py and
sync_to_sheets.py don't duplicate the conference-slug -> venue-label
conversion. Anything here must be safe to import without pulling in
heavy deps (no gspread, no sentence-transformers, no torch).
"""

from __future__ import annotations


def slug_to_venue_label(conference: str) -> str:
    """Turn a conference slug ("iclr-2026") into the viewer's venue label ("ICLR 2026").

    Acronym casing is not preserved ("neurips-2025" -> "NEURIPS 2025")
    because the slug has lost that information. Callers that need the
    cased form should pass --venue-override / --title explicitly.
    """
    return conference.upper().replace("-", " ")

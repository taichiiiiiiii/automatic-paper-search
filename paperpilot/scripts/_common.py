"""Shared helpers for paperpilot/scripts/*.

Kept deliberately small: this module exists so build_lineage.py and
sync_to_sheets.py don't duplicate the conference-slug -> venue-label
conversion. Anything here must be safe to import without pulling in
heavy deps (no gspread, no sentence-transformers, no torch).
"""

from __future__ import annotations

import re
import unicodedata

_SLUG_MAX_LEN = 64
# Same character class enforced client-side by theme.js's SLUG_RE.
# Centralised so any drift between server-emitted slugs and the
# client-side validator surfaces as a unit-test failure.
_SLUG_ALLOWED_RE = re.compile(r"[^a-z0-9]+")


def slug_to_venue_label(conference: str) -> str:
    """Turn a conference slug ("iclr-2026") into the viewer's venue label ("ICLR 2026").

    Acronym casing is not preserved ("neurips-2025" -> "NEURIPS 2025")
    because the slug has lost that information. Callers that need the
    cased form should pass --venue-override / --title explicitly.
    """
    return conference.upper().replace("-", " ")


def theme_slug(label: str) -> str:
    """Normalise a free-text theme label into a URL- and filesystem-safe slug.

    Why: themes come from CLI free text (`--theme "Mixture of Experts"`) and
    flow into both filesystem paths (`docs/themes/<slug>/lineage.json`) and
    URL params (`?theme=<slug>`). The slug is the only sanitisation gate.
    Path traversal probes (`../../etc/passwd`), unicode shenanigans, and
    over-long inputs all collapse to a safe ASCII identifier or raise.

    Algorithm:
      1. NFKD-normalise, encode ASCII (errors=ignore) — strips combining
         marks and rejects characters with no ASCII fallback (e.g. CJK).
      2. Lowercase, replace any run of non-[a-z0-9] with a single hyphen.
      3. Trim leading/trailing hyphens.
      4. Cap to 64 characters; trim trailing hyphen left by the cut.

    Raises:
        ValueError: input is empty/whitespace-only OR collapses to an
        empty slug after normalisation. Filesystem paths and URL params
        constructed from the slug must never be empty.
    """
    if not label or not label.strip():
        raise ValueError("theme_slug: label must be non-empty")

    normalised = (
        unicodedata.normalize("NFKD", label)
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    slug = _SLUG_ALLOWED_RE.sub("-", normalised.lower()).strip("-")
    if len(slug) > _SLUG_MAX_LEN:
        slug = slug[:_SLUG_MAX_LEN].rstrip("-")
    if not slug:
        raise ValueError(f"theme_slug: derived slug is empty for input: {label!r}")
    return slug

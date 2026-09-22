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


_CONFERENCE_SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
# "daily" is paperpilot/output/daily/ (config.daily-watch.yaml's own output
# dir, not a conference). Kept as a local literal rather than importing
# build_pages.NON_CONFERENCE to avoid a layering inversion (_common.py must
# stay import-light per the module docstring); build_pages.py's own
# NON_CONFERENCE serves the same purpose for docs/ routing — keep both in
# sync if either set ever grows.
_RESERVED_CONFERENCE_SLUGS = {"daily"}


def validate_conference_slug(conference: str) -> str:
    """Validate that a `--conference` CLI value is already a safe slug.

    Unlike theme_slug() (which *transforms* free text into a slug), a
    conference slug is provided directly by the operator/workflow
    (`--conference cvpr-2026`) and is path-joined as-is into output
    directories (`output/<conference>/...`, `docs/<conference>/...` via
    collect_conference.write_outputs, shared by collect_cvf.py /
    collect_acl_anthology.py / collect_openreview.py). It must be REJECTED
    outright if it isn't already slug-shaped, not silently coerced — both
    to close path traversal (`../../etc`) and because coercing would mask
    an operator typo instead of failing loudly.
    """
    if (
        not conference
        or len(conference) > _SLUG_MAX_LEN
        # fullmatch, not match: `$` in the compiled pattern would otherwise
        # also match just before a trailing newline, letting "cvpr-2026\n"
        # (not slug-shaped) through.
        or not _CONFERENCE_SLUG_RE.fullmatch(conference)
        or conference in _RESERVED_CONFERENCE_SLUGS
    ):
        raise ValueError(
            f"invalid --conference value: {conference!r} "
            "(must match [a-z0-9]+(-[a-z0-9]+)*, e.g. 'cvpr-2026', "
            f"max {_SLUG_MAX_LEN} chars, and not a reserved name "
            f"{sorted(_RESERVED_CONFERENCE_SLUGS)})"
        )
    return conference


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

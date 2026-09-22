"""Tests for shared helpers used by paperpilot/scripts/*."""

from __future__ import annotations

import pytest

from paperpilot.scripts._common import (
    slug_to_venue_label,
    theme_slug,
    validate_conference_slug,
)


def test_slug_to_venue_label_iclr():
    assert slug_to_venue_label("iclr-2026") == "ICLR 2026"


def test_slug_to_venue_label_preserves_year():
    assert slug_to_venue_label("neurips-2025") == "NEURIPS 2025"


def test_slug_to_venue_label_handles_multiple_dashes():
    # "emnlp-findings-2025" -> "EMNLP FINDINGS 2025"
    assert slug_to_venue_label("emnlp-findings-2025") == "EMNLP FINDINGS 2025"


def test_slug_to_venue_label_empty_input():
    assert slug_to_venue_label("") == ""


# ---- theme_slug ----


def test_theme_slug_basic():
    assert theme_slug("Mixture of Experts") == "mixture-of-experts"


def test_theme_slug_lowercases():
    assert theme_slug("DPO") == "dpo"


def test_theme_slug_collapses_repeated_separators():
    assert theme_slug("RAG // dense retrieval") == "rag-dense-retrieval"


def test_theme_slug_strips_leading_and_trailing_hyphens():
    # "  -- foo --  " should not produce "-foo-"
    assert theme_slug("  -- foo --  ") == "foo"


def test_theme_slug_strips_special_characters():
    # Path-traversal probes collapse to safe ascii — never produce ".." or "/"
    slug = theme_slug("../../etc/passwd")
    assert "/" not in slug
    assert ".." not in slug
    assert slug == "etc-passwd"


def test_theme_slug_unicode_is_normalized_or_rejected():
    # Japanese has no ASCII fallback; result is empty after NFKD ASCII strip,
    # so the function must raise rather than silently return "" or "uncategorized".
    with pytest.raises(ValueError):
        theme_slug("混合エキスパート")


def test_theme_slug_unicode_with_ascii_fallback():
    # Latin-1 supplement chars NFKD-decompose to ASCII (é → e).
    assert theme_slug("Café Latté") == "cafe-latte"


def test_theme_slug_caps_length_to_64():
    very_long = "alpha " * 200  # ~1200 chars
    slug = theme_slug(very_long)
    assert len(slug) <= 64
    # The cap must not leave a trailing hyphen.
    assert not slug.endswith("-")


def test_theme_slug_empty_input_raises():
    with pytest.raises(ValueError):
        theme_slug("")


def test_theme_slug_whitespace_only_raises():
    with pytest.raises(ValueError):
        theme_slug("   \t\n  ")


def test_theme_slug_pure_punctuation_raises():
    # No alphanumeric content → would yield empty slug → reject.
    with pytest.raises(ValueError):
        theme_slug("!!!---///")


# ---- validate_conference_slug ----


def test_validate_conference_slug_accepts_valid_slugs():
    for good in ("cvpr-2026", "iclr-2026", "emnlp-findings-2025", "acl2025", "a"):
        assert validate_conference_slug(good) == good


def test_validate_conference_slug_rejects_path_traversal():
    """Regression test (closes #390)."""
    for bad in ("../../etc/passwd", "..", "/etc/passwd", "cvpr/../escape", "a/b"):
        with pytest.raises(ValueError):
            validate_conference_slug(bad)


def test_validate_conference_slug_rejects_non_slug_shapes():
    for bad in ("", "CVPR-2026", "cvpr 2026", "cvpr_2026", "-cvpr", "cvpr-", "cvpr--2026"):
        with pytest.raises(ValueError):
            validate_conference_slug(bad)


def test_validate_conference_slug_rejects_trailing_newline():
    """Regression test (closes #390 follow-up): `re.match` with a `$`-
    anchored pattern also matches just before a trailing newline, so
    "cvpr-2026\n" would incorrectly pass a `.match()`-based check even
    though it isn't slug-shaped. Must use `.fullmatch()` instead."""
    for bad in ("cvpr-2026\n", "cvpr-2026\n\n", "\ncvpr-2026"):
        with pytest.raises(ValueError):
            validate_conference_slug(bad)


def test_validate_conference_slug_rejects_reserved_name():
    """Regression test (closes #390 follow-up): "daily" is
    paperpilot/output/daily/ (the daily-watch pipeline's own output dir,
    config.daily-watch.yaml), not a conference — collect_conference.py
    writing there would corrupt/collide with the daily-watch pipeline's
    output. Mirrors build_pages.py's NON_CONFERENCE reserved-name check."""
    with pytest.raises(ValueError):
        validate_conference_slug("daily")


def test_validate_conference_slug_rejects_overlong_input():
    with pytest.raises(ValueError):
        validate_conference_slug("a" * 65)
    assert validate_conference_slug("a" * 64) == "a" * 64


def test_theme_slug_matches_url_param_regex():
    # Whatever slug we emit must satisfy the client-side SLUG_RE
    # (`^[a-z0-9-]+$`) used by theme.js for path-traversal defense.
    import re

    slug_re = re.compile(r"^[a-z0-9-]+$")
    cases = [
        "Mixture of Experts",
        "Direct Preference Optimization",
        "RLHF",
        "diffusion-models",
        "Café",
    ]
    for case in cases:
        assert slug_re.match(theme_slug(case)), f"{case!r} produced an invalid slug"

"""WCAG contrast test for `--rel-*` relation colors on site backgrounds.

Validates that all 6 relation edge colors achieve ≥ 3.0:1 contrast ratio
against each of the three site backgrounds (bg / surface / surface-2),
per WCAG 2.1 non-text contrast (graphical objects).

oklch → linear sRGB conversion is implemented from scratch using the
standard OKLab matrices — no external colour-science dependency is added.
"""

from __future__ import annotations

import math
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
STYLE_CSS = REPO_ROOT / "docs" / "assets" / "style.css"

REL_NAMES = (
    "supersedes",
    "successor",
    "extends",
    "ablation",
    "baseline",
    "contrasts",
)

BG_NAMES = (
    "color-bg",
    "color-surface",
    "color-surface-2",
)

MIN_CONTRAST = 3.0


# ---------------------------------------------------------------------------
# CSS token extraction
# ---------------------------------------------------------------------------


def _extract_oklch(css_text: str, token: str) -> tuple[float, float, float]:
    """Return (L_percent, chroma, hue) for a given `--<token>` definition.

    Parses `--<token>: oklch(<L>% <C> <H>)` (whitespace-tolerant). Raises
    if the token is absent — tests must fail loudly when a token is renamed.
    """
    pattern = re.compile(
        rf"--{re.escape(token)}\s*:\s*oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)",
        re.MULTILINE,
    )
    match = pattern.search(css_text)
    if match is None:
        raise AssertionError(f"Token --{token} not found or not in oklch form in style.css")
    return float(match.group(1)), float(match.group(2)), float(match.group(3))


# ---------------------------------------------------------------------------
# oklch → linear sRGB → relative luminance pipeline
#
# References:
# - Björn Ottosson, "A perceptual color space for image processing" (2020)
# - https://bottosson.github.io/posts/oklab/
# - WCAG 2.1 relative luminance:
#   https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
# ---------------------------------------------------------------------------


def oklch_to_linear_srgb(
    lightness_pct: float, chroma: float, hue: float
) -> tuple[float, float, float]:
    """Convert oklch(L in %, C, H in degrees) to linear sRGB in [0, 1]."""
    lightness = lightness_pct / 100.0
    h_rad = math.radians(hue)
    a = chroma * math.cos(h_rad)
    b = chroma * math.sin(h_rad)

    # OKLab → intermediate l_, m_, s_ (cube-root compressed)
    l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
    m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
    s_ = lightness - 0.0894841775 * a - 1.2914855480 * b

    # Cube to recover linear cone responses
    l_cubed = l_ ** 3
    m_cubed = m_ ** 3
    s_cubed = s_ ** 3

    # Cone → linear sRGB (inverse OKLab matrix, Björn Ottosson)
    r = 4.0767416621 * l_cubed - 3.3077115913 * m_cubed + 0.2309699292 * s_cubed
    g = -1.2684380046 * l_cubed + 2.6097574011 * m_cubed - 0.3413193965 * s_cubed
    bl = -0.0041960863 * l_cubed - 0.7034186147 * m_cubed + 1.7076147010 * s_cubed

    return r, g, bl


def srgb_to_linear(c: float) -> float:
    """Invert the sRGB transfer function (gamma decode), per WCAG 2.x."""
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def relative_luminance(r_lin: float, g_lin: float, b_lin: float) -> float:
    """WCAG 2.x relative luminance from a LINEAR sRGB triplet.

    WCAG defines luminance as coefficients applied to *linearized* channel
    values. The OKLab pipeline above already yields linear sRGB, so the
    values are used directly — gamma-encoding them first (a bug caught by
    the anchor tests below) computes luminance in gamma space and reports
    dark-on-light contrast roughly 2x too low.
    """
    r = min(1.0, max(0.0, r_lin))
    g = min(1.0, max(0.0, g_lin))
    b = min(1.0, max(0.0, b_lin))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(lum1: float, lum2: float) -> float:
    """WCAG contrast ratio; both luminances in [0, 1]."""
    lo = min(lum1, lum2)
    hi = max(lum1, lum2)
    return (hi + 0.05) / (lo + 0.05)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def css_text() -> str:
    assert STYLE_CSS.exists(), f"style.css not found at {STYLE_CSS}"
    return STYLE_CSS.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def rel_colors(css_text: str) -> dict[str, tuple[float, float, float]]:
    return {name: _extract_oklch(css_text, f"rel-{name}") for name in REL_NAMES}


@pytest.fixture(scope="module")
def bg_colors(css_text: str) -> dict[str, tuple[float, float, float]]:
    return {name: _extract_oklch(css_text, name) for name in BG_NAMES}


# ---------------------------------------------------------------------------
# Parametrised contrast test
# ---------------------------------------------------------------------------


def _all_pairs(
    rel_colors: dict[str, tuple[float, float, float]],
    bg_colors: dict[str, tuple[float, float, float]],
) -> list[tuple[str, str, float]]:
    out: list[tuple[str, str, float]] = []
    for rel_name, oklch in rel_colors.items():
        rel_lum = relative_luminance(*oklch_to_linear_srgb(*oklch))
        for bg_name, bg_oklch in bg_colors.items():
            bg_lum = relative_luminance(*oklch_to_linear_srgb(*bg_oklch))
            ratio = contrast_ratio(rel_lum, bg_lum)
            out.append((rel_name, bg_name, ratio))
    return out


def test_all_rel_colors_meet_3_to_1_on_all_backgrounds(
    rel_colors: dict[str, tuple[float, float, float]],
    bg_colors: dict[str, tuple[float, float, float]],
) -> None:
    """6 rel colors × 3 backgrounds must all meet WCAG non-text ≥ 3.0:1."""
    failures: list[str] = []
    for rel_name, bg_name, ratio in _all_pairs(rel_colors, bg_colors):
        if ratio < MIN_CONTRAST:
            failures.append(
                f"--rel-{rel_name} on --{bg_name}: {ratio:.4f}:1 "
                f"(need ≥ {MIN_CONTRAST})"
            )
    assert not failures, "Contrast failures:\n  " + "\n  ".join(failures)


def test_css_file_contains_expected_tokens(css_text: str) -> None:
    """Sanity: each expected token is present in oklch form."""
    all_tokens = tuple(f"rel-{n}" for n in REL_NAMES) + BG_NAMES
    for token in all_tokens:
        match = re.search(
            rf"--{re.escape(token)}\s*:\s*oklch\(", css_text
        )
        assert match is not None, f"Missing or non-oklch --{token} in style.css"


def test_font_ja_token_defined(css_text: str) -> None:
    """`--font-ja` is declared in :root (applied in later phases)."""
    match = re.search(r"--font-ja\s*:", css_text)
    assert match is not None, "--font-ja token is missing from :root"


# ---------------------------------------------------------------------------
# Instrument self-checks — validate the pipeline against canonical WCAG
# anchor pairs before trusting it on project colors. A broken conversion
# and "all colors pass/fail" are otherwise indistinguishable.
# ---------------------------------------------------------------------------


def test_anchor_gray_767676_on_white() -> None:
    """#767676 on white is the canonical 4.54:1 WCAG pair."""
    gray_lin = srgb_to_linear(0x76 / 255)
    ratio = contrast_ratio(
        relative_luminance(gray_lin, gray_lin, gray_lin),
        relative_luminance(1.0, 1.0, 1.0),
    )
    assert abs(ratio - 4.54) < 0.01, f"expected 4.54:1, got {ratio:.4f}:1"


def test_anchor_pure_red_on_white() -> None:
    """Pure red on white is the canonical 4.00:1 WCAG pair."""
    ratio = contrast_ratio(
        relative_luminance(1.0, 0.0, 0.0),
        relative_luminance(1.0, 1.0, 1.0),
    )
    assert abs(ratio - 4.00) < 0.01, f"expected 4.00:1, got {ratio:.4f}:1"


def test_anchor_oklch_red_roundtrip() -> None:
    """oklch(62.8% 0.2577 29.23) is (approximately) pure sRGB red."""
    r, g, b = oklch_to_linear_srgb(62.8, 0.2577, 29.23)
    assert abs(r - 1.0) < 0.01 and abs(g) < 0.01 and abs(b) < 0.01, (r, g, b)

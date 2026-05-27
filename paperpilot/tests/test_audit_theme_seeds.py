"""Tests for the audit_theme_seeds CLI mirror of production seed filter.

The audit script mirrors `build_theme_lineage._filter_topic_relevant_seeds`
on persisted lineage.json data (using `title + tldr` instead of the full
abstract). Tests pin the parity: when the production filter would
drop a seed, the audit must flag it; when production keeps a seed,
the audit must accept it (or at worst stay silent on title+tldr that
lacks the abstract context).
"""

from __future__ import annotations

from paperpilot.scripts.audit_theme_seeds import _is_on_topic, _normalize


def test_normalize_handles_hyphens_and_whitespace():
    assert _normalize("Self-Supervised Learning") == "self supervised learning"
    assert _normalize("  Mixture  of   Experts  ") == "mixture of experts"
    assert _normalize("Chain-of-Thought") == "chain of thought"


def test_is_on_topic_short_theme_skips_filter():
    """Single-word themes (RAG, MoE) → no filter applied (mirrors prod)."""
    paper = {"title": "anything", "tldr": "anything"}
    assert _is_on_topic("RAG", paper) is True


def test_is_on_topic_two_word_drops_lpips_against_self_supervised():
    """Two-word themes: phrase OR both words in title. LPIPS has the
    words only in its abstract, not its title, and the phrase isn't
    verbatim anywhere → drop."""
    paper = {
        "title": "The Unreasonable Effectiveness of Deep Features",
        "tldr": "supervised, self-supervised, and even unsupervised; deep learning",
    }
    assert _is_on_topic("Self-Supervised Learning", paper) is False


def test_is_on_topic_two_word_keeps_ddpm_against_diffusion_models():
    """DDPM's title carries both "diffusion" and "models" even though
    it writes "Diffusion Probabilistic Models" instead of the theme's
    "Diffusion Models". The title-only fallback (#209) keeps it."""
    paper = {
        "title": "Denoising Diffusion Probabilistic Models",
        "tldr": "we present diffusion probabilistic models for image synthesis",
    }
    assert _is_on_topic("Diffusion Models", paper) is True


def test_is_on_topic_two_word_keeps_phrase_match_with_hyphen_normalisation():
    """When the paper's tldr writes "self supervised learning" with a
    space and the theme writes "Self-Supervised Learning" with a
    hyphen, the audit must still accept — the normalisation makes the
    audit byte-for-byte compatible with the production filter."""
    paper = {
        "title": "Self-Supervised Learning of Visual Features",
        "tldr": "self-supervised learning matured rapidly post-2020",
    }
    assert _is_on_topic("Self-Supervised Learning", paper) is True


def test_is_on_topic_three_word_phrase_or_partial():
    """Three-word themes: phrase OR ceil(N/2) words. Pins the audit
    matches production for "Direct Preference Optimization" — a
    paper that mentions just preference + optimization keeps."""
    paper = {
        "title": "Preference Optimization without DPO",
        "tldr": "we revisit preference optimization without ...",
    }
    assert _is_on_topic("Direct Preference Optimization", paper) is True


def test_is_on_topic_three_word_drops_only_one_word_match():
    """Three-word theme + paper mentions only 1 of the words → drop."""
    paper = {
        "title": "On the Convergence of Direct Methods",
        "tldr": "direct methods in numerical analysis",
    }
    assert _is_on_topic("Direct Preference Optimization", paper) is False

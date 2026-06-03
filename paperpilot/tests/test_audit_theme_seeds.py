"""Tests for the audit_theme_seeds CLI mirror of production seed filter.

The audit script mirrors `build_theme_lineage._filter_topic_relevant_seeds`
on persisted lineage.json data (using `title + tldr` instead of the full
abstract). Tests pin the parity: when the production filter would
drop a seed, the audit must flag it; when production keeps a seed,
the audit must accept it (or at worst stay silent on title+tldr that
lacks the abstract context).
"""

from __future__ import annotations

from paperpilot.scripts.audit_theme_seeds import (
    _is_on_topic,
    _normalize,
    _stem,
    _stem_contains,
)


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


# ---- audit stemming (fewer false positives without abstract) ----


def test_stem_strips_common_suffixes():
    """Key contract: inflectional variants of the same word collapse
    to the SAME stem. The exact stem string isn't important — what
    matters is that distillation/distilled/distilling all reduce to
    the same key, and likewise for other word families.
    """
    # distill family: all reduce to "distill"
    assert _stem("distillation") == _stem("distilled") == _stem("distilling")
    assert _stem("distillation") == "distill"
    # supervis family: all reduce to the same stem (whichever exact
    # form the chopper lands on). "supervision" → ion → supervis →
    # s → supervi (s-rule does not recurse, see _stem docstring).
    assert _stem("supervision") == _stem("supervised") == _stem("supervising")
    # optimiz family: ation chop, no s-tail
    assert _stem("optimization") == _stem("optimizing")
    assert _stem("optimization") == "optimiz"


def test_stem_preserves_short_words():
    """Words < 5 chars must not be stemmed (would collapse common
    tokens). 4-char words are at the boundary — must stay intact."""
    assert _stem("self") == "self"
    assert _stem("the") == "the"
    assert _stem("at") == "at"
    # 4-char word: keep
    assert _stem("each") == "each"


def test_stem_idempotent():
    """Stemming twice gives the same result — important so callers
    don't have to worry about applying stem repeatedly."""
    assert _stem(_stem("distillation")) == _stem("distillation")
    assert _stem(_stem("supervised")) == _stem("supervised")


def test_stem_contains_matches_inflection():
    """The end goal: 'distillation' theme word matches a haystack
    containing only 'distilled' — both stem to 'distill', which is
    a substring of 'distilled'."""
    assert _stem_contains("distilbert a distilled version of bert", "distillation")
    assert _stem_contains("we propose self supervised pretraining", "supervision")
    assert _stem_contains("ablation studies for the proposed method", "ablations")


def test_is_on_topic_keeps_distilbert_for_knowledge_distillation():
    """DistilBERT paper for Knowledge Distillation theme: when the
    tldr mentions "knowledge distillation" verbatim, the phrase check
    keeps the paper even though the title only says "distilled".

    The realistic tldr (paraphrased from S2's actual tldr) carries
    the phrase, which is how the audit can recover this seed without
    seeing the full abstract."""
    paper = {
        "title": (
            "DistilBERT, a distilled version of BERT: smaller, faster, "
            "cheaper and lighter"
        ),
        "tldr": (
            "we apply knowledge distillation to BERT, producing a model "
            "that is 40% smaller, 60% faster, and retains 97% of accuracy"
        ),
    }
    assert _is_on_topic("Knowledge Distillation", paper) is True


def test_is_on_topic_stemming_helps_three_word_theme():
    """Stemming primary win: 3-word theme where the paper's title +
    tldr have inflected forms of theme words.

    Theme "Neural Architecture Search" (3 words). Paper says
    "architectures" + "searching" + "neural" — all inflected. Without
    stemming: only "neural" exact-matches → 1 of 3 hits → DROP. With
    stemming: "architecture" stem matches "architectures",
    "search" stem matches "searching" → 3 of 3 hits → KEEP.
    """
    paper = {
        "title": "Searching for Neural Architectures via Reinforcement Learning",
        "tldr": "we propose a method for searching neural network architectures",
    }
    assert _is_on_topic("Neural Architecture Search", paper) is True


def test_is_on_topic_keeps_simclr_for_self_supervised_learning():
    """SimCLR's title is 'A Simple Framework for Contrastive Learning
    of Visual Representations'. Title has 'learning' but no 'self'
    or 'supervised'. Phrase 'self supervised learning' might not be
    in tldr verbatim — keep via abstract match in production. Audit
    can keep when tldr mentions self-supervised."""
    paper = {
        "title": "A Simple Framework for Contrastive Learning of Visual Representations",
        "tldr": (
            "we present simclr, a simple framework for contrastive "
            "self-supervised learning of visual representations"
        ),
    }
    assert _is_on_topic("Self-Supervised Learning", paper) is True


def test_is_on_topic_keeps_vit_for_vision_transformer():
    """ViT paper "An Image is Worth 16x16 Words": title has neither
    'vision' nor 'transformer'. tldr likely mentions both → keep."""
    paper = {
        "title": "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
        "tldr": "vision transformer applied directly to image patches outperforms CNN baselines",
    }
    assert _is_on_topic("Vision Transformer", paper) is True


# ---- short_abstract field (#245): audit reads the 1000-char abstract
#      excerpt when available, falling back to tldr for legacy themes ----


def test_is_on_topic_prefers_short_abstract_over_tldr():
    """When ``short_abstract`` is present, the audit reads it instead of
    tldr — recovering false positives where the theme keywords appear
    later in the abstract than the 140-char tldr cutoff.

    The original ViT abstract starts "While the Transformer architecture
    has become the de-facto standard for natural language processing..."
    — neither "Vision" nor "Transformer" appears in the first 140 chars,
    so a tldr-only audit DROPS this seed even though production keeps it.
    With short_abstract reaching ~chars 200-300, "Vision Transformer (ViT)"
    becomes visible and the audit accepts the seed.
    """
    # Realistic ViT-style 1000-char excerpt; theme keyword "Vision Transformer"
    # appears well past the 140-char tldr cutoff.
    short_abstract = (
        "While the Transformer architecture has become the de-facto "
        "standard for natural language processing tasks, its applications "
        "to computer vision remain limited. In vision, attention is either "
        "applied in conjunction with convolutional networks, or used to "
        "replace certain components of convolutional networks while keeping "
        "their overall structure in place. We show that this reliance on "
        "CNNs is not necessary and a pure transformer applied directly "
        "to sequences of image patches can perform very well on image "
        "classification tasks. When pre-trained on large amounts of data "
        "and transferred to multiple mid-sized or small image recognition "
        "benchmarks (ImageNet, CIFAR-100, VTAB, etc.), Vision Transformer "
        "(ViT) attains excellent results compared to state-of-the-art "
        "convolutional networks while requiring substantially fewer "
        "computational resources to train."
    )
    # tldr is the first 140 chars — "Vision Transformer" NOT visible here.
    tldr = short_abstract[:140]
    paper_legacy = {
        "title": "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
        "tldr": tldr,
    }
    paper_new = {**paper_legacy, "short_abstract": short_abstract}
    # Legacy theme (no short_abstract): the audit reads tldr only and
    # incorrectly flags the seed as off-topic.
    assert _is_on_topic("Vision Transformer", paper_legacy) is False
    # With short_abstract present, "Vision Transformer" surfaces in the
    # haystack via the phrase match, and the seed is accepted.
    assert _is_on_topic("Vision Transformer", paper_new) is True


def test_is_on_topic_falls_back_to_tldr_for_legacy_lineage():
    """Legacy themes (built before short_abstract landed) have no
    short_abstract field. The audit must continue to read tldr without
    raising KeyError or returning False on every legacy seed."""
    paper = {
        "title": "Diffusion Models in Practice",
        "tldr": "we present diffusion models for image synthesis",
    }
    assert _is_on_topic("Diffusion Models", paper) is True


def test_is_on_topic_handles_empty_short_abstract():
    """Defensive: a short_abstract that's empty / None should not crash
    and should not poison the haystack (audit degrades to title-only)."""
    paper = {
        "title": "Self-Supervised Learning of Visual Features",
        "tldr": "",
        "short_abstract": None,
    }
    # Two-word phrase in title → kept by title-only fallback.
    assert _is_on_topic("Self-Supervised Learning", paper) is True

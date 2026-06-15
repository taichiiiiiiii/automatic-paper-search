"""Title-version supersedes heuristic (Track A LLM-free accuracy work).

`_is_version_increment` / the `_derive_relation_heuristic` title-version path
is the only LLM-free route to a `supersedes` edge — #283 kept the noisy
year/cite supersedes dead. High PRECISION is the contract: it must fire on
explicit version increments and never on unrelated or merely year-gapped
pairs (a false supersedes edge is worse than a missing one).
"""

from paperpilot.scripts._lineage_classify import (
    _TEMPLATE_RATIONALES_SET,
    _apply_llm_classification,
    _derive_relation_heuristic,
    _is_version_increment,
)


def _p(title: str, year: int = 2020) -> dict:
    return {"title": title, "year": year}


# ---- _is_version_increment: positives -------------------------------------
def test_version_increment_flashattention_chain():
    assert _is_version_increment(
        _p("FlashAttention: Fast and Memory-Efficient Exact Attention", 2022),
        _p("FlashAttention-2: Faster Attention with Better Parallelism", 2023),
    )
    assert _is_version_increment(
        _p("FlashAttention-2: Faster Attention with Better Parallelism", 2023),
        _p("FlashAttention-3: Fast and Accurate Attention", 2024),
    )


def test_version_increment_improved_prefix():
    assert _is_version_increment(
        _p("Denoising Diffusion Probabilistic Models", 2020),
        _p("Improved Denoising Diffusion Probabilistic Models", 2021),
    )


def test_version_increment_improving_prefix():
    # "Improving" (not just "Improved") is a distinct academic title pattern.
    assert _is_version_increment(
        _p("Neural Machine Translation", 2016),
        _p("Improving Neural Machine Translation", 2017),
    )


def test_version_increment_enhanced_prefix():
    assert _is_version_increment(
        _p("Super-Resolution Network", 2017),
        _p("Enhanced Super-Resolution Network", 2018),
    )


def test_version_increment_improved_prefix_with_colon_subtitle():
    # Parent has a colon subtitle; comparison is on the pre-colon short name,
    # so "Improved <short>" still matches.
    assert _is_version_increment(
        _p("DDPM: Denoising Diffusion Probabilistic Models", 2020),
        _p("Improved DDPM: even better sampling", 2021),
    )


# ---- _is_version_increment: negatives (precision is the priority) ----------
def test_no_version_increment_unrelated_titles():
    assert not _is_version_increment(_p("BERT", 2018), _p("GPT-3", 2020))
    assert not _is_version_increment(
        _p("Going deeper with convolutions", 2014),
        _p("Rethinking the Inception Architecture for Computer Vision", 2016),
    )
    assert not _is_version_increment(
        _p("Outrageously Large Neural Networks: The Sparsely-Gated MoE", 2017),
        _p("Switch Transformers: Scaling to Trillion Parameter Models", 2021),
    )


def test_no_version_increment_different_base_with_version_token():
    # Gold-labeled SUCCESSOR: the parent title "A ConvNet for the 2020s"
    # shares no base with "ConvNeXt V2", so a version token in the child
    # alone must NOT trigger supersedes.
    assert not _is_version_increment(
        _p("A ConvNet for the 2020s", 2022),
        _p("ConvNeXt V2: Co-designing and Scaling ConvNets", 2023),
    )


def test_no_version_increment_architecture_config_suffix():
    # Model-depth/config suffixes (ResNet-50 → ResNet-101) are config variants
    # of ONE paper, not supersession — the version-token cap must exclude them.
    assert not _is_version_increment(
        _p("ResNet-50", 2015), _p("ResNet-101", 2015)
    )


def test_no_version_increment_year_token_suffix():
    # A trailing year looks like a version token; the cap must exclude it.
    assert not _is_version_increment(
        _p("Some Model 2022", 2022), _p("Some Model 2023", 2023)
    )


def test_no_version_increment_missing_or_equal_titles():
    assert not _is_version_increment(None, _p("FlashAttention-2"))
    assert not _is_version_increment(_p("Same Title"), _p("Same Title"))
    assert not _is_version_increment(_p(""), _p("FlashAttention-2"))


# ---- heuristic emits supersedes with a slot-filled, non-template rationale -
def test_heuristic_emits_title_version_supersedes():
    edge = _derive_relation_heuristic(
        {"_intents": []},
        parent=_p("FlashAttention: Fast and Memory-Efficient Exact Attention", 2022),
        child=_p("FlashAttention-2: Faster Attention with Better Parallelism", 2023),
    )
    assert edge is not None
    assert edge["relation"] == "supersedes"
    assert edge["provenance"] == "title_version"
    assert edge["rationale"] not in _TEMPLATE_RATIONALES_SET
    assert "FlashAttention" in edge["rationale"]


def test_title_version_supersedes_survives_llm_dark():
    """When the LLM is None (steady state under free-tier quota), the
    slot-filled supersedes edge must survive _apply_llm_classification's
    template-reject — otherwise it would collapse to no edge (#300)."""
    edge = _derive_relation_heuristic(
        {"_intents": []},
        parent=_p("FlashAttention", 2022),
        child=_p("FlashAttention-2", 2023),
    )
    assert edge is not None
    kept = _apply_llm_classification(edge, None)
    assert kept is not None
    assert kept["relation"] == "supersedes"


# ---- #283 stays dead: year/cite supersedes must NOT be reintroduced -------
def test_year_cite_supersedes_still_dead_when_no_titles():
    edge = _derive_relation_heuristic(
        {"_intents": []},
        parent={"year": 2015, "citationCount": 500},
        child={"year": 2020, "citationCount": 5000},  # delta=5, cc/pc=10
    )
    assert edge is None or edge["relation"] != "supersedes"


# ---- eval --predictor=heuristic on the real gold set: 0 false positives ----
def test_eval_heuristic_predictor_zero_supersedes_false_positives():
    from paperpilot.scripts.eval_relation_prompt import (
        _load_records,
        _predict_heuristic,
    )

    records = _load_records()
    preds = _predict_heuristic(records)
    assert len(preds) == len(records)
    # PRECISION contract: every emitted supersedes must be a gold supersedes.
    for record, pred in zip(records, preds):
        if pred == "supersedes":
            assert record["gold_rel"] == "supersedes", (
                f"false-positive supersedes on {record.get('id')}: "
                f"{record['parent']['title']} -> {record['child']['title']}"
            )
    # RECALL floor: recovers at least the FlashAttention version chain.
    assert sum(1 for p in preds if p == "supersedes") >= 2

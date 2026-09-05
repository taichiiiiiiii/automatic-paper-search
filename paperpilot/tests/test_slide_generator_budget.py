from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from paperpilot.identity import make_paper_id
from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_BUDGET_EXCEEDED,
    PAPER_SLIDE_PROVIDER_FAILED,
)
from paperpilot.paper_slides.generator_budget import (
    BUDGET_POLICY_VERSION,
    DEFAULT_MAX_CALLS,
    DEFAULT_MAX_INPUT_TOKENS,
    DEFAULT_MAX_OUTPUT_TOKENS,
    DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL,
    DEFAULT_MAX_WALL_SECONDS,
    HARD_MAX_CALLS,
    HARD_MAX_INPUT_TOKENS,
    HARD_MAX_OUTPUT_TOKENS,
    HARD_MAX_OUTPUT_TOKENS_PER_CALL,
    HARD_MAX_WALL_SECONDS,
    INPUT_HASH_VERSION,
    LICENSE_POLICY_VERSION,
    BudgetReservation,
    GenerationBudget,
    GenerationInputHashRecord,
    GenerationUsageLedger,
    PricingSnapshot,
    ProviderIdentity,
    SlideGenerationBudgetError,
    cache_key,
    calculate_cache_key,
    calculate_input_sha256,
    input_sha256,
)
from paperpilot.paper_slides.resolver import ResolvedPDFSource, resolve_pdf_source

NOW = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)
_DEFAULT_PRICING = object()
_CANDIDATE_SHA256 = "a" * 64


def _identity() -> ProviderIdentity:
    return ProviderIdentity(provider="qwen", model="qwen3.7-max", adapter_version="adapter-v1")


def _pricing(**changes: object) -> PricingSnapshot:
    value = PricingSnapshot(
        provider="qwen",
        model="qwen3.7-max",
        currency="USD",
        input_per_million_micro_units=2_000_000,
        output_per_million_micro_units=8_000_000,
        request_cost_ceiling_micro_units=1_000_000,
        effective_at=NOW - timedelta(days=1),
        expires_at=NOW + timedelta(days=1),
        version="qwen-price-v1",
    )
    return replace(value, **changes)


def _budget(**changes: object) -> GenerationBudget:
    return replace(GenerationBudget(), **changes)


def _ledger(
    *,
    pricing: PricingSnapshot | object | None = _DEFAULT_PRICING,
    budget: GenerationBudget | None = None,
) -> GenerationUsageLedger:
    return GenerationUsageLedger(
        identity=_identity(),
        pricing=_pricing() if pricing is _DEFAULT_PRICING else pricing,  # type: ignore[arg-type]
        budget=_budget() if budget is None else budget,
        at=NOW,
    )


def _record(**changes: object) -> GenerationInputHashRecord:
    source_id = "2608.12345"
    paper_id = make_paper_id("arxiv", source_id)
    source = resolve_pdf_source({"paper_id": paper_id, "source": "arxiv", "source_id": source_id})
    value = GenerationInputHashRecord(
        paper_id=paper_id,
        coverage_kind="full_text",
        source=source,
        content_sha256="b" * 64,
        ordered_chunk_sha256s=("c" * 64, "d" * 64),
        language="ja",
        deck_profile="research-brief-v1",
        extractor="pypdf:6.16.2",
        provider_identity=_identity(),
        generation_config_sha256="a" * 64,
        metadata_sha256="e" * 64,
        fetched_at=NOW,
        generated_at=NOW,
        page_count=2,
        extracted_page_count=2,
        generator_version="2",
        prompt_content_version="paper-slide-prompt-content-v2",
        prompt_envelope_version="paper-slide-prompt-v1",
        schema_version="slide-deck-v1",
        pricing_version="qwen-price-v1",
    )
    return replace(value, **changes)


def _cache(record: GenerationInputHashRecord, **changes: str) -> str:
    return calculate_cache_key(record, candidate_sha256=_CANDIDATE_SHA256, **changes)


def _assert_error(
    function: object, error_code: str, issue_code: str, *args: object, **kwargs: object
) -> SlideGenerationBudgetError:
    with pytest.raises(SlideGenerationBudgetError) as caught:
        function(*args, **kwargs)  # type: ignore[operator]
    assert (caught.value.error_code, caught.value.issue_code) == (error_code, issue_code)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None
    return caught.value


def test_default_and_hard_budget_constants_are_exact() -> None:
    assert (
        DEFAULT_MAX_CALLS,
        DEFAULT_MAX_INPUT_TOKENS,
        DEFAULT_MAX_OUTPUT_TOKENS,
        DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL,
        DEFAULT_MAX_WALL_SECONDS,
    ) == (8, 120_000, 16_000, 4_000, 180)
    assert (
        HARD_MAX_CALLS,
        HARD_MAX_INPUT_TOKENS,
        HARD_MAX_OUTPUT_TOKENS,
        HARD_MAX_OUTPUT_TOKENS_PER_CALL,
        HARD_MAX_WALL_SECONDS,
    ) == (16, 200_000, 32_000, 8_000, 300)


def test_reservation_uses_worst_case_integer_cost_then_reconciles_actual_usage() -> None:
    ledger = _ledger()
    reservation = ledger.reserve_call(
        input_tokens=1_000, requested_output_tokens=500, elapsed_wall_ms=7
    )
    assert reservation == BudgetReservation(1, 1_000, 500, 6_000)
    assert ledger.usage.calls == 0
    usage = ledger.reconcile_call(
        reservation, input_tokens=900, output_tokens=100, elapsed_wall_ms=11
    )
    assert (usage.calls, usage.input_tokens, usage.output_tokens) == (1, 900, 100)
    assert usage.cost_micro_units == 2_600
    assert usage.elapsed_wall_ms == 11


def test_each_price_component_rounds_up_and_free_pricing_is_explicitly_allowed() -> None:
    priced = _ledger(
        pricing=_pricing(
            input_per_million_micro_units=1,
            output_per_million_micro_units=1,
        )
    )
    assert (
        priced.reserve_call(
            input_tokens=1, requested_output_tokens=1, elapsed_wall_ms=0
        ).reserved_cost_micro_units
        == 2
    )
    free = _ledger(
        pricing=_pricing(
            input_per_million_micro_units=0,
            output_per_million_micro_units=0,
            request_cost_ceiling_micro_units=0,
        ),
        budget=_budget(max_cost_micro_units=0),
    )
    assert (
        free.reserve_call(
            input_tokens=1, requested_output_tokens=1, elapsed_wall_ms=0
        ).reserved_cost_micro_units
        == 0
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("max_calls", 17),
        ("max_input_tokens", 200_001),
        ("max_output_tokens", 32_001),
        ("max_output_tokens_per_call", 8_001),
        ("max_wall_seconds", 301),
        ("max_calls", True),
        ("max_cost_micro_units", True),
    ],
)
def test_budget_rejects_hard_limit_and_bool_as_int(field: str, value: object) -> None:
    _assert_error(
        _ledger,
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "budget_invalid",
        budget=_budget(**{field: value}),
    )


def test_operator_cost_must_not_exceed_registry_ceiling() -> None:
    _assert_error(
        _ledger,
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "budget_cost_policy",
        pricing=_pricing(request_cost_ceiling_micro_units=99),
        budget=_budget(max_cost_micro_units=100),
    )


@pytest.mark.parametrize(
    ("pricing", "issue"),
    [
        (None, "pricing_unknown"),
        (_pricing(expires_at=NOW), "pricing_expired"),
        (_pricing(effective_at=NOW + timedelta(seconds=1)), "pricing_expired"),
        (_pricing(model="other"), "pricing_identity_mismatch"),
        (_pricing(input_per_million_micro_units=True), "pricing_invalid"),
    ],
)
def test_unknown_expired_mismatched_and_bool_pricing_fail_closed(
    pricing: PricingSnapshot | None, issue: str
) -> None:
    _assert_error(_ledger, PAPER_SLIDE_BUDGET_EXCEEDED, issue, pricing=pricing)


@pytest.mark.parametrize(
    ("reserve_kwargs", "issue"),
    [
        (
            {"input_tokens": True, "requested_output_tokens": 1, "elapsed_wall_ms": 0},
            "input_token_count_invalid",
        ),
        (
            {"input_tokens": 1, "requested_output_tokens": True, "elapsed_wall_ms": 0},
            "output_token_request_invalid",
        ),
        (
            {"input_tokens": 1, "requested_output_tokens": 4_001, "elapsed_wall_ms": 0},
            "output_per_call_exceeded",
        ),
        (
            {"input_tokens": 120_001, "requested_output_tokens": 1, "elapsed_wall_ms": 0},
            "input_token_limit_exceeded",
        ),
        (
            {"input_tokens": 1, "requested_output_tokens": 1, "elapsed_wall_ms": 180_001},
            "wall_time_exceeded",
        ),
    ],
)
def test_reservation_fails_before_committing_usage(
    reserve_kwargs: dict[str, object], issue: str
) -> None:
    ledger = _ledger()
    _assert_error(ledger.reserve_call, PAPER_SLIDE_BUDGET_EXCEEDED, issue, **reserve_kwargs)
    assert ledger.usage.calls == 0


def test_call_output_and_cost_totals_are_reserved_before_next_call() -> None:
    ledger = _ledger(budget=_budget(max_calls=1, max_output_tokens=1, max_cost_micro_units=10))
    reservation = ledger.reserve_call(input_tokens=1, requested_output_tokens=1, elapsed_wall_ms=0)
    ledger.reconcile_call(reservation, input_tokens=1, output_tokens=1, elapsed_wall_ms=0)
    _assert_error(
        ledger.reserve_call,
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "call_limit_exceeded",
        input_tokens=0,
        requested_output_tokens=1,
        elapsed_wall_ms=0,
    )


def test_pending_reservation_blocks_double_admission() -> None:
    ledger = _ledger()
    ledger.reserve_call(input_tokens=1, requested_output_tokens=1, elapsed_wall_ms=0)
    _assert_error(
        ledger.reserve_call,
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "reservation_pending",
        input_tokens=1,
        requested_output_tokens=1,
        elapsed_wall_ms=0,
    )


@pytest.mark.parametrize(
    ("usage", "issue"),
    [
        (
            {"input_tokens": True, "output_tokens": 1, "elapsed_wall_ms": 1},
            "provider_usage_invalid",
        ),
        ({"input_tokens": 11, "output_tokens": 1, "elapsed_wall_ms": 1}, "provider_usage_mismatch"),
        ({"input_tokens": 1, "output_tokens": 11, "elapsed_wall_ms": 1}, "provider_usage_mismatch"),
    ],
)
def test_provider_usage_mismatch_is_provider_failure(usage: dict[str, object], issue: str) -> None:
    ledger = _ledger()
    reservation = ledger.reserve_call(
        input_tokens=10, requested_output_tokens=10, elapsed_wall_ms=0
    )
    _assert_error(
        ledger.reconcile_call,
        PAPER_SLIDE_PROVIDER_FAILED,
        issue,
        reservation,
        **usage,
    )
    assert ledger.usage.calls == 0


def test_forged_equal_reservation_is_rejected() -> None:
    ledger = _ledger()
    reservation = ledger.reserve_call(
        input_tokens=10, requested_output_tokens=10, elapsed_wall_ms=0
    )
    forged = replace(reservation)
    _assert_error(
        ledger.reconcile_call,
        PAPER_SLIDE_PROVIDER_FAILED,
        "provider_usage_reservation_mismatch",
        forged,
        input_tokens=1,
        output_tokens=1,
        elapsed_wall_ms=1,
    )


def test_large_integer_arithmetic_is_exact_and_cost_ceiling_fails_stably() -> None:
    huge = (1 << 63) - 1
    ledger = _ledger(
        pricing=_pricing(
            input_per_million_micro_units=huge,
            output_per_million_micro_units=huge,
            request_cost_ceiling_micro_units=huge,
        ),
        budget=_budget(
            max_input_tokens=200_000,
            max_output_tokens=32_000,
            max_output_tokens_per_call=8_000,
            max_cost_micro_units=huge,
        ),
    )
    reservation = ledger.reserve_call(
        input_tokens=200_000,
        requested_output_tokens=8_000,
        elapsed_wall_ms=0,
    )
    expected = ((200_000 * huge + 999_999) // 1_000_000) + ((8_000 * huge + 999_999) // 1_000_000)
    assert reservation.reserved_cost_micro_units == expected

    capped = _ledger(budget=_budget(max_cost_micro_units=1))
    _assert_error(
        capped.reserve_call,
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "cost_limit_exceeded",
        input_tokens=1,
        requested_output_tokens=1,
        elapsed_wall_ms=0,
    )


def test_process_control_exceptions_are_preserved(monkeypatch: pytest.MonkeyPatch) -> None:
    def interrupt(_value: object) -> str:
        raise KeyboardInterrupt

    monkeypatch.setattr("paperpilot.paper_slides.generator_budget.canonical_json_sha256", interrupt)
    with pytest.raises(KeyboardInterrupt):
        calculate_input_sha256(_record())


def test_input_hash_and_cache_key_are_deterministic_and_versioned() -> None:
    record = _record()
    first = calculate_input_sha256(record)
    assert first == calculate_input_sha256(record)
    assert len(first) == 64
    key = _cache(record)
    assert key == _cache(record)
    assert len(key) == 64
    assert cache_key(record, candidate_sha256=_CANDIDATE_SHA256) == key
    assert input_sha256(record) == first
    assert INPUT_HASH_VERSION == "paper-slide-input-v1"
    assert BUDGET_POLICY_VERSION == "paper-slide-budget-v1"
    assert LICENSE_POLICY_VERSION == "paper-slide-license-v1"


@pytest.mark.parametrize(
    "change",
    [
        {"content_sha256": "e" * 64},
        {"ordered_chunk_sha256s": ("d" * 64, "c" * 64)},
        {"language": "en"},
        {"metadata_sha256": "f" * 64},
        {"generation_config_sha256": "b" * 64},
        {"fetched_at": NOW - timedelta(seconds=1)},
        {"generated_at": NOW + timedelta(seconds=1)},
        {"page_count": 3},
        {"extracted_page_count": 1},
        {"generator_version": "3"},
        {"prompt_content_version": "paper-slide-prompt-content-v3"},
        {"prompt_envelope_version": "paper-slide-prompt-v2"},
        {"schema_version": "slide-deck-v2"},
        {"pricing_version": "qwen-price-v2"},
        {"provider_identity": ProviderIdentity("qwen", "qwen3.7-max", "adapter-v2")},
    ],
)
def test_each_identity_version_or_order_change_changes_input_hash(
    change: dict[str, object],
) -> None:
    original = _record()
    changed = _record(**change)
    assert calculate_input_sha256(original) != calculate_input_sha256(changed)
    assert _cache(original) != _cache(changed)


def test_cache_policy_versions_change_cache_key_but_not_input_hash() -> None:
    record = _record()
    digest = calculate_input_sha256(record)
    assert _cache(record) != calculate_cache_key(
        record, budget_policy_version="paper-slide-budget-v2", candidate_sha256=_CANDIDATE_SHA256
    )
    assert _cache(record) != calculate_cache_key(
        record, license_policy_version="paper-slide-license-v2", candidate_sha256=_CANDIDATE_SHA256
    )
    assert calculate_input_sha256(record) == digest


def test_candidate_bytes_digest_is_bound_into_final_cache_key() -> None:
    record = _record()
    assert calculate_cache_key(record, candidate_sha256="a" * 64) != calculate_cache_key(
        record, candidate_sha256="b" * 64
    )


def test_abstract_hash_record_forbids_chunk_hashes() -> None:
    abstract = _record(
        coverage_kind="abstract_only",
        ordered_chunk_sha256s=(),
        fetched_at=None,
        page_count=None,
        extracted_page_count=None,
    )
    assert len(calculate_input_sha256(abstract)) == 64
    _assert_error(
        calculate_input_sha256,
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "input_hash_record_invalid",
        replace(abstract, ordered_chunk_sha256s=("c" * 64,)),
    )


def test_full_text_hash_record_rejects_duplicate_chunks_and_accepts_visible_extractor_id() -> None:
    record = _record(extractor="visible-text-v1:pdfium-1+tesseract-5+eng-a1b2c3d4")
    assert len(calculate_input_sha256(record)) == 64
    _assert_error(
        calculate_input_sha256,
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "input_hash_record_invalid",
        replace(record, ordered_chunk_sha256s=("c" * 64, "c" * 64)),
    )


def test_hash_boundary_rejects_subclasses_and_untrusted_shape_without_leaking_values() -> None:
    class HostileRecord(GenerationInputHashRecord):
        pass

    hostile = HostileRecord(**_record().__dict__)
    error = _assert_error(
        calculate_input_sha256,
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "input_hash_record_invalid",
        hostile,
    )
    assert "2608.12345" not in repr(error)
    _assert_error(
        calculate_input_sha256,
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "input_hash_record_invalid",
        _record(ordered_chunk_sha256s=(True,)),
    )


def test_mutation_after_construction_is_detected() -> None:
    record = _record()
    object.__setattr__(record, "paper_id", "secret paper prose")
    _assert_error(
        calculate_input_sha256,
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "input_hash_record_invalid",
        record,
    )


def test_ledger_snapshots_identity_pricing_and_budget_primitives() -> None:
    identity = _identity()
    pricing = _pricing()
    budget = _budget(max_cost_micro_units=20_000)
    ledger = GenerationUsageLedger(identity=identity, pricing=pricing, budget=budget, at=NOW)
    reservation = ledger.reserve_call(
        input_tokens=1_000, requested_output_tokens=500, elapsed_wall_ms=0
    )
    object.__setattr__(identity, "model", "mutated")
    object.__setattr__(pricing, "input_per_million_micro_units", 0)
    object.__setattr__(pricing, "output_per_million_micro_units", 0)
    object.__setattr__(budget, "max_cost_micro_units", 0)
    usage = ledger.reconcile_call(
        reservation, input_tokens=1_000, output_tokens=500, elapsed_wall_ms=1
    )
    assert usage.cost_micro_units == 6_000


def test_noncanonical_source_and_source_identity_mismatch_are_rejected() -> None:
    record = _record()
    forged = replace(record.source, landing_url="https://arxiv.org/abs/secret-paper-text")
    _assert_error(
        calculate_input_sha256,
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "input_hash_record_invalid",
        replace(record, source=forged),
    )
    other_source_id = "2608.99999"
    other_source = resolve_pdf_source(
        {
            "paper_id": make_paper_id("arxiv", other_source_id),
            "source": "arxiv",
            "source_id": other_source_id,
        }
    )
    _assert_error(
        calculate_input_sha256,
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "input_hash_record_invalid",
        replace(record, source=other_source),
    )


def test_source_subclass_is_rejected() -> None:
    class HostileSource(ResolvedPDFSource):
        pass

    record = _record()
    hostile = HostileSource(**record.source.__dict__)
    _assert_error(
        calculate_input_sha256,
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "input_hash_record_invalid",
        replace(record, source=hostile),
    )

"""Offline tests for the on-demand slide provider execution boundary."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_BUDGET_EXCEEDED,
    PAPER_SLIDE_PROVIDER_FAILED,
)
from paperpilot.paper_slides.generator_budget import (
    GenerationBudget,
    PricingSnapshot,
    ProviderIdentity,
    SlideGenerationBudgetError,
)
from paperpilot.paper_slides.provider_execution import (
    CONFIG_VERSION,
    ApprovedProviderRegistration,
    PreparedProviderExecution,
    ProviderExecutionError,
    ProviderRegistry,
    load_provider_execution_config,
    prepare_provider_execution,
    pricing_snapshot_sha256,
)

NOW = datetime(2026, 9, 4, tzinfo=timezone.utc)
IDENTITY = ProviderIdentity("offline-fixture", "fixture-model", "fixture-adapter-v1")


class FakeAdapter:
    def __init__(self) -> None:
        self.identity_value = IDENTITY
        self.calls = 0

    @property
    def identity(self) -> ProviderIdentity:
        return self.identity_value

    def paid_call(self) -> None:
        self.calls += 1


class OtherAdapter(FakeAdapter):
    pass


def _pricing(**changes: object) -> PricingSnapshot:
    value = PricingSnapshot(
        provider=IDENTITY.provider,
        model=IDENTITY.model,
        currency="USD",
        input_per_million_micro_units=2_000_000,
        output_per_million_micro_units=4_000_000,
        request_cost_ceiling_micro_units=20_000,
        effective_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        expires_at=datetime(2027, 1, 1, tzinfo=timezone.utc),
        version="offline-fixture-pricing-v1",
    )
    return replace(value, **changes)


def _maximum_budget(**changes: object) -> GenerationBudget:
    value = GenerationBudget(
        max_calls=4,
        max_input_tokens=10_000,
        max_output_tokens=2_000,
        max_output_tokens_per_call=1_000,
        max_wall_seconds=60,
        max_cost_micro_units=20_000,
    )
    return replace(value, **changes)


def _registration(
    *,
    pricing: PricingSnapshot | None = None,
    maximum_budget: GenerationBudget | None = None,
    adapter_type: type[object] = FakeAdapter,
) -> ApprovedProviderRegistration:
    selected_pricing = pricing or _pricing()
    return ApprovedProviderRegistration(
        identity=IDENTITY,
        adapter_type=adapter_type,
        pricing=selected_pricing,
        pricing_snapshot_sha256=pricing_snapshot_sha256(selected_pricing),
        maximum_budget=maximum_budget or _maximum_budget(),
    )


def _config(**changes: object) -> dict[str, object]:
    budget = _maximum_budget(max_calls=2, max_cost_micro_units=12_000)
    value: dict[str, object] = {
        "schema_version": CONFIG_VERSION,
        "provider": IDENTITY.provider,
        "model": IDENTITY.model,
        "adapter_version": IDENTITY.adapter_version,
        "pricing_snapshot_sha256": pricing_snapshot_sha256(_pricing()),
        "budget": {
            "max_calls": budget.max_calls,
            "max_input_tokens": budget.max_input_tokens,
            "max_output_tokens": budget.max_output_tokens,
            "max_output_tokens_per_call": budget.max_output_tokens_per_call,
            "max_wall_seconds": budget.max_wall_seconds,
            "max_cost_micro_units": budget.max_cost_micro_units,
        },
    }
    value.update(changes)
    return value


def _assert_error(call, error: str, issue: str) -> None:
    with pytest.raises(ProviderExecutionError) as caught:
        call()
    assert (caught.value.error_code, caught.value.issue_code) == (error, issue)


def test_exact_approved_adapter_prepares_detached_job_snapshots() -> None:
    pricing = _pricing()
    maximum = _maximum_budget()
    registration = _registration(pricing=pricing, maximum_budget=maximum)
    registry = ProviderRegistry((registration,))
    adapter = FakeAdapter()

    prepared = prepare_provider_execution(_config(), registry=registry, provider=adapter, at=NOW)

    assert prepared.require_provider() is adapter
    assert prepared.identity == IDENTITY
    assert prepared.pricing == pricing
    assert prepared.budget.max_calls == 2
    assert prepared.new_usage_ledger().usage.calls == 0
    assert adapter.calls == 0

    object.__setattr__(pricing, "version", "mutated")
    object.__setattr__(maximum, "max_calls", 1)
    assert prepared.pricing.version == "offline-fixture-pricing-v1"
    assert prepared.budget.max_calls == 2


def test_empty_registry_fails_closed_before_any_provider_call() -> None:
    adapter = FakeAdapter()
    _assert_error(
        lambda: prepare_provider_execution(_config(), provider=adapter, at=NOW),
        PAPER_SLIDE_PROVIDER_FAILED,
        "provider_not_approved",
    )
    assert adapter.calls == 0


def test_prepared_execution_cannot_be_directly_constructed_around_registry() -> None:
    adapter = FakeAdapter()
    registry = ProviderRegistry((_registration(),))
    approved = prepare_provider_execution(_config(), registry=registry, provider=adapter, at=NOW)
    _assert_error(
        lambda: PreparedProviderExecution(
            provider=adapter,
            provider_type=FakeAdapter,
            identity=IDENTITY,
            pricing=approved.pricing,
            budget=approved.budget,
            ledger=approved.new_usage_ledger(),
            prepared_at=NOW,
        ),
        PAPER_SLIDE_PROVIDER_FAILED,
        "provider_execution_invalid",
    )


@pytest.mark.parametrize(
    "value",
    [
        None,
        {},
        {**_config(), "unknown": 1},
        {key: value for key, value in _config().items() if key != "model"},
        {**_config(), "schema_version": "future"},
        {**_config(), "provider": 1},
    ],
)
def test_config_is_a_closed_exact_top_level_object(value: object) -> None:
    _assert_error(
        lambda: load_provider_execution_config(value),
        PAPER_SLIDE_PROVIDER_FAILED,
        "provider_config_invalid",
    )


@pytest.mark.parametrize(
    "change",
    [
        {"provider": "Uppercase"},
        {"provider": "-leading"},
        {"model": "has spaces"},
        {"adapter_version": "slash/not-allowed"},
        {"pricing_snapshot_sha256": "A" * 64},
        {"pricing_snapshot_sha256": "0" * 63},
    ],
)
def test_config_identity_and_snapshot_hash_are_validated_before_lookup(
    change: dict[str, object],
) -> None:
    _assert_error(
        lambda: load_provider_execution_config({**_config(), **change}),
        PAPER_SLIDE_PROVIDER_FAILED,
        "provider_config_invalid",
    )


def test_mapping_subclasses_are_not_accepted_as_own_data() -> None:
    class DerivedDict(dict):
        pass

    _assert_error(
        lambda: load_provider_execution_config(DerivedDict(_config())),
        PAPER_SLIDE_PROVIDER_FAILED,
        "provider_config_invalid",
    )


@pytest.mark.parametrize(
    "budget",
    [
        {},
        {**_config()["budget"], "unknown": 1},
        {key: value for key, value in _config()["budget"].items() if key != "max_calls"},
        {**_config()["budget"], "max_calls": True},
    ],
)
def test_budget_config_is_closed_complete_and_rejects_bool(budget: object) -> None:
    _assert_error(
        lambda: load_provider_execution_config({**_config(), "budget": budget}),
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "budget_config_invalid",
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("max_calls", 5),
        ("max_input_tokens", 10_001),
        ("max_output_tokens", 2_001),
        ("max_output_tokens_per_call", 1_001),
        ("max_wall_seconds", 61),
        ("max_cost_micro_units", 20_001),
    ],
)
def test_every_configured_job_ceiling_must_be_within_registered_policy(
    field: str, value: int
) -> None:
    budget = dict(_config()["budget"])
    budget[field] = value
    _assert_error(
        lambda: prepare_provider_execution(
            {**_config(), "budget": budget},
            registry=ProviderRegistry((_registration(),)),
            provider=FakeAdapter(),
            at=NOW,
        ),
        PAPER_SLIDE_PROVIDER_FAILED,
        "provider_config_not_approved",
    )


def test_pricing_snapshot_digest_is_exact_and_price_changes_are_not_approved() -> None:
    first = _pricing()
    second = replace(first, output_per_million_micro_units=4_000_001)
    assert pricing_snapshot_sha256(first) != pricing_snapshot_sha256(second)
    _assert_error(
        lambda: prepare_provider_execution(
            {**_config(), "pricing_snapshot_sha256": pricing_snapshot_sha256(second)},
            registry=ProviderRegistry((_registration(pricing=first),)),
            provider=FakeAdapter(),
            at=NOW,
        ),
        PAPER_SLIDE_PROVIDER_FAILED,
        "provider_config_not_approved",
    )


@pytest.mark.parametrize(
    "pricing",
    [
        _pricing(provider="UPPER"),
        _pricing(model="bad model"),
        _pricing(currency="usd"),
        _pricing(input_per_million_micro_units=True),
        _pricing(output_per_million_micro_units=-1),
        _pricing(request_cost_ceiling_micro_units=True),
        _pricing(effective_at=datetime(2026, 1, 1)),
        _pricing(effective_at=datetime(2026, 1, 1, tzinfo=timezone(timedelta(hours=9)))),
        _pricing(effective_at=datetime(2026, 1, 1, 0, 0, 0, 1, tzinfo=timezone.utc)),
        _pricing(expires_at=datetime(2026, 1, 1, tzinfo=timezone.utc)),
        _pricing(version="bad version"),
    ],
)
def test_pricing_identity_rejects_malformed_or_ambiguous_snapshots(
    pricing: PricingSnapshot,
) -> None:
    _assert_error(
        lambda: pricing_snapshot_sha256(pricing),
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "pricing_snapshot_invalid",
    )


def test_expired_pricing_uses_trusted_prepare_time() -> None:
    _assert_error(
        lambda: prepare_provider_execution(
            _config(),
            registry=ProviderRegistry((_registration(),)),
            provider=FakeAdapter(),
            at=datetime(2027, 1, 1, tzinfo=timezone.utc),
        ),
        PAPER_SLIDE_BUDGET_EXCEEDED,
        "pricing_expired",
    )


def test_exact_adapter_type_and_identity_are_both_required() -> None:
    _assert_error(
        lambda: prepare_provider_execution(
            _config(),
            registry=ProviderRegistry((_registration(),)),
            provider=OtherAdapter(),
            at=NOW,
        ),
        PAPER_SLIDE_PROVIDER_FAILED,
        "provider_config_not_approved",
    )
    adapter = FakeAdapter()
    adapter.identity_value = replace(IDENTITY, adapter_version="self-claimed-v2")
    _assert_error(
        lambda: prepare_provider_execution(
            _config(),
            registry=ProviderRegistry((_registration(),)),
            provider=adapter,
            at=NOW,
        ),
        PAPER_SLIDE_PROVIDER_FAILED,
        "provider_identity_mismatch",
    )


def test_identity_mutation_after_prepare_is_rejected_before_use() -> None:
    adapter = FakeAdapter()
    prepared = prepare_provider_execution(
        _config(),
        registry=ProviderRegistry((_registration(),)),
        provider=adapter,
        at=NOW,
    )
    adapter.identity_value = replace(IDENTITY, adapter_version="changed-v2")
    _assert_error(
        prepared.require_provider,
        PAPER_SLIDE_PROVIDER_FAILED,
        "provider_identity_changed",
    )
    assert adapter.calls == 0


def test_registry_rejects_duplicate_pair_and_forged_snapshot_identity() -> None:
    registration = _registration()
    _assert_error(
        lambda: ProviderRegistry((registration, registration)),
        PAPER_SLIDE_PROVIDER_FAILED,
        "provider_registry_invalid",
    )
    forged = replace(registration, pricing_snapshot_sha256="0" * 64)
    _assert_error(
        lambda: ProviderRegistry((forged,)),
        PAPER_SLIDE_PROVIDER_FAILED,
        "provider_registry_invalid",
    )


def test_job_ledger_blocks_call_output_input_and_cost_before_fake_paid_call() -> None:
    adapter = FakeAdapter()
    prepared = prepare_provider_execution(
        _config(),
        registry=ProviderRegistry((_registration(),)),
        provider=adapter,
        at=NOW,
    )
    ledger = prepared.new_usage_ledger()
    with pytest.raises(SlideGenerationBudgetError) as caught:
        ledger.reserve_call(
            input_tokens=10_001,
            requested_output_tokens=1,
            elapsed_wall_ms=0,
        )
    assert caught.value.issue_code == "input_token_limit_exceeded"
    assert adapter.calls == 0

    with pytest.raises(SlideGenerationBudgetError) as caught:
        ledger.reserve_call(
            input_tokens=5_000,
            requested_output_tokens=1_000,
            elapsed_wall_ms=0,
        )
    assert caught.value.issue_code == "cost_limit_exceeded"
    assert adapter.calls == 0


def test_repeated_ledger_access_returns_one_cumulative_per_job_ledger() -> None:
    adapter = FakeAdapter()
    prepared = prepare_provider_execution(
        _config(),
        registry=ProviderRegistry((_registration(),)),
        provider=adapter,
        at=NOW,
    )
    first = prepared.new_usage_ledger()
    reservation = first.reserve_call(
        input_tokens=100,
        requested_output_tokens=100,
        elapsed_wall_ms=0,
    )
    first.reconcile_call(
        reservation,
        input_tokens=100,
        output_tokens=100,
        elapsed_wall_ms=1,
    )
    second = prepared.new_usage_ledger()
    assert second is first
    assert second.usage.calls == 1

    reservation = second.reserve_call(
        input_tokens=100,
        requested_output_tokens=100,
        elapsed_wall_ms=1,
    )
    second.reconcile_call(
        reservation,
        input_tokens=100,
        output_tokens=100,
        elapsed_wall_ms=2,
    )
    with pytest.raises(SlideGenerationBudgetError) as caught:
        prepared.new_usage_ledger().reserve_call(
            input_tokens=1,
            requested_output_tokens=1,
            elapsed_wall_ms=2,
        )
    assert caught.value.issue_code == "call_limit_exceeded"
    assert adapter.calls == 0


def test_no_registry_entry_names_a_live_provider_or_model() -> None:
    # This unit must not silently activate the existing qwen config or any SOL
    # implementation. Production registration remains an explicit later gate.
    adapter = FakeAdapter()
    _assert_error(
        lambda: prepare_provider_execution(
            {**_config(), "provider": "qwen", "model": "qwen3.7-max"},
            provider=adapter,
            at=NOW,
        ),
        PAPER_SLIDE_PROVIDER_FAILED,
        "provider_not_approved",
    )

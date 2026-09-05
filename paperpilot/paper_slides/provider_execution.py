"""Local-only provider authorization and per-job budget boundary.

This module deliberately contains no HTTP client, credential lookup, or live
provider registration.  A future workflow may construct a code-owned
``ProviderRegistry`` and use ``prepare_provider_execution`` to turn an exact,
closed configuration object into detached pricing and budget snapshots.
"""

from __future__ import annotations

import re
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from types import MappingProxyType
from typing import Protocol

from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_BUDGET_EXCEEDED,
    PAPER_SLIDE_PROVIDER_FAILED,
)
from paperpilot.paper_slides.generator_budget import (
    GenerationBudget,
    GenerationUsageLedger,
    PricingSnapshot,
    ProviderIdentity,
    SlideGenerationBudgetError,
)
from paperpilot.replay import canonical_json_sha256

CONFIG_VERSION = "paper-slide-provider-execution-v1"
PRICING_SNAPSHOT_HASH_VERSION = "paper-slide-pricing-snapshot-v1"

_CONFIG_KEYS = frozenset(
    {
        "schema_version",
        "provider",
        "model",
        "adapter_version",
        "pricing_snapshot_sha256",
        "budget",
    }
)
_BUDGET_KEYS = frozenset(
    {
        "max_calls",
        "max_input_tokens",
        "max_output_tokens",
        "max_output_tokens_per_call",
        "max_wall_seconds",
        "max_cost_micro_units",
    }
)
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_ADAPTER_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PREPARED_CONSTRUCTOR_TOKEN = object()


class ProviderExecutionError(ValueError):
    """Stable provider-boundary failure with no adapter or config prose."""

    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__(f"{error_code}:{issue_code}")


class IdentifiedProvider(Protocol):
    """Minimum identity surface required before any provider call."""

    @property
    def identity(self) -> ProviderIdentity: ...


@dataclass(frozen=True)
class ProviderExecutionConfig:
    schema_version: str
    identity: ProviderIdentity
    pricing_snapshot_sha256: str
    budget: GenerationBudget


@dataclass(frozen=True)
class ApprovedProviderRegistration:
    """One code-owned adapter type, price snapshot, and maximum job policy."""

    identity: ProviderIdentity
    adapter_type: type[object]
    pricing: PricingSnapshot
    pricing_snapshot_sha256: str
    maximum_budget: GenerationBudget


def _copy_identity(value: ProviderIdentity) -> ProviderIdentity:
    return ProviderIdentity(value.provider, value.model, value.adapter_version)


def _copy_pricing(value: PricingSnapshot) -> PricingSnapshot:
    return PricingSnapshot(
        provider=value.provider,
        model=value.model,
        currency=value.currency,
        input_per_million_micro_units=value.input_per_million_micro_units,
        output_per_million_micro_units=value.output_per_million_micro_units,
        request_cost_ceiling_micro_units=value.request_cost_ceiling_micro_units,
        effective_at=value.effective_at,
        expires_at=value.expires_at,
        version=value.version,
    )


def _copy_budget(value: GenerationBudget) -> GenerationBudget:
    return GenerationBudget(
        max_calls=value.max_calls,
        max_input_tokens=value.max_input_tokens,
        max_output_tokens=value.max_output_tokens,
        max_output_tokens_per_call=value.max_output_tokens_per_call,
        max_wall_seconds=value.max_wall_seconds,
        max_cost_micro_units=value.max_cost_micro_units,
    )


def pricing_snapshot_sha256(value: PricingSnapshot) -> str:
    """Return the immutable identity of an exact pricing snapshot."""

    try:
        if type(value) is not PricingSnapshot:
            raise TypeError
        # Reuse the budget ledger's exact identity, monetary, and UTC timestamp
        # validation before serializing. A zero-cost job budget is valid for
        # every non-negative registry ceiling and performs no reservation.
        checked = GenerationUsageLedger(
            identity=ProviderIdentity(value.provider, value.model, "pricing-snapshot-validator-v1"),
            pricing=value,
            budget=GenerationBudget(max_cost_micro_units=0),
            at=value.effective_at,
        ).pricing
        return canonical_json_sha256(
            {
                "schema_version": PRICING_SNAPSHOT_HASH_VERSION,
                "provider": checked.provider,
                "model": checked.model,
                "currency": checked.currency,
                "input_per_million_micro_units": checked.input_per_million_micro_units,
                "output_per_million_micro_units": checked.output_per_million_micro_units,
                "request_cost_ceiling_micro_units": checked.request_cost_ceiling_micro_units,
                "effective_at": checked.effective_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "expires_at": checked.expires_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "version": checked.version,
            }
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        raise ProviderExecutionError(
            PAPER_SLIDE_BUDGET_EXCEEDED, "pricing_snapshot_invalid"
        ) from None


def _parse_exact_budget(value: object) -> GenerationBudget:
    if type(value) is not dict or frozenset(value) != _BUDGET_KEYS:
        raise ProviderExecutionError(PAPER_SLIDE_BUDGET_EXCEEDED, "budget_config_invalid")
    if any(type(value[key]) is not int for key in _BUDGET_KEYS):
        raise ProviderExecutionError(PAPER_SLIDE_BUDGET_EXCEEDED, "budget_config_invalid")
    return GenerationBudget(**{key: value[key] for key in _BUDGET_KEYS})


def load_provider_execution_config(value: object) -> ProviderExecutionConfig:
    """Parse an exact own-data mapping; defaults and unknown keys are rejected."""

    try:
        if type(value) is not dict or frozenset(value) != _CONFIG_KEYS:
            raise ProviderExecutionError(PAPER_SLIDE_PROVIDER_FAILED, "provider_config_invalid")
        if any(
            type(value[key]) is not str
            for key in (
                "schema_version",
                "provider",
                "model",
                "adapter_version",
                "pricing_snapshot_sha256",
            )
        ):
            raise ProviderExecutionError(PAPER_SLIDE_PROVIDER_FAILED, "provider_config_invalid")
        if value["schema_version"] != CONFIG_VERSION:
            raise ProviderExecutionError(PAPER_SLIDE_PROVIDER_FAILED, "provider_config_invalid")
        if (
            _NAME_RE.fullmatch(value["provider"]) is None
            or _NAME_RE.fullmatch(value["model"]) is None
            or _ADAPTER_VERSION_RE.fullmatch(value["adapter_version"]) is None
            or _SHA256_RE.fullmatch(value["pricing_snapshot_sha256"]) is None
        ):
            raise ProviderExecutionError(PAPER_SLIDE_PROVIDER_FAILED, "provider_config_invalid")
        budget = _parse_exact_budget(value["budget"])
        return ProviderExecutionConfig(
            schema_version=CONFIG_VERSION,
            identity=ProviderIdentity(value["provider"], value["model"], value["adapter_version"]),
            pricing_snapshot_sha256=value["pricing_snapshot_sha256"],
            budget=budget,
        )
    except (KeyboardInterrupt, SystemExit, ProviderExecutionError):
        raise
    except Exception:
        raise ProviderExecutionError(
            PAPER_SLIDE_PROVIDER_FAILED, "provider_config_invalid"
        ) from None


class ProviderRegistry:
    """Immutable exact-pair allowlist assembled by future workflow code."""

    __slots__ = ("_registrations",)

    def __init__(self, registrations: tuple[ApprovedProviderRegistration, ...] = ()) -> None:
        try:
            if type(registrations) is not tuple:
                raise TypeError
            stored: dict[tuple[str, str], ApprovedProviderRegistration] = {}
            for registration in registrations:
                if (
                    type(registration) is not ApprovedProviderRegistration
                    or type(registration.identity) is not ProviderIdentity
                    or type(registration.adapter_type) is not type
                    or registration.adapter_type is object
                    or type(registration.pricing) is not PricingSnapshot
                    or type(registration.maximum_budget) is not GenerationBudget
                    or type(registration.pricing_snapshot_sha256) is not str
                ):
                    raise TypeError
                identity = _copy_identity(registration.identity)
                pricing = _copy_pricing(registration.pricing)
                maximum_budget = _copy_budget(registration.maximum_budget)
                # The existing ledger is the single source of truth for identity,
                # price lifetime, and hard maxima validation.
                GenerationUsageLedger(
                    identity=identity,
                    pricing=pricing,
                    budget=maximum_budget,
                    at=pricing.effective_at,
                )
                digest = pricing_snapshot_sha256(pricing)
                if (
                    pricing.provider != identity.provider
                    or pricing.model != identity.model
                    or digest != registration.pricing_snapshot_sha256
                ):
                    raise TypeError
                pair = (identity.provider, identity.model)
                if pair in stored:
                    raise TypeError
                stored[pair] = ApprovedProviderRegistration(
                    identity=identity,
                    adapter_type=registration.adapter_type,
                    pricing=pricing,
                    pricing_snapshot_sha256=digest,
                    maximum_budget=maximum_budget,
                )
            self._registrations: Mapping[tuple[str, str], ApprovedProviderRegistration] = (
                MappingProxyType(stored)
            )
        except (KeyboardInterrupt, SystemExit, ProviderExecutionError):
            raise
        except Exception:
            raise ProviderExecutionError(
                PAPER_SLIDE_PROVIDER_FAILED, "provider_registry_invalid"
            ) from None

    def find(self, identity: ProviderIdentity) -> ApprovedProviderRegistration | None:
        if type(identity) is not ProviderIdentity:
            return None
        value = self._registrations.get((identity.provider, identity.model))
        if value is None:
            return None
        return ApprovedProviderRegistration(
            identity=_copy_identity(value.identity),
            adapter_type=value.adapter_type,
            pricing=_copy_pricing(value.pricing),
            pricing_snapshot_sha256=str(value.pricing_snapshot_sha256),
            maximum_budget=_copy_budget(value.maximum_budget),
        )


EMPTY_PROVIDER_REGISTRY = ProviderRegistry()


class PreparedProviderExecution:
    """Detached execution inputs authorized for one job at one trusted time."""

    __slots__ = (
        "_budget",
        "_claim_lock",
        "_claimed",
        "_identity",
        "_ledger",
        "_prepared_at",
        "_pricing",
        "_provider",
        "_provider_type",
    )

    def __init__(
        self,
        *,
        provider: IdentifiedProvider,
        provider_type: type[object],
        identity: ProviderIdentity,
        pricing: PricingSnapshot,
        budget: GenerationBudget,
        ledger: GenerationUsageLedger,
        prepared_at: datetime,
        _constructor_token: object | None = None,
    ) -> None:
        if _constructor_token is not _PREPARED_CONSTRUCTOR_TOKEN:
            raise ProviderExecutionError(PAPER_SLIDE_PROVIDER_FAILED, "provider_execution_invalid")
        self._provider = provider
        self._provider_type = provider_type
        self._identity = _copy_identity(identity)
        self._pricing = _copy_pricing(pricing)
        self._budget = _copy_budget(budget)
        self._ledger = ledger
        self._prepared_at = prepared_at
        self._claim_lock = threading.Lock()
        self._claimed = False

    @property
    def identity(self) -> ProviderIdentity:
        return _copy_identity(self._identity)

    @property
    def pricing(self) -> PricingSnapshot:
        return _copy_pricing(self._pricing)

    @property
    def budget(self) -> GenerationBudget:
        return _copy_budget(self._budget)

    @property
    def prepared_at(self) -> datetime:
        return self._prepared_at

    def require_provider(self) -> IdentifiedProvider:
        """Recheck the exact adapter type and identity immediately before use."""

        try:
            if type(self._provider) is not self._provider_type:
                raise TypeError
            current = self._provider.identity
            if type(current) is not ProviderIdentity or current != self._identity:
                raise TypeError
            return self._provider
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception:
            raise ProviderExecutionError(
                PAPER_SLIDE_PROVIDER_FAILED, "provider_identity_changed"
            ) from None

    def new_usage_ledger(self) -> GenerationUsageLedger:
        """Return this job's single cumulative ledger; never reset its usage."""

        return self._ledger

    def claim_generation(self) -> IdentifiedProvider:
        """Claim this prepared job exactly once and return its checked adapter."""

        with self._claim_lock:
            if self._claimed:
                raise ProviderExecutionError(
                    PAPER_SLIDE_PROVIDER_FAILED, "provider_execution_already_started"
                )
            provider = self.require_provider()
            self._claimed = True
            return provider


def _budget_within(requested: GenerationBudget, maximum: GenerationBudget) -> bool:
    return all(getattr(requested, field) <= getattr(maximum, field) for field in _BUDGET_KEYS)


def prepare_provider_execution(
    config: object,
    *,
    registry: ProviderRegistry = EMPTY_PROVIDER_REGISTRY,
    provider: IdentifiedProvider,
    at: datetime,
) -> PreparedProviderExecution:
    """Authorize exact adapter/config/pricing and freeze one job's ceilings."""

    checked = load_provider_execution_config(config)
    try:
        if type(registry) is not ProviderRegistry:
            raise ProviderExecutionError(PAPER_SLIDE_PROVIDER_FAILED, "provider_registry_invalid")
        registration = registry.find(checked.identity)
        if registration is None:
            raise ProviderExecutionError(PAPER_SLIDE_PROVIDER_FAILED, "provider_not_approved")
        if (
            checked.identity != registration.identity
            or checked.pricing_snapshot_sha256 != registration.pricing_snapshot_sha256
            or type(provider) is not registration.adapter_type
            or not _budget_within(checked.budget, registration.maximum_budget)
        ):
            raise ProviderExecutionError(
                PAPER_SLIDE_PROVIDER_FAILED, "provider_config_not_approved"
            )
        current_identity = provider.identity
        if type(current_identity) is not ProviderIdentity or current_identity != checked.identity:
            raise ProviderExecutionError(PAPER_SLIDE_PROVIDER_FAILED, "provider_identity_mismatch")
        # Validates active price interval and every hard/operator budget bound.
        ledger = GenerationUsageLedger(
            identity=checked.identity,
            pricing=registration.pricing,
            budget=checked.budget,
            at=at,
        )
        return PreparedProviderExecution(
            provider=provider,
            provider_type=registration.adapter_type,
            identity=checked.identity,
            pricing=registration.pricing,
            budget=checked.budget,
            ledger=ledger,
            prepared_at=at,
            _constructor_token=_PREPARED_CONSTRUCTOR_TOKEN,
        )
    except (KeyboardInterrupt, SystemExit, ProviderExecutionError):
        raise
    except SlideGenerationBudgetError as exc:
        raise ProviderExecutionError(exc.error_code, exc.issue_code) from None
    except Exception:
        raise ProviderExecutionError(
            PAPER_SLIDE_PROVIDER_FAILED, "provider_execution_invalid"
        ) from None


__all__ = [
    "CONFIG_VERSION",
    "EMPTY_PROVIDER_REGISTRY",
    "PRICING_SNAPSHOT_HASH_VERSION",
    "ApprovedProviderRegistration",
    "PreparedProviderExecution",
    "ProviderExecutionConfig",
    "ProviderExecutionError",
    "ProviderRegistry",
    "load_provider_execution_config",
    "prepare_provider_execution",
    "pricing_snapshot_sha256",
]

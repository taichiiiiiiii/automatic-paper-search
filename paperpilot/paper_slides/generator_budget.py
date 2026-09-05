"""Fail-closed SD2 provider budgets and content-free cache identities.

All monetary values are integer micro-units of ``currency`` (one million
micro-units per currency unit).  Reservations round each price component up,
so a provider call is never admitted by an underestimated cost.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import NoReturn, TypeVar, cast

from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_BUDGET_EXCEEDED,
    PAPER_SLIDE_PROVIDER_FAILED,
)
from paperpilot.paper_slides.resolver import (
    ResolvedPDFSource,
    SourceResolutionError,
    resolve_pdf_source,
)
from paperpilot.replay import canonical_json_sha256

DEFAULT_MAX_CALLS = 8
DEFAULT_MAX_INPUT_TOKENS = 120_000
DEFAULT_MAX_OUTPUT_TOKENS = 16_000
DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL = 4_000
DEFAULT_MAX_WALL_SECONDS = 180
DEFAULT_MAX_COST_MICRO_UNITS = 1_000_000

HARD_MAX_CALLS = 16
HARD_MAX_INPUT_TOKENS = 200_000
HARD_MAX_OUTPUT_TOKENS = 32_000
HARD_MAX_OUTPUT_TOKENS_PER_CALL = 8_000
HARD_MAX_WALL_SECONDS = 300

INPUT_HASH_VERSION = "paper-slide-input-v1"
CACHE_KEY_VERSION = "paper-slide-cache-v1"
BUDGET_POLICY_VERSION = "paper-slide-budget-v1"
LICENSE_POLICY_VERSION = "paper-slide-license-v1"

_MICRO_UNITS_PER_UNIT = 1_000_000
_MAX_INT64 = (1 << 63) - 1
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_EXTRACTOR_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$")
_PAPER_ID_RE = re.compile(r"^[0-9a-f]{40}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_LANGUAGES = frozenset({"ja", "en"})
_COVERAGE_KINDS = frozenset({"full_text", "abstract_only"})
_DECK_PROFILE = "research-brief-v1"
_T = TypeVar("_T")
_MISSING = object()


class SlideGenerationBudgetError(ValueError):
    """Stable, redacted budget/provider failure."""

    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__(f"{error_code}:{issue_code}")


class _BudgetIssueError(Exception):
    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__()


def _public_call(
    function: Callable[[], _T], *, internal_error_code: str, internal_issue_code: str
) -> _T:
    failure: tuple[str, str] | None = None
    result: object = _MISSING
    try:
        result = function()
    except (KeyboardInterrupt, SystemExit):
        raise
    except _BudgetIssueError as exc:
        failure = (exc.error_code, exc.issue_code)
    except Exception:
        failure = (internal_error_code, internal_issue_code)
    if failure is not None:
        raise SlideGenerationBudgetError(*failure)
    if result is _MISSING:
        raise SlideGenerationBudgetError(internal_error_code, internal_issue_code)
    return cast(_T, result)


@dataclass(frozen=True)
class ProviderIdentity:
    provider: str
    model: str
    adapter_version: str


@dataclass(frozen=True)
class PricingSnapshot:
    provider: str
    model: str
    currency: str
    input_per_million_micro_units: int
    output_per_million_micro_units: int
    request_cost_ceiling_micro_units: int
    effective_at: datetime
    expires_at: datetime
    version: str


@dataclass(frozen=True)
class GenerationBudget:
    max_calls: int = DEFAULT_MAX_CALLS
    max_input_tokens: int = DEFAULT_MAX_INPUT_TOKENS
    max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS
    max_output_tokens_per_call: int = DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL
    max_wall_seconds: int = DEFAULT_MAX_WALL_SECONDS
    max_cost_micro_units: int = DEFAULT_MAX_COST_MICRO_UNITS


@dataclass(frozen=True)
class BudgetReservation:
    call_number: int
    input_tokens: int
    requested_output_tokens: int
    reserved_cost_micro_units: int


@dataclass(frozen=True)
class GenerationUsage:
    calls: int
    input_tokens: int
    output_tokens: int
    cost_micro_units: int
    elapsed_wall_ms: int


@dataclass(frozen=True)
class GenerationInputHashRecord:
    """Closed trusted metadata used for hashes; contains no paper prose."""

    paper_id: str
    coverage_kind: str
    source: ResolvedPDFSource
    content_sha256: str
    ordered_chunk_sha256s: tuple[str, ...]
    language: str
    deck_profile: str
    extractor: str
    provider_identity: ProviderIdentity
    generation_config_sha256: str
    metadata_sha256: str
    fetched_at: datetime | None
    generated_at: datetime
    page_count: int | None
    extracted_page_count: int | None
    generator_version: str
    prompt_content_version: str
    prompt_envelope_version: str
    schema_version: str
    pricing_version: str


def _issue(issue_code: str, *, provider: bool = False) -> NoReturn:
    error_code = PAPER_SLIDE_PROVIDER_FAILED if provider else PAPER_SLIDE_BUDGET_EXCEEDED
    raise _BudgetIssueError(error_code, issue_code)


def _exact_int(value: object, issue_code: str, *, minimum: int = 0, provider: bool = False) -> int:
    if type(value) is not int or value < minimum or value > _MAX_INT64:
        _issue(issue_code, provider=provider)
    return value


def _valid_name(value: object, pattern: re.Pattern[str], issue_code: str) -> str:
    if type(value) is not str or pattern.fullmatch(value) is None:
        _issue(issue_code)
    return value


def _valid_utc(value: object, issue_code: str) -> datetime:
    if (
        type(value) is not datetime
        or value.tzinfo is not timezone.utc
        or value.utcoffset() is None
        or value.microsecond != 0
    ):
        _issue(issue_code)
    return value


def _validate_provider_identity(value: object) -> ProviderIdentity:
    if type(value) is not ProviderIdentity:
        _issue("provider_identity_invalid")
    _valid_name(value.provider, _NAME_RE, "provider_identity_invalid")
    _valid_name(value.model, _NAME_RE, "provider_identity_invalid")
    _valid_name(value.adapter_version, _VERSION_RE, "provider_identity_invalid")
    return ProviderIdentity(
        provider=str(value.provider),
        model=str(value.model),
        adapter_version=str(value.adapter_version),
    )


def _validate_pricing(value: object, identity: ProviderIdentity, at: datetime) -> PricingSnapshot:
    if type(value) is not PricingSnapshot:
        _issue("pricing_unknown")
    if value.provider != identity.provider or value.model != identity.model:
        _issue("pricing_identity_mismatch")
    _valid_name(value.provider, _NAME_RE, "pricing_invalid")
    _valid_name(value.model, _NAME_RE, "pricing_invalid")
    _valid_name(value.currency, _CURRENCY_RE, "pricing_invalid")
    _valid_name(value.version, _VERSION_RE, "pricing_invalid")
    _exact_int(value.input_per_million_micro_units, "pricing_invalid")
    _exact_int(value.output_per_million_micro_units, "pricing_invalid")
    _exact_int(value.request_cost_ceiling_micro_units, "pricing_invalid")
    effective_at = _valid_utc(value.effective_at, "pricing_invalid")
    expires_at = _valid_utc(value.expires_at, "pricing_invalid")
    if effective_at >= expires_at:
        _issue("pricing_invalid")
    if not effective_at <= at < expires_at:
        _issue("pricing_expired")
    return PricingSnapshot(
        provider=str(value.provider),
        model=str(value.model),
        currency=str(value.currency),
        input_per_million_micro_units=int(value.input_per_million_micro_units),
        output_per_million_micro_units=int(value.output_per_million_micro_units),
        request_cost_ceiling_micro_units=int(value.request_cost_ceiling_micro_units),
        effective_at=effective_at,
        expires_at=expires_at,
        version=str(value.version),
    )


def _validate_budget(value: object, pricing: PricingSnapshot) -> GenerationBudget:
    if type(value) is not GenerationBudget:
        _issue("budget_invalid")
    limits = (
        (value.max_calls, HARD_MAX_CALLS),
        (value.max_input_tokens, HARD_MAX_INPUT_TOKENS),
        (value.max_output_tokens, HARD_MAX_OUTPUT_TOKENS),
        (value.max_output_tokens_per_call, HARD_MAX_OUTPUT_TOKENS_PER_CALL),
        (value.max_wall_seconds, HARD_MAX_WALL_SECONDS),
    )
    if any(type(current) is not int or not 1 <= current <= hard for current, hard in limits):
        _issue("budget_invalid")
    cost = _exact_int(value.max_cost_micro_units, "budget_invalid")
    if cost > pricing.request_cost_ceiling_micro_units:
        _issue("budget_cost_policy")
    return GenerationBudget(
        max_calls=int(value.max_calls),
        max_input_tokens=int(value.max_input_tokens),
        max_output_tokens=int(value.max_output_tokens),
        max_output_tokens_per_call=int(value.max_output_tokens_per_call),
        max_wall_seconds=int(value.max_wall_seconds),
        max_cost_micro_units=int(value.max_cost_micro_units),
    )


def _component_cost(tokens: int, rate: int) -> int:
    product = tokens * rate
    cost = (product + _MICRO_UNITS_PER_UNIT - 1) // _MICRO_UNITS_PER_UNIT
    if cost > _MAX_INT64:
        _issue("budget_cost_overflow")
    return cost


def _call_cost(input_tokens: int, output_tokens: int, pricing: PricingSnapshot) -> int:
    first = _component_cost(input_tokens, pricing.input_per_million_micro_units)
    second = _component_cost(output_tokens, pricing.output_per_million_micro_units)
    if first > _MAX_INT64 - second:
        _issue("budget_cost_overflow")
    return first + second


class GenerationUsageLedger:
    """Sequential, pre-call reservation ledger for one generation request."""

    __slots__ = (
        "_budget",
        "_calls",
        "_cost",
        "_elapsed_ms",
        "_identity",
        "_input_tokens",
        "_output_tokens",
        "_pending",
        "_pricing",
    )

    def __init__(
        self,
        *,
        identity: ProviderIdentity,
        pricing: PricingSnapshot | None,
        budget: GenerationBudget,
        at: datetime,
    ) -> None:
        def validate() -> tuple[ProviderIdentity, PricingSnapshot, GenerationBudget]:
            checked_identity = _validate_provider_identity(identity)
            checked_at = _valid_utc(at, "pricing_clock_invalid")
            checked_pricing = _validate_pricing(pricing, checked_identity, checked_at)
            checked_budget = _validate_budget(budget, checked_pricing)
            return checked_identity, checked_pricing, checked_budget

        checked_identity, checked_pricing, checked_budget = _public_call(
            validate,
            internal_error_code=PAPER_SLIDE_BUDGET_EXCEEDED,
            internal_issue_code="budget_internal_failure",
        )
        self._identity = checked_identity
        self._pricing = checked_pricing
        self._budget = checked_budget
        self._calls = 0
        self._input_tokens = 0
        self._output_tokens = 0
        self._cost = 0
        self._elapsed_ms = 0
        self._pending: BudgetReservation | None = None

    @property
    def usage(self) -> GenerationUsage:
        return GenerationUsage(
            calls=self._calls,
            input_tokens=self._input_tokens,
            output_tokens=self._output_tokens,
            cost_micro_units=self._cost,
            elapsed_wall_ms=self._elapsed_ms,
        )

    @property
    def identity(self) -> ProviderIdentity:
        """Return a fresh copy of the trusted provider identity snapshot."""

        return ProviderIdentity(**self._identity.__dict__)

    @property
    def pricing(self) -> PricingSnapshot:
        """Return a fresh copy of the trusted pricing snapshot."""

        return PricingSnapshot(**self._pricing.__dict__)

    @property
    def budget(self) -> GenerationBudget:
        """Return a fresh copy of the trusted budget snapshot."""

        return GenerationBudget(**self._budget.__dict__)

    def reserve_call(
        self, *, input_tokens: int, requested_output_tokens: int, elapsed_wall_ms: int
    ) -> BudgetReservation:
        def reserve() -> BudgetReservation:
            if self._pending is not None:
                _issue("reservation_pending")
            counted_input = _exact_int(input_tokens, "input_token_count_invalid")
            requested_output = _exact_int(
                requested_output_tokens, "output_token_request_invalid", minimum=1
            )
            elapsed = _exact_int(elapsed_wall_ms, "wall_time_invalid")
            if elapsed < self._elapsed_ms:
                _issue("wall_time_invalid")
            if elapsed > self._budget.max_wall_seconds * 1_000:
                _issue("wall_time_exceeded")
            if self._calls + 1 > self._budget.max_calls:
                _issue("call_limit_exceeded")
            if requested_output > self._budget.max_output_tokens_per_call:
                _issue("output_per_call_exceeded")
            if self._input_tokens + counted_input > self._budget.max_input_tokens:
                _issue("input_token_limit_exceeded")
            if self._output_tokens + requested_output > self._budget.max_output_tokens:
                _issue("output_token_limit_exceeded")
            reserved_cost = _call_cost(counted_input, requested_output, self._pricing)
            if self._cost > self._budget.max_cost_micro_units - reserved_cost:
                _issue("cost_limit_exceeded")
            reservation = BudgetReservation(
                call_number=self._calls + 1,
                input_tokens=counted_input,
                requested_output_tokens=requested_output,
                reserved_cost_micro_units=reserved_cost,
            )
            self._pending = reservation
            self._elapsed_ms = elapsed
            return reservation

        return _public_call(
            reserve,
            internal_error_code=PAPER_SLIDE_BUDGET_EXCEEDED,
            internal_issue_code="budget_internal_failure",
        )

    def reconcile_call(
        self,
        reservation: BudgetReservation,
        *,
        input_tokens: int,
        output_tokens: int,
        elapsed_wall_ms: int,
    ) -> GenerationUsage:
        def reconcile() -> GenerationUsage:
            if type(reservation) is not BudgetReservation or reservation is not self._pending:
                _issue("provider_usage_reservation_mismatch", provider=True)
            actual_input = _exact_int(input_tokens, "provider_usage_invalid", provider=True)
            actual_output = _exact_int(output_tokens, "provider_usage_invalid", provider=True)
            elapsed = _exact_int(elapsed_wall_ms, "provider_usage_invalid", provider=True)
            if elapsed < self._elapsed_ms:
                _issue("provider_usage_invalid", provider=True)
            if elapsed > self._budget.max_wall_seconds * 1_000:
                _issue("wall_time_exceeded")
            if (
                actual_input > reservation.input_tokens
                or actual_output > reservation.requested_output_tokens
            ):
                _issue("provider_usage_mismatch", provider=True)
            actual_cost = _call_cost(actual_input, actual_output, self._pricing)
            if self._cost > self._budget.max_cost_micro_units - actual_cost:
                _issue("cost_limit_exceeded")
            self._calls += 1
            self._input_tokens += actual_input
            self._output_tokens += actual_output
            self._cost += actual_cost
            self._elapsed_ms = elapsed
            self._pending = None
            return self.usage

        return _public_call(
            reconcile,
            internal_error_code=PAPER_SLIDE_PROVIDER_FAILED,
            internal_issue_code="provider_usage_internal_failure",
        )


def _validate_hash_record(value: object) -> GenerationInputHashRecord:
    if type(value) is not GenerationInputHashRecord:
        _issue("input_hash_record_invalid")
    _valid_name(value.paper_id, _PAPER_ID_RE, "input_hash_record_invalid")
    if type(value.coverage_kind) is not str or value.coverage_kind not in _COVERAGE_KINDS:
        _issue("input_hash_record_invalid")
    if type(value.source) is not ResolvedPDFSource or value.source.paper_id != value.paper_id:
        _issue("input_hash_record_invalid")
    source = value.source
    try:
        canonical_source = resolve_pdf_source(
            {
                "paper_id": source.paper_id,
                "source": source.source,
                "source_id": source.source_id,
                "landing_url": source.landing_url,
                "arxiv_url": source.landing_url,
                "pdf_url": source.pdf_url,
            }
        )
    except SourceResolutionError:
        _issue("input_hash_record_invalid")
    if canonical_source != source:
        _issue("input_hash_record_invalid")
    _valid_name(value.content_sha256, _SHA256_RE, "input_hash_record_invalid")
    if type(value.ordered_chunk_sha256s) is not tuple:
        _issue("input_hash_record_invalid")
    if value.coverage_kind == "full_text":
        if not value.ordered_chunk_sha256s:
            _issue("input_hash_record_invalid")
    elif value.ordered_chunk_sha256s:
        _issue("input_hash_record_invalid")
    if (
        len(value.ordered_chunk_sha256s) > 64
        or len(value.ordered_chunk_sha256s) != len(set(value.ordered_chunk_sha256s))
        or any(
            type(item) is not str or _SHA256_RE.fullmatch(item) is None
            for item in value.ordered_chunk_sha256s
        )
    ):
        _issue("input_hash_record_invalid")
    if (
        type(value.language) is not str
        or value.language not in _LANGUAGES
        or type(value.deck_profile) is not str
        or value.deck_profile != _DECK_PROFILE
    ):
        _issue("input_hash_record_invalid")
    _valid_name(value.extractor, _EXTRACTOR_RE, "input_hash_record_invalid")
    _valid_name(value.generation_config_sha256, _SHA256_RE, "input_hash_record_invalid")
    _valid_name(value.metadata_sha256, _SHA256_RE, "input_hash_record_invalid")
    generated_at = _valid_utc(value.generated_at, "input_hash_record_invalid")
    if value.fetched_at is not None:
        fetched_at = _valid_utc(value.fetched_at, "input_hash_record_invalid")
        if fetched_at > generated_at:
            _issue("input_hash_record_invalid")
    if value.coverage_kind == "full_text":
        if (
            type(value.page_count) is not int
            or type(value.extracted_page_count) is not int
            or not 1 <= value.extracted_page_count <= value.page_count <= 128
            or value.fetched_at is None
        ):
            _issue("input_hash_record_invalid")
    elif any(
        item is not None
        for item in (value.fetched_at, value.page_count, value.extracted_page_count)
    ):
        _issue("input_hash_record_invalid")
    for item in (
        value.generator_version,
        value.prompt_content_version,
        value.prompt_envelope_version,
        value.schema_version,
        value.pricing_version,
    ):
        _valid_name(item, _VERSION_RE, "input_hash_record_invalid")
    _validate_provider_identity(value.provider_identity)
    return value


def _input_identity(value: GenerationInputHashRecord) -> dict[str, object]:
    provider = value.provider_identity
    return {
        "version": INPUT_HASH_VERSION,
        "paper_id": value.paper_id,
        "coverage_kind": value.coverage_kind,
        "source": {
            "source": value.source.source,
            "source_id": value.source.source_id,
            "landing_url": value.source.landing_url,
            "pdf_url": value.source.pdf_url,
            "access": value.source.access,
            "license": value.source.license,
            "license_evidence_url": value.source.license_evidence_url,
        },
        "content_sha256": value.content_sha256,
        "ordered_chunk_sha256s": list(value.ordered_chunk_sha256s),
        "language": value.language,
        "deck_profile": value.deck_profile,
        "extractor": value.extractor,
        "metadata_sha256": value.metadata_sha256,
        "fetched_at": value.fetched_at.strftime("%Y-%m-%dT%H:%M:%SZ")
        if value.fetched_at is not None
        else None,
        "generated_at": value.generated_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "page_count": value.page_count,
        "extracted_page_count": value.extracted_page_count,
        "provider": {
            "provider": provider.provider,
            "model": provider.model,
            "adapter_version": provider.adapter_version,
        },
        "generation_config_sha256": value.generation_config_sha256,
        "generator_version": value.generator_version,
        "prompt_content_version": value.prompt_content_version,
        "prompt_envelope_version": value.prompt_envelope_version,
        "schema_version": value.schema_version,
        "pricing_version": value.pricing_version,
    }


def _canonical_hash(value: object) -> str:
    digest = canonical_json_sha256(value)
    if type(digest) is not str or _SHA256_RE.fullmatch(digest) is None:
        _issue("hash_calculation_failed")
    return digest


def calculate_input_sha256(record: GenerationInputHashRecord) -> str:
    """Hash only closed identity/provenance and precomputed content hashes."""

    def calculate() -> str:
        trusted = _validate_hash_record(record)
        return _canonical_hash(_input_identity(trusted))

    return _public_call(
        calculate,
        internal_error_code=PAPER_SLIDE_BUDGET_EXCEEDED,
        internal_issue_code="input_hash_internal_failure",
    )


def calculate_cache_key(
    record: GenerationInputHashRecord,
    *,
    candidate_sha256: str,
    budget_policy_version: str = BUDGET_POLICY_VERSION,
    license_policy_version: str = LICENSE_POLICY_VERSION,
) -> str:
    """Return a versioned key binding identity to exact candidate bytes."""

    def calculate() -> str:
        trusted = _validate_hash_record(record)
        budget_version = _valid_name(
            budget_policy_version, _VERSION_RE, "cache_policy_version_invalid"
        )
        license_version = _valid_name(
            license_policy_version, _VERSION_RE, "cache_policy_version_invalid"
        )
        candidate = _valid_name(candidate_sha256, _SHA256_RE, "candidate_hash_invalid")
        digest = _canonical_hash(
            {
                "version": CACHE_KEY_VERSION,
                "input_sha256": _canonical_hash(_input_identity(trusted)),
                "budget_policy_version": budget_version,
                "license_policy_version": license_version,
                "candidate_sha256": candidate,
            }
        )
        return digest

    return _public_call(
        calculate,
        internal_error_code=PAPER_SLIDE_BUDGET_EXCEEDED,
        internal_issue_code="cache_key_internal_failure",
    )


def input_sha256(record: GenerationInputHashRecord) -> str:
    """Public contract spelling for the deterministic SD2 input digest."""

    return calculate_input_sha256(record)


def cache_key(
    record: GenerationInputHashRecord,
    *,
    candidate_sha256: str,
    budget_policy_version: str = BUDGET_POLICY_VERSION,
    license_policy_version: str = LICENSE_POLICY_VERSION,
) -> str:
    """Public contract spelling for the deterministic SD2 cache digest."""

    return calculate_cache_key(
        record,
        candidate_sha256=candidate_sha256,
        budget_policy_version=budget_policy_version,
        license_policy_version=license_policy_version,
    )


__all__ = [
    "BUDGET_POLICY_VERSION",
    "CACHE_KEY_VERSION",
    "DEFAULT_MAX_CALLS",
    "DEFAULT_MAX_COST_MICRO_UNITS",
    "DEFAULT_MAX_INPUT_TOKENS",
    "DEFAULT_MAX_OUTPUT_TOKENS",
    "DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL",
    "DEFAULT_MAX_WALL_SECONDS",
    "HARD_MAX_CALLS",
    "HARD_MAX_INPUT_TOKENS",
    "HARD_MAX_OUTPUT_TOKENS",
    "HARD_MAX_OUTPUT_TOKENS_PER_CALL",
    "HARD_MAX_WALL_SECONDS",
    "INPUT_HASH_VERSION",
    "LICENSE_POLICY_VERSION",
    "BudgetReservation",
    "GenerationBudget",
    "GenerationInputHashRecord",
    "GenerationUsage",
    "GenerationUsageLedger",
    "PricingSnapshot",
    "ProviderIdentity",
    "SlideGenerationBudgetError",
    "cache_key",
    "calculate_cache_key",
    "calculate_input_sha256",
    "input_sha256",
]

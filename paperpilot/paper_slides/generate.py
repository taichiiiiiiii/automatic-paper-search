"""Offline SD2 coordinator for grounded, provisional paper slide decks.

The coordinator owns provider call ordering and trusted-envelope construction.
Paper text and provider payloads are ephemeral and are deliberately hidden from
``repr`` and from the returned cache identity.
"""

from __future__ import annotations

import hashlib
import re
import time
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import MappingProxyType
from typing import NoReturn, Protocol, TypeGuard, TypeVar, cast

from paperpilot.paper_slides.contract import (
    ABSTRACT_ONLY_LABEL,
    ABSTRACT_ONLY_LABEL_EN,
    AUTH_VALUE_RE,
    DECK_PROFILE,
    EMAIL_SEARCH_RE,
    FULL_TEXT_LABEL,
    FULL_TEXT_LABEL_EN,
    KNOWN_TOKEN_RE,
    MACHINE_SUMMARY_LIMITATION,
    MACHINE_SUMMARY_LIMITATION_EN,
    PAPER_SLIDE_BUDGET_EXCEEDED,
    PAPER_SLIDE_CITATION_INVALID,
    PAPER_SLIDE_OUTPUT_INVALID,
    PAPER_SLIDE_PROVIDER_FAILED,
    PAPER_SLIDE_REQUEST_INVALID,
    PRIVATE_KEY_RE,
    PRODUCER,
    PROMPT_VERSION,
    SECRET_ASSIGNMENT_RE,
    SECRET_QUERY_RE,
    SLIDE_DECK_VERSION,
    UNSAFE_GENERATED_TEXT_RE,
    URL_USERINFO_RE,
    PdfChunkReference,
    SlideDeckValidationContext,
    SlideDeckValidationError,
    canonical_slide_deck_bytes,
    derive_deck_id,
    trusted_envelope_sha256,
)
from paperpilot.paper_slides.extract import (
    MAX_CHUNKS,
    MAX_PAGES,
    PdfExtractionOptions,
    PdfExtractionResult,
    PdfTextChunk,
    _sanitize_page_text,
    _validate_options,
)
from paperpilot.paper_slides.generator_budget import (
    BUDGET_POLICY_VERSION,
    GenerationBudget,
    GenerationInputHashRecord,
    GenerationUsage,
    GenerationUsageLedger,
    PricingSnapshot,
    ProviderIdentity,
    SlideGenerationBudgetError,
    calculate_cache_key,
    calculate_input_sha256,
)
from paperpilot.paper_slides.generator_contract import (
    MAX_PROVIDER_PAYLOAD_BYTES,
    ChunkSummary,
    DeckContent,
    GeneratorClaim,
    SlideGeneratorContractError,
    load_chunk_summary,
    load_deck_content,
)
from paperpilot.paper_slides.generator_prompt import (
    COMPOSITION_STAGE,
    PROMPT_CONTENT_VERSION,
    PROMPT_REQUEST_VERSION,
    SlideGeneratorPromptError,
    SlidePromptRequest,
    UntrustedPromptRecord,
    build_claim_request,
    canonical_prompt_data_bytes,
    plan_chunk_summary_calls,
)
from paperpilot.paper_slides.pipeline import BoundPdfExtraction
from paperpilot.paper_slides.provider_execution import (
    PreparedProviderExecution,
    ProviderExecutionError,
)
from paperpilot.paper_slides.resolver import (
    ResolvedPDFSource,
    SourceResolutionError,
    resolve_pdf_source,
)
from paperpilot.replay import canonical_json_sha256

GENERATOR_VERSION = "2"
ABSTRACT_EXTRACTOR = "abstract-only:1"
MAX_ABSTRACT_CODEPOINTS = 48_000
MIN_ABSTRACT_CODEPOINTS = 500
CHUNK_SUMMARY_MAX_OUTPUT_TOKENS = 2_000
COMPOSITION_MAX_OUTPUT_TOKENS = 4_000
VERBATIM_NGRAM_TOKENS = 6
MAX_VERBATIM_CONTIGUOUS_TOKENS = 24
MAX_VERBATIM_SINGLE_TOKEN_CODEPOINTS = 80
MIN_VERBATIM_AGGREGATE_TOKENS = 30
MAX_VERBATIM_AGGREGATE_PERCENT = 35

ALLOWED_PROVIDER_MODELS = frozenset({("qwen", "qwen3.7-max")})
_TEST_FIXTURE_PROVIDER_MODEL = ("fixture-provider", "fixture-model")
_PricingRecord = tuple[str, str, str, int, int, int, datetime, datetime, str]

# No live adapter is part of SD2 core. Production authorization remains empty
# until a concrete adapter type and an independently verified price snapshot are
# added by the separately gated adapter unit. Provider/model strings alone are
# never sufficient authorization.
_PRODUCTION_ADAPTER_TYPES: Mapping[tuple[str, str], type[object]] = MappingProxyType({})
_PRODUCTION_PRICING_REGISTRY: Mapping[tuple[str, str], _PricingRecord] = MappingProxyType({})
_TEST_FIXTURE_PRICING_RECORD: _PricingRecord = (
    "fixture-provider",
    "fixture-model",
    "USD",
    0,
    0,
    1_000_000,
    datetime(2026, 1, 1, tzinfo=timezone.utc),
    datetime(2027, 1, 1, tzinfo=timezone.utc),
    "fixture-pricing-v1",
)

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PAPER_ID_RE = re.compile(r"^[0-9a-f]{40}$")
_ADAPTER_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_UNSAFE_CATALOG_URL_RE = re.compile(
    r"(?:\b[a-z][a-z0-9+.-]*://|\b(?:file|mailto|tel|urn|doi|s3|gs):|\bwww\.)",
    re.IGNORECASE,
)
_OVERLAP_TOKEN_RE = re.compile(r"[a-z0-9]+|[^\W_a-z0-9]", re.IGNORECASE | re.UNICODE)
_T = TypeVar("_T")
_MISSING = object()


class SlideGenerationError(ValueError):
    """Stable coordinator failure containing no paper or provider prose."""

    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__(f"{error_code}:{issue_code}")


class _GenerationIssueError(Exception):
    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__()


@dataclass(frozen=True)
class FullTextGenerationInput:
    bound_extraction: BoundPdfExtraction = field(repr=False)


@dataclass(frozen=True)
class AbstractOnlyGenerationInput:
    source: ResolvedPDFSource
    abstract: str = field(repr=False)
    abstract_sha256: str


@dataclass(frozen=True)
class SlideGenerationInput:
    paper_id: str
    language: str
    deck_profile: str
    title: str = field(repr=False)
    authors: tuple[str, ...] = field(repr=False)
    coverage: FullTextGenerationInput | AbstractOnlyGenerationInput = field(repr=False)
    fetched_at: datetime | None
    generated_at: datetime


@dataclass(frozen=True)
class ProviderJsonResponse:
    identity: ProviderIdentity
    request_sha256: str
    payload: bytes = field(repr=False)
    input_tokens: int
    output_tokens: int
    provider_request_id_sha256: str | None


@dataclass(frozen=True)
class SlideGenerationResult:
    deck_bytes: bytes = field(repr=False)
    usage: GenerationUsage
    input_sha256: str
    cache_key: str
    provider_request_id_sha256s: tuple[str, ...]


class StructuredSlideProvider(Protocol):
    @property
    def identity(self) -> ProviderIdentity: ...

    def count_tokens(self, request: SlidePromptRequest, *, remaining_wall_ms: int) -> int: ...

    def generate_json(
        self,
        request: SlidePromptRequest,
        *,
        max_output_tokens: int,
        remaining_wall_ms: int,
    ) -> ProviderJsonResponse: ...


@dataclass(frozen=True)
class _TrustedInput:
    paper_id: str
    language: str
    deck_profile: str
    title: str = field(repr=False)
    authors: tuple[str, ...] = field(repr=False)
    fetched_at: datetime | None
    generated_at: datetime
    source: ResolvedPDFSource
    coverage_kind: str
    records: tuple[UntrustedPromptRecord, ...] = field(repr=False)
    record_references: Mapping[str, PdfChunkReference] = field(repr=False)
    content_sha256: str
    ordered_chunk_sha256s: tuple[str, ...]
    extractor: str
    page_count: int | None
    extracted_page_count: int | None


def _fail(error_code: str, issue_code: str) -> NoReturn:
    raise _GenerationIssueError(error_code, issue_code)


def _utc(value: object, issue: str, *, optional: bool = False) -> datetime | None:
    if optional and value is None:
        return None
    if (
        type(value) is not datetime
        or value.tzinfo is not timezone.utc
        or value.utcoffset() is None
        or value.microsecond != 0
    ):
        _fail(PAPER_SLIDE_REQUEST_INVALID, issue)
    return value


def _timestamp(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def _catalog_text(value: object, *, maximum: int, issue: str) -> str:
    if (
        type(value) is not str
        or not value
        or not value.strip()
        or len(value) > maximum
        or value != value.strip()
        or unicodedata.normalize("NFKC", value) != value
        or UNSAFE_GENERATED_TEXT_RE.search(value) is not None
        or _UNSAFE_CATALOG_URL_RE.search(value) is not None
        or EMAIL_SEARCH_RE.search(value) is not None
        or any(
            pattern.search(value) is not None
            for pattern in (
                AUTH_VALUE_RE,
                URL_USERINFO_RE,
                SECRET_QUERY_RE,
                KNOWN_TOKEN_RE,
                PRIVATE_KEY_RE,
                SECRET_ASSIGNMENT_RE,
            )
        )
        or any(unicodedata.category(character).startswith("C") for character in value)
    ):
        _fail(PAPER_SLIDE_REQUEST_INVALID, issue)
    return value


def _is_exact_resolved_source(value: object) -> TypeGuard[ResolvedPDFSource]:
    return type(value) is ResolvedPDFSource


def _canonical_source(value: object, paper_id: str) -> ResolvedPDFSource:
    if not _is_exact_resolved_source(value):
        _fail(PAPER_SLIDE_REQUEST_INVALID, "source_invalid")
    source = value
    if source.paper_id != paper_id:
        _fail(PAPER_SLIDE_REQUEST_INVALID, "source_invalid")
    row = {
        "paper_id": source.paper_id,
        "source": source.source,
        "source_id": source.source_id,
        "landing_url": source.landing_url,
        "arxiv_url": source.landing_url,
        "pdf_url": source.pdf_url,
    }
    try:
        expected = resolve_pdf_source(row)
    except SourceResolutionError:
        expected = None
    if expected != source:
        _fail(PAPER_SLIDE_REQUEST_INVALID, "source_invalid")
    # ``source`` belongs to the caller and frozen dataclasses remain mutable via
    # ``object.__setattr__``.  Keep only the freshly resolved canonical object.
    assert expected is not None
    return expected


def _validate_common(value: object, generated_at: object) -> SlideGenerationInput:
    if type(value) is not SlideGenerationInput:
        _fail(PAPER_SLIDE_REQUEST_INVALID, "generation_input_type")
    request = value
    if type(request.paper_id) is not str or _PAPER_ID_RE.fullmatch(request.paper_id) is None:
        _fail(PAPER_SLIDE_REQUEST_INVALID, "paper_id_invalid")
    if request.language not in {"ja", "en"} or request.deck_profile != DECK_PROFILE:
        _fail(PAPER_SLIDE_REQUEST_INVALID, "generation_profile_invalid")
    _catalog_text(request.title, maximum=1_000, issue="catalog_title_invalid")
    if type(request.authors) is not tuple or not 1 <= len(request.authors) <= 100:
        _fail(PAPER_SLIDE_REQUEST_INVALID, "catalog_authors_invalid")
    for author in request.authors:
        _catalog_text(author, maximum=300, issue="catalog_authors_invalid")
    checked_generated_at = _utc(request.generated_at, "generated_at_invalid")
    checked_clock = _utc(generated_at, "generated_at_clock_invalid")
    if checked_generated_at != checked_clock:
        _fail(PAPER_SLIDE_REQUEST_INVALID, "generated_at_clock_mismatch")
    return request


def _validate_bound(request: SlideGenerationInput, value: object) -> _TrustedInput:
    if (
        type(value) is not FullTextGenerationInput
        or type(value.bound_extraction) is not BoundPdfExtraction
    ):
        _fail(PAPER_SLIDE_REQUEST_INVALID, "full_text_input_invalid")
    bound = value.bound_extraction
    source = _canonical_source(bound.source, request.paper_id)
    fetched_at = _utc(request.fetched_at, "fetched_at_invalid")
    assert fetched_at is not None
    if fetched_at > request.generated_at:
        _fail(PAPER_SLIDE_REQUEST_INVALID, "timestamp_order_invalid")
    extraction = bound.extraction
    if (
        type(extraction) is not PdfExtractionResult
        or type(extraction.options) is not PdfExtractionOptions
        or type(bound.byte_count) is not int
        or not 5 <= bound.byte_count <= 32 * 1024 * 1024
        or type(extraction.pdf_sha256) is not str
        or _SHA256_RE.fullmatch(extraction.pdf_sha256) is None
        or type(extraction.page_count) is not int
        or not 1 <= extraction.page_count <= MAX_PAGES
        or type(extraction.extracted_page_count) is not int
        or not 1 <= extraction.extracted_page_count <= extraction.page_count
        or type(extraction.chunks) is not tuple
        or not 1 <= len(extraction.chunks) <= MAX_CHUNKS
        or type(extraction.extractor) is not str
        or not extraction.extractor
        or type(bound.pdf_chunks) is not type(MappingProxyType({}))
    ):
        _fail(PAPER_SLIDE_REQUEST_INVALID, "full_text_binding_invalid")
    try:
        _validate_options(extraction.options)
    except Exception:
        _fail(PAPER_SLIDE_REQUEST_INVALID, "full_text_binding_invalid")
    records: list[UntrustedPromptRecord] = []
    references: dict[str, PdfChunkReference] = {}
    bound_references = cast(Mapping[str, PdfChunkReference], bound.pdf_chunks)
    previous_page = 0
    page_counts: dict[int, int] = {}
    page_codepoints: dict[int, int] = {}
    total = 0
    seen_text: set[str] = set()
    for chunk in extraction.chunks:
        if type(chunk) is not PdfTextChunk:
            _fail(PAPER_SLIDE_REQUEST_INVALID, "full_text_chunk_invalid")
        page_counts[chunk.page] = page_counts.get(chunk.page, 0) + 1
        expected_id = f"p{chunk.page:03d}-c{page_counts[chunk.page]:02d}"
        expected_hash = hashlib.sha256(chunk.text.encode("utf-8")).hexdigest()
        expected_hint = chunk.text.partition("\n")[0].strip()[:160].rstrip() or None
        if (
            type(chunk.page) is not int
            or not 1 <= chunk.page <= extraction.page_count
            or chunk.page < previous_page
            or type(chunk.chunk_id) is not str
            or chunk.chunk_id != expected_id
            or type(chunk.text) is not str
            or not chunk.text
            or len(chunk.text) > extraction.options.max_chunk_codepoints
            or _sanitize_page_text(chunk.text) != chunk.text
            or chunk.text in seen_text
            or chunk.sha256 != expected_hash
            or chunk.section_hint != expected_hint
        ):
            _fail(PAPER_SLIDE_REQUEST_INVALID, "full_text_chunk_invalid")
        page_codepoints[chunk.page] = page_codepoints.get(chunk.page, 0) + len(chunk.text)
        total += len(chunk.text)
        reference = bound_references.get(chunk.chunk_id)
        expected_anchor = f"{source.pdf_url}#page={chunk.page}"
        expected_reference = PdfChunkReference(
            page=chunk.page,
            sha256=chunk.sha256,
            source_anchor=expected_anchor,
            pdf_sha256=extraction.pdf_sha256,
        )
        if type(reference) is not PdfChunkReference or reference != expected_reference:
            _fail(PAPER_SLIDE_REQUEST_INVALID, "full_text_reference_invalid")
        if (
            page_codepoints[chunk.page] > extraction.options.max_page_codepoints
            or total > extraction.options.max_total_codepoints
        ):
            _fail(PAPER_SLIDE_REQUEST_INVALID, "full_text_chunk_invalid")
        records.append(UntrustedPromptRecord(chunk.chunk_id, chunk.text))
        references[chunk.chunk_id] = reference
        previous_page = chunk.page
        seen_text.add(chunk.text)
    if (
        len(bound_references) != len(references)
        or len(page_counts) != extraction.extracted_page_count
        or total < extraction.options.minimum_text_codepoints
    ):
        _fail(PAPER_SLIDE_REQUEST_INVALID, "full_text_binding_invalid")
    return _TrustedInput(
        paper_id=str(request.paper_id),
        language=str(request.language),
        deck_profile=str(request.deck_profile),
        title=str(request.title),
        authors=tuple(str(author) for author in request.authors),
        fetched_at=fetched_at,
        generated_at=cast(datetime, _utc(request.generated_at, "generated_at_invalid")),
        source=source,
        coverage_kind="full_text",
        records=tuple(records),
        record_references=MappingProxyType(references),
        content_sha256=extraction.pdf_sha256,
        ordered_chunk_sha256s=tuple(chunk.sha256 for chunk in extraction.chunks),
        extractor=extraction.extractor,
        page_count=extraction.page_count,
        extracted_page_count=extraction.extracted_page_count,
    )


def _validate_abstract(request: SlideGenerationInput, value: object) -> _TrustedInput:
    if type(value) is not AbstractOnlyGenerationInput or request.fetched_at is not None:
        _fail(PAPER_SLIDE_REQUEST_INVALID, "abstract_input_invalid")
    source = _canonical_source(value.source, request.paper_id)
    abstract = value.abstract
    if (
        type(abstract) is not str
        or not MIN_ABSTRACT_CODEPOINTS <= len(abstract) <= MAX_ABSTRACT_CODEPOINTS
        or not abstract.strip()
        or type(value.abstract_sha256) is not str
        or _SHA256_RE.fullmatch(value.abstract_sha256) is None
        or hashlib.sha256(abstract.encode("utf-8")).hexdigest() != value.abstract_sha256
    ):
        _fail(PAPER_SLIDE_REQUEST_INVALID, "abstract_input_invalid")
    reference = PdfChunkReference(
        page=0,
        sha256=value.abstract_sha256,
        source_anchor=source.landing_url,
        pdf_sha256=value.abstract_sha256,
    )
    return _TrustedInput(
        paper_id=str(request.paper_id),
        language=str(request.language),
        deck_profile=str(request.deck_profile),
        title=str(request.title),
        authors=tuple(str(author) for author in request.authors),
        fetched_at=None,
        generated_at=cast(datetime, _utc(request.generated_at, "generated_at_invalid")),
        source=source,
        coverage_kind="abstract_only",
        records=(UntrustedPromptRecord("abstract", abstract),),
        record_references=MappingProxyType({"abstract": reference}),
        content_sha256=value.abstract_sha256,
        ordered_chunk_sha256s=(),
        extractor=ABSTRACT_EXTRACTOR,
        page_count=None,
        extracted_page_count=None,
    )


def _validate_input(
    value: object, *, generated_at: object, allow_test_full_text: bool
) -> _TrustedInput:
    request = _validate_common(value, generated_at)
    if type(request.coverage) is FullTextGenerationInput:
        # No production-visible-text attestation exists yet.  Extractor names,
        # including values that look like verifier versions, are untrusted prose
        # and cannot open this boundary.
        extraction = request.coverage.bound_extraction.extraction
        if (
            not allow_test_full_text
            or type(extraction) is not PdfExtractionResult
            or extraction.extractor != "visible-text-v1:test"
        ):
            _fail(PAPER_SLIDE_REQUEST_INVALID, "full_text_visibility_unattested")
        return _validate_bound(request, request.coverage)
    if type(request.coverage) is AbstractOnlyGenerationInput:
        return _validate_abstract(request, request.coverage)
    _fail(PAPER_SLIDE_REQUEST_INVALID, "coverage_input_invalid")


def _validate_identity(value: object, *, allow_test_fixture: bool = False) -> ProviderIdentity:
    if type(value) is not ProviderIdentity:
        _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_identity_invalid")
    identity = value
    pair = (identity.provider, identity.model)
    if pair == _TEST_FIXTURE_PROVIDER_MODEL and not allow_test_fixture:
        _fail(PAPER_SLIDE_PROVIDER_FAILED, "fixture_provider_not_allowed")
    if pair not in ALLOWED_PROVIDER_MODELS and not (
        allow_test_fixture and pair == _TEST_FIXTURE_PROVIDER_MODEL
    ):
        _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_model_not_allowed")
    if (
        type(identity.adapter_version) is not str
        or _ADAPTER_VERSION_RE.fullmatch(identity.adapter_version) is None
    ):
        _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_identity_invalid")
    return ProviderIdentity(
        provider=str(identity.provider),
        model=str(identity.model),
        adapter_version=str(identity.adapter_version),
    )


def _authorize_provider_and_pricing(
    provider: StructuredSlideProvider,
    identity: ProviderIdentity,
    pricing: PricingSnapshot | None,
    *,
    allow_test_fixture: bool,
) -> PricingSnapshot:
    pair = (identity.provider, identity.model)
    registered_record: _PricingRecord | None
    if allow_test_fixture:
        if pair != _TEST_FIXTURE_PROVIDER_MODEL:
            _fail(PAPER_SLIDE_PROVIDER_FAILED, "fixture_provider_required")
        registered_record = _TEST_FIXTURE_PRICING_RECORD
    else:
        registered_type = _PRODUCTION_ADAPTER_TYPES.get(pair)
        if registered_type is None or type(provider) is not registered_type:
            _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_adapter_not_registered")
        registered_record = _PRODUCTION_PRICING_REGISTRY.get(pair)
        if registered_record is None:
            _fail(PAPER_SLIDE_BUDGET_EXCEEDED, "pricing_unknown")
    registered_pricing = PricingSnapshot(*registered_record)
    if type(pricing) is not PricingSnapshot or pricing != registered_pricing:
        _fail(PAPER_SLIDE_BUDGET_EXCEEDED, "pricing_unknown")
    return PricingSnapshot(**registered_pricing.__dict__)


def _detached_provider_request(request: SlidePromptRequest) -> SlidePromptRequest:
    detached = SlidePromptRequest(
        call_id=str(request.call_id),
        request_version=str(request.request_version),
        stage=str(request.stage),
        system_instruction=str(request.system_instruction),
        language=str(request.language),
        output_contract=str(request.output_contract),
        untrusted_records=tuple(
            UntrustedPromptRecord(record_id=str(item.record_id), text=str(item.text))
            for item in request.untrusted_records
        ),
        prior_claims=tuple(
            GeneratorClaim(
                claim_id=str(claim.claim_id),
                claim_kind=str(claim.claim_kind),
                text=str(claim.text),
                record_ids=tuple(str(record_id) for record_id in claim.record_ids),
            )
            for claim in request.prior_claims
        ),
        canonical_data=bytes(request.canonical_data),
    )
    if _request_sha256(detached) != _request_sha256(request):
        _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_request_copy_failed")
    return detached


def _request_sha256(request: SlidePromptRequest) -> str:
    data = canonical_prompt_data_bytes(request)
    digest = canonical_json_sha256(
        {
            "call_id": request.call_id,
            "request_version": request.request_version,
            "stage": request.stage,
            "system_instruction": request.system_instruction,
            "canonical_data_sha256": hashlib.sha256(data).hexdigest(),
        }
    )
    if type(digest) is not str or _SHA256_RE.fullmatch(digest) is None:
        _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_request_hash_failed")
    return digest


def _elapsed_ms(start_ns: int) -> int:
    return max(0, (time.monotonic_ns() - start_ns) // 1_000_000)


def _remaining_wall_ms(ledger: GenerationUsageLedger, start_ns: int) -> int:
    remaining = ledger.budget.max_wall_seconds * 1_000 - _elapsed_ms(start_ns)
    if remaining <= 0:
        _fail(PAPER_SLIDE_BUDGET_EXCEEDED, "wall_time_exceeded")
    return remaining


def _configuration_unchanged(
    provider: StructuredSlideProvider,
    identity: ProviderIdentity,
    pricing: PricingSnapshot | None,
    pricing_snapshot: PricingSnapshot,
    budget: GenerationBudget,
    budget_snapshot: GenerationBudget,
    *,
    allow_test_fixture: bool,
) -> bool:
    try:
        current_identity = _validate_identity(
            provider.identity, allow_test_fixture=allow_test_fixture
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        return False
    return (
        current_identity == identity
        and type(pricing) is PricingSnapshot
        and pricing == pricing_snapshot
        and type(budget) is GenerationBudget
        and budget == budget_snapshot
    )


def _prepared_configuration_unchanged(
    execution: PreparedProviderExecution,
    provider: StructuredSlideProvider,
    identity: ProviderIdentity,
    pricing: PricingSnapshot,
    budget: GenerationBudget,
    ledger: GenerationUsageLedger,
) -> bool:
    try:
        return (
            execution.require_provider() is provider
            and execution.identity == identity
            and execution.pricing == pricing
            and execution.budget == budget
            and execution.new_usage_ledger() is ledger
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        return False


def _provider_call(
    provider: StructuredSlideProvider,
    identity: ProviderIdentity,
    ledger: GenerationUsageLedger,
    request: SlidePromptRequest,
    *,
    max_output_tokens: int,
    start_ns: int,
    pricing: PricingSnapshot | None,
    pricing_snapshot: PricingSnapshot,
    budget: GenerationBudget,
    budget_snapshot: GenerationBudget,
    allow_test_fixture: bool,
    prepared_execution: PreparedProviderExecution | None = None,
) -> ProviderJsonResponse:
    provider_request = _detached_provider_request(request)
    expected_hash = _request_sha256(provider_request)
    configuration_unchanged = (
        _prepared_configuration_unchanged(
            prepared_execution,
            provider,
            identity,
            pricing_snapshot,
            budget_snapshot,
            ledger,
        )
        if prepared_execution is not None
        else _configuration_unchanged(
            provider,
            identity,
            pricing,
            pricing_snapshot,
            budget,
            budget_snapshot,
            allow_test_fixture=allow_test_fixture,
        )
    )
    if not configuration_unchanged:
        _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_request_tampered")
    try:
        input_tokens = provider.count_tokens(
            provider_request, remaining_wall_ms=_remaining_wall_ms(ledger, start_ns)
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_token_count_failed")
    if type(input_tokens) is not int or input_tokens < 0:
        _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_token_count_invalid")
    # ``count_tokens`` is adapter code. Revalidate the frozen request after it
    # returns so even deliberate ``object.__setattr__`` tampering cannot reach
    # the paid generation boundary.
    try:
        request_unchanged = _request_sha256(provider_request) == expected_hash
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        request_unchanged = False
    configuration_unchanged = (
        _prepared_configuration_unchanged(
            prepared_execution,
            provider,
            identity,
            pricing_snapshot,
            budget_snapshot,
            ledger,
        )
        if prepared_execution is not None
        else _configuration_unchanged(
            provider,
            identity,
            pricing,
            pricing_snapshot,
            budget,
            budget_snapshot,
            allow_test_fixture=allow_test_fixture,
        )
    )
    if not request_unchanged or not configuration_unchanged:
        _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_request_tampered")
    reservation = ledger.reserve_call(
        input_tokens=input_tokens,
        requested_output_tokens=max_output_tokens,
        elapsed_wall_ms=_elapsed_ms(start_ns),
    )
    try:
        response = provider.generate_json(
            provider_request,
            max_output_tokens=max_output_tokens,
            remaining_wall_ms=_remaining_wall_ms(ledger, start_ns),
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_call_failed")
    try:
        request_unchanged = _request_sha256(provider_request) == expected_hash
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        request_unchanged = False
    configuration_unchanged = (
        _prepared_configuration_unchanged(
            prepared_execution,
            provider,
            identity,
            pricing_snapshot,
            budget_snapshot,
            ledger,
        )
        if prepared_execution is not None
        else _configuration_unchanged(
            provider,
            identity,
            pricing,
            pricing_snapshot,
            budget,
            budget_snapshot,
            allow_test_fixture=allow_test_fixture,
        )
    )
    if not request_unchanged or not configuration_unchanged:
        _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_request_tampered")
    if (
        type(response) is not ProviderJsonResponse
        or type(response.identity) is not ProviderIdentity
        or response.identity != identity
        or type(response.request_sha256) is not str
        or response.request_sha256 != expected_hash
        or type(response.payload) is not bytes
        or not response.payload
        or len(response.payload) > MAX_PROVIDER_PAYLOAD_BYTES
        or type(response.input_tokens) is not int
        or response.input_tokens != input_tokens
        or type(response.output_tokens) is not int
        or response.output_tokens < 0
        or (
            response.provider_request_id_sha256 is not None
            and (
                type(response.provider_request_id_sha256) is not str
                or _SHA256_RE.fullmatch(response.provider_request_id_sha256) is None
            )
        )
    ):
        _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_response_invalid")
    ledger.reconcile_call(
        reservation,
        input_tokens=response.input_tokens,
        output_tokens=response.output_tokens,
        elapsed_wall_ms=_elapsed_ms(start_ns),
    )
    return ProviderJsonResponse(
        identity=ProviderIdentity(**identity.__dict__),
        request_sha256=str(response.request_sha256),
        payload=response.payload,
        input_tokens=int(response.input_tokens),
        output_tokens=int(response.output_tokens),
        provider_request_id_sha256=(
            str(response.provider_request_id_sha256)
            if response.provider_request_id_sha256 is not None
            else None
        ),
    )


def _balanced_claims(summaries: tuple[ChunkSummary, ...]) -> tuple[GeneratorClaim, ...]:
    chosen: list[GeneratorClaim] = []
    seen: set[tuple[str, str, tuple[str, ...]]] = set()
    position = 0
    while len(chosen) < 12:
        added = False
        for summary in summaries:
            if position >= len(summary.claims):
                continue
            claim = summary.claims[position]
            key = (claim.claim_kind, claim.text, claim.record_ids)
            if key not in seen:
                chosen.append(claim)
                seen.add(key)
                added = True
                if len(chosen) == 12:
                    break
        if not added and all(position + 1 >= len(item.claims) for item in summaries):
            break
        position += 1
    if not chosen:
        _fail(PAPER_SLIDE_OUTPUT_INVALID, "summary_claims_empty")
    return tuple(
        GeneratorClaim(f"k{index:02d}", claim.claim_kind, claim.text, claim.record_ids)
        for index, claim in enumerate(chosen, start=1)
    )


def _referenced_records(content: DeckContent) -> tuple[str, ...]:
    result: set[str] = set()
    for slide in content.slides:
        for statement in (*slide.bullets, *slide.speaker_notes):
            result.update(statement.record_ids)
    return tuple(result)


def _overlap_tokens(text: str) -> tuple[str, ...]:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return tuple(_OVERLAP_TOKEN_RE.findall(normalized))


def _overlap_ngram_fingerprint(tokens: tuple[str, ...]) -> int:
    value = 0xCBF29CE484222325
    for token in tokens:
        for character in token:
            value = ((value ^ ord(character)) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
        value = ((value ^ 0xFF) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def _require_bounded_verbatim_overlap(
    records: tuple[UntrustedPromptRecord, ...], content: DeckContent
) -> None:
    source_ngrams: set[int] = set()
    long_source_tokens: set[str] = set()
    for record in records:
        tokens = _overlap_tokens(record.text)
        long_source_tokens.update(
            token for token in tokens if len(token) >= MAX_VERBATIM_SINGLE_TOKEN_CODEPOINTS
        )
        source_ngrams.update(
            _overlap_ngram_fingerprint(tokens[index : index + VERBATIM_NGRAM_TOKENS])
            for index in range(len(tokens) - VERBATIM_NGRAM_TOKENS + 1)
        )

    total_tokens = 0
    matched_tokens = 0
    for slide in content.slides:
        for statement in (*slide.bullets, *slide.speaker_notes):
            tokens = _overlap_tokens(statement.text)
            total_tokens += len(tokens)
            if any(
                len(token) >= MAX_VERBATIM_SINGLE_TOKEN_CODEPOINTS
                and any(token in source_token for source_token in long_source_tokens)
                for token in tokens
            ):
                _fail(PAPER_SLIDE_OUTPUT_INVALID, "verbatim_overlap_exceeded")
            matched = [False] * len(tokens)
            for index in range(len(tokens) - VERBATIM_NGRAM_TOKENS + 1):
                fingerprint = _overlap_ngram_fingerprint(
                    tokens[index : index + VERBATIM_NGRAM_TOKENS]
                )
                if fingerprint in source_ngrams:
                    matched[index : index + VERBATIM_NGRAM_TOKENS] = [True] * VERBATIM_NGRAM_TOKENS
            longest = 0
            current = 0
            for is_matched in matched:
                current = current + 1 if is_matched else 0
                longest = max(longest, current)
            if longest >= MAX_VERBATIM_CONTIGUOUS_TOKENS:
                _fail(PAPER_SLIDE_OUTPUT_INVALID, "verbatim_overlap_exceeded")
            matched_tokens += sum(matched)
    if (
        matched_tokens >= MIN_VERBATIM_AGGREGATE_TOKENS
        and matched_tokens * 100 > total_tokens * MAX_VERBATIM_AGGREGATE_PERCENT
    ):
        _fail(PAPER_SLIDE_OUTPUT_INVALID, "verbatim_overlap_exceeded")


def _build_deck(
    trusted: _TrustedInput,
    identity: ProviderIdentity,
    content: DeckContent,
    input_hash: str,
) -> tuple[dict[str, object], SlideDeckValidationContext]:
    known = tuple(record.record_id for record in trusted.records)
    referenced_set = set(_referenced_records(content))
    referenced = tuple(record_id for record_id in known if record_id in referenced_set)
    citation_ids = {record_id: f"c{index:02d}" for index, record_id in enumerate(referenced, 1)}
    slides: list[dict[str, object]] = []
    labels = {
        "ja": {
            "problem": "課題",
            "method": "手法",
            "evidence": "根拠",
            "limitations": "限界",
            "conclusion": "結論",
            "context": "背景",
        },
        "en": {
            "problem": "Problem",
            "method": "Method",
            "evidence": "Evidence",
            "limitations": "Limitations",
            "conclusion": "Conclusion",
            "context": "Context",
        },
    }
    for index, slide in enumerate(content.slides, 1):
        slides.append(
            {
                "slide_id": f"s{index:02d}",
                "kind": slide.kind,
                "title": trusted.title
                if slide.kind == "title"
                else labels[trusted.language][slide.kind],
                "bullets": [
                    {
                        "text": item.text,
                        "citation_ids": [citation_ids[record] for record in item.record_ids],
                        "content_origin": "paper",
                    }
                    for item in slide.bullets
                ],
                "visual": {"kind": "none", "alt": None, "spec": None},
                "speaker_notes": [
                    {
                        "text": item.text,
                        "citation_ids": [citation_ids[record] for record in item.record_ids],
                    }
                    for item in slide.speaker_notes
                ],
            }
        )
    citations: list[dict[str, object]] = []
    for record_id in referenced:
        reference = trusted.record_references[record_id]
        citations.append(
            {
                "citation_id": citation_ids[record_id],
                "source_kind": "pdf_page" if trusted.coverage_kind == "full_text" else "abstract",
                "page": reference.page if trusted.coverage_kind == "full_text" else None,
                "chunk_id": record_id,
                "chunk_sha256": reference.sha256,
                "source_anchor": reference.source_anchor,
            }
        )
    machine = (
        MACHINE_SUMMARY_LIMITATION if trusted.language == "ja" else MACHINE_SUMMARY_LIMITATION_EN
    )
    required = [machine]
    if trusted.coverage_kind == "abstract_only":
        required.insert(
            0, ABSTRACT_ONLY_LABEL if trusted.language == "ja" else ABSTRACT_ONLY_LABEL_EN
        )
    limitations = required
    deck: dict[str, object] = {
        "schema_version": SLIDE_DECK_VERSION,
        "deck_id": "sd1-" + "0" * 64,
        "paper_id": trusted.paper_id,
        "language": trusted.language,
        "deck_profile": trusted.deck_profile,
        "coverage": {
            "kind": trusted.coverage_kind,
            "label": (FULL_TEXT_LABEL if trusted.language == "ja" else FULL_TEXT_LABEL_EN)
            if trusted.coverage_kind == "full_text"
            else (ABSTRACT_ONLY_LABEL if trusted.language == "ja" else ABSTRACT_ONLY_LABEL_EN),
            "page_count": trusted.page_count,
            "extracted_page_count": trusted.extracted_page_count,
        },
        "source": {
            "title": trusted.title,
            "authors": list(trusted.authors),
            "landing_url": trusted.source.landing_url,
            "pdf_sha256": trusted.content_sha256 if trusted.coverage_kind == "full_text" else None,
            "access": trusted.source.access if trusted.coverage_kind == "full_text" else "unknown",
            "license": trusted.source.license,
            "license_evidence_url": trusted.source.license_evidence_url,
            "fetched_at": _timestamp(trusted.fetched_at)
            if trusted.fetched_at is not None
            else None,
        },
        "generator": {
            "producer": PRODUCER,
            "version": GENERATOR_VERSION,
            "extractor": trusted.extractor,
            "provider": identity.provider,
            "model": identity.model,
            "prompt_version": PROMPT_VERSION,
            "schema_version": SLIDE_DECK_VERSION,
        },
        "slides": slides,
        "citations": citations,
        "limitations": limitations,
        "review": {"status": "provisional", "review_record": None},
        "generated_at": _timestamp(trusted.generated_at),
        "input_sha256": input_hash,
    }
    deck["deck_id"] = derive_deck_id(deck)
    context = SlideDeckValidationContext(
        expected_envelope_sha256=trusted_envelope_sha256(deck),
        pdf_chunks=trusted.record_references if trusted.coverage_kind == "full_text" else {},
        abstract_sha256=trusted.content_sha256
        if trusted.coverage_kind == "abstract_only"
        else None,
        abstract_source_anchor=(
            trusted.source.landing_url if trusted.coverage_kind == "abstract_only" else None
        ),
    )
    return deck, context


def _generate(
    request: object,
    provider: StructuredSlideProvider | None,
    pricing: PricingSnapshot | None,
    budget: GenerationBudget,
    at: datetime,
    *,
    allow_test_fixture: bool,
    allow_test_full_text: bool,
    prepared_execution: PreparedProviderExecution | None = None,
) -> SlideGenerationResult:
    start_ns = time.monotonic_ns()
    if prepared_execution is not None:
        if allow_test_fixture or allow_test_full_text:
            _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_execution_invalid")
        if prepared_execution.prepared_at != at:
            _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_execution_clock_mismatch")
        try:
            claimed_provider = prepared_execution.claim_generation()
            provider = cast(StructuredSlideProvider, claimed_provider)
            identity = prepared_execution.identity
            checked_registered_pricing = prepared_execution.pricing
            budget = prepared_execution.budget
            ledger = prepared_execution.new_usage_ledger()
        except (KeyboardInterrupt, SystemExit):
            raise
        except ProviderExecutionError as exc:
            _fail(exc.error_code, exc.issue_code)
        except Exception:
            _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_execution_invalid")
        if ledger.usage != GenerationUsage(0, 0, 0, 0, 0):
            _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_execution_already_used")
    else:
        if provider is None:
            _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_execution_invalid")
        try:
            identity_value = provider.identity
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception:
            _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_identity_failed")
        identity = _validate_identity(identity_value, allow_test_fixture=allow_test_fixture)
        checked_registered_pricing = _authorize_provider_and_pricing(
            provider,
            identity,
            pricing,
            allow_test_fixture=allow_test_fixture,
        )
        ledger = GenerationUsageLedger(
            identity=identity,
            pricing=checked_registered_pricing,
            budget=budget,
            at=at,
        )
    trusted = _validate_input(
        request,
        generated_at=at,
        allow_test_full_text=allow_test_full_text,
    )
    prompt_plan = plan_chunk_summary_calls(trusted.records, language=trusted.language)
    if (
        type(budget) is GenerationBudget
        and type(budget.max_calls) is int
        and len(prompt_plan.calls) + 1 > budget.max_calls
    ):
        _fail(PAPER_SLIDE_BUDGET_EXCEEDED, "call_limit_exceeded")
    identity = ledger.identity
    checked_pricing = ledger.pricing
    checked_budget = ledger.budget
    generation_config_sha256 = canonical_json_sha256(
        {
            "budget": {
                "max_calls": checked_budget.max_calls,
                "max_cost_micro_units": checked_budget.max_cost_micro_units,
                "max_input_tokens": checked_budget.max_input_tokens,
                "max_output_tokens": checked_budget.max_output_tokens,
                "max_output_tokens_per_call": checked_budget.max_output_tokens_per_call,
                "max_wall_seconds": checked_budget.max_wall_seconds,
            },
            "composition_max_output_tokens": min(
                COMPOSITION_MAX_OUTPUT_TOKENS,
                checked_budget.max_output_tokens_per_call,
            ),
            "chunk_summary_max_output_tokens": min(
                CHUNK_SUMMARY_MAX_OUTPUT_TOKENS,
                checked_budget.max_output_tokens_per_call,
            ),
            "version": BUDGET_POLICY_VERSION,
        }
    )
    metadata_sha256 = canonical_json_sha256(
        {"title": trusted.title, "authors": list(trusted.authors)}
    )
    input_record = GenerationInputHashRecord(
        paper_id=trusted.paper_id,
        coverage_kind=trusted.coverage_kind,
        source=trusted.source,
        content_sha256=trusted.content_sha256,
        ordered_chunk_sha256s=trusted.ordered_chunk_sha256s,
        language=trusted.language,
        deck_profile=trusted.deck_profile,
        extractor=trusted.extractor,
        provider_identity=identity,
        generation_config_sha256=generation_config_sha256,
        metadata_sha256=metadata_sha256,
        fetched_at=trusted.fetched_at,
        generated_at=trusted.generated_at,
        page_count=trusted.page_count,
        extracted_page_count=trusted.extracted_page_count,
        generator_version=GENERATOR_VERSION,
        prompt_content_version=PROMPT_CONTENT_VERSION,
        prompt_envelope_version=PROMPT_REQUEST_VERSION,
        schema_version=SLIDE_DECK_VERSION,
        pricing_version=checked_pricing.version,
    )
    input_hash = calculate_input_sha256(input_record)
    summaries: list[ChunkSummary] = []
    request_hashes: list[str] = []
    for prompt in prompt_plan.calls:
        known = tuple(str(record.record_id) for record in prompt.untrusted_records)
        response = _provider_call(
            provider,
            identity,
            ledger,
            prompt,
            max_output_tokens=min(
                CHUNK_SUMMARY_MAX_OUTPUT_TOKENS,
                checked_budget.max_output_tokens_per_call,
            ),
            start_ns=start_ns,
            pricing=pricing,
            pricing_snapshot=checked_pricing,
            budget=budget,
            budget_snapshot=checked_budget,
            allow_test_fixture=allow_test_fixture,
            prepared_execution=prepared_execution,
        )
        summaries.append(load_chunk_summary(response.payload, known_record_ids=known))
        if response.provider_request_id_sha256 is not None:
            request_hashes.append(response.provider_request_id_sha256)
    claims = _balanced_claims(tuple(summaries))
    all_known = tuple(record.record_id for record in trusted.records)
    composition = build_claim_request(
        stage=COMPOSITION_STAGE,
        claims=claims,
        known_record_ids=all_known,
        language=trusted.language,
    )
    response = _provider_call(
        provider,
        identity,
        ledger,
        composition,
        max_output_tokens=min(
            COMPOSITION_MAX_OUTPUT_TOKENS, checked_budget.max_output_tokens_per_call
        ),
        start_ns=start_ns,
        pricing=pricing,
        pricing_snapshot=checked_pricing,
        budget=budget,
        budget_snapshot=checked_budget,
        allow_test_fixture=allow_test_fixture,
        prepared_execution=prepared_execution,
    )
    if response.provider_request_id_sha256 is not None:
        request_hashes.append(response.provider_request_id_sha256)
    content = load_deck_content(
        response.payload,
        known_record_ids=all_known,
        coverage_kind=trusted.coverage_kind,
    )
    selected_records = {record for claim in claims for record in claim.record_ids}
    if not set(_referenced_records(content)).issubset(selected_records):
        _fail(PAPER_SLIDE_CITATION_INVALID, "composition_reference_unselected")
    _require_bounded_verbatim_overlap(trusted.records, content)
    deck, context = _build_deck(trusted, identity, content, input_hash)
    try:
        deck_bytes = canonical_slide_deck_bytes(deck, context=context)
    except SlideDeckValidationError as exc:
        _fail(exc.code, exc.issue_code)
    cache = calculate_cache_key(
        input_record, candidate_sha256=hashlib.sha256(deck_bytes).hexdigest()
    )
    return SlideGenerationResult(
        deck_bytes=deck_bytes,
        usage=ledger.usage,
        input_sha256=input_hash,
        cache_key=cache,
        provider_request_id_sha256s=tuple(request_hashes),
    )


def generate_slide_deck(
    request: SlideGenerationInput,
    *,
    provider: StructuredSlideProvider,
    pricing: PricingSnapshot | None,
    budget: GenerationBudget = GenerationBudget(),
    at: datetime,
) -> SlideGenerationResult:
    """Generate one validated provisional deck with no retry or fallback."""

    failure: tuple[str, str] | None = None
    result: object = _MISSING
    try:
        result = _generate(
            request,
            provider,
            pricing,
            budget,
            at,
            allow_test_fixture=False,
            allow_test_full_text=False,
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except _GenerationIssueError as exc:
        failure = (exc.error_code, exc.issue_code)
    except (
        SlideGenerationBudgetError,
        SlideGeneratorContractError,
        SlideGeneratorPromptError,
    ) as exc:
        failure = (exc.error_code, exc.issue_code)
    except Exception:
        failure = (PAPER_SLIDE_OUTPUT_INVALID, "generation_internal_failure")
    if failure is not None:
        raise SlideGenerationError(*failure)
    if result is _MISSING:
        raise SlideGenerationError(PAPER_SLIDE_OUTPUT_INVALID, "generation_internal_failure")
    return cast(SlideGenerationResult, result)


def generate_slide_deck_from_prepared(
    request: SlideGenerationInput,
    *,
    execution: PreparedProviderExecution,
    at: datetime,
) -> SlideGenerationResult:
    """Generate once using only a registry-authorized prepared execution."""

    failure: tuple[str, str] | None = None
    result: object = _MISSING
    try:
        if type(execution) is not PreparedProviderExecution:
            _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_execution_invalid")
        result = _generate(
            request,
            None,
            None,
            GenerationBudget(),
            at,
            allow_test_fixture=False,
            allow_test_full_text=False,
            prepared_execution=execution,
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except _GenerationIssueError as exc:
        failure = (exc.error_code, exc.issue_code)
    except (
        SlideGenerationBudgetError,
        SlideGeneratorContractError,
        SlideGeneratorPromptError,
    ) as exc:
        failure = (exc.error_code, exc.issue_code)
    except Exception:
        failure = (PAPER_SLIDE_OUTPUT_INVALID, "generation_internal_failure")
    if failure is not None:
        raise SlideGenerationError(*failure)
    if result is _MISSING:
        raise SlideGenerationError(PAPER_SLIDE_OUTPUT_INVALID, "generation_internal_failure")
    return cast(SlideGenerationResult, result)


def _generate_slide_deck_for_test(
    request: SlideGenerationInput,
    *,
    provider: StructuredSlideProvider,
    pricing: PricingSnapshot | None,
    at: datetime,
    budget: GenerationBudget = GenerationBudget(),
) -> SlideGenerationResult:
    """Private offline fixture seam; never exported as a production API."""

    failure: tuple[str, str] | None = None
    result: object = _MISSING
    try:
        result = _generate(
            request,
            provider,
            pricing,
            budget,
            at,
            allow_test_fixture=True,
            allow_test_full_text=False,
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except _GenerationIssueError as exc:
        failure = (exc.error_code, exc.issue_code)
    except (
        SlideGenerationBudgetError,
        SlideGeneratorContractError,
        SlideGeneratorPromptError,
    ) as exc:
        failure = (exc.error_code, exc.issue_code)
    except Exception:
        failure = (PAPER_SLIDE_OUTPUT_INVALID, "generation_internal_failure")
    if failure is not None:
        raise SlideGenerationError(*failure)
    if result is _MISSING:
        raise SlideGenerationError(PAPER_SLIDE_OUTPUT_INVALID, "generation_internal_failure")
    return cast(SlideGenerationResult, result)


def _generate_full_text_slide_deck_for_test(
    request: SlideGenerationInput,
    *,
    provider: StructuredSlideProvider,
    pricing: PricingSnapshot | None,
    at: datetime,
    budget: GenerationBudget = GenerationBudget(),
) -> SlideGenerationResult:
    """Private fixture-only full-text seam requiring test visibility attestation."""

    failure: tuple[str, str] | None = None
    result: object = _MISSING
    try:
        result = _generate(
            request,
            provider,
            pricing,
            budget,
            at,
            allow_test_fixture=True,
            allow_test_full_text=True,
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except _GenerationIssueError as exc:
        failure = (exc.error_code, exc.issue_code)
    except (
        SlideGenerationBudgetError,
        SlideGeneratorContractError,
        SlideGeneratorPromptError,
    ) as exc:
        failure = (exc.error_code, exc.issue_code)
    except Exception:
        failure = (PAPER_SLIDE_OUTPUT_INVALID, "generation_internal_failure")
    if failure is not None:
        raise SlideGenerationError(*failure)
    if result is _MISSING:
        raise SlideGenerationError(PAPER_SLIDE_OUTPUT_INVALID, "generation_internal_failure")
    return cast(SlideGenerationResult, result)


__all__ = [
    "ABSTRACT_EXTRACTOR",
    "ALLOWED_PROVIDER_MODELS",
    "AbstractOnlyGenerationInput",
    "FullTextGenerationInput",
    "ProviderJsonResponse",
    "SlideGenerationError",
    "SlideGenerationInput",
    "SlideGenerationResult",
    "StructuredSlideProvider",
    "generate_slide_deck",
    "generate_slide_deck_from_prepared",
]

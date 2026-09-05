"""Stdlib-only runtime contract for ``slide-deck-v1`` artifacts.

JSON Schema protects tooling boundaries.  This module additionally enforces
cross-reference, canonical identity and trusted external-reference invariants
that JSON Schema cannot express.
"""

from __future__ import annotations

import ipaddress
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import NamedTuple
from urllib.parse import unquote, urlsplit

from paperpilot.replay import canonical_json_bytes, canonical_json_sha256, strict_json_loads

SLIDE_DECK_VERSION = "slide-deck-v1"
DECK_PROFILE = "research-brief-v1"
PRODUCER = "paperpilot.paper_slides"
PROMPT_VERSION = "paper-slide-v1"
MAX_CANONICAL_BYTES = 512 * 1024
MAX_RAW_INPUT_BYTES = MAX_CANONICAL_BYTES
MAX_JSON_DEPTH = 32
MAX_JSON_CONTAINERS = 2048
MAX_JSON_SCALARS = 20_000

FULL_TEXT_LABEL = "公開PDF本文から生成"
ABSTRACT_ONLY_LABEL = "要旨のみから生成。論文全文の要約ではありません"
MACHINE_SUMMARY_LIMITATION = "機械生成された要約であり、原論文の確認が必要です。"
FULL_TEXT_LABEL_EN = "Generated from the public PDF full text"
ABSTRACT_ONLY_LABEL_EN = (
    "Generated from the abstract only. This is not a summary of the full paper."
)
MACHINE_SUMMARY_LIMITATION_EN = "Machine-generated summary; verify against the original paper."
REVIEW_CHECKLIST = (
    "citation_pages_checked",
    "major_claims_checked",
    "coverage_label_checked",
    "copyright_notice_checked",
)
REVIEW_RECORD_VERSION = "paper-slide-review-record-v1"
REVIEW_DECISIONS = frozenset({"approved", "rejected", "needs_changes"})

PAPER_SLIDE_REQUEST_INVALID = "PAPER_SLIDE_REQUEST_INVALID"
PAPER_SLIDE_PAPER_NOT_FOUND = "PAPER_SLIDE_PAPER_NOT_FOUND"
PAPER_SLIDE_SOURCE_UNTRUSTED = "PAPER_SLIDE_SOURCE_UNTRUSTED"
PAPER_SLIDE_SOURCE_RESTRICTED = "PAPER_SLIDE_SOURCE_RESTRICTED"
PAPER_SLIDE_FETCH_FAILED = "PAPER_SLIDE_FETCH_FAILED"
PAPER_SLIDE_FETCH_LIMIT_EXCEEDED = "PAPER_SLIDE_FETCH_LIMIT_EXCEEDED"
PAPER_SLIDE_PDF_INVALID = "PAPER_SLIDE_PDF_INVALID"
PAPER_SLIDE_PDF_ENCRYPTED = "PAPER_SLIDE_PDF_ENCRYPTED"
PAPER_SLIDE_EXTRACTION_FAILED = "PAPER_SLIDE_EXTRACTION_FAILED"
PAPER_SLIDE_EXTRACTION_INSUFFICIENT = "PAPER_SLIDE_EXTRACTION_INSUFFICIENT"
PAPER_SLIDE_BUDGET_EXCEEDED = "PAPER_SLIDE_BUDGET_EXCEEDED"
PAPER_SLIDE_PROVIDER_FAILED = "PAPER_SLIDE_PROVIDER_FAILED"
PAPER_SLIDE_OUTPUT_INVALID = "PAPER_SLIDE_OUTPUT_INVALID"
PAPER_SLIDE_CITATION_INVALID = "PAPER_SLIDE_CITATION_INVALID"
PAPER_SLIDE_SECRET_DETECTED = "PAPER_SLIDE_SECRET_DETECTED"
PAPER_SLIDE_REVIEW_REQUIRED = "PAPER_SLIDE_REVIEW_REQUIRED"
PAPER_SLIDE_REVIEW_REJECTED = "PAPER_SLIDE_REVIEW_REJECTED"
PAPER_SLIDE_CANDIDATE_EXPIRED = "PAPER_SLIDE_CANDIDATE_EXPIRED"
PAPER_SLIDE_PROMOTION_CONFLICT = "PAPER_SLIDE_PROMOTION_CONFLICT"
PAPER_SLIDE_PUBLISH_FAILED = "PAPER_SLIDE_PUBLISH_FAILED"

PAPER_ID_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
DECK_ID_RE = re.compile(r"^sd1-[0-9a-f]{64}$")
SLIDE_ID_RE = re.compile(r"^s(?:0[1-9]|1[0-2])$")
CITATION_ID_RE = re.compile(r"^c(?:0[1-9]|[1-9][0-9])$")
CHUNK_ID_RE = re.compile(r"^p(?:00[1-9]|0[1-9][0-9]|1[01][0-9]|12[0-8])-c(?:0[1-9]|[1-9][0-9])$")
UTC_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")
REVIEW_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")
PAPER_SLIDES_PUBLIC_ROOT = "/automatic-paper-search/paper-slides-v1"
REVIEW_RECORD_PATH_RE = re.compile(
    rf"^{re.escape(PAPER_SLIDES_PUBLIC_ROOT)}/reviews/"
    rf"(?P<deck_id>sd1-[0-9a-f]{{64}})/(?P<sha256>[0-9a-f]{{64}})\.json$"
)
UNSAFE_VISUAL_RE = re.compile(r"(?:<[^>]*>|(?:https?|data|javascript):)", re.IGNORECASE)
UNSAFE_GENERATED_TEXT_RE = re.compile(
    r"(?:<\s*/?\s*[a-z][^>]*>|(?:https?|javascript|data):)", re.IGNORECASE
)
SECRET_KEY_RE = re.compile(
    r"(?:authorization|api_?key|access_?token|refresh_?token|client_?secret|password|private_?key)$",
    re.IGNORECASE,
)
AUTH_VALUE_RE = re.compile(r"\b(?:Bearer|Basic)\s+\S+", re.IGNORECASE)
URL_USERINFO_RE = re.compile(r"[a-z][a-z0-9+.-]*://[^\s/@]+@", re.IGNORECASE)
SECRET_QUERY_RE = re.compile(r"[?&][^\s&#=]*(?:token|key|signature)=[^\s&#]+", re.IGNORECASE)
KNOWN_TOKEN_RE = re.compile(
    r"(?:\bAKIA[0-9A-Z]{12,}|\bAIza[0-9A-Za-z_-]{16,}|\bgithub_pat_[0-9A-Za-z_]{8,}|"
    r"\bgh[pousr]_[0-9A-Za-z]{8,}|\bgsk_[0-9A-Za-z]{8,}|\bglpat-[0-9A-Za-z_-]{8,}|"
    r"\bhf_[0-9A-Za-z]{8,}|\bsk-[0-9A-Za-z_-]{8,}|\bxox[baprs]-[0-9A-Za-z-]{8,})"
)
PRIVATE_KEY_RE = re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")
SECRET_ASSIGNMENT_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[\s_-]+)*(?:"
    r"aws[\s_-]*secret[\s_-]*access[\s_-]*key|api[\s_-]*key|access[\s_-]*token|"
    r"refresh[\s_-]*token|client[\s_-]*secret|private[\s_-]*key|password|authorization)"
    r"\b\s*[\"'`]?\s*[:=]\s*"
    r"[\"'`]?[^\s\"'`]{4,}",
    re.IGNORECASE,
)
OPAQUE_REVIEWER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$")
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
EMAIL_SEARCH_RE = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
SAFE_REVIEW_REASON_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,280}$")
DNS_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+"
    r"(?:[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?|xn--[A-Za-z0-9-]{1,59})$"
)
HTTPS_URL_RE = re.compile(
    r"^https://(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+"
    r"(?:[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?|xn--[A-Za-z0-9-]{1,59})"
    r"(?::443)?(?:/[^\s\"'`<>\\%]*)?$"
)
RAW_ACTIVE_CHARS_RE = re.compile(r"[\s\"'`<>\\]")
ENCODED_CONTROL_RE = re.compile(r"%(?:0[0-9A-F]|1[0-9A-F]|7F|25)", re.IGNORECASE)
SOURCE_WORK_ID_RE = re.compile(r"^(?:arxiv|doi|openreview|acl_anthology|cvf):[!-~]{1,240}$")
SAME_ORIGIN_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._~-]+$")
SAME_ORIGIN_SUFFIX_RE = re.compile(r"^[A-Za-z0-9._~!$&()*+,;=:@%/?-]*$")

TOP_FIELDS = {
    "schema_version",
    "deck_id",
    "paper_id",
    "language",
    "deck_profile",
    "coverage",
    "source",
    "generator",
    "slides",
    "citations",
    "limitations",
    "review",
    "generated_at",
    "input_sha256",
}
COVERAGE_FIELDS = {"kind", "label", "page_count", "extracted_page_count"}
SOURCE_FIELDS = {
    "title",
    "authors",
    "landing_url",
    "pdf_sha256",
    "access",
    "license",
    "license_evidence_url",
    "fetched_at",
}
GENERATOR_FIELDS = {
    "producer",
    "version",
    "extractor",
    "provider",
    "model",
    "prompt_version",
    "schema_version",
}
SLIDE_FIELDS = {"slide_id", "kind", "title", "bullets", "visual", "speaker_notes"}
BULLET_FIELDS = {"text", "citation_ids", "content_origin"}
VISUAL_FIELDS = {"kind", "alt", "spec"}
NOTE_FIELDS = {"text", "citation_ids"}
PDF_CITATION_FIELDS = {
    "citation_id",
    "source_kind",
    "page",
    "chunk_id",
    "chunk_sha256",
    "source_anchor",
}
LINEAGE_CITATION_FIELDS = {
    "citation_id",
    "source_kind",
    "page",
    "artifact_path",
    "claim_id",
    "artifact_sha256",
    "quality_path",
    "quality_sha256",
    "source_anchor",
}
REVIEW_FIELDS = {"status", "review_record"}


class SlideDeckIssue(NamedTuple):
    """One non-sensitive, stable validation result."""

    error_code: str
    issue_code: str
    path: str


class SlideDeckValidationError(ValueError):
    """Raised at fail-closed consumer boundaries."""

    def __init__(self, code: str, issue_code: str, path: str = "$") -> None:
        self.code = code
        self.issue_code = issue_code
        self.path = path
        super().__init__(f"{code}:{issue_code}:{path}")


@dataclass(frozen=True)
class PdfChunkReference:
    """Trusted extraction result retained without raw chunk text."""

    page: int
    sha256: str
    source_anchor: str
    pdf_sha256: str


@dataclass(frozen=True)
class LineageClaimReference:
    """Trusted accepted claim from a quality-passed v2 artifact.

    ``independent_source_work_ids`` are canonical ASCII-visible IDs of distinct
    source works, never chunk IDs, evidence-record IDs, locators, or duplicate
    projections of the same paper.  The trusted context builder must merge
    aliases for the same work before it establishes independence.
    """

    artifact_sha256: str
    quality_path: str
    quality_sha256: str
    source_anchor: str
    decision: str
    trust_tier: str
    quality_status: str
    quality_result: str
    claim_family: str
    calibrated_probability: float | None
    calibration_id: str | None
    independent_source_work_ids: tuple[str, ...]
    verified_by_review: bool


@dataclass(frozen=True)
class ReviewRecordReference:
    """Minimum trusted review identity needed to accept ``reviewed``."""

    deck_id: str
    candidate_sha256: str
    pdf_sha256: str | None
    reviewer_id: str
    decision: str
    reviewed_at: str
    checklist: tuple[str, ...]
    reason: str


def _review_record_payload(record: ReviewRecordReference) -> dict[str, object]:
    if type(record) is not ReviewRecordReference:
        raise TypeError("review record must be an exact ReviewRecordReference")
    if (
        type(record.deck_id) is not str
        or DECK_ID_RE.fullmatch(record.deck_id) is None
        or type(record.candidate_sha256) is not str
        or SHA256_RE.fullmatch(record.candidate_sha256) is None
        or (
            record.pdf_sha256 is not None
            and (
                type(record.pdf_sha256) is not str or SHA256_RE.fullmatch(record.pdf_sha256) is None
            )
        )
        or type(record.reviewer_id) is not str
        or OPAQUE_REVIEWER_RE.fullmatch(record.reviewer_id) is None
        or EMAIL_RE.fullmatch(record.reviewer_id) is not None
        or type(record.decision) is not str
        or record.decision not in REVIEW_DECISIONS
        or type(record.reviewed_at) is not str
        or _parse_review_timestamp(record.reviewed_at) is None
        or type(record.checklist) is not tuple
        or record.checklist != REVIEW_CHECKLIST
        or type(record.reason) is not str
        or not _text(record.reason, 280)
        or SAFE_REVIEW_REASON_RE.fullmatch(record.reason) is None
        or EMAIL_SEARCH_RE.search(record.reason) is not None
        or UNSAFE_GENERATED_TEXT_RE.search(record.reason) is not None
        or _has_secret_value(record.reason)
    ):
        raise ValueError("review record fields are invalid")
    return {
        "candidate_sha256": record.candidate_sha256,
        "checklist": list(record.checklist),
        "decision": record.decision,
        "deck_id": record.deck_id,
        "pdf_sha256": record.pdf_sha256,
        "reason": record.reason,
        "reviewed_at": record.reviewed_at,
        "reviewer_id": record.reviewer_id,
        "schema_version": REVIEW_RECORD_VERSION,
    }


def canonical_review_record_bytes(record: ReviewRecordReference) -> bytes:
    """Return the closed canonical JSON bytes owned by the future SD4 publisher."""

    return canonical_json_bytes(_review_record_payload(record))


def canonical_review_record_sha256(record: ReviewRecordReference) -> str:
    """Return the full SHA-256 of the canonical public review record."""

    return canonical_json_sha256(_review_record_payload(record))


def public_review_record_path(record: ReviewRecordReference) -> str:
    """Derive the immutable public path for one exact review-record artifact."""

    if type(record) is not ReviewRecordReference or type(record.deck_id) is not str:
        raise TypeError("review record must be an exact ReviewRecordReference")
    if DECK_ID_RE.fullmatch(record.deck_id) is None:
        raise ValueError("review record deck_id is invalid")
    return (
        f"{PAPER_SLIDES_PUBLIC_ROOT}/reviews/{record.deck_id}/"
        f"{canonical_review_record_sha256(record)}.json"
    )


@dataclass(frozen=True)
class SlideDeckValidationContext:
    """Trusted references intentionally kept outside the generated artifact.

    Raw PDF, extracted text and quotes must never be placed in this context.
    Keys for ``lineage_claims`` are ``(artifact_path, claim_id)``.
    Its trusted builder must canonicalize aliases and provide genuinely
    distinct source-work IDs; this validator rejects duplicates/chunk IDs but
    does not perform source resolution itself.
    """

    expected_envelope_sha256: str | None = None
    pdf_chunks: Mapping[str, PdfChunkReference] = field(default_factory=dict)
    abstract_sha256: str | None = None
    abstract_source_anchor: str | None = None
    lineage_claims: Mapping[tuple[str, str], LineageClaimReference] = field(default_factory=dict)
    review_records: Mapping[str, ReviewRecordReference] = field(default_factory=dict)
    current_lineage_calibration_id: str | None = None
    review_as_of: str | None = None


def _add(
    issues: list[SlideDeckIssue],
    issue_code: str,
    path: str,
    *,
    error_code: str = PAPER_SLIDE_OUTPUT_INVALID,
) -> None:
    issues.append(SlideDeckIssue(error_code, issue_code, path))


def _safe_path(parent: str, segment: object) -> str:
    text = str(segment)
    if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", text):
        return f"{parent}.{text}" if parent != "$" else f"$.{text}"
    return f"{parent}.*"


def _has_secret_value(value: str) -> bool:
    return any(
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


def _preflight_json_value(value: object) -> SlideDeckIssue | None:
    """Bound traversal before any recursive parser/canonical operation."""

    stack: list[tuple[object, str, int, bool]] = [(value, "$", 0, False)]
    active_containers: set[int] = set()
    container_count = 0
    scalar_count = 0
    while stack:
        item, path, depth, exiting = stack.pop()
        if exiting:
            active_containers.discard(id(item))
            continue
        if depth > MAX_JSON_DEPTH:
            return SlideDeckIssue(PAPER_SLIDE_OUTPUT_INVALID, "json_depth", path)
        if type(item) in {dict, list}:
            if len(item) > MAX_JSON_SCALARS:
                return SlideDeckIssue(PAPER_SLIDE_OUTPUT_INVALID, "json_scalar_limit", path)
            container_count += 1
            if container_count > MAX_JSON_CONTAINERS:
                return SlideDeckIssue(PAPER_SLIDE_OUTPUT_INVALID, "json_container_limit", path)
            container_id = id(item)
            if container_id in active_containers:
                return SlideDeckIssue(PAPER_SLIDE_OUTPUT_INVALID, "json_cycle", path)
            active_containers.add(container_id)
            stack.append((item, path, depth, True))
            if type(item) is dict:
                children: list[tuple[object, str, int, bool]] = []
                for key, child in item.items():
                    if type(key) is not str:
                        return SlideDeckIssue(PAPER_SLIDE_OUTPUT_INVALID, "json_key", path)
                    child_path = _safe_path(path, key)
                    if child is not None and child != "" and SECRET_KEY_RE.search(key):
                        return SlideDeckIssue(
                            PAPER_SLIDE_SECRET_DETECTED, "secret_detected", child_path
                        )
                    children.append((child, child_path, depth + 1, False))
                stack.extend(reversed(children))
            else:
                stack.extend(
                    (child, f"{path}[{index}]", depth + 1, False)
                    for index, child in reversed(list(enumerate(item)))
                )
            continue
        scalar_count += 1
        if scalar_count > MAX_JSON_SCALARS:
            return SlideDeckIssue(PAPER_SLIDE_OUTPUT_INVALID, "json_scalar_limit", path)
        if item is None or type(item) in {bool, int}:
            continue
        if type(item) is float:
            if not math.isfinite(item):
                return SlideDeckIssue(PAPER_SLIDE_OUTPUT_INVALID, "json_number", path)
            continue
        if type(item) is str:
            if _has_secret_value(item):
                return SlideDeckIssue(PAPER_SLIDE_SECRET_DETECTED, "secret_detected", path)
            continue
        return SlideDeckIssue(PAPER_SLIDE_OUTPUT_INVALID, "json_value", path)
    return None


def _is_object(value: object) -> bool:
    return type(value) is dict


def _is_array(value: object) -> bool:
    return type(value) is list


def _is_int(value: object) -> bool:
    return type(value) is int


def _text(value: object, maximum: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= maximum and bool(value.strip())


def _generated_text(
    value: object,
    maximum: int,
    path: str,
    issues: list[SlideDeckIssue],
) -> bool:
    if not _text(value, maximum):
        _add(issues, "text_value", path)
        return False
    assert isinstance(value, str)
    if UNSAFE_GENERATED_TEXT_RE.search(value):
        _add(issues, "active_content", path)
        return False
    return True


def _exact_fields(
    value: object,
    expected: set[str],
    path: str,
    issues: list[SlideDeckIssue],
) -> bool:
    if not _is_object(value):
        _add(issues, "object_shape", path)
        return False
    if set(value) != expected:
        _add(issues, "object_fields", path)
        return False
    return True


def _parse_utc_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or UTC_TIMESTAMP_RE.fullmatch(value) is None:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _valid_utc_timestamp(value: object) -> bool:
    return _parse_utc_timestamp(value) is not None


def _parse_review_timestamp(value: object) -> datetime | None:
    if (
        not isinstance(value, str)
        or not 20 <= len(value) <= 27
        or REVIEW_TIMESTAMP_RE.fullmatch(value) is None
    ):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _valid_https_url(value: object) -> bool:
    """Accept only canonical unescaped HTTPS URLs; SD1 owns DNS/redirect checks."""

    if not isinstance(value, str) or not (9 <= len(value) <= 2048):
        return False
    if (
        HTTPS_URL_RE.fullmatch(value) is None
        or RAW_ACTIVE_CHARS_RE.search(value) is not None
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        return False
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return False
    try:
        ipaddress.ip_address(parsed.hostname or "")
    except ValueError:
        hostname_is_ip = False
    else:
        hostname_is_ip = True
    return (
        parsed.scheme == "https"
        and bool(parsed.hostname)
        and not hostname_is_ip
        and DNS_HOSTNAME_RE.fullmatch(parsed.hostname or "") is not None
        and parsed.username is None
        and parsed.password is None
        and port in (None, 443)
        and "\\" not in value
        and ((not parsed.query and not parsed.fragment) or parsed.path.startswith("/"))
    )


def _valid_same_origin_path(value: object, *, json_only: bool) -> bool:
    if not isinstance(value, str) or not (2 <= len(value) <= 2048):
        return False
    if (
        not value.isascii()
        or "//" in value
        or RAW_ACTIVE_CHARS_RE.search(value) is not None
        or ENCODED_CONTROL_RE.search(value) is not None
    ):
        return False
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        return False
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or not parsed.path.startswith("/"):
        return False
    decoded_path = unquote(parsed.path)
    if "%" in parsed.path or "\\" in decoded_path or "//" in decoded_path:
        return False
    if any(segment in {".", ".."} for segment in decoded_path.split("/")):
        return False
    if json_only:
        segments = parsed.path.removeprefix("/").split("/")
        return (
            not parsed.query
            and not parsed.fragment
            and len(value) <= 1024
            and bool(segments)
            and all(
                segment not in {"", ".", ".."}
                and SAME_ORIGIN_SEGMENT_RE.fullmatch(segment) is not None
                for segment in segments
            )
            and segments[-1].endswith(".json")
        )
    path_segments = parsed.path.removeprefix("/").split("/")
    if path_segments and path_segments[-1] == "":
        path_segments.pop()
    return (
        all(
            segment not in {"", ".", ".."} and SAME_ORIGIN_SEGMENT_RE.fullmatch(segment) is not None
            for segment in path_segments
        )
        and SAME_ORIGIN_SUFFIX_RE.fullmatch(parsed.query) is not None
        and SAME_ORIGIN_SUFFIX_RE.fullmatch(parsed.fragment) is not None
    )


def derive_deck_id(deck: Mapping[str, object]) -> str:
    """Derive the stable deck ID from canonical input and producer identity."""

    identity = {
        "coverage": deck["coverage"]["kind"],  # type: ignore[index]
        "deck_profile": deck["deck_profile"],
        "generator": deck["generator"],
        "input_sha256": deck["input_sha256"],
        "language": deck["language"],
        "paper_id": deck["paper_id"],
        "schema_version": deck["schema_version"],
    }
    return f"sd1-{canonical_json_sha256(identity)}"


def trusted_envelope_sha256(deck: Mapping[str, object]) -> str:
    """Hash only producer-injected identity/provenance envelope fields."""

    envelope = {
        "coverage": deck["coverage"],
        "deck_profile": deck["deck_profile"],
        "generated_at": deck["generated_at"],
        "generator": deck["generator"],
        "input_sha256": deck["input_sha256"],
        "language": deck["language"],
        "paper_id": deck["paper_id"],
        "schema_version": deck["schema_version"],
        "source": deck["source"],
    }
    return canonical_json_sha256(envelope)


def derive_candidate_sha256(deck: Mapping[str, object]) -> str:
    """Hash the provisional candidate bytes bound by a later review record."""

    candidate = dict(deck)
    candidate["review"] = {"status": "provisional", "review_record": None}
    return canonical_json_sha256(candidate)


def _validate_coverage(deck: dict, issues: list[SlideDeckIssue]) -> str | None:
    value = deck.get("coverage")
    if not _exact_fields(value, COVERAGE_FIELDS, "$.coverage", issues):
        return None
    kind = value.get("kind")
    if not isinstance(kind, str) or kind not in {"full_text", "abstract_only"}:
        _add(issues, "coverage_kind", "$.coverage.kind")
        return None
    language = deck.get("language")
    labels = {
        ("ja", "full_text"): FULL_TEXT_LABEL,
        ("ja", "abstract_only"): ABSTRACT_ONLY_LABEL,
        ("en", "full_text"): FULL_TEXT_LABEL_EN,
        ("en", "abstract_only"): ABSTRACT_ONLY_LABEL_EN,
    }
    expected_label = labels.get((language, kind))
    if value.get("label") != expected_label:
        _add(issues, "coverage_label", "$.coverage.label")
    page_count = value.get("page_count")
    extracted = value.get("extracted_page_count")
    if kind == "full_text":
        if not _is_int(page_count) or not 1 <= page_count <= 128:
            _add(issues, "coverage_page_count", "$.coverage.page_count")
        if not _is_int(extracted) or not 1 <= extracted <= 128:
            _add(issues, "coverage_extracted_page_count", "$.coverage.extracted_page_count")
        elif _is_int(page_count) and extracted > page_count:
            _add(issues, "coverage_page_count_order", "$.coverage.extracted_page_count")
    elif page_count is not None or extracted is not None:
        _add(issues, "abstract_coverage_shape", "$.coverage")
    return kind


def _validate_source(deck: dict, coverage: str | None, issues: list[SlideDeckIssue]) -> None:
    value = deck.get("source")
    if not _exact_fields(value, SOURCE_FIELDS, "$.source", issues):
        return
    for field_name, maximum in (("title", 1000), ("license", 256)):
        _generated_text(value.get(field_name), maximum, f"$.source.{field_name}", issues)
    authors = value.get("authors")
    if not _is_array(authors) or not 1 <= len(authors) <= 100:
        _add(issues, "authors_shape", "$.source.authors")
    else:
        for index, author in enumerate(authors):
            _generated_text(author, 300, f"$.source.authors[{index}]", issues)
    if not _valid_https_url(value.get("landing_url")):
        _add(issues, "source_url", "$.source.landing_url")
    pdf_sha = value.get("pdf_sha256")
    if pdf_sha is not None and (
        not isinstance(pdf_sha, str) or SHA256_RE.fullmatch(pdf_sha) is None
    ):
        _add(issues, "sha256", "$.source.pdf_sha256")
    access = value.get("access")
    if not isinstance(access, str) or access not in {"open_access", "unknown"}:
        _add(issues, "source_access", "$.source.access")
    evidence_url = value.get("license_evidence_url")
    if evidence_url is not None and not _valid_https_url(evidence_url):
        _add(issues, "source_url", "$.source.license_evidence_url")
    fetched_at = value.get("fetched_at")
    if fetched_at is not None and not _valid_utc_timestamp(fetched_at):
        _add(issues, "timestamp", "$.source.fetched_at")
    if coverage == "full_text":
        if not isinstance(pdf_sha, str) or SHA256_RE.fullmatch(pdf_sha) is None:
            _add(issues, "full_text_pdf_hash", "$.source.pdf_sha256")
        if value.get("access") != "open_access":
            _add(issues, "full_text_access", "$.source.access")
        if not _valid_utc_timestamp(fetched_at):
            _add(issues, "full_text_fetched_at", "$.source.fetched_at")


def _validate_generator(deck: dict, issues: list[SlideDeckIssue]) -> None:
    value = deck.get("generator")
    if not _exact_fields(value, GENERATOR_FIELDS, "$.generator", issues):
        return
    constants = {
        "producer": PRODUCER,
        "prompt_version": PROMPT_VERSION,
        "schema_version": SLIDE_DECK_VERSION,
    }
    for field_name, expected in constants.items():
        if value.get(field_name) != expected:
            _add(issues, "generator_identity", f"$.generator.{field_name}")
    for field_name, maximum in (
        ("version", 128),
        ("extractor", 256),
        ("provider", 128),
        ("model", 256),
    ):
        if not _generated_text(value.get(field_name), maximum, f"$.generator.{field_name}", issues):
            _add(issues, "generator_identity", f"$.generator.{field_name}")


def _validate_citation_ids(
    value: object,
    path: str,
    issues: list[SlideDeckIssue],
    *,
    required: bool,
) -> list[str]:
    if not _is_array(value) or len(value) > 16:
        _add(issues, "citation_ids_shape", path, error_code=PAPER_SLIDE_CITATION_INVALID)
        return []
    ids: list[str] = []
    for index, candidate in enumerate(value):
        if not isinstance(candidate, str) or CITATION_ID_RE.fullmatch(candidate) is None:
            _add(
                issues,
                "citation_id_shape",
                f"{path}[{index}]",
                error_code=PAPER_SLIDE_CITATION_INVALID,
            )
        else:
            ids.append(candidate)
    if len(ids) != len(set(ids)):
        _add(issues, "citation_ref_duplicate", path, error_code=PAPER_SLIDE_CITATION_INVALID)
    if required and not ids:
        _add(issues, "bullet_citation_required", path, error_code=PAPER_SLIDE_CITATION_INVALID)
    return ids


def _validate_slides(deck: dict, issues: list[SlideDeckIssue]) -> list[tuple[str, list[str], str]]:
    slides = deck.get("slides")
    references: list[tuple[str, list[str], str]] = []
    if not _is_array(slides) or not 2 <= len(slides) <= 12:
        _add(issues, "slides_shape", "$.slides")
        return references
    ids: list[str] = []
    kinds: list[object] = []
    for index, slide in enumerate(slides):
        path = f"$.slides[{index}]"
        if not _exact_fields(slide, SLIDE_FIELDS, path, issues):
            continue
        slide_id = slide.get("slide_id")
        if not isinstance(slide_id, str) or SLIDE_ID_RE.fullmatch(slide_id) is None:
            _add(issues, "slide_id_shape", f"{path}.slide_id")
        else:
            ids.append(slide_id)
        kind = slide.get("kind")
        kinds.append(kind)
        if not isinstance(kind, str) or kind not in {
            "title",
            "problem",
            "method",
            "evidence",
            "limitations",
            "conclusion",
            "context",
        }:
            _add(issues, "slide_kind", f"{path}.kind")
        _generated_text(slide.get("title"), 300, f"{path}.title", issues)
        bullets = slide.get("bullets")
        cited_bullet_count = 0
        if not _is_array(bullets) or len(bullets) > 12:
            _add(issues, "bullets_shape", f"{path}.bullets")
        else:
            for bullet_index, bullet in enumerate(bullets):
                bullet_path = f"{path}.bullets[{bullet_index}]"
                if not _exact_fields(bullet, BULLET_FIELDS, bullet_path, issues):
                    continue
                _generated_text(bullet.get("text"), 800, f"{bullet_path}.text", issues)
                origin = bullet.get("content_origin")
                if not isinstance(origin, str) or origin not in {"paper", "lineage"}:
                    _add(issues, "content_origin", f"{bullet_path}.content_origin")
                citation_ids = _validate_citation_ids(
                    bullet.get("citation_ids"),
                    f"{bullet_path}.citation_ids",
                    issues,
                    required=kind != "title",
                )
                if citation_ids:
                    cited_bullet_count += 1
                references.append((f"{bullet_path}.citation_ids", citation_ids, str(origin)))
        if kind != "title" and cited_bullet_count == 0:
            _add(
                issues,
                "non_title_cited_bullet",
                f"{path}.bullets",
                error_code=PAPER_SLIDE_CITATION_INVALID,
            )
        visual = slide.get("visual")
        if _exact_fields(visual, VISUAL_FIELDS, f"{path}.visual", issues):
            visual_kind = visual.get("kind")
            if visual_kind == "none":
                if visual.get("alt") is not None or visual.get("spec") is not None:
                    _add(issues, "visual_none_shape", f"{path}.visual")
            elif visual_kind == "generated_diagram":
                alt = visual.get("alt")
                spec = visual.get("spec")
                if not _generated_text(
                    alt, 800, f"{path}.visual.alt", issues
                ) or not _generated_text(spec, 4000, f"{path}.visual.spec", issues):
                    _add(issues, "visual_shape", f"{path}.visual")
                if (
                    isinstance(alt, str)
                    and isinstance(spec, str)
                    and (UNSAFE_VISUAL_RE.search(alt) or UNSAFE_VISUAL_RE.search(spec))
                ):
                    _add(issues, "visual_content_unsafe", f"{path}.visual")
            else:
                _add(issues, "visual_kind", f"{path}.visual.kind")
        notes = slide.get("speaker_notes")
        if not _is_array(notes) or len(notes) > 12:
            _add(issues, "speaker_notes_shape", f"{path}.speaker_notes")
        else:
            for note_index, note in enumerate(notes):
                note_path = f"{path}.speaker_notes[{note_index}]"
                if not _exact_fields(note, NOTE_FIELDS, note_path, issues):
                    continue
                _generated_text(note.get("text"), 2000, f"{note_path}.text", issues)
                note_ids = _validate_citation_ids(
                    note.get("citation_ids"),
                    f"{note_path}.citation_ids",
                    issues,
                    required=True,
                )
                references.append((f"{note_path}.citation_ids", note_ids, "note"))
    if len(ids) != len(set(ids)):
        _add(issues, "slide_id_duplicate", "$.slides")
    if ids != sorted(ids):
        _add(issues, "slide_id_order", "$.slides")
    if not kinds or kinds[0] != "title" or kinds.count("title") != 1:
        _add(issues, "title_slide_position", "$.slides")
    return references


def _validate_citations(
    deck: dict,
    coverage: str | None,
    context: SlideDeckValidationContext | None,
    issues: list[SlideDeckIssue],
) -> dict[str, str]:
    citations = deck.get("citations")
    kinds_by_id: dict[str, str] = {}
    if not _is_array(citations) or not 1 <= len(citations) <= 99:
        _add(issues, "citations_shape", "$.citations", error_code=PAPER_SLIDE_CITATION_INVALID)
        return kinds_by_id
    ids: list[str] = []
    for index, citation in enumerate(citations):
        path = f"$.citations[{index}]"
        if not _is_object(citation):
            _add(issues, "citation_shape", path, error_code=PAPER_SLIDE_CITATION_INVALID)
            continue
        kind = citation.get("source_kind")
        if not isinstance(kind, str) or kind not in {
            "pdf_page",
            "abstract",
            "lineage_assertion",
        }:
            _add(
                issues,
                "citation_kind",
                f"{path}.source_kind",
                error_code=PAPER_SLIDE_CITATION_INVALID,
            )
            continue
        expected = (
            PDF_CITATION_FIELDS if kind in {"pdf_page", "abstract"} else LINEAGE_CITATION_FIELDS
        )
        if not _exact_fields(citation, expected, path, issues):
            continue
        citation_id = citation.get("citation_id")
        if not isinstance(citation_id, str) or CITATION_ID_RE.fullmatch(citation_id) is None:
            _add(
                issues,
                "citation_id_shape",
                f"{path}.citation_id",
                error_code=PAPER_SLIDE_CITATION_INVALID,
            )
        else:
            ids.append(citation_id)
            kinds_by_id[citation_id] = str(kind)
        if kind == "pdf_page":
            page = citation.get("page")
            chunk_id = citation.get("chunk_id")
            sha = citation.get("chunk_sha256")
            anchor = citation.get("source_anchor")
            if not _is_int(page) or not 1 <= page <= 128:
                _add(issues, "pdf_citation_shape", path, error_code=PAPER_SLIDE_CITATION_INVALID)
            if not isinstance(chunk_id, str) or CHUNK_ID_RE.fullmatch(chunk_id) is None:
                _add(issues, "pdf_citation_shape", path, error_code=PAPER_SLIDE_CITATION_INVALID)
            elif _is_int(page) and int(chunk_id[1:4]) != page:
                _add(
                    issues,
                    "pdf_chunk_page",
                    f"{path}.chunk_id",
                    error_code=PAPER_SLIDE_CITATION_INVALID,
                )
            parsed_anchor = urlsplit(anchor) if isinstance(anchor, str) else None
            if (
                not isinstance(sha, str)
                or SHA256_RE.fullmatch(sha) is None
                or not _valid_https_url(anchor)
                or parsed_anchor is None
                or parsed_anchor.fragment != f"page={page}"
            ):
                _add(issues, "pdf_citation_shape", path, error_code=PAPER_SLIDE_CITATION_INVALID)
            coverage_value = deck.get("coverage")
            page_count = coverage_value.get("page_count") if _is_object(coverage_value) else None
            if _is_int(page) and _is_int(page_count) and page > page_count:
                _add(
                    issues,
                    "citation_page_count",
                    f"{path}.page",
                    error_code=PAPER_SLIDE_CITATION_INVALID,
                )
            if context is None or not context.pdf_chunks:
                _add(issues, "pdf_context_required", path, error_code=PAPER_SLIDE_CITATION_INVALID)
            elif isinstance(chunk_id, str):
                trusted = context.pdf_chunks.get(chunk_id)
                source = deck.get("source")
                source_pdf_sha = source.get("pdf_sha256") if _is_object(source) else None
                if trusted is None or (
                    trusted.page,
                    trusted.sha256,
                    trusted.source_anchor,
                    trusted.pdf_sha256,
                ) != (page, sha, anchor, source_pdf_sha):
                    _add(
                        issues,
                        "pdf_citation_mismatch",
                        path,
                        error_code=PAPER_SLIDE_CITATION_INVALID,
                    )
        elif kind == "abstract":
            sha = citation.get("chunk_sha256")
            anchor = citation.get("source_anchor")
            if (
                citation.get("page") is not None
                or citation.get("chunk_id") != "abstract"
                or not isinstance(sha, str)
                or SHA256_RE.fullmatch(sha) is None
                or not _valid_https_url(anchor)
                or anchor
                != (deck["source"].get("landing_url") if _is_object(deck.get("source")) else None)
            ):
                _add(
                    issues, "abstract_citation_shape", path, error_code=PAPER_SLIDE_CITATION_INVALID
                )
            if (
                context is None
                or context.abstract_sha256 is None
                or context.abstract_source_anchor is None
            ):
                _add(
                    issues,
                    "abstract_context_required",
                    path,
                    error_code=PAPER_SLIDE_CITATION_INVALID,
                )
            elif (sha, anchor) != (context.abstract_sha256, context.abstract_source_anchor):
                _add(
                    issues,
                    "abstract_citation_mismatch",
                    path,
                    error_code=PAPER_SLIDE_CITATION_INVALID,
                )
        elif kind == "lineage_assertion":
            artifact_path = citation.get("artifact_path")
            claim_id = citation.get("claim_id")
            artifact_sha = citation.get("artifact_sha256")
            quality_path = citation.get("quality_path")
            quality_sha = citation.get("quality_sha256")
            anchor = citation.get("source_anchor")
            if (
                citation.get("page") is not None
                or not _valid_same_origin_path(artifact_path, json_only=True)
                or not isinstance(claim_id, str)
                or re.fullmatch(r"claim:[0-9a-f]{64}", claim_id) is None
                or not isinstance(artifact_sha, str)
                or SHA256_RE.fullmatch(artifact_sha) is None
                or not _valid_same_origin_path(quality_path, json_only=True)
                or not isinstance(quality_sha, str)
                or SHA256_RE.fullmatch(quality_sha) is None
                or not _valid_same_origin_path(anchor, json_only=False)
            ):
                _add(
                    issues, "lineage_citation_shape", path, error_code=PAPER_SLIDE_CITATION_INVALID
                )
            key = (artifact_path, claim_id)
            if context is None or not context.lineage_claims:
                _add(
                    issues,
                    "lineage_context_required",
                    path,
                    error_code=PAPER_SLIDE_CITATION_INVALID,
                )
            elif isinstance(artifact_path, str) and isinstance(claim_id, str):
                trusted = context.lineage_claims.get(key)
                if (
                    trusted is None
                    or trusted.artifact_sha256 != artifact_sha
                    or trusted.quality_path != quality_path
                    or trusted.quality_sha256 != quality_sha
                    or trusted.source_anchor != anchor
                    or trusted.decision != "accepted"
                    or trusted.trust_tier not in {"verified", "corroborated"}
                    or trusted.quality_status != "ready"
                    or trusted.quality_result != "passed"
                ):
                    _add(
                        issues,
                        "lineage_citation_mismatch",
                        path,
                        error_code=PAPER_SLIDE_CITATION_INVALID,
                    )
                elif trusted.claim_family != "genealogy":
                    _add(
                        issues,
                        "lineage_claim_unqualified",
                        path,
                        error_code=PAPER_SLIDE_CITATION_INVALID,
                    )
                elif trusted.trust_tier == "verified":
                    if trusted.verified_by_review is not True:
                        _add(
                            issues,
                            "lineage_claim_unqualified",
                            path,
                            error_code=PAPER_SLIDE_CITATION_INVALID,
                        )
                elif trusted.trust_tier == "corroborated":
                    probability = trusted.calibrated_probability
                    independent = trusted.independent_source_work_ids
                    if (
                        type(probability) is not float
                        or not math.isfinite(probability)
                        or not 0.70 <= probability <= 1.0
                        or not _text(trusted.calibration_id, 256)
                        or trusted.calibration_id != context.current_lineage_calibration_id
                        or type(independent) is not tuple
                        or len(independent) < 2
                        or len(set(independent)) != len(independent)
                        or not all(
                            isinstance(item, str) and SOURCE_WORK_ID_RE.fullmatch(item) is not None
                            for item in independent
                        )
                    ):
                        _add(
                            issues,
                            "lineage_claim_unqualified",
                            path,
                            error_code=PAPER_SLIDE_CITATION_INVALID,
                        )
                else:
                    _add(
                        issues,
                        "lineage_claim_unqualified",
                        path,
                        error_code=PAPER_SLIDE_CITATION_INVALID,
                    )
        if coverage == "full_text" and kind == "abstract":
            _add(issues, "coverage_citation_kind", path, error_code=PAPER_SLIDE_CITATION_INVALID)
        if coverage == "abstract_only" and kind == "pdf_page":
            _add(issues, "coverage_citation_kind", path, error_code=PAPER_SLIDE_CITATION_INVALID)
    if len(ids) != len(set(ids)):
        _add(
            issues, "citation_id_duplicate", "$.citations", error_code=PAPER_SLIDE_CITATION_INVALID
        )
    if ids != sorted(ids):
        _add(issues, "citation_id_order", "$.citations", error_code=PAPER_SLIDE_CITATION_INVALID)
    return kinds_by_id


def _validate_references(
    references: list[tuple[str, list[str], str]],
    kinds_by_id: Mapping[str, str],
    issues: list[SlideDeckIssue],
) -> None:
    for path, ids, origin in references:
        for citation_id in ids:
            kind = kinds_by_id.get(citation_id)
            if kind is None:
                _add(issues, "citation_unresolved", path, error_code=PAPER_SLIDE_CITATION_INVALID)
            elif (origin == "lineage" and kind != "lineage_assertion") or (
                origin == "paper" and kind == "lineage_assertion"
            ):
                _add(
                    issues,
                    "citation_origin_mismatch",
                    path,
                    error_code=PAPER_SLIDE_CITATION_INVALID,
                )


def _validate_review(
    deck: dict,
    context: SlideDeckValidationContext | None,
    issues: list[SlideDeckIssue],
) -> None:
    value = deck.get("review")
    if not _exact_fields(value, REVIEW_FIELDS, "$.review", issues):
        return
    status = value.get("status")
    record_path = value.get("review_record")
    if status == "provisional":
        if record_path is not None:
            _add(issues, "provisional_review_shape", "$.review")
        return
    if status != "reviewed" or not _valid_same_origin_path(record_path, json_only=True):
        _add(issues, "review_shape", "$.review")
        return
    if not isinstance(record_path, str) or REVIEW_RECORD_PATH_RE.fullmatch(record_path) is None:
        _add(issues, "review_path", "$.review.review_record")
        return
    if context is None or not context.review_records:
        _add(
            issues,
            "review_context_required",
            "$.review.review_record",
            error_code=PAPER_SLIDE_REVIEW_REQUIRED,
        )
        return
    trusted = context.review_records.get(record_path)
    try:
        candidate_sha = derive_candidate_sha256(deck)
    except (KeyError, TypeError, ValueError):
        candidate_sha = None
    try:
        expected_path = (
            public_review_record_path(trusted) if type(trusted) is ReviewRecordReference else None
        )
    except (TypeError, ValueError, RecursionError):
        expected_path = None
    source = deck.get("source")
    pdf_sha = source.get("pdf_sha256") if _is_object(source) else None
    generated_at = _parse_utc_timestamp(deck.get("generated_at"))
    reviewed_at = (
        _parse_review_timestamp(trusted.reviewed_at)
        if type(trusted) is ReviewRecordReference
        else None
    )
    review_as_of = _parse_review_timestamp(context.review_as_of)
    if (
        type(trusted) is not ReviewRecordReference
        or expected_path != record_path
        or trusted.deck_id != deck.get("deck_id")
        or trusted.candidate_sha256 != candidate_sha
        or trusted.pdf_sha256 != pdf_sha
        or not isinstance(trusted.reviewer_id, str)
        or OPAQUE_REVIEWER_RE.fullmatch(trusted.reviewer_id) is None
        or EMAIL_RE.fullmatch(trusted.reviewer_id) is not None
        or trusted.decision != "approved"
        or reviewed_at is None
        or generated_at is None
        or review_as_of is None
        or not generated_at <= reviewed_at <= review_as_of
        or trusted.checklist != REVIEW_CHECKLIST
        or not _text(trusted.reason, 280)
        or SAFE_REVIEW_REASON_RE.fullmatch(trusted.reason) is None
        or EMAIL_SEARCH_RE.search(trusted.reason) is not None
        or UNSAFE_GENERATED_TEXT_RE.search(trusted.reason) is not None
        or _has_secret_value(trusted.reason)
    ):
        _add(
            issues,
            "review_record_mismatch",
            "$.review.review_record",
            error_code=PAPER_SLIDE_REVIEW_REQUIRED,
        )


def _validate_slide_deck_impl(
    deck: object,
    *,
    context: SlideDeckValidationContext | None = None,
) -> list[SlideDeckIssue]:
    """Return all stable contract failures without exposing generated content."""

    issues: list[SlideDeckIssue] = []
    if not _exact_fields(deck, TOP_FIELDS, "$", issues) and not _is_object(deck):
        return issues
    assert type(deck) is dict
    if deck.get("schema_version") != SLIDE_DECK_VERSION:
        _add(issues, "schema_version", "$.schema_version")
    deck_id = deck.get("deck_id")
    if not isinstance(deck_id, str) or DECK_ID_RE.fullmatch(deck_id) is None:
        _add(issues, "deck_id_shape", "$.deck_id")
    paper_id = deck.get("paper_id")
    if not isinstance(paper_id, str) or PAPER_ID_RE.fullmatch(paper_id) is None:
        _add(issues, "paper_id_shape", "$.paper_id")
    if deck.get("language") not in {"ja", "en"}:
        _add(issues, "language", "$.language")
    if deck.get("deck_profile") != DECK_PROFILE:
        _add(issues, "deck_profile", "$.deck_profile")
    input_sha = deck.get("input_sha256")
    if not isinstance(input_sha, str) or SHA256_RE.fullmatch(input_sha) is None:
        _add(issues, "sha256", "$.input_sha256")
    if not _valid_utc_timestamp(deck.get("generated_at")):
        _add(issues, "timestamp", "$.generated_at")

    coverage = _validate_coverage(deck, issues)
    _validate_source(deck, coverage, issues)
    _validate_generator(deck, issues)
    references = _validate_slides(deck, issues)
    kinds_by_id = _validate_citations(deck, coverage, context, issues)
    _validate_references(references, kinds_by_id, issues)

    limitations = deck.get("limitations")
    if not _is_array(limitations) or not 1 <= len(limitations) <= 20:
        _add(issues, "limitations_shape", "$.limitations")
    else:
        if len(limitations) != len(set(item for item in limitations if isinstance(item, str))):
            _add(issues, "limitations_duplicate", "$.limitations")
        for index, limitation in enumerate(limitations):
            _generated_text(limitation, 1000, f"$.limitations[{index}]", issues)
        language = deck.get("language")
        required_limitations = {
            MACHINE_SUMMARY_LIMITATION if language == "ja" else MACHINE_SUMMARY_LIMITATION_EN
        }
        if coverage == "abstract_only":
            required_limitations.add(
                ABSTRACT_ONLY_LABEL if language == "ja" else ABSTRACT_ONLY_LABEL_EN
            )
        if not required_limitations.issubset(
            {item for item in limitations if isinstance(item, str)}
        ):
            _add(issues, "required_limitation", "$.limitations")
    _validate_review(deck, context, issues)

    output_shape_valid = not any(issue.error_code == PAPER_SLIDE_OUTPUT_INVALID for issue in issues)
    if output_shape_valid:
        try:
            expected_deck_id = derive_deck_id(deck)
        except (KeyError, TypeError, ValueError, RecursionError):
            expected_deck_id = None
        if expected_deck_id is None or deck_id != expected_deck_id:
            _add(issues, "deck_id_mismatch", "$.deck_id")

        expected_envelope = context.expected_envelope_sha256 if context is not None else None
        if not isinstance(expected_envelope, str) or SHA256_RE.fullmatch(expected_envelope) is None:
            _add(issues, "trusted_envelope_required", "$")
        else:
            try:
                actual_envelope = trusted_envelope_sha256(deck)
            except (KeyError, TypeError, ValueError, RecursionError):
                actual_envelope = None
            if actual_envelope != expected_envelope:
                _add(issues, "trusted_envelope_mismatch", "$")

    # Never canonicalize the full artifact after any failure.  Valid shapes are
    # already bounded by preflight and per-field limits.
    if not issues and len(canonical_json_bytes(deck)) > MAX_CANONICAL_BYTES:
        _add(issues, "deck_size", "$")
    return issues


def validate_slide_deck(
    deck: object,
    *,
    context: SlideDeckValidationContext | None = None,
) -> list[SlideDeckIssue]:
    """Total validator for any JSON value and bounded direct Python input."""

    try:
        preflight_issue = _preflight_json_value(deck)
        if preflight_issue is not None:
            return [preflight_issue]
        return _validate_slide_deck_impl(deck, context=context)
    except (KeyError, TypeError, ValueError, OverflowError, RecursionError):
        return [SlideDeckIssue(PAPER_SLIDE_OUTPUT_INVALID, "validator_failure", "$")]


def require_valid_slide_deck(
    deck: object,
    *,
    context: SlideDeckValidationContext | None = None,
) -> dict:
    """Return a valid deck or raise the first stable failure."""

    issues = validate_slide_deck(deck, context=context)
    if issues:
        issue = issues[0]
        raise SlideDeckValidationError(issue.error_code, issue.issue_code, issue.path)
    assert type(deck) is dict
    return deck


def load_slide_deck(
    payload: str | bytes | bytearray,
    *,
    context: SlideDeckValidationContext | None = None,
) -> dict:
    """Strictly parse and validate one generated deck JSON payload."""

    try:
        raw_size = len(payload.encode("utf-8")) if isinstance(payload, str) else len(payload)
    except (AttributeError, TypeError, UnicodeEncodeError):
        raise SlideDeckValidationError(PAPER_SLIDE_OUTPUT_INVALID, "json_parse") from None
    if raw_size > MAX_RAW_INPUT_BYTES:
        raise SlideDeckValidationError(PAPER_SLIDE_OUTPUT_INVALID, "input_size")
    try:
        deck = strict_json_loads(payload)
    except (TypeError, ValueError, UnicodeDecodeError, RecursionError):
        raise SlideDeckValidationError(PAPER_SLIDE_OUTPUT_INVALID, "json_parse") from None
    return require_valid_slide_deck(deck, context=context)


def canonical_slide_deck_bytes(
    deck: object,
    *,
    context: SlideDeckValidationContext | None = None,
) -> bytes:
    """Validate then serialize exactly as the Replay Lite canonical contract."""

    valid = require_valid_slide_deck(deck, context=context)
    return canonical_json_bytes(valid)


def canonical_slide_deck_sha256(
    deck: object,
    *,
    context: SlideDeckValidationContext | None = None,
) -> str:
    """Return the SHA-256 of validated canonical deck bytes."""

    valid = require_valid_slide_deck(deck, context=context)
    return canonical_json_sha256(valid)

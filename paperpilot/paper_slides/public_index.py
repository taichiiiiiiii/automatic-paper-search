"""Reviewed-only projection for the public paper-slide index.

The projector is deliberately separate from generation and publication.  It
accepts a deck plus trusted review context, reuses the strict deck validator and
public HTML renderer, and emits only the small browser-safe lookup record.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from types import MappingProxyType
from typing import NoReturn, cast

from paperpilot.paper_slides.contract import (
    MAX_CANONICAL_BYTES,
    PAPER_SLIDES_PUBLIC_ROOT,
    LineageClaimReference,
    PdfChunkReference,
    ReviewRecordReference,
    SlideDeckValidationContext,
    SlideDeckValidationError,
    canonical_slide_deck_bytes,
)
from paperpilot.paper_slides.render import (
    MAX_RENDERED_HTML_BYTES,
    AssetReferences,
    SlideRenderError,
    render_slide_deck_html,
)
from paperpilot.replay import canonical_json_bytes, strict_json_loads

PUBLIC_INDEX_SCHEMA_VERSION = "paper-slide-public-index-v1"
PUBLIC_MANIFEST_SCHEMA_VERSION = "paper-slide-public-manifest-v1"
MAX_PUBLIC_INDEX_ENTRIES = 10_000
MAX_PUBLIC_INDEX_SHARD_BYTES = 8 * 1024 * 1024
MAX_PUBLIC_MANIFEST_BYTES = 256 * 1024
MAX_TRUSTED_CONTEXT_REFERENCES = 128
MAX_PUBLIC_ASSET_VERSIONS_BYTES = 256 * 1024
MAX_PUBLIC_SLIDE_ASSET_BYTES = 2 * 1024 * 1024
# This is an aggregate ceiling for every byte retained in ``PublicIndexBundle.files``.
# It bounds a build independently of the 10,000-entry logical catalog limit.
MAX_PUBLIC_BUNDLE_BYTES = 128 * 1024 * 1024
PUBLIC_MANIFEST_PATH = f"{PAPER_SLIDES_PUBLIC_ROOT}/manifest.json"
_PUBLIC_ASSET_VERSIONS_PATH = (
    Path(__file__).resolve().parents[2] / "docs" / "assets" / "versions.json"
)
_PUBLIC_SLIDE_ASSET_ROOT = "/automatic-paper-search/assets"
_MAX_ASSET_VERSION = 2_147_483_647

_PAPER_ID_RE = re.compile(r"^[0-9a-f]{40}$")
_DECK_ID_RE = re.compile(r"^sd1-[0-9a-f]{64}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ASSET_SHA_RE = re.compile(r"^[0-9a-f]{12}$")
_UTC_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")
_ENTRY_FIELDS = {
    "paper_id",
    "language",
    "deck_id",
    "deck_path",
    "deck_json_path",
    "deck_sha256",
    "html_sha256",
    "coverage",
    "reviewed_at",
}
_MAPPING_PROXY_TYPE: type = type(MappingProxyType({}))


class SlidePublicIndexError(ValueError):
    """Stable, non-sensitive public-index projection failure."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class PublicIndexEntry:
    """One immutable, browser-safe reviewed deck lookup entry."""

    paper_id: str
    language: str
    deck_id: str
    deck_path: str
    deck_json_path: str
    deck_sha256: str
    html_sha256: str
    coverage: str
    reviewed_at: str

    def as_dict(self) -> dict[str, str]:
        """Return a detached JSON object for canonical serialization."""

        return {name: cast(str, getattr(self, name)) for name in sorted(_ENTRY_FIELDS)}


@dataclass(frozen=True, slots=True)
class PublicDeckProjection:
    """Exact reviewed deck/HTML and asset bytes plus their immutable entry."""

    entry: PublicIndexEntry = field(repr=False)
    deck_bytes: bytes = field(repr=False)
    html_bytes: bytes = field(repr=False)
    files: Mapping[str, bytes] = field(repr=False)


@dataclass(frozen=True, slots=True)
class PublicAssetSnapshot:
    """One verified, immutable snapshot of renderer references and bytes."""

    references: AssetReferences
    files: Mapping[str, bytes] = field(repr=False)


@dataclass(frozen=True, slots=True)
class ReviewedDeckCandidate:
    """Untrusted deck plus the trusted references required to revalidate it."""

    deck: object = field(repr=False)
    context: SlideDeckValidationContext = field(repr=False)


@dataclass(frozen=True, slots=True)
class PublicIndexBundle:
    """Bounded immutable promotion unit for all indexed public files.

    Review-record links target separately supplied, reviewed SD4 artifacts and
    are deliberately not represented as files owned by this SD3 bundle.
    """

    shards: Mapping[str, bytes] = field(repr=False)
    manifest_bytes: bytes = field(repr=False)
    manifest_sha256: str
    files: Mapping[str, bytes] = field(repr=False)
    total_bytes: int


def _fail(code: str) -> NoReturn:
    raise SlidePublicIndexError(code)


def _bounded_file_bytes(path: Path, limit: int, error_code: str) -> bytes:
    try:
        with path.open("rb") as source:
            payload = source.read(limit + 1)
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        _fail(error_code)
    if not payload or len(payload) > limit:
        _fail(error_code)
    return payload


def _resolve_public_slide_assets() -> PublicAssetSnapshot:
    """Resolve the public renderer assets from the checked-in version source."""

    raw_state = _bounded_file_bytes(
        _PUBLIC_ASSET_VERSIONS_PATH,
        MAX_PUBLIC_ASSET_VERSIONS_BYTES,
        "public_asset_versions_invalid",
    )
    try:
        state = strict_json_loads(raw_state)
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        _fail("public_asset_versions_invalid")
    if type(state) is not dict:
        _fail("public_asset_versions_invalid")

    resolved: dict[str, tuple[str, bytes]] = {}
    for filename in ("paper-slides.css", "paper-slides.js"):
        record = state.get(filename)
        if type(record) is not dict or set(record) != {"sha", "v"}:
            _fail("public_asset_versions_invalid")
        version = record.get("v")
        expected_sha = record.get("sha")
        if (
            type(version) is not int
            or not 1 <= version <= _MAX_ASSET_VERSION
            or type(expected_sha) is not str
            or _ASSET_SHA_RE.fullmatch(expected_sha) is None
        ):
            _fail("public_asset_versions_invalid")
        asset_bytes = _bounded_file_bytes(
            _PUBLIC_ASSET_VERSIONS_PATH.parent / filename,
            MAX_PUBLIC_SLIDE_ASSET_BYTES,
            "public_asset_versions_invalid",
        )
        full_sha = hashlib.sha256(asset_bytes).hexdigest()
        if full_sha[:12] != expected_sha:
            _fail("public_asset_hash_mismatch")
        resolved[filename] = (full_sha, asset_bytes)

    stylesheet_sha, stylesheet_bytes = resolved["paper-slides.css"]
    script_sha, script_bytes = resolved["paper-slides.js"]
    stylesheet_path = f"{_PUBLIC_SLIDE_ASSET_ROOT}/paper-slides.{stylesheet_sha}.css"
    script_path = f"{_PUBLIC_SLIDE_ASSET_ROOT}/paper-slides.{script_sha}.js"
    references = AssetReferences(
        stylesheet_path=stylesheet_path,
        stylesheet_sha256=stylesheet_sha,
        script_path=script_path,
        script_sha256=script_sha,
    )
    return PublicAssetSnapshot(
        references=references,
        files=MappingProxyType(
            {
                stylesheet_path: stylesheet_bytes,
                script_path: script_bytes,
            }
        ),
    )


def resolve_public_slide_assets() -> PublicAssetSnapshot:
    """Return one verified code-owned asset snapshot or fail closed."""

    try:
        return _resolve_public_slide_assets()
    except (KeyboardInterrupt, SystemExit):
        raise
    except SlidePublicIndexError as error:
        code = error.code
    except Exception:
        code = "public_asset_versions_invalid"
    raise SlidePublicIndexError(code) from None


def _valid_reviewed_at(value: object) -> bool:
    if type(value) is not str or not 20 <= len(value) <= 27:
        return False
    if _UTC_TIMESTAMP_RE.fullmatch(value) is None:
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _detached_mapping(value: object) -> dict[object, object]:
    if type(value) not in {dict, _MAPPING_PROXY_TYPE}:
        _fail("context_snapshot")
    mapping = cast(Mapping[object, object], value)
    try:
        if len(mapping) > MAX_TRUSTED_CONTEXT_REFERENCES:
            _fail("context_snapshot")
        detached = dict(mapping)
    except SlidePublicIndexError:
        raise
    except Exception:
        _fail("context_snapshot")
    if len(detached) > MAX_TRUSTED_CONTEXT_REFERENCES:
        _fail("context_snapshot")
    return detached


def snapshot_slide_validation_context(value: object) -> SlideDeckValidationContext:
    """Detach every caller-owned mapping and frozen value before validation."""

    if type(value) is not SlideDeckValidationContext:
        _fail("context_snapshot")
    context = cast(SlideDeckValidationContext, value)  # type: ignore[redundant-cast]
    optional_strings = (
        context.expected_envelope_sha256,
        context.abstract_sha256,
        context.abstract_source_anchor,
        context.current_lineage_calibration_id,
        context.review_as_of,
    )
    if any(
        item is not None and (type(item) is not str or len(item) > 4096)
        for item in optional_strings
    ):
        _fail("context_snapshot")
    try:
        pdf_chunks: dict[str, PdfChunkReference] = {}
        for pdf_key_value, pdf_item_value in _detached_mapping(context.pdf_chunks).items():
            if type(pdf_key_value) is not str or type(pdf_item_value) is not PdfChunkReference:
                _fail("context_snapshot")
            pdf_key = pdf_key_value
            pdf_item = cast(PdfChunkReference, pdf_item_value)  # type: ignore[redundant-cast]
            if (
                type(pdf_item.page) is not int
                or type(pdf_item.sha256) is not str
                or type(pdf_item.source_anchor) is not str
                or type(pdf_item.pdf_sha256) is not str
                or any(
                    len(text) > 4096
                    for text in (
                        pdf_key,
                        pdf_item.sha256,
                        pdf_item.source_anchor,
                        pdf_item.pdf_sha256,
                    )
                )
            ):
                _fail("context_snapshot")
            pdf_chunks[pdf_key] = PdfChunkReference(
                page=pdf_item.page,
                sha256=pdf_item.sha256,
                source_anchor=pdf_item.source_anchor,
                pdf_sha256=pdf_item.pdf_sha256,
            )

        lineage_claims: dict[tuple[str, str], LineageClaimReference] = {}
        for lineage_key_value, lineage_item_value in _detached_mapping(
            context.lineage_claims
        ).items():
            if (
                type(lineage_key_value) is not tuple
                or len(lineage_key_value) != 2
                or not all(type(part) is str for part in lineage_key_value)
                or type(lineage_item_value) is not LineageClaimReference
            ):
                _fail("context_snapshot")
            lineage_key = cast(tuple[str, str], lineage_key_value)
            lineage_item = cast(  # type: ignore[redundant-cast]
                LineageClaimReference, lineage_item_value
            )
            if (
                type(lineage_item.independent_source_work_ids) is not tuple
                or len(lineage_item.independent_source_work_ids) > MAX_TRUSTED_CONTEXT_REFERENCES
                or not all(
                    type(work_id) is str for work_id in lineage_item.independent_source_work_ids
                )
                or type(lineage_item.artifact_sha256) is not str
                or type(lineage_item.quality_path) is not str
                or type(lineage_item.quality_sha256) is not str
                or type(lineage_item.source_anchor) is not str
                or type(lineage_item.decision) is not str
                or type(lineage_item.trust_tier) is not str
                or type(lineage_item.quality_status) is not str
                or type(lineage_item.quality_result) is not str
                or type(lineage_item.claim_family) is not str
                or (
                    lineage_item.calibrated_probability is not None
                    and type(lineage_item.calibrated_probability) is not float
                )
                or (
                    lineage_item.calibration_id is not None
                    and type(lineage_item.calibration_id) is not str
                )
                or type(lineage_item.verified_by_review) is not bool
                or any(
                    len(text) > 4096
                    for text in (
                        *lineage_key,
                        lineage_item.artifact_sha256,
                        lineage_item.quality_path,
                        lineage_item.quality_sha256,
                        lineage_item.source_anchor,
                        lineage_item.decision,
                        lineage_item.trust_tier,
                        lineage_item.quality_status,
                        lineage_item.quality_result,
                        lineage_item.claim_family,
                        *lineage_item.independent_source_work_ids,
                    )
                )
            ):
                _fail("context_snapshot")
            lineage_claims[(lineage_key[0], lineage_key[1])] = LineageClaimReference(
                artifact_sha256=lineage_item.artifact_sha256,
                quality_path=lineage_item.quality_path,
                quality_sha256=lineage_item.quality_sha256,
                source_anchor=lineage_item.source_anchor,
                decision=lineage_item.decision,
                trust_tier=lineage_item.trust_tier,
                quality_status=lineage_item.quality_status,
                quality_result=lineage_item.quality_result,
                claim_family=lineage_item.claim_family,
                calibrated_probability=lineage_item.calibrated_probability,
                calibration_id=lineage_item.calibration_id,
                independent_source_work_ids=tuple(lineage_item.independent_source_work_ids),
                verified_by_review=lineage_item.verified_by_review,
            )

        review_records: dict[str, ReviewRecordReference] = {}
        for review_key_value, review_item_value in _detached_mapping(
            context.review_records
        ).items():
            if (
                type(review_key_value) is not str
                or type(review_item_value) is not ReviewRecordReference
            ):
                _fail("context_snapshot")
            review_key = review_key_value
            review_item = cast(  # type: ignore[redundant-cast]
                ReviewRecordReference, review_item_value
            )
            if (
                type(review_item.checklist) is not tuple
                or not all(type(check) is str for check in review_item.checklist)
                or type(review_item.deck_id) is not str
                or type(review_item.candidate_sha256) is not str
                or (review_item.pdf_sha256 is not None and type(review_item.pdf_sha256) is not str)
                or type(review_item.reviewer_id) is not str
                or type(review_item.decision) is not str
                or type(review_item.reviewed_at) is not str
                or type(review_item.reason) is not str
                or len(review_item.checklist) > MAX_TRUSTED_CONTEXT_REFERENCES
                or any(
                    len(text) > 4096
                    for text in (
                        review_key,
                        review_item.deck_id,
                        review_item.candidate_sha256,
                        review_item.pdf_sha256 or "",
                        review_item.reviewer_id,
                        review_item.decision,
                        review_item.reviewed_at,
                        *review_item.checklist,
                        review_item.reason,
                    )
                )
            ):
                _fail("context_snapshot")
            review_records[review_key] = ReviewRecordReference(
                deck_id=review_item.deck_id,
                candidate_sha256=review_item.candidate_sha256,
                pdf_sha256=review_item.pdf_sha256,
                reviewer_id=review_item.reviewer_id,
                decision=review_item.decision,
                reviewed_at=review_item.reviewed_at,
                checklist=tuple(review_item.checklist),
                reason=review_item.reason,
            )
    except SlidePublicIndexError:
        raise
    except Exception:
        _fail("context_snapshot")

    return SlideDeckValidationContext(
        expected_envelope_sha256=context.expected_envelope_sha256,
        pdf_chunks=MappingProxyType(pdf_chunks),
        abstract_sha256=context.abstract_sha256,
        abstract_source_anchor=context.abstract_source_anchor,
        lineage_claims=MappingProxyType(lineage_claims),
        review_records=MappingProxyType(review_records),
        current_lineage_calibration_id=context.current_lineage_calibration_id,
        review_as_of=context.review_as_of,
    )


def _project(
    deck: object,
    *,
    context: SlideDeckValidationContext,
    assets: PublicAssetSnapshot,
) -> PublicDeckProjection:
    if type(deck) is dict:
        review = deck.get("review")
        if type(review) is dict and review.get("status") == "provisional":
            _fail("public_review_required")

    deck_bytes = canonical_slide_deck_bytes(deck, context=context)
    validated = cast(dict, json.loads(deck_bytes))
    if validated["review"]["status"] != "reviewed":
        _fail("public_review_required")

    review_path = cast(str, validated["review"]["review_record"])
    review_record = context.review_records.get(review_path)
    if review_record is None or review_record.decision != "approved":
        _fail("public_review_required")

    rendered = render_slide_deck_html(
        validated,
        context=context,
        mode="public",
        assets=assets.references,
    )
    deck_sha256 = hashlib.sha256(deck_bytes).hexdigest()
    if rendered.deck_sha256 != deck_sha256:
        _fail("projection_integrity")

    deck_id = cast(str, validated["deck_id"])
    if not _valid_reviewed_at(review_record.reviewed_at):
        _fail("public_review_required")
    revision = f"{deck_sha256}-{rendered.html_sha256}"
    revision_root = f"{PAPER_SLIDES_PUBLIC_ROOT}/decks/{deck_id}/{revision}"
    deck_path = f"{revision_root}.html"
    deck_json_path = f"{revision_root}.deck.json"
    entry = PublicIndexEntry(
        paper_id=cast(str, validated["paper_id"]),
        language=cast(str, validated["language"]),
        deck_id=deck_id,
        deck_path=deck_path,
        deck_json_path=deck_json_path,
        deck_sha256=deck_sha256,
        html_sha256=rendered.html_sha256,
        coverage=cast(str, validated["coverage"]["kind"]),
        reviewed_at=review_record.reviewed_at,
    )
    files: dict[str, bytes] = {}
    total_bytes = 0
    for path, payload in assets.files.items():
        total_bytes = _add_public_file(files, path, payload, total_bytes)
    total_bytes = _add_public_file(files, deck_path, rendered.html_bytes, total_bytes)
    _add_public_file(files, deck_json_path, deck_bytes, total_bytes)
    return PublicDeckProjection(
        entry=entry,
        deck_bytes=deck_bytes,
        html_bytes=rendered.html_bytes,
        files=MappingProxyType(files),
    )


def project_reviewed_deck(
    deck: object,
    *,
    context: SlideDeckValidationContext,
) -> PublicDeckProjection:
    """Validate and render one reviewed deck without publishing it."""

    try:
        assets = resolve_public_slide_assets()
        trusted_context = snapshot_slide_validation_context(context)
        return _project(deck, context=trusted_context, assets=assets)
    except (KeyboardInterrupt, SystemExit):
        raise
    except SlidePublicIndexError as error:
        code = error.code
    except SlideRenderError as error:
        code = error.issue_code
    except SlideDeckValidationError as error:
        code = error.issue_code
    except Exception:
        code = "public_index_projection_failed"
    raise SlidePublicIndexError(code) from None


def _valid_entry(entry: object, deck: dict, deck_bytes: bytes, html_bytes: bytes) -> bool:
    if type(entry) is not PublicIndexEntry:
        return False
    values = entry.as_dict()
    if set(values) != _ENTRY_FIELDS or not all(type(value) is str for value in values.values()):
        return False

    paper_id = entry.paper_id
    deck_id = entry.deck_id
    revision = f"{entry.deck_sha256}-{entry.html_sha256}"
    revision_root = f"{PAPER_SLIDES_PUBLIC_ROOT}/decks/{deck_id}/{revision}"
    deck_path = f"{revision_root}.html"
    deck_json_path = f"{revision_root}.deck.json"
    return (
        _PAPER_ID_RE.fullmatch(paper_id) is not None
        and _DECK_ID_RE.fullmatch(deck_id) is not None
        and entry.language in {"ja", "en"}
        and entry.coverage in {"full_text", "abstract_only"}
        and _SHA256_RE.fullmatch(entry.deck_sha256) is not None
        and _SHA256_RE.fullmatch(entry.html_sha256) is not None
        and _valid_reviewed_at(entry.reviewed_at)
        and entry.deck_path == deck_path
        and entry.deck_json_path == deck_json_path
        and entry.deck_sha256 == hashlib.sha256(deck_bytes).hexdigest()
        and entry.html_sha256 == hashlib.sha256(html_bytes).hexdigest()
        and deck.get("paper_id") == paper_id
        and deck.get("deck_id") == deck_id
        and deck.get("language") == entry.language
        and type(deck.get("coverage")) is dict
        and deck["coverage"].get("kind") == entry.coverage
        and type(deck.get("review")) is dict
        and deck["review"].get("status") == "reviewed"
    )


def _checked_projection(projection: PublicDeckProjection) -> tuple[dict[str, str], str]:
    if (
        type(projection.deck_bytes) is not bytes
        or type(projection.html_bytes) is not bytes
        or not projection.deck_bytes.endswith(b"\n")
        or not projection.html_bytes.endswith(b"\n")
        or len(projection.deck_bytes) > MAX_CANONICAL_BYTES
        or len(projection.html_bytes) > MAX_RENDERED_HTML_BYTES
    ):
        _fail("projection_integrity")
    try:
        deck = strict_json_loads(projection.deck_bytes)
        if type(deck) is not dict or canonical_json_bytes(deck) != projection.deck_bytes:
            _fail("projection_integrity")
    except (TypeError, ValueError, UnicodeDecodeError, RecursionError):
        _fail("projection_integrity")
    if not _valid_entry(projection.entry, deck, projection.deck_bytes, projection.html_bytes):
        _fail("projection_integrity")
    if type(projection.files) is not _MAPPING_PROXY_TYPE:
        _fail("projection_integrity")
    try:
        files = dict(projection.files)
    except Exception:
        _fail("projection_integrity")
    if (
        files.get(projection.entry.deck_path) != projection.html_bytes
        or files.get(projection.entry.deck_json_path) != projection.deck_bytes
        or any(
            type(path) is not str or type(payload) is not bytes for path, payload in files.items()
        )
    ):
        _fail("projection_integrity")
    return projection.entry.as_dict(), projection.entry.paper_id[:2]


def _add_public_file(files: dict[str, bytes], path: str, payload: bytes, total: int) -> int:
    """Insert one exact public file without overwrite or aggregate over-retention."""

    if type(path) is not str or type(payload) is not bytes or path in files:
        _fail("public_file_collision")
    updated = total + len(payload)
    if updated > MAX_PUBLIC_BUNDLE_BYTES:
        _fail("bundle_size")
    files[path] = payload
    return updated


def build_public_index_shards(candidates: object) -> PublicIndexBundle:
    """Build all reviewed-only shards and their canonical hash manifest."""

    try:
        if type(candidates) is not list:
            _fail("candidate_collection")
        candidate_list = cast(list[object], candidates)
        if len(candidate_list) > MAX_PUBLIC_INDEX_ENTRIES:
            _fail("projection_limit")

        # One verified snapshot per bundle prevents candidate HTML from mixing
        # asset versions if the checked-in files change during a long build.
        assets = resolve_public_slide_assets()
        public_files: dict[str, bytes] = {}
        total_bytes = 0
        for path, payload in assets.files.items():
            total_bytes = _add_public_file(public_files, path, payload, total_bytes)
        entries_by_prefix: dict[str, list[dict[str, str]]] = {}
        identities: set[tuple[str, str]] = set()
        for value in candidate_list:
            if type(value) is not ReviewedDeckCandidate:
                _fail("candidate_type")
            candidate = value
            trusted_context = snapshot_slide_validation_context(candidate.context)
            projection = _project(candidate.deck, context=trusted_context, assets=assets)
            entry, prefix = _checked_projection(projection)
            expected_projection_paths = {
                *assets.files,
                projection.entry.deck_path,
                projection.entry.deck_json_path,
            }
            if set(projection.files) != expected_projection_paths or any(
                projection.files[path] != payload for path, payload in assets.files.items()
            ):
                _fail("projection_integrity")
            identity = (entry["paper_id"], entry["language"])
            if identity in identities:
                _fail("duplicate_paper_language")
            identities.add(identity)
            total_bytes = _add_public_file(
                public_files,
                projection.entry.deck_path,
                projection.html_bytes,
                total_bytes,
            )
            total_bytes = _add_public_file(
                public_files,
                projection.entry.deck_json_path,
                projection.deck_bytes,
                total_bytes,
            )
            entries_by_prefix.setdefault(prefix, []).append(entry)

        result: dict[str, bytes] = {}
        manifest_rows: list[dict[str, object]] = []
        for value in range(256):
            prefix = f"{value:02x}"
            entries = sorted(
                entries_by_prefix.get(prefix, []),
                key=lambda entry: (entry["paper_id"], entry["language"], entry["deck_id"]),
            )
            shard = canonical_json_bytes(
                {
                    "schema_version": PUBLIC_INDEX_SCHEMA_VERSION,
                    "entries": entries,
                }
            )
            if len(shard) > MAX_PUBLIC_INDEX_SHARD_BYTES:
                _fail("shard_size")
            result[prefix] = shard
            total_bytes = _add_public_file(
                public_files,
                f"{PAPER_SLIDES_PUBLIC_ROOT}/index/{prefix}.json",
                shard,
                total_bytes,
            )
            manifest_rows.append(
                {
                    "entry_count": len(entries),
                    "path": f"{PAPER_SLIDES_PUBLIC_ROOT}/index/{prefix}.json",
                    "prefix": prefix,
                    "sha256": hashlib.sha256(shard).hexdigest(),
                }
            )
        manifest_bytes = canonical_json_bytes(
            {
                "manifest_path": PUBLIC_MANIFEST_PATH,
                "schema_version": PUBLIC_MANIFEST_SCHEMA_VERSION,
                "shards": manifest_rows,
            }
        )
        if len(manifest_bytes) > MAX_PUBLIC_MANIFEST_BYTES:
            _fail("manifest_size")
        total_bytes = _add_public_file(
            public_files,
            PUBLIC_MANIFEST_PATH,
            manifest_bytes,
            total_bytes,
        )
        return PublicIndexBundle(
            shards=MappingProxyType(result),
            manifest_bytes=manifest_bytes,
            manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
            files=MappingProxyType(public_files),
            total_bytes=total_bytes,
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except SlidePublicIndexError as error:
        code = error.code
    except SlideRenderError as error:
        code = error.issue_code
    except SlideDeckValidationError as error:
        code = error.issue_code
    except Exception:
        code = "public_index_build_failed"
    raise SlidePublicIndexError(code) from None


__all__ = [
    "MAX_PUBLIC_ASSET_VERSIONS_BYTES",
    "MAX_PUBLIC_BUNDLE_BYTES",
    "MAX_PUBLIC_INDEX_ENTRIES",
    "MAX_PUBLIC_INDEX_SHARD_BYTES",
    "MAX_PUBLIC_MANIFEST_BYTES",
    "MAX_PUBLIC_SLIDE_ASSET_BYTES",
    "PAPER_SLIDES_PUBLIC_ROOT",
    "PUBLIC_INDEX_SCHEMA_VERSION",
    "PUBLIC_MANIFEST_PATH",
    "PUBLIC_MANIFEST_SCHEMA_VERSION",
    "PublicAssetSnapshot",
    "PublicDeckProjection",
    "PublicIndexBundle",
    "PublicIndexEntry",
    "ReviewedDeckCandidate",
    "SlidePublicIndexError",
    "build_public_index_shards",
    "project_reviewed_deck",
    "resolve_public_slide_assets",
    "snapshot_slide_validation_context",
]

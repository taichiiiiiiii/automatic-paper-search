"""Prepare immutable private lineage review packets from pinned local bytes.

This module performs no collection, filesystem writes, human-review synthesis,
quality construction, publication, or network access.  A matching source-byte
hash proves only which local bytes were supplied; it does not prove that an
excerpt occurs in visible source text or that a relation is correct.
"""

from __future__ import annotations

import hashlib
import re
import weakref
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from itertools import islice
from types import MappingProxyType
from typing import Any, NoReturn, cast
from urllib.parse import urlsplit

from paperpilot.identity import IdentityError, identity_from_url, normalize_alias
from paperpilot.replay import canonical_json_bytes, canonical_json_sha256, strict_json_loads
from paperpilot.scripts._lineage_contract_v2 import validate_lineage_artifact_v2

from .bundle import LineagePilotError, _catalog_ids

BLIND_PACK_VERSION = "lineage-blind-review-pack-v1"
CANDIDATE_UNIVERSE_VERSION = "lineage-candidate-universe-v1"
COORDINATOR_VERSION = "lineage-private-review-coordinator-v1"
EVIDENCE_BOUNDARY = "local_snapshot_hash_only_source_identity_and_excerpt_membership_unverified"
MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
MAX_CATALOG_BYTES = 8 * 1024 * 1024
MAX_CANDIDATE_SNAPSHOT_BYTES = 8 * 1024 * 1024
MAX_SOURCE_SNAPSHOT_BYTES = 16 * 1024 * 1024
MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024
MAX_CANDIDATES = 256
MAX_EVIDENCE_PER_CANDIDATE = 64
MAX_SOURCE_SNAPSHOTS = 256
MAX_BLIND_PACK_BYTES = 16 * 1024 * 1024
MAX_COORDINATOR_BYTES = 16 * 1024 * 1024

_PAPER_ID_RE = re.compile(r"^[0-9a-f]{40}$")
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
_OPAQUE_RE = re.compile(r"^[^\s\x00-\x1f\x7f]{1,512}$")
_CANDIDATE_REF_RE = re.compile(r"^candidate-snapshot:[A-Za-z0-9._:-]{1,240}$")
_SOURCE_REF_RE = re.compile(r"^source-snapshot:[A-Za-z0-9._:-]{1,240}$")
_REVIEW_RESPONSE_FIELDS = (
    "reviewer_id",
    "blind_to_model",
    "blind_to_peer",
    "citation_valid",
    "gold_family",
    "gold_relation",
    "evidence_support",
    "notes",
    "reviewed_at",
)
_BLIND_EVIDENCE_FIELDS = (
    "source",
    "kind",
    "source_work_id",
    "cited_work_id",
    "citing_work_id",
    "url",
    "locator",
    "excerpt",
    "excerpt_sha256",
    "input_sha256",
    "snapshot_ref",
)


class PrivateReviewError(ValueError):
    """Fail-closed private review-preparation error with a stable safe code."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _fail(code: str) -> NoReturn:
    raise PrivateReviewError(code) from None


@dataclass(frozen=True, eq=False)
class PrivateReviewBundle:
    """Factory-branded exact bytes for one coordinator and two blind packets."""

    files: Mapping[str, bytes] = field(repr=False)
    coordinator_sha256: str
    reviewer_pack_sha256s: Mapping[str, str]


_BundleAttestation = tuple[
    Mapping[str, bytes],
    Mapping[str, str],
    bytes,
    bytes,
    bytes,
    str,
    str,
    str,
]
_VALID_BUNDLES: weakref.WeakKeyDictionary[PrivateReviewBundle, _BundleAttestation] = (
    weakref.WeakKeyDictionary()
)


def _load_json_bytes(
    value: object,
    *,
    maximum: int,
    prefix: str,
    canonical: bool,
) -> tuple[object, bytes]:
    if type(value) is not bytes:
        _fail(f"{prefix}_bytes_required")
    payload = value
    if not payload or len(payload) > maximum:
        _fail(f"{prefix}_size")
    try:
        parsed = strict_json_loads(payload)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail(f"{prefix}_invalid")
    if canonical:
        try:
            expected = canonical_json_bytes(parsed)
        except (TypeError, ValueError, UnicodeError, RecursionError):
            _fail(f"{prefix}_invalid")
        if expected != payload:
            _fail(f"{prefix}_noncanonical")
    return parsed, payload


def _timestamp(value: object, code: str) -> datetime:
    if type(value) is not str or "T" not in value:
        _fail(code)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _fail(code)
    if parsed.tzinfo is None:
        _fail(code)
    return parsed


def _safe_text(value: object) -> bool:
    return type(value) is str and _OPAQUE_RE.fullmatch(value) is not None


def _validate_selected_catalog_identity(
    catalog: object,
    *,
    paper_id: str,
    focus: Mapping[str, Any],
) -> None:
    assert isinstance(catalog, list)
    selected = next(
        (row for row in catalog if isinstance(row, Mapping) and row.get("paper_id") == paper_id),
        None,
    )
    if not isinstance(selected, Mapping):
        _fail("catalog_identity_invalid")
    source = selected.get("source")
    source_id = selected.get("source_id")
    source_url = selected.get("arxiv_url")
    if not all(
        type(value) is str and bool(value.strip()) for value in (source, source_id, source_url)
    ):
        _fail("catalog_identity_invalid")
    try:
        declared = normalize_alias(cast(str, source), cast(str, source_id))
        from_url = identity_from_url(cast(str, source_url))
    except (IdentityError, UnicodeError, ValueError):
        _fail("catalog_identity_invalid")
    if declared != (from_url.source, from_url.source_id) or from_url.paper_id != paper_id:
        _fail("catalog_identity_mismatch")
    aliases = focus.get("aliases")
    normalized_aliases = (
        {
            (item[0], item[1])
            for item in aliases
            if isinstance(item, list)
            and len(item) == 2
            and all(type(value) is str for value in item)
        }
        if isinstance(aliases, list)
        else set()
    )
    if declared not in normalized_aliases:
        _fail("focus_catalog_alias_mismatch")


def _reject_prior_review(artifact: Mapping[str, Any]) -> None:
    claims = artifact.get("claims")
    if not isinstance(claims, list):
        return
    for claim in claims:
        if not isinstance(claim, Mapping):
            continue
        classification = claim.get("classification")
        if (
            claim.get("trust_tier") != "tentative"
            or claim.get("review_binding") is not None
            or (
                isinstance(classification, Mapping)
                and classification.get("method") == "human_review"
            )
        ):
            _fail("candidate_pre_reviewed")


def _validate_candidate_snapshot(
    candidate: object,
    *,
    candidate_bytes: bytes,
    artifact: Mapping[str, Any],
    collection_id: str,
) -> list[Mapping[str, Any]]:
    top = {
        "schema_version",
        "snapshot_ref",
        "collection_id",
        "release_id",
        "selection_method",
        "candidates",
    }
    if not isinstance(candidate, Mapping) or set(candidate) != top:
        _fail("candidate_snapshot_shape")
    if (
        candidate.get("schema_version") != CANDIDATE_UNIVERSE_VERSION
        or not isinstance(candidate.get("snapshot_ref"), str)
        or _CANDIDATE_REF_RE.fullmatch(candidate["snapshot_ref"]) is None
        or candidate.get("collection_id") != collection_id
        or candidate.get("release_id") != artifact.get("release_id")
        or not _safe_text(candidate.get("selection_method"))
    ):
        _fail("candidate_snapshot_identity")
    rows = candidate.get("candidates")
    if not isinstance(rows, list) or not rows or len(rows) > MAX_CANDIDATES:
        _fail("candidate_snapshot_candidates")
    parsed: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    row_keys = {"candidate_id", "src", "dst", "evidence_ids"}
    for row in rows:
        if not isinstance(row, Mapping) or set(row) != row_keys:
            _fail("candidate_snapshot_candidate_shape")
        candidate_id = row.get("candidate_id")
        evidence_ids = row.get("evidence_ids")
        if (
            not _safe_text(candidate_id)
            or not _safe_text(row.get("src"))
            or not _safe_text(row.get("dst"))
            or not isinstance(evidence_ids, list)
            or len(evidence_ids) > MAX_EVIDENCE_PER_CANDIDATE
            or not all(_safe_text(item) for item in evidence_ids)
            or len(evidence_ids) != len(set(evidence_ids))
        ):
            _fail("candidate_snapshot_candidate_shape")
        assert isinstance(candidate_id, str)
        if candidate_id in seen:
            _fail("candidate_snapshot_duplicate")
        seen.add(candidate_id)
        parsed.append(row)

    meta = artifact.get("meta")
    universe = meta.get("candidate_universe") if isinstance(meta, Mapping) else None
    if not isinstance(universe, Mapping) or (
        universe.get("snapshot_ref") != candidate.get("snapshot_ref")
        or universe.get("input_sha256") != hashlib.sha256(candidate_bytes).hexdigest()
        or universe.get("selection_method") != candidate.get("selection_method")
        or universe.get("candidate_count") != len(parsed)
    ):
        _fail("candidate_universe_binding")

    claims = artifact.get("claims")
    if not isinstance(claims, list):
        _fail("candidate_population_mismatch")
    claims_by_id = {
        claim.get("id"): claim
        for claim in claims
        if isinstance(claim, Mapping) and _safe_text(claim.get("id"))
    }
    rows_by_id = {row["candidate_id"]: row for row in parsed}
    if len(claims_by_id) != len(claims) or set(rows_by_id) != set(claims_by_id):
        _fail("candidate_population_mismatch")
    for candidate_id, row in rows_by_id.items():
        claim = claims_by_id[candidate_id]
        if (
            row["src"] != claim.get("src")
            or row["dst"] != claim.get("dst")
            or set(row["evidence_ids"]) != set(claim.get("evidence_ids", []))
            or (not row["evidence_ids"] and claim.get("decision") not in {"unknown", "abstained"})
        ):
            _fail("candidate_population_mismatch")
    return parsed


def _validate_url(value: object) -> None:
    if (
        type(value) is not str
        or len(value) > 4_096
        or any(character.isspace() for character in value)
    ):
        _fail("evidence_url_unsafe")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        _fail("evidence_url_unsafe")
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        _fail("evidence_url_unsafe")


def _snapshot_hashes(
    source_snapshots: object,
    evidence: list[Mapping[str, Any]],
) -> dict[str, str]:
    if not isinstance(source_snapshots, Mapping):
        _fail("source_snapshots_invalid")
    try:
        iterator = iter(source_snapshots.items())
        items = tuple(islice(iterator, MAX_SOURCE_SNAPSHOTS + 1))
    except (TypeError, ValueError, RuntimeError):
        _fail("source_snapshots_invalid")
    if len(items) > MAX_SOURCE_SNAPSHOTS:
        _fail("source_snapshots_invalid")
    snapshots: dict[str, bytes] = {}
    total = 0
    for snapshot_ref, payload in items:
        if (
            type(snapshot_ref) is not str
            or _SOURCE_REF_RE.fullmatch(snapshot_ref) is None
            or type(payload) is not bytes
        ):
            _fail("source_snapshot_invalid")
        if snapshot_ref in snapshots:
            _fail("source_snapshot_duplicate")
        if not payload or len(payload) > MAX_SOURCE_SNAPSHOT_BYTES:
            _fail("source_snapshot_size")
        total += len(payload)
        if total > MAX_TOTAL_SOURCE_BYTES:
            _fail("source_snapshots_size")
        snapshots[snapshot_ref] = payload

    used = {item.get("snapshot_ref") for item in evidence if isinstance(item, Mapping)}
    missing = used - set(snapshots)
    if missing:
        _fail("source_snapshot_missing")
    if set(snapshots) - used:
        _fail("source_snapshot_unused")
    hashes = {key: hashlib.sha256(value).hexdigest() for key, value in snapshots.items()}
    for item in evidence:
        snapshot_ref = item.get("snapshot_ref")
        if (
            any(
                not _safe_text(item.get(field))
                for field in (
                    "source",
                    "kind",
                    "source_work_id",
                    "cited_work_id",
                    "citing_work_id",
                )
            )
            or not isinstance(snapshot_ref, str)
            or _SOURCE_REF_RE.fullmatch(snapshot_ref) is None
        ):
            _fail("source_evidence_binding_invalid")
        if item.get("input_sha256") != hashes.get(snapshot_ref):
            _fail("source_snapshot_hash_mismatch")
        _validate_url(item.get("url"))
    return hashes


def _node_projection(node: Mapping[str, Any]) -> dict[str, object]:
    aliases = node.get("aliases")
    if (
        not _safe_text(node.get("id"))
        or type(node.get("title")) is not str
        or len(node["title"]) > 10_000
        or type(node.get("first_published_at")) is not str
        or len(node["first_published_at"]) > 64
        or not isinstance(aliases, list)
        or len(aliases) > 100
        or any(
            not isinstance(alias, list)
            or len(alias) != 2
            or not all(type(value) is str and len(value) <= 512 for value in alias)
            for alias in aliases
        )
    ):
        _fail("node_projection_unsafe")
    return {
        "node_id": node["id"],
        "title": node["title"],
        "first_published_at": node["first_published_at"],
        "aliases": node["aliases"],
    }


def _blind_evidence(item: Mapping[str, Any]) -> dict[str, object]:
    return {key: item[key] for key in _BLIND_EVIDENCE_FIELDS}


def _review_id(
    *, fixture_id: str, collection_id: str, src: str, dst: str, evidence_sha256: str
) -> str:
    digest: str = canonical_json_sha256(
        {
            "fixture_id": fixture_id,
            "collection_id": collection_id,
            "src": src,
            "dst": dst,
            "evidence_sha256": evidence_sha256,
        }
    )
    return f"review:{digest}"


def _pack_id(
    *,
    fixture_id: str,
    collection_id: str,
    reviewer_slot: str,
    bindings: Mapping[str, str],
    review_ids: list[str],
) -> str:
    digest: str = canonical_json_sha256(
        {
            "fixture_id": fixture_id,
            "collection_id": collection_id,
            "reviewer_slot": reviewer_slot,
            "bindings": dict(bindings),
            "review_ids": review_ids,
        }
    )
    return "pack:" + digest


def prepare_blind_review(
    *,
    artifact_bytes: bytes,
    catalog_bytes: bytes,
    candidate_snapshot_bytes: bytes,
    source_snapshots: Mapping[str, bytes],
    conference: str,
    paper_id: str,
    fixture_id: str,
    created_at: str,
) -> PrivateReviewBundle:
    """Return coordinator-only and A/B blind pending packets from pinned bytes."""

    if type(conference) is not str or _SLUG_RE.fullmatch(conference) is None:
        _fail("conference_invalid")
    if type(paper_id) is not str or _PAPER_ID_RE.fullmatch(paper_id) is None:
        _fail("paper_id_invalid")
    if not _safe_text(fixture_id):
        _fail("fixture_id_invalid")
    created = _timestamp(created_at, "created_at_invalid")

    artifact_value, exact_artifact_bytes = _load_json_bytes(
        artifact_bytes,
        maximum=MAX_ARTIFACT_BYTES,
        prefix="artifact",
        canonical=True,
    )
    catalog, exact_catalog_bytes = _load_json_bytes(
        catalog_bytes,
        maximum=MAX_CATALOG_BYTES,
        prefix="catalog",
        canonical=False,
    )
    candidate, exact_candidate_bytes = _load_json_bytes(
        candidate_snapshot_bytes,
        maximum=MAX_CANDIDATE_SNAPSHOT_BYTES,
        prefix="candidate_snapshot",
        canonical=True,
    )
    if not isinstance(artifact_value, Mapping) or not isinstance(candidate, Mapping):
        _fail("artifact_invalid")
    artifact = cast(Mapping[str, Any], artifact_value)
    candidate_mapping = cast(Mapping[str, Any], candidate)
    _reject_prior_review(artifact)

    try:
        catalog_ids = _catalog_ids(catalog)
    except LineagePilotError as error:
        _fail(error.code)
    if paper_id not in catalog_ids:
        _fail("paper_absent_from_catalog")
    try:
        artifact_issues = validate_lineage_artifact_v2(
            artifact,
            kind="deep",
            catalog_ids=catalog_ids,
        )
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail("artifact_validation_error")
    if artifact_issues:
        _fail(f"artifact_{artifact_issues[0].code}")
    if not _safe_text(artifact.get("release_id")):
        _fail("release_id_invalid")
    nodes_for_focus = artifact.get("nodes")
    assert isinstance(nodes_for_focus, list)
    focus_nodes = [
        node
        for node in nodes_for_focus
        if isinstance(node, Mapping) and node.get("is_focus") is True
    ]
    assert len(focus_nodes) == 1
    if focus_nodes[0].get("seed_paper_id") != paper_id:
        _fail("focus_paper_mismatch")
    _validate_selected_catalog_identity(catalog, paper_id=paper_id, focus=focus_nodes[0])

    collection_id = f"deep:{conference}:paper:{paper_id}"
    candidate_rows = _validate_candidate_snapshot(
        candidate_mapping,
        candidate_bytes=exact_candidate_bytes,
        artifact=artifact,
        collection_id=collection_id,
    )
    generated_at = artifact.get("meta", {}).get("generated_at")
    if created < _timestamp(generated_at, "artifact_generated_at_invalid"):
        _fail("review_prep_timeline")

    evidence_value = artifact.get("evidence")
    claims_value = artifact.get("claims")
    nodes_value = artifact.get("nodes")
    assert isinstance(evidence_value, list)
    assert isinstance(claims_value, list)
    assert isinstance(nodes_value, list)
    evidence = [cast(Mapping[str, Any], item) for item in evidence_value]
    claims = [cast(Mapping[str, Any], item) for item in claims_value]
    nodes = [cast(Mapping[str, Any], item) for item in nodes_value]
    source_hashes = _snapshot_hashes(source_snapshots, evidence)
    evidence_by_id = {item["id"]: item for item in evidence}
    claims_by_id = {item["id"]: item for item in claims}
    nodes_by_id = {item["id"]: item for item in nodes}

    artifact_sha256 = hashlib.sha256(exact_artifact_bytes).hexdigest()
    catalog_sha256 = hashlib.sha256(exact_catalog_bytes).hexdigest()
    candidate_sha256 = hashlib.sha256(exact_candidate_bytes).hexdigest()
    public_bindings = {
        "artifact_sha256": artifact_sha256,
        "catalog_sha256": catalog_sha256,
        "candidate_snapshot_sha256": candidate_sha256,
    }

    prepared_candidates: list[dict[str, object]] = []
    identities: set[tuple[str, str, str]] = set()
    for candidate_row in candidate_rows:
        claim = claims_by_id[candidate_row["candidate_id"]]
        bound_evidence = sorted(
            (evidence_by_id[evidence_id] for evidence_id in claim["evidence_ids"]),
            key=lambda item: item["id"],
        )
        evidence_sha256 = canonical_json_sha256(bound_evidence)
        identity = (claim["src"], claim["dst"], evidence_sha256)
        if identity in identities:
            _fail("candidate_identity_duplicate")
        identities.add(identity)
        prepared_candidates.append(
            {
                "candidate_id": candidate_row["candidate_id"],
                "review_id": _review_id(
                    fixture_id=fixture_id,
                    collection_id=collection_id,
                    src=claim["src"],
                    dst=claim["dst"],
                    evidence_sha256=evidence_sha256,
                ),
                "src": claim["src"],
                "dst": claim["dst"],
                "evidence_ids": list(claim["evidence_ids"]),
                "evidence_sha256": evidence_sha256,
                "evidence": bound_evidence,
                "machine_claim": dict(claim),
            }
        )
    prepared_candidates.sort(
        key=lambda item: (
            item["src"],
            item["dst"],
            item["evidence_sha256"],
            item["candidate_id"],
        )
    )

    blind_candidate_rows: list[dict[str, object]] = []
    for item in prepared_candidates:
        blind_candidate_rows.append(
            {
                "review_id": item["review_id"],
                "src": _node_projection(nodes_by_id[item["src"]]),
                "dst": _node_projection(nodes_by_id[item["dst"]]),
                "evidence_sha256": item["evidence_sha256"],
                "evidence": [
                    _blind_evidence(value)
                    for value in cast(list[Mapping[str, Any]], item["evidence"])
                ],
                "response": {field: None for field in _REVIEW_RESPONSE_FIELDS},
            }
        )

    pack_values: dict[str, dict[str, object]] = {}
    pack_bytes: dict[str, bytes] = {}
    pack_hashes: dict[str, str] = {}
    review_ids = [cast(str, item["review_id"]) for item in prepared_candidates]
    for slot in ("a", "b"):
        value = {
            "schema_version": BLIND_PACK_VERSION,
            "pack_id": _pack_id(
                fixture_id=fixture_id,
                collection_id=collection_id,
                reviewer_slot=slot,
                bindings=public_bindings,
                review_ids=review_ids,
            ),
            "fixture_id": fixture_id,
            "created_at": created_at,
            "collection_id": collection_id,
            "release_id": artifact["release_id"],
            "reviewer_slot": slot,
            "status": "pending",
            "evidence_boundary": EVIDENCE_BOUNDARY,
            "bindings": public_bindings,
            "candidate_count": len(blind_candidate_rows),
            "candidates": blind_candidate_rows,
        }
        payload = canonical_json_bytes(value)
        if len(payload) > MAX_BLIND_PACK_BYTES:
            _fail("blind_pack_size")
        pack_values[slot] = value
        pack_bytes[slot] = payload
        pack_hashes[slot] = hashlib.sha256(payload).hexdigest()

    coordinator = {
        "schema_version": COORDINATOR_VERSION,
        "fixture_id": fixture_id,
        "created_at": created_at,
        "collection_id": collection_id,
        "release_id": artifact["release_id"],
        "conference": conference,
        "paper_id": paper_id,
        "status": "pending",
        "evidence_boundary": EVIDENCE_BOUNDARY,
        "bindings": {
            **public_bindings,
            "source_snapshots": [
                {"snapshot_ref": key, "sha256": source_hashes[key]} for key in sorted(source_hashes)
            ],
        },
        "candidate_universe": {
            "snapshot_ref": candidate_mapping["snapshot_ref"],
            "selection_method": candidate_mapping["selection_method"],
            "candidate_count": len(prepared_candidates),
        },
        "candidates": [
            {
                "review_id": item["review_id"],
                "candidate_id": item["candidate_id"],
                "src": item["src"],
                "dst": item["dst"],
                "evidence_ids": item["evidence_ids"],
                "evidence_sha256": item["evidence_sha256"],
                "machine_claim": item["machine_claim"],
            }
            for item in prepared_candidates
        ],
        "blind_packs": [
            {
                "reviewer_slot": slot,
                "pack_id": pack_values[slot]["pack_id"],
                "sha256": pack_hashes[slot],
            }
            for slot in ("a", "b")
        ],
    }
    coordinator_bytes = canonical_json_bytes(coordinator)
    if len(coordinator_bytes) > MAX_COORDINATOR_BYTES:
        _fail("coordinator_size")
    coordinator_sha256 = hashlib.sha256(coordinator_bytes).hexdigest()
    files = MappingProxyType(
        {
            "coordinator.json": coordinator_bytes,
            "reviewer-a.json": pack_bytes["a"],
            "reviewer-b.json": pack_bytes["b"],
        }
    )
    bundle = PrivateReviewBundle(
        files=files,
        coordinator_sha256=coordinator_sha256,
        reviewer_pack_sha256s=MappingProxyType(dict(pack_hashes)),
    )
    _VALID_BUNDLES[bundle] = (
        files,
        bundle.reviewer_pack_sha256s,
        coordinator_bytes,
        pack_bytes["a"],
        pack_bytes["b"],
        coordinator_sha256,
        pack_hashes["a"],
        pack_hashes["b"],
    )
    return bundle


def validated_private_review_files(bundle: object) -> Mapping[str, bytes]:
    """Return detached exact files only for an untampered factory-created bundle."""

    if type(bundle) is not PrivateReviewBundle:
        _fail("review_bundle_invalid")
    trusted = bundle
    attestation = _VALID_BUNDLES.get(trusted)
    if attestation is None:
        _fail("review_bundle_invalid")
    if (
        type(trusted.files) is not MappingProxyType
        or type(trusted.reviewer_pack_sha256s) is not MappingProxyType
        or trusted.files is not attestation[0]
        or trusted.reviewer_pack_sha256s is not attestation[1]
        or type(trusted.coordinator_sha256) is not str
    ):
        _fail("review_bundle_invalid")
    expected_names = {"coordinator.json", "reviewer-a.json", "reviewer-b.json"}
    if set(trusted.files) != expected_names or set(trusted.reviewer_pack_sha256s) != {"a", "b"}:
        _fail("review_bundle_invalid")
    if attestation != (
        trusted.files,
        trusted.reviewer_pack_sha256s,
        trusted.files.get("coordinator.json"),
        trusted.files.get("reviewer-a.json"),
        trusted.files.get("reviewer-b.json"),
        trusted.coordinator_sha256,
        trusted.reviewer_pack_sha256s.get("a"),
        trusted.reviewer_pack_sha256s.get("b"),
    ):
        _fail("review_bundle_invalid")
    files: dict[str, bytes] = {}
    for name in sorted(expected_names):
        payload = trusted.files.get(name)
        if type(payload) is not bytes:
            _fail("review_bundle_invalid")
        expected = (
            trusted.coordinator_sha256
            if name == "coordinator.json"
            else trusted.reviewer_pack_sha256s[name.removeprefix("reviewer-").removesuffix(".json")]
        )
        if hashlib.sha256(payload).hexdigest() != expected:
            _fail("review_bundle_invalid")
        files[name] = payload
    return MappingProxyType(files)


__all__ = [
    "BLIND_PACK_VERSION",
    "CANDIDATE_UNIVERSE_VERSION",
    "COORDINATOR_VERSION",
    "EVIDENCE_BOUNDARY",
    "MAX_ARTIFACT_BYTES",
    "MAX_BLIND_PACK_BYTES",
    "MAX_CANDIDATES",
    "MAX_CANDIDATE_SNAPSHOT_BYTES",
    "MAX_CATALOG_BYTES",
    "MAX_COORDINATOR_BYTES",
    "MAX_EVIDENCE_PER_CANDIDATE",
    "MAX_SOURCE_SNAPSHOTS",
    "MAX_SOURCE_SNAPSHOT_BYTES",
    "MAX_TOTAL_SOURCE_BYTES",
    "PrivateReviewBundle",
    "PrivateReviewError",
    "prepare_blind_review",
    "validated_private_review_files",
]

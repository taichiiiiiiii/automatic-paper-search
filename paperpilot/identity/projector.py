"""Pure Identity Lite projection over committed conference catalogs."""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from paperpilot.identity.source_ids import (
    IdentityError,
    identity_from_url,
    normalize_alias,
)


@dataclass(frozen=True)
class IdentityProjection:
    """Validated catalog rows plus deterministic public sidecars."""

    catalogs: dict[str, list[dict[str, Any]]]
    aliases: list[list[str]]
    coverage: dict[str, Any]

    @property
    def valid(self) -> bool:
        return bool(self.coverage.get("valid"))


def _validate_as_of(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("as_of must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError("as_of must include a timezone")
    return value


def _native_url_fingerprint(url: str) -> str:
    parts = urlsplit(url)
    return f"{(parts.hostname or '').lower()}{parts.path}"


def project_catalogs(
    docs_root: Path,
    conference_names: list[str],
    *,
    as_of: str,
) -> IdentityProjection:
    """Project known-source IDs while collecting every coverage failure."""

    as_of = _validate_as_of(as_of)
    catalogs: dict[str, list[dict[str, Any]]] = {}
    source_counts: Counter[str] = Counter()
    failures: list[dict[str, Any]] = []
    paper_records: dict[str, tuple[str, str]] = {}
    paper_occurrences: defaultdict[str, int] = defaultdict(int)
    alias_map: dict[tuple[str, str], str] = {}
    alias_conflicts: list[dict[str, str]] = []
    native_fingerprints: dict[tuple[str, str], str] = {}
    input_rows = 0
    resolved_rows = 0
    hash_collisions = 0

    def record_alias(namespace: str, normalized_id: str, paper_id: str) -> None:
        nonlocal alias_conflicts
        key = (namespace, normalized_id)
        existing = alias_map.get(key)
        if existing is None:
            alias_map[key] = paper_id
        elif existing != paper_id:
            alias_conflicts.append(
                {
                    "namespace": namespace,
                    "normalized_id": normalized_id,
                    "first_paper_id": existing,
                    "second_paper_id": paper_id,
                }
            )

    for conference in sorted(conference_names):
        path = docs_root / conference / "papers.json"
        try:
            rows = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            failures.append({"conference": conference, "row": None, "title": "", "error": str(exc)})
            continue
        if not isinstance(rows, list):
            failures.append(
                {
                    "conference": conference,
                    "row": None,
                    "title": "",
                    "error": "papers.json must be an array",
                }
            )
            continue

        enriched_rows: list[dict[str, Any]] = []
        for ordinal, row in enumerate(rows):
            input_rows += 1
            title = row.get("title", "") if isinstance(row, dict) else ""
            try:
                if not isinstance(row, dict):
                    raise IdentityError("paper row must be an object")
                source_url = str(row.get("arxiv_url") or "")
                identity = identity_from_url(source_url)
                embedded = row.get("paper_id")
                if embedded is not None and embedded != identity.paper_id:
                    raise IdentityError("embedded paper_id does not match source URL")
                if row.get("source") is not None or row.get("source_id") is not None:
                    source = row.get("source")
                    source_id = row.get("source_id")
                    if not isinstance(source, str) or not isinstance(source_id, str):
                        raise IdentityError("embedded source/source_id must be strings")
                    if normalize_alias(source, source_id) != (
                        identity.source,
                        identity.source_id,
                    ):
                        raise IdentityError("embedded source/source_id does not match URL")

                existing_record = paper_records.get(identity.paper_id)
                native_record = (identity.source, identity.source_id)
                if existing_record is not None and existing_record != native_record:
                    hash_collisions += 1
                    raise IdentityError("paper_id hash collision")
                paper_records[identity.paper_id] = native_record
                paper_occurrences[identity.paper_id] += 1

                native_key = (identity.source, identity.source_id)
                fingerprint = _native_url_fingerprint(source_url)
                previous_fingerprint = native_fingerprints.get(native_key)
                if (
                    identity.source == "cvf"
                    and previous_fingerprint is not None
                    and previous_fingerprint != fingerprint
                ):
                    raise IdentityError("CVF filename stem maps to multiple canonical paths")
                native_fingerprints[native_key] = fingerprint

                record_alias(identity.source, identity.source_id, identity.paper_id)
                arxiv_id = str(row.get("arxiv_id") or "").strip()
                if arxiv_id:
                    namespace, normalized_id = normalize_alias("arxiv", arxiv_id)
                    record_alias(namespace, normalized_id, identity.paper_id)

                enriched_rows.append(
                    {
                        **row,
                        "paper_id": identity.paper_id,
                        "source": identity.source,
                        "source_id": identity.source_id,
                    }
                )
                source_counts[identity.source] += 1
                resolved_rows += 1
            except (IdentityError, ValueError) as exc:
                failures.append(
                    {
                        "conference": conference,
                        "row": ordinal,
                        "title": str(title),
                        "error": str(exc),
                    }
                )
        catalogs[conference] = enriched_rows

    duplicate_paper_ids = sum(
        occurrences - 1 for occurrences in paper_occurrences.values() if occurrences > 1
    )
    valid = (
        input_rows > 0
        and resolved_rows == input_rows
        and not failures
        and not alias_conflicts
        and hash_collisions == 0
        and duplicate_paper_ids == 0
    )
    coverage = {
        "schema_version": "identity-coverage-v1",
        "as_of": as_of,
        "valid": valid,
        "input_rows": input_rows,
        "resolved_rows": resolved_rows,
        "coverage": resolved_rows / input_rows if input_rows else 0.0,
        "unique_paper_ids": len(paper_records),
        "duplicate_paper_ids": duplicate_paper_ids,
        "hash_collisions": hash_collisions,
        "alias_conflicts": len(alias_conflicts),
        "field_loss_rows": 0,
        "source_counts": dict(sorted(source_counts.items())),
        "failures": failures,
        "alias_conflict_details": alias_conflicts,
    }
    aliases = [
        [namespace, normalized_id, paper_id]
        for (namespace, normalized_id), paper_id in sorted(alias_map.items())
    ]
    return IdentityProjection(catalogs=catalogs, aliases=aliases, coverage=coverage)

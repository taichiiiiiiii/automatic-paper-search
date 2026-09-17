"""Canonical immutable snapshot fingerprinting."""

from __future__ import annotations

import hashlib
import json

from .models import NormalizedPaper


def canonical_fingerprint_bytes(
    *,
    adapter_version: str,
    edition_id: str,
    source_id: str,
    rows: tuple[NormalizedPaper, ...],
) -> bytes:
    """Serialize the exact v1 fingerprint payload with one trailing LF."""

    payload = {
        "adapter_version": adapter_version,
        "edition_id": edition_id,
        "source_id": source_id,
        "rows": [row.fingerprint_fields() for row in sorted(rows, key=lambda row: row.source_id)],
    }
    return (
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def source_fingerprint(
    *,
    adapter_version: str,
    edition_id: str,
    source_id: str,
    rows: tuple[NormalizedPaper, ...],
) -> str:
    """Return the deterministic SHA-256 source fingerprint."""

    return hashlib.sha256(
        canonical_fingerprint_bytes(
            adapter_version=adapter_version,
            edition_id=edition_id,
            source_id=source_id,
            rows=rows,
        )
    ).hexdigest()

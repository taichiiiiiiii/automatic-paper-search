"""On-disk caches whose entries carry the schema that wrote them.

Why: an older builder cached outages and malformed pages as ``[]``, and
a bare ``[]`` on disk is indistinguishable from a real "no results".
Element validation cannot tell them apart either, because an empty list
has no elements. Wrapping every entry as ``{"schema_version", "data"}``
lets a reader refuse anything written before the current contract: a
legacy or mismatched file is a cache miss (refetch), never an answer.

Only a versioned ``{"data": []}`` is a trusted empty result.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Final

from paperpilot.utils.atomic import atomic_write_text


class _CacheMiss:
    __slots__ = ()

    def __repr__(self) -> str:
        return "CACHE_MISS"


CACHE_MISS: Final = _CacheMiss()


def read_versioned_cache(path: Path, version: str) -> object:
    """Return the cached ``data`` or ``CACHE_MISS``.

    Missing, unreadable, legacy (unwrapped) and other-version files are
    all misses. The caller still validates the returned data against its
    own predicate; the version only proves which writer produced it.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return CACHE_MISS
    except (OSError, ValueError):
        return CACHE_MISS
    if (
        not isinstance(raw, dict)
        or raw.get("schema_version") != version
        or "data" not in raw
    ):
        return CACHE_MISS
    return raw["data"]


def write_versioned_cache(path: Path, version: str, data: object) -> None:
    """Atomically write ``data`` wrapped with ``version``."""
    atomic_write_text(
        path,
        json.dumps({"schema_version": version, "data": data}, ensure_ascii=False, indent=2),
    )

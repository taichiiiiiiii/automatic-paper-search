"""Build immutable, content-addressed local lineage pilot bundles.

This module never collects research data, invents review results, or publishes
into ``docs/``.  It only packages already parsed lineage-v2 inputs after the
existing Python validators bind them to an actual parsed conference catalog.
"""

from __future__ import annotations

import ctypes
import errno
import os
import re
import shutil
import stat
import sys
import tempfile
import weakref
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from itertools import islice
from pathlib import Path
from types import MappingProxyType
from typing import Any, NoReturn

from paperpilot.replay import canonical_json_bytes, sha256_bytes, strict_json_loads
from paperpilot.scripts._lineage_contract_v2 import (
    validate_lineage_artifact_v2,
    validate_lineage_audit_fixtures_v2,
    validate_lineage_quality_v2,
)

INDEX_VERSION = "lineage-pilot-index-v1"
RELEASE_PROFILE = "claim-verified-pilot-v1"
MAX_INDEX_ENTRIES = 100
MAX_INDEX_BYTES = 256 * 1024
MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
MAX_FIXTURE_BYTES = 8 * 1024 * 1024
MAX_QUALITY_BYTES = 256 * 1024
MAX_CATALOG_BYTES = 8 * 1024 * 1024

_PAPER_ID_RE = re.compile(r"^[0-9a-f]{40}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_DIRECTORY_BY_KIND = {
    "artifact": "artifacts",
    "fixture": "fixtures",
    "quality": "quality",
}


class LineagePilotError(ValueError):
    """A fail-closed lineage pilot error with a stable non-sensitive code."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _fail(code: str) -> NoReturn:
    raise LineagePilotError(code) from None


@dataclass(frozen=True, slots=True)
class PilotHashedPath:
    """One content-addressed path and its exact byte digest."""

    path: str
    sha256: str

    def as_dict(self) -> dict[str, str]:
        return {"path": self.path, "sha256": self.sha256}


@dataclass(frozen=True, slots=True)
class PilotIndexEntry:
    """One validated closed index entry."""

    paper_id: str
    conference: str
    collection_id: str
    release_id: str
    release_profile: str
    artifact: PilotHashedPath
    fixture: PilotHashedPath
    quality: PilotHashedPath

    def as_dict(self) -> dict[str, object]:
        return {
            "paper_id": self.paper_id,
            "conference": self.conference,
            "collection_id": self.collection_id,
            "release_id": self.release_id,
            "release_profile": self.release_profile,
            "artifact": self.artifact.as_dict(),
            "fixture": self.fixture.as_dict(),
            "quality": self.quality.as_dict(),
        }


@dataclass(frozen=True, slots=True)
class PilotIndex:
    """A validated immutable index value."""

    entries: tuple[PilotIndexEntry, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "schema_version": INDEX_VERSION,
            "entries": [entry.as_dict() for entry in self.entries],
        }


@dataclass(frozen=True, eq=False)
class PilotBundle:
    """Immutable bytes and index identity for one pilot release."""

    files: Mapping[str, bytes]
    index_entry: PilotIndexEntry


_VALID_BUNDLES: weakref.WeakSet[PilotBundle] = weakref.WeakSet()


def _canonical_bytes(value: object, maximum: int, code: str) -> bytes:
    try:
        payload: bytes = canonical_json_bytes(value)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail(code)
    if len(payload) > maximum:
        _fail(code)
    return payload


def _canonical_snapshot(value: object, maximum: int, code: str) -> tuple[object, bytes]:
    """Detach one private parsed snapshot from a caller-owned JSON value."""

    payload = _canonical_bytes(value, maximum, code)
    try:
        snapshot = strict_json_loads(payload)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail(code)
    return snapshot, payload


def _expected_path(kind: str, conference: str, paper_id: str, sha256: str) -> str:
    return f"lineage-pilots/{conference}/{paper_id}/{_DIRECTORY_BY_KIND[kind]}/{sha256}.json"


def _parse_hashed_path(
    value: object,
    *,
    kind: str,
    conference: str,
    paper_id: str,
) -> PilotHashedPath:
    if type(value) is not dict or set(value) != {"path", "sha256"}:
        _fail("index_reference_invalid")
    path = value.get("path")
    sha256 = value.get("sha256")
    if (
        type(path) is not str
        or type(sha256) is not str
        or _SHA256_RE.fullmatch(sha256) is None
        or path != _expected_path(kind, conference, paper_id, sha256)
    ):
        _fail("index_reference_invalid")
    return PilotHashedPath(path=path, sha256=sha256)


def validate_pilot_index(value: object) -> PilotIndex:
    """Validate and freeze one closed ``lineage-pilot-index-v1`` value."""

    value, _payload = _canonical_snapshot(value, MAX_INDEX_BYTES, "index_invalid")
    if type(value) is not dict or set(value) != {"schema_version", "entries"}:
        _fail("index_invalid")
    if value.get("schema_version") != INDEX_VERSION:
        _fail("index_invalid")
    entries_value = value.get("entries")
    if type(entries_value) is not list or len(entries_value) > MAX_INDEX_ENTRIES:
        _fail("index_invalid")

    parsed: list[PilotIndexEntry] = []
    seen_paper_ids: set[str] = set()
    entry_keys = {
        "paper_id",
        "conference",
        "collection_id",
        "release_id",
        "release_profile",
        "artifact",
        "fixture",
        "quality",
    }
    for value_entry in entries_value:
        if type(value_entry) is not dict or set(value_entry) != entry_keys:
            _fail("index_entry_invalid")
        paper_id = value_entry.get("paper_id")
        conference = value_entry.get("conference")
        release_id = value_entry.get("release_id")
        if (
            type(paper_id) is not str
            or _PAPER_ID_RE.fullmatch(paper_id) is None
            or type(conference) is not str
            or _SLUG_RE.fullmatch(conference) is None
            or type(release_id) is not str
            or not release_id.strip()
            or value_entry.get("collection_id") != f"deep:{conference}:paper:{paper_id}"
            or value_entry.get("release_profile") != RELEASE_PROFILE
        ):
            _fail("index_entry_invalid")
        if paper_id in seen_paper_ids:
            _fail("index_duplicate_paper")
        seen_paper_ids.add(paper_id)
        parsed.append(
            PilotIndexEntry(
                paper_id=paper_id,
                conference=conference,
                collection_id=f"deep:{conference}:paper:{paper_id}",
                release_id=release_id,
                release_profile=RELEASE_PROFILE,
                artifact=_parse_hashed_path(
                    value_entry.get("artifact"),
                    kind="artifact",
                    conference=conference,
                    paper_id=paper_id,
                ),
                fixture=_parse_hashed_path(
                    value_entry.get("fixture"),
                    kind="fixture",
                    conference=conference,
                    paper_id=paper_id,
                ),
                quality=_parse_hashed_path(
                    value_entry.get("quality"),
                    kind="quality",
                    conference=conference,
                    paper_id=paper_id,
                ),
            )
        )
    return PilotIndex(tuple(parsed))


def build_pilot_index(entries: Iterable[PilotIndexEntry]) -> bytes:
    """Return deterministic canonical bytes for validated typed entries."""

    try:
        iterator = iter(entries)
        values = tuple(islice(iterator, MAX_INDEX_ENTRIES + 1))
    except (TypeError, ValueError, RuntimeError):
        _fail("index_invalid")
    if len(values) > MAX_INDEX_ENTRIES:
        _fail("index_invalid")
    if not all(type(entry) is PilotIndexEntry for entry in values):
        _fail("index_invalid")
    ordered = sorted(values, key=lambda entry: (entry.paper_id, entry.conference))
    raw = {
        "schema_version": INDEX_VERSION,
        "entries": [entry.as_dict() for entry in ordered],
    }
    validated = validate_pilot_index(raw)
    return _canonical_bytes(validated.as_dict(), MAX_INDEX_BYTES, "index_invalid")


def _catalog_ids(catalog: object) -> set[str]:
    if type(catalog) is not list or not catalog:
        _fail("catalog_invalid")
    result: set[str] = set()
    for row in catalog:
        if type(row) is not dict:
            _fail("catalog_invalid")
        paper_id = row.get("paper_id")
        if type(paper_id) is not str or _PAPER_ID_RE.fullmatch(paper_id) is None:
            _fail("catalog_invalid")
        title = row.get("title")
        authors = row.get("authors")
        tags = row.get("tags")
        abstract = row.get("abstract")
        try:
            valid_text = (
                type(title) is str
                and bool(title.strip())
                and len(title) <= 1_000
                and type(authors) is list
                and 1 <= len(authors) <= 100
                and all(
                    type(author) is str and bool(author.strip()) and len(author) <= 300
                    for author in authors
                )
                and type(tags) is list
                and all(type(tag) is str for tag in tags)
                and type(abstract) is str
                and bool(title.encode("utf-8"))
                and all(bool(author.encode("utf-8")) for author in authors)
            )
        except UnicodeError:
            valid_text = False
        if not valid_text:
            _fail("catalog_metadata_invalid")
        if paper_id in result:
            _fail("catalog_duplicate_paper")
        result.add(paper_id)
    return result


def _v2_issues_code(prefix: str, issues: list[Any]) -> str:
    if not issues:
        return prefix
    code = getattr(issues[0], "code", "invalid")
    return f"{prefix}_{code}"


def _validated_v2(prefix: str, validator: Any, value: object, **kwargs: object) -> None:
    """Normalize expected contract-parser failures without exposing input data."""

    try:
        issues = validator(value, **kwargs)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail(f"{prefix}_validation_error")
    if issues:
        _fail(_v2_issues_code(prefix, issues))


def build_pilot_bundle(
    *,
    artifact: object,
    fixture: object,
    quality: object,
    catalog: object,
    conference: str,
    paper_id: str,
) -> PilotBundle:
    """Validate and package one deep, claim-verified local pilot release.

    The input objects are never modified.  ``quality.collections[0].path`` is
    the sole projected field and is rebound to the emitted artifact path before
    the complete v2 quality validator runs a second time.
    """

    if type(conference) is not str or _SLUG_RE.fullmatch(conference) is None:
        _fail("conference_invalid")
    if type(paper_id) is not str or _PAPER_ID_RE.fullmatch(paper_id) is None:
        _fail("paper_id_invalid")
    if type(artifact) is not dict or type(fixture) is not dict or type(quality) is not dict:
        _fail("input_shape_invalid")

    artifact_snapshot, artifact_bytes = _canonical_snapshot(
        artifact, MAX_ARTIFACT_BYTES, "artifact_invalid"
    )
    fixture_snapshot, fixture_bytes = _canonical_snapshot(
        fixture, MAX_FIXTURE_BYTES, "fixture_invalid"
    )
    quality_snapshot, _ = _canonical_snapshot(quality, MAX_QUALITY_BYTES, "quality_invalid")
    catalog_snapshot, _ = _canonical_snapshot(catalog, MAX_CATALOG_BYTES, "catalog_invalid")
    if (
        type(artifact_snapshot) is not dict
        or type(fixture_snapshot) is not dict
        or type(quality_snapshot) is not dict
    ):
        _fail("input_shape_invalid")

    catalog_ids = _catalog_ids(catalog_snapshot)
    if paper_id not in catalog_ids:
        _fail("paper_absent_from_catalog")
    collection_id = f"deep:{conference}:paper:{paper_id}"

    _validated_v2(
        "artifact_v2",
        validate_lineage_artifact_v2,
        artifact_snapshot,
        kind="deep",
        catalog_ids=catalog_ids,
    )
    _validated_v2("fixture_v2", validate_lineage_audit_fixtures_v2, fixture_snapshot)

    rows = quality_snapshot.get("collections")
    if type(rows) is not list or len(rows) != 1 or type(rows[0]) is not dict:
        _fail("quality_selector_invalid")
    row = rows[0]
    focus_seeds = [
        node.get("seed_paper_id")
        for node in artifact_snapshot.get("nodes", [])
        if type(node) is dict and node.get("is_focus") is True
    ]
    if (
        focus_seeds != [paper_id]
        or row.get("kind") != "deep"
        or row.get("slug") != conference
        or row.get("collection_id") != collection_id
        or row.get("release_profile") != RELEASE_PROFILE
    ):
        _fail("quality_selector_invalid")

    validation_inputs = {
        "artifacts": {collection_id: artifact_snapshot},
        "fixtures": {collection_id: fixture_snapshot},
        "catalog_ids": {collection_id: catalog_ids},
    }
    _validated_v2("quality_v2", validate_lineage_quality_v2, quality_snapshot, **validation_inputs)

    artifact_sha256 = sha256_bytes(artifact_bytes)
    fixture_sha256 = sha256_bytes(fixture_bytes)
    artifact_path = _expected_path("artifact", conference, paper_id, artifact_sha256)

    projected_quality = {
        **quality_snapshot,
        "collections": [{**row, "path": artifact_path}],
    }
    projected_quality_bytes = _canonical_bytes(
        projected_quality,
        MAX_QUALITY_BYTES,
        "quality_invalid",
    )
    _validated_v2(
        "quality_rehome_v2",
        validate_lineage_quality_v2,
        projected_quality,
        **validation_inputs,
    )

    quality_sha256 = sha256_bytes(projected_quality_bytes)
    fixture_path = _expected_path("fixture", conference, paper_id, fixture_sha256)
    quality_path = _expected_path("quality", conference, paper_id, quality_sha256)
    index_entry = PilotIndexEntry(
        paper_id=paper_id,
        conference=conference,
        collection_id=collection_id,
        release_id=artifact_snapshot["release_id"],
        release_profile=RELEASE_PROFILE,
        artifact=PilotHashedPath(artifact_path, artifact_sha256),
        fixture=PilotHashedPath(fixture_path, fixture_sha256),
        quality=PilotHashedPath(quality_path, quality_sha256),
    )
    # Exercise the closed index validator before exposing the typed entry.
    build_pilot_index((index_entry,))
    files = MappingProxyType(
        {
            artifact_path: artifact_bytes,
            fixture_path: fixture_bytes,
            quality_path: projected_quality_bytes,
        }
    )
    bundle = PilotBundle(files=files, index_entry=index_entry)
    _VALID_BUNDLES.add(bundle)
    return bundle


def _has_symlink_component(path: Path) -> bool:
    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor)
    try:
        for part in absolute.parts[1:]:
            current /= part
            try:
                if stat.S_ISLNK(current.lstat().st_mode):
                    return True
            except FileNotFoundError:
                return False
        return False
    except OSError:
        return True


def _rename_noreplace(source: Path, destination: Path) -> None:
    """Atomically publish a directory without replacing a race winner."""

    try:
        source_bytes = os.fsencode(source)
        destination_bytes = os.fsencode(destination)
        libc = ctypes.CDLL(None, use_errno=True)
        if sys.platform.startswith("linux"):
            operation = libc.renameat2
            operation.argtypes = [
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_uint,
            ]
            operation.restype = ctypes.c_int
            result = operation(-100, source_bytes, -100, destination_bytes, 1)
        elif sys.platform == "darwin":
            operation = libc.renamex_np
            operation.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
            operation.restype = ctypes.c_int
            result = operation(source_bytes, destination_bytes, 0x00000004)
        else:
            _fail("output_platform_unsupported")
    except LineagePilotError:
        raise
    except (AttributeError, OSError, TypeError, ValueError):
        _fail("output_write_failed")
    if result == 0:
        return
    if ctypes.get_errno() in {errno.EEXIST, errno.ENOTEMPTY}:
        _fail("output_exists")
    _fail("output_write_failed")


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _validated_bundle_files(bundle: PilotBundle) -> dict[str, bytes]:
    if bundle not in _VALID_BUNDLES:
        _fail("bundle_invalid")
    build_pilot_index((bundle.index_entry,))
    references = (
        (bundle.index_entry.artifact, MAX_ARTIFACT_BYTES),
        (bundle.index_entry.fixture, MAX_FIXTURE_BYTES),
        (bundle.index_entry.quality, MAX_QUALITY_BYTES),
    )
    expected_paths = {reference.path for reference, _maximum in references}
    if set(bundle.files) != expected_paths:
        _fail("bundle_invalid")
    files: dict[str, bytes] = {}
    for reference, maximum in references:
        payload = bundle.files.get(reference.path)
        if (
            type(payload) is not bytes
            or len(payload) > maximum
            or sha256_bytes(payload) != reference.sha256
        ):
            _fail("bundle_invalid")
        files[reference.path] = payload
    return files


def write_local_pilot_bundle(bundle: PilotBundle, output_dir: Path) -> Path:
    """Publish ``bundle`` into one fresh local directory and return its path."""

    if type(bundle) is not PilotBundle:
        _fail("bundle_invalid")
    files = _validated_bundle_files(bundle)
    try:
        raw_output = Path(output_dir)
        invalid_output = ".." in raw_output.parts or "\x00" in os.fspath(raw_output)
    except (TypeError, ValueError, OSError):
        _fail("output_path_invalid")
    if invalid_output:
        _fail("output_path_invalid")
    output = Path(os.path.abspath(raw_output))
    repository_root = Path(__file__).resolve().parents[2]
    forbidden_roots = (repository_root / "docs", repository_root / "paperpilot" / "data")
    if any(_is_within(output, forbidden) for forbidden in forbidden_roots):
        _fail("output_canonical_forbidden")
    parent = output.parent
    if _has_symlink_component(parent):
        _fail("output_path_invalid")
    try:
        parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        _fail("output_write_failed")
    if _has_symlink_component(parent):
        _fail("output_path_invalid")
    if output.is_symlink():
        _fail("output_path_invalid")
    if output.exists():
        _fail("output_exists")

    files["lineage-pilot-index-v1.json"] = build_pilot_index((bundle.index_entry,))
    temporary: Path | None = None
    committed = False
    try:
        temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}.tmp-", dir=parent))
        for relative, payload in sorted(files.items()):
            parts = relative.split("/")
            if any(part in {"", ".", ".."} for part in parts):
                _fail("bundle_invalid")
            destination = temporary.joinpath(*parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
        _rename_noreplace(temporary, output)
        committed = True
    except LineagePilotError:
        raise
    except OSError:
        _fail("output_write_failed")
    finally:
        if temporary is not None and not committed:
            shutil.rmtree(temporary, ignore_errors=True)
    return output

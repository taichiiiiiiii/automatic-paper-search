"""Deterministic producer for the approved Paper Slide catalog snapshot.

The snapshot is a read-only trust input for ``worker/paper-slide-catalog.js``.
It contains no abstract text and never asserts full-text coverage: the current
catalog has a public full-abstract projection, but no PDF byte digest produced
by the SD1 fetch boundary.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Any
from urllib.parse import urlsplit

from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_EXTRACTION_INSUFFICIENT,
    PAPER_SLIDE_SOURCE_UNTRUSTED,
)
from paperpilot.paper_slides.generate import (
    MAX_ABSTRACT_CODEPOINTS,
    MIN_ABSTRACT_CODEPOINTS,
)
from paperpilot.paper_slides.resolver import SourceResolutionError, resolve_pdf_source

PIN_SCHEMA = "paper-slide-approved-catalog-pin-v1"
MANIFEST_SCHEMA = "paper-slide-approved-catalog-manifest-v1"
RECORD_SCHEMA = "paper-slide-approved-catalog-record-v1"
JOB_KEY_SCHEMA = "paper-slide-job-key-v1"

MAX_CONFIG_BYTES = 64 * 1024
MAX_CATALOG_BYTES = 128 * 1024 * 1024
MAX_DETAIL_SHARD_BYTES = 16 * 1024 * 1024
MAX_MANIFEST_BYTES = 8 * 1024 * 1024
MAX_RECORD_BYTES = 64 * 1024
MAX_RECORDS = 100_000

DEFAULT_CATALOG_NAMES = (
    "aaai-2026",
    "acl-2025",
    "cvpr-2025",
    "cvpr-2026",
    "eccv-2024",
    "emnlp-2025",
    "iccv-2025",
    "iclr-2026",
    "icml-2025",
    "neurips-2025",
)
SOURCE_REGISTRY = frozenset({"arxiv", "openreview", "acl_anthology", "cvf"})

_PAPER_ID_RE = re.compile(r"^[0-9a-f]{40}$")
_SNAPSHOT_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$")
_SAFE_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$")
_SOURCE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/()+=-]{0,511}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_CONFIG_KEYS = frozenset(
    {
        "deck_profile",
        "deck_schema_version",
        "extractor_version",
        "license_policy_version",
        "manifest_key",
        "model",
        "prompt_version",
        "provider",
        "records_prefix",
        "snapshot_version",
    }
)


class CatalogBuildError(ValueError):
    """Stable, non-sensitive snapshot build failure."""

    def __init__(self, issue_code: str) -> None:
        self.issue_code = issue_code
        super().__init__(f"PAPER_SLIDE_CATALOG_BUILD_FAILED:{issue_code}")


class _DuplicateJsonKeyError(ValueError):
    pass


def _closed_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise _DuplicateJsonKeyError
        value[key] = item
    return value


def _read_json(path: Path, maximum_bytes: int, issue_code: str) -> object:
    descriptor: int | None = None
    try:
        if _has_symlink_component(path):
            raise CatalogBuildError(f"{issue_code}_invalid")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise CatalogBuildError(f"{issue_code}_invalid")
        if before.st_size > maximum_bytes:
            raise CatalogBuildError(f"{issue_code}_oversized")
        with os.fdopen(descriptor, "rb", closefd=True) as handle:
            descriptor = None
            raw = handle.read(maximum_bytes + 1)
            after = os.fstat(handle.fileno())
        if len(raw) > maximum_bytes:
            raise CatalogBuildError(f"{issue_code}_oversized")
        if (
            len(raw) != before.st_size
            or after.st_size != before.st_size
            or after.st_mtime_ns != before.st_mtime_ns
            or after.st_ctime_ns != before.st_ctime_ns
            or after.st_ino != before.st_ino
            or after.st_dev != before.st_dev
        ):
            raise CatalogBuildError(f"{issue_code}_changed")
        text = raw.decode("utf-8", errors="strict")
        return json.loads(text, object_pairs_hook=_closed_object)
    except CatalogBuildError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, _DuplicateJsonKeyError):
        raise CatalogBuildError(f"{issue_code}_invalid") from None
    finally:
        if descriptor is not None:
            with suppress(OSError):
                os.close(descriptor)


def canonical_json_bytes(value: object) -> bytes:
    """Return compact, key-sorted UTF-8 JSON with exactly one trailing LF."""

    try:
        text = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return (text + "\n").encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeError):
        raise CatalogBuildError("canonical_json_invalid") from None


def sha256_hex(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _safe_binding_key(value: str, *, prefix: bool = False) -> bool:
    if _SAFE_KEY_RE.fullmatch(value) is None:
        return False
    if value.startswith("/") or "//" in value or "\\" in value:
        return False
    parts = value.split("/")
    if prefix and parts[-1] == "":
        parts.pop()
    if prefix != value.endswith("/"):
        return False
    return bool(parts) and all(part not in {"", ".", ".."} for part in parts)


def _required_string(value: object, pattern: re.Pattern[str]) -> str | None:
    return value if type(value) is str and pattern.fullmatch(value) is not None else None


@dataclass(frozen=True)
class CatalogConfig:
    """Closed build identity. Every cache-affecting value is caller supplied.

    Provider/model strings are cache identity only.  They do not authorize a
    production provider adapter; that remains a separate generator/runtime
    approval gate.
    """

    deck_profile: str
    deck_schema_version: str
    extractor_version: str
    license_policy_version: str
    manifest_key: str
    model: str
    prompt_version: str
    provider: str
    records_prefix: str
    snapshot_version: str

    @classmethod
    def from_mapping(cls, value: object) -> CatalogConfig:
        if type(value) is not dict or set(value) != _CONFIG_KEYS:
            raise CatalogBuildError("config_schema_invalid")
        candidate = value
        versions = (
            "deck_profile",
            "deck_schema_version",
            "extractor_version",
            "license_policy_version",
            "prompt_version",
        )
        if any(_required_string(candidate.get(key), _VERSION_RE) is None for key in versions):
            raise CatalogBuildError("config_version_invalid")
        if any(
            _required_string(candidate.get(key), _NAME_RE) is None for key in ("provider", "model")
        ):
            raise CatalogBuildError("config_provider_invalid")
        snapshot = _required_string(candidate.get("snapshot_version"), _SNAPSHOT_RE)
        manifest_key = candidate.get("manifest_key")
        records_prefix = candidate.get("records_prefix")
        if snapshot is None:
            raise CatalogBuildError("config_snapshot_invalid")
        if type(manifest_key) is not str or not _safe_binding_key(manifest_key):
            raise CatalogBuildError("config_manifest_key_invalid")
        if type(records_prefix) is not str or not _safe_binding_key(records_prefix, prefix=True):
            raise CatalogBuildError("config_records_prefix_invalid")
        if (
            manifest_key == "pin.json"
            or manifest_key.startswith("pin.json/")
            or records_prefix.startswith("pin.json/")
            or records_prefix.startswith(f"{manifest_key}/")
        ):
            raise CatalogBuildError("config_key_collision")
        return cls(**{key: candidate[key] for key in sorted(_CONFIG_KEYS)})

    @classmethod
    def from_json_file(cls, path: Path) -> CatalogConfig:
        return cls.from_mapping(_read_json(path, MAX_CONFIG_BYTES, "config"))


@dataclass(frozen=True)
class SnapshotReport:
    record_count: int
    eligible_count: int
    unavailable_count: int
    failure_counts: Mapping[str, int]
    manifest_bytes: int
    maximum_record_bytes: int
    total_record_bytes: int
    pin: Mapping[str, object]

    def __post_init__(self) -> None:
        object.__setattr__(self, "failure_counts", MappingProxyType(dict(self.failure_counts)))
        object.__setattr__(self, "pin", MappingProxyType(dict(self.pin)))

    def as_dict(self) -> dict[str, object]:
        return {
            "eligible_count": self.eligible_count,
            "failure_counts": dict(sorted(self.failure_counts.items())),
            "manifest_bytes": self.manifest_bytes,
            "maximum_record_bytes": self.maximum_record_bytes,
            "pin": dict(self.pin),
            "record_count": self.record_count,
            "total_record_bytes": self.total_record_bytes,
            "unavailable_count": self.unavailable_count,
        }


@dataclass(frozen=True)
class CatalogSnapshot:
    config: CatalogConfig
    pin_bytes: bytes
    manifest_bytes: bytes
    record_bytes: Mapping[str, bytes]
    report: SnapshotReport

    def __post_init__(self) -> None:
        object.__setattr__(self, "record_bytes", MappingProxyType(dict(self.record_bytes)))

    def files(self) -> dict[PurePosixPath, bytes]:
        files = {
            PurePosixPath("pin.json"): self.pin_bytes,
            _binding_path(self.config.manifest_key): self.manifest_bytes,
        }
        for paper_id, payload in self.record_bytes.items():
            key = f"{self.config.records_prefix}{paper_id}.json"
            path = _binding_path(key)
            if path in files:
                raise CatalogBuildError("output_key_collision")
            files[path] = payload
        paths = set(files)
        if any(
            parent in paths
            for path in paths
            for parent in path.parents
            if parent != PurePosixPath(".")
        ):
            raise CatalogBuildError("output_key_collision")
        return files


def _binding_path(key: str) -> PurePosixPath:
    path = PurePosixPath(key)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise CatalogBuildError("output_key_invalid")
    return path


def _load_abstracts(detail_dir: Path) -> dict[str, list[str]]:
    abstracts: dict[str, list[str]] = defaultdict(list)
    total_records = 0
    expected_names = {f"{value:02x}.json" for value in range(256)}
    try:
        actual_paths = sorted(detail_dir.glob("*.json"))
    except OSError:
        raise CatalogBuildError("detail_directory_invalid") from None
    if {path.name for path in actual_paths} != expected_names:
        raise CatalogBuildError("detail_shards_incomplete")
    for path in actual_paths:
        value = _read_json(path, MAX_DETAIL_SHARD_BYTES, "detail_shard")
        if type(value) is not dict or set(value) != {"papers", "prefix", "schema_version"}:
            raise CatalogBuildError("detail_shard_schema_invalid")
        prefix = path.stem
        if value.get("schema_version") != "paper-details-v1" or value.get("prefix") != prefix:
            raise CatalogBuildError("detail_shard_identity_invalid")
        papers = value.get("papers")
        if type(papers) is not list:
            raise CatalogBuildError("detail_shard_schema_invalid")
        for pair in papers:
            total_records += 1
            if total_records > MAX_RECORDS:
                raise CatalogBuildError("detail_record_count_exceeded")
            if (
                type(pair) is not list
                or len(pair) != 2
                or type(pair[0]) is not str
                or _PAPER_ID_RE.fullmatch(pair[0]) is None
                or not pair[0].startswith(prefix)
                or type(pair[1]) is not str
            ):
                raise CatalogBuildError("detail_record_invalid")
            abstracts[pair[0]].append(pair[1])
    return abstracts


def _load_catalog_rows(catalog_paths: Sequence[Path]) -> dict[str, list[Mapping[str, object]]]:
    rows: dict[str, list[Mapping[str, object]]] = defaultdict(list)
    total_records = 0
    if not catalog_paths:
        raise CatalogBuildError("catalog_paths_missing")
    for path in sorted(catalog_paths, key=lambda item: item.as_posix()):
        value = _read_json(path, MAX_CATALOG_BYTES, "catalog")
        if type(value) is not list:
            raise CatalogBuildError("catalog_schema_invalid")
        for row in value:
            total_records += 1
            if total_records > MAX_RECORDS:
                raise CatalogBuildError("catalog_record_count_exceeded")
            if type(row) is not dict:
                raise CatalogBuildError("catalog_row_invalid")
            paper_id = row.get("paper_id")
            if type(paper_id) is not str or _PAPER_ID_RE.fullmatch(paper_id) is None:
                raise CatalogBuildError("catalog_paper_id_invalid")
            rows[paper_id].append(row)
            if len(rows) > MAX_RECORDS:
                raise CatalogBuildError("record_count_exceeded")
    return rows


def _canonical_https_url(value: object) -> bool:
    if type(value) is not str or len(value) > 2048 or not value.isascii():
        return False
    try:
        parts = urlsplit(value)
        port = parts.port
    except (UnicodeError, ValueError):
        return False
    return (
        parts.scheme == "https"
        and bool(parts.hostname)
        and parts.netloc == parts.hostname
        and parts.username is None
        and parts.password is None
        and port is None
        and parts.path.startswith("/")
        and not parts.fragment
        and parts.geturl() == value
    )


def _unavailable_record(
    config: CatalogConfig, paper_id: str, failure_code: str
) -> dict[str, object]:
    return {
        "canonical_material": None,
        "eligible": False,
        "failure_code": failure_code,
        "paper_id": paper_id,
        "schema_version": RECORD_SCHEMA,
        "snapshot_version": config.snapshot_version,
    }


def _eligible_record(
    config: CatalogConfig,
    paper_id: str,
    canonical_source: Mapping[str, str],
    abstract: str,
) -> dict[str, object]:
    abstract_digest = hashlib.sha256(abstract.encode("utf-8", errors="strict")).hexdigest()
    return {
        "canonical_material": {
            "deck_profile": config.deck_profile,
            "deck_schema_version": config.deck_schema_version,
            "extractor_version": config.extractor_version,
            "input": {
                "content_sha256": abstract_digest,
                "coverage": "abstract_only",
                "pdf_url": None,
            },
            "license_policy_version": config.license_policy_version,
            "model": config.model,
            "paper_id": paper_id,
            "prompt_version": config.prompt_version,
            "provider": config.provider,
            "source": dict(canonical_source),
        },
        "eligible": True,
        "failure_code": None,
        "paper_id": paper_id,
        "schema_version": RECORD_SCHEMA,
        "snapshot_version": config.snapshot_version,
    }


def _validated_source(paper_id: str, row: Mapping[str, object]) -> dict[str, str] | None:
    source = row.get("source")
    source_id = row.get("source_id")
    if type(source) is not str or source not in SOURCE_REGISTRY or type(source_id) is not str:
        return None
    try:
        resolved = resolve_pdf_source(row)
    except SourceResolutionError:
        return None
    if (
        resolved.paper_id != paper_id
        or resolved.source != source
        or resolved.source_id != source_id
        or not _canonical_https_url(resolved.landing_url)
    ):
        return None
    return {
        "landing_url": resolved.landing_url,
        "source": source,
        "source_id": source_id,
    }


def build_catalog_snapshot(
    *,
    config: CatalogConfig,
    catalog_paths: Sequence[Path],
    detail_dir: Path,
) -> CatalogSnapshot:
    """Join catalog rows to full abstracts and produce one record per paper."""

    rows = _load_catalog_rows(catalog_paths)
    abstracts = _load_abstracts(detail_dir)
    record_bytes: dict[str, bytes] = {}
    manifest_entries: list[dict[str, str]] = []
    failure_counts: Counter[str] = Counter()
    eligible_count = 0
    maximum_record_bytes = 0
    total_record_bytes = 0

    for paper_id in sorted(rows):
        catalog_rows = rows[paper_id]
        abstract_values = abstracts.get(paper_id, [])
        record: dict[str, object]
        if len(catalog_rows) != 1:
            failure_code = PAPER_SLIDE_SOURCE_UNTRUSTED
            record = _unavailable_record(config, paper_id, failure_code)
        else:
            canonical_source = _validated_source(paper_id, catalog_rows[0])
            if canonical_source is None:
                failure_code = PAPER_SLIDE_SOURCE_UNTRUSTED
                record = _unavailable_record(config, paper_id, failure_code)
            elif len(abstract_values) != 1 or not _usable_abstract(abstract_values[0]):
                failure_code = PAPER_SLIDE_EXTRACTION_INSUFFICIENT
                record = _unavailable_record(config, paper_id, failure_code)
            else:
                record = _eligible_record(config, paper_id, canonical_source, abstract_values[0])

        if record["eligible"]:
            eligible_count += 1
        else:
            failure_counts[str(record["failure_code"])] += 1
        payload = canonical_json_bytes(record)
        if len(payload) > MAX_RECORD_BYTES:
            raise CatalogBuildError("record_bytes_exceeded")
        maximum_record_bytes = max(maximum_record_bytes, len(payload))
        total_record_bytes += len(payload)
        record_bytes[paper_id] = payload
        manifest_entries.append({"paper_id": paper_id, "sha256": sha256_hex(payload)})

    manifest = {
        "record_count": len(manifest_entries),
        "records": manifest_entries,
        "schema_version": MANIFEST_SCHEMA,
        "snapshot_version": config.snapshot_version,
    }
    manifest_bytes = canonical_json_bytes(manifest)
    if len(manifest_bytes) > MAX_MANIFEST_BYTES:
        raise CatalogBuildError("manifest_bytes_exceeded")
    pin = {
        "manifest_key": config.manifest_key,
        "manifest_sha256": sha256_hex(manifest_bytes),
        "records_prefix": config.records_prefix,
        "schema_version": PIN_SCHEMA,
        "snapshot_version": config.snapshot_version,
    }
    pin_bytes = canonical_json_bytes(pin)
    report = SnapshotReport(
        record_count=len(manifest_entries),
        eligible_count=eligible_count,
        unavailable_count=len(manifest_entries) - eligible_count,
        failure_counts=dict(sorted(failure_counts.items())),
        manifest_bytes=len(manifest_bytes),
        maximum_record_bytes=maximum_record_bytes,
        total_record_bytes=total_record_bytes,
        pin=pin,
    )
    return CatalogSnapshot(config, pin_bytes, manifest_bytes, record_bytes, report)


def _expected_disk_files(snapshot: CatalogSnapshot) -> dict[PurePosixPath, bytes]:
    files = snapshot.files()
    if len(files) != snapshot.report.record_count + 2:
        raise CatalogBuildError("output_key_collision")
    try:
        manifest = json.loads(
            snapshot.manifest_bytes.decode("utf-8", errors="strict"),
            object_pairs_hook=_closed_object,
        )
        pin = json.loads(
            snapshot.pin_bytes.decode("utf-8", errors="strict"),
            object_pairs_hook=_closed_object,
        )
    except (AttributeError, UnicodeError, json.JSONDecodeError, _DuplicateJsonKeyError):
        raise CatalogBuildError("snapshot_integrity_invalid") from None
    expected_manifest = {
        "record_count": len(snapshot.record_bytes),
        "records": [
            {"paper_id": paper_id, "sha256": sha256_hex(payload)}
            for paper_id, payload in sorted(snapshot.record_bytes.items())
        ],
        "schema_version": MANIFEST_SCHEMA,
        "snapshot_version": snapshot.config.snapshot_version,
    }
    expected_pin = {
        "manifest_key": snapshot.config.manifest_key,
        "manifest_sha256": sha256_hex(snapshot.manifest_bytes),
        "records_prefix": snapshot.config.records_prefix,
        "schema_version": PIN_SCHEMA,
        "snapshot_version": snapshot.config.snapshot_version,
    }
    if (
        manifest != expected_manifest
        or pin != expected_pin
        or snapshot.manifest_bytes != canonical_json_bytes(expected_manifest)
        or snapshot.pin_bytes != canonical_json_bytes(expected_pin)
        or snapshot.report.record_count != len(snapshot.record_bytes)
        or dict(snapshot.report.pin) != expected_pin
    ):
        raise CatalogBuildError("snapshot_integrity_invalid")
    return files


def _usable_abstract(value: str) -> bool:
    if not value.strip() or not MIN_ABSTRACT_CODEPOINTS <= len(value) <= MAX_ABSTRACT_CODEPOINTS:
        return False
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeError:
        return False
    return True


def check_snapshot(snapshot: CatalogSnapshot, output: Path) -> bool:
    """Return whether ``output`` is an exact regular-file projection."""

    expected = _expected_disk_files(snapshot)
    if _has_symlink_component(output) or not output.is_dir() or output.is_symlink():
        return False
    try:
        actual = {
            PurePosixPath(path.relative_to(output).as_posix())
            for path in output.rglob("*")
            if path.is_file() and not path.is_symlink()
        }
        all_paths = list(output.rglob("*"))
        non_files = [
            path
            for path in all_paths
            if (path.is_symlink() or (not path.is_file() and not path.is_dir()))
        ]
        expected_directories = {
            parent
            for relative in expected
            for parent in relative.parents
            if parent != PurePosixPath(".")
        }
        actual_directories = {
            PurePosixPath(path.relative_to(output).as_posix())
            for path in all_paths
            if path.is_dir() and not path.is_symlink()
        }
        if non_files or actual != set(expected) or actual_directories != expected_directories:
            return False
        return all(
            (output / Path(*relative.parts)).read_bytes() == payload
            for relative, payload in expected.items()
        )
    except OSError:
        return False


def write_snapshot(snapshot: CatalogSnapshot, output: Path) -> None:
    """Publish a new immutable snapshot directory through one atomic rename."""

    expected = _expected_disk_files(snapshot)
    output = Path(os.path.abspath(output))
    if _has_symlink_component(output):
        raise CatalogBuildError("output_path_invalid")
    parent = output.parent
    parent.mkdir(parents=True, exist_ok=True)
    if _has_symlink_component(parent):
        raise CatalogBuildError("output_path_invalid")
    if output.exists() or output.is_symlink():
        if check_snapshot(snapshot, output):
            return
        raise CatalogBuildError("output_exists_different")

    temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}.tmp-", dir=parent))
    published = False
    try:
        for relative, payload in sorted(expected.items(), key=lambda item: item[0].as_posix()):
            destination = temporary / Path(*relative.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
        os.replace(temporary, output)
        published = True
    except OSError:
        raise CatalogBuildError("output_write_failed") from None
    finally:
        if not published:
            shutil.rmtree(temporary, ignore_errors=True)


def _has_symlink_component(path: Path) -> bool:
    """Reject existing symlinks without resolving the caller's path."""

    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor)
    try:
        for part in absolute.parts[1:]:
            current /= part
            try:
                metadata = current.lstat()
                if stat.S_ISLNK(metadata.st_mode):
                    return True
            except FileNotFoundError:
                return False
        return False
    except OSError:
        return True


def canonical_job_key(material: Mapping[str, object], language: str) -> str:
    """Mirror the adapter's fixed JSON.stringify payload for fixture parity."""

    if language not in {"ja", "en"}:
        raise CatalogBuildError("job_language_invalid")
    material_keys = {
        "deck_profile",
        "deck_schema_version",
        "extractor_version",
        "input",
        "license_policy_version",
        "model",
        "paper_id",
        "prompt_version",
        "provider",
        "source",
    }
    try:
        if type(material) is not dict or set(material) != material_keys:
            raise KeyError
        source = material["source"]
        input_value = material["input"]
        if (
            type(source) is not dict
            or set(source) != {"landing_url", "source", "source_id"}
            or type(input_value) is not dict
            or set(input_value) != {"content_sha256", "coverage", "pdf_url"}
            or _required_string(material["paper_id"], _PAPER_ID_RE) is None
            or _required_string(source["source"], _NAME_RE) is None
            or _required_string(source["source_id"], _SOURCE_ID_RE) is None
            or not _canonical_https_url(source["landing_url"])
            or input_value["coverage"] not in {"full_text", "abstract_only"}
            or _required_string(input_value["content_sha256"], _SHA256_RE) is None
            or (
                input_value["coverage"] == "full_text"
                and not _canonical_https_url(input_value["pdf_url"])
            )
            or (input_value["coverage"] == "abstract_only" and input_value["pdf_url"] is not None)
            or any(
                _required_string(material[key], _VERSION_RE) is None
                for key in (
                    "deck_profile",
                    "deck_schema_version",
                    "extractor_version",
                    "license_policy_version",
                    "prompt_version",
                )
            )
            or any(
                _required_string(material[key], _NAME_RE) is None for key in ("provider", "model")
            )
        ):
            raise KeyError
        payload = {
            "job_key_schema": JOB_KEY_SCHEMA,
            "paper_id": material["paper_id"],
            "source": {
                "source": source["source"],
                "source_id": source["source_id"],
                "landing_url": source["landing_url"],
            },
            "input": {
                "coverage": input_value["coverage"],
                "content_sha256": input_value["content_sha256"],
                "pdf_url": input_value["pdf_url"],
            },
            "language": language,
            "deck_profile": material["deck_profile"],
            "extractor_version": material["extractor_version"],
            "provider": material["provider"],
            "model": material["model"],
            "prompt_version": material["prompt_version"],
            "deck_schema_version": material["deck_schema_version"],
            "license_policy_version": material["license_policy_version"],
        }
    except (KeyError, TypeError):
        raise CatalogBuildError("job_material_invalid") from None
    # JS JSON.stringify preserves this insertion order and does not append LF.
    try:
        encoded = json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        raise CatalogBuildError("job_material_invalid") from None
    return sha256_hex(encoded)

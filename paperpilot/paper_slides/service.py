"""Local application service for one abstract-only paper slide preview.

The service resolves only a canonical catalog identity, consumes an already
authorized :class:`PreparedProviderExecution`, and writes an immutable local
preview bundle.  It performs no provider/profile selection, review approval,
publication, network access, or repository mutation.
"""

from __future__ import annotations

import ctypes
import errno
import hashlib
import os
import re
import shutil
import stat
import sys
import tempfile
from collections.abc import Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import NoReturn, cast

from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_OUTPUT_INVALID,
    PAPER_SLIDE_PAPER_NOT_FOUND,
    PAPER_SLIDE_PROVIDER_FAILED,
    PAPER_SLIDE_REQUEST_INVALID,
    PAPER_SLIDE_SOURCE_UNTRUSTED,
    SlideDeckValidationContext,
    SlideDeckValidationError,
    load_slide_deck,
    trusted_envelope_sha256,
)
from paperpilot.paper_slides.generate import (
    MAX_ABSTRACT_CODEPOINTS,
    MIN_ABSTRACT_CODEPOINTS,
    AbstractOnlyGenerationInput,
    SlideGenerationError,
    SlideGenerationInput,
    SlideGenerationResult,
    generate_slide_deck_from_prepared,
)
from paperpilot.paper_slides.provider_execution import PreparedProviderExecution
from paperpilot.paper_slides.render import (
    AssetReferences,
    SlideRenderError,
    render_slide_deck_html,
)
from paperpilot.paper_slides.resolver import (
    ResolvedPDFSource,
    SourceResolutionError,
    resolve_pdf_source,
)
from paperpilot.replay import canonical_json_bytes, strict_json_loads

LOCAL_PREVIEW_MANIFEST_VERSION = "paper-slide-local-preview-v1"
MAX_CATALOG_BYTES = 128 * 1024 * 1024
MAX_DETAIL_BYTES = 16 * 1024 * 1024
MAX_ASSET_BYTES = 2 * 1024 * 1024
_PAPER_ID_RE = re.compile(r"^[0-9a-f]{40}$")


class SlidePreviewServiceError(ValueError):
    """Stable local-preview failure containing no paper or provider prose."""

    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__(f"{error_code}:{issue_code}")


@dataclass(frozen=True, slots=True)
class PaperSlidePreviewRequest:
    """Closed user-controlled request surface for a local preview."""

    paper_id: str
    language: str = "ja"


@dataclass(frozen=True, slots=True)
class PaperSlideSourceConstraint:
    """Code-owned identity and content pins for a bounded local execution profile."""

    paper_id: str
    language: str
    source: str
    source_id: str
    detail_shard_sha256: str
    abstract_sha256: str
    title: str
    authors: tuple[str, ...]
    landing_url: str
    pdf_url: str


@dataclass(frozen=True, slots=True)
class LocalPreviewBundle:
    """Hashes and paths for one successfully committed provisional bundle."""

    output_dir: Path
    paper_id: str
    language: str
    coverage: str
    review_status: str
    deck_sha256: str
    html_sha256: str
    stylesheet_sha256: str
    script_sha256: str
    cache_key: str
    input_sha256: str
    calls: int
    input_tokens: int
    output_tokens: int
    cost_micro_units: int
    elapsed_wall_ms: int
    provider_request_id_sha256s: tuple[str, ...] = field(repr=False)

    def cli_summary(self) -> dict[str, str | int]:
        """Return a non-sensitive summary suitable for stdout."""

        return {
            "coverage": self.coverage,
            "cost_micro_units": self.cost_micro_units,
            "deck_sha256": self.deck_sha256,
            "elapsed_wall_ms": self.elapsed_wall_ms,
            "html_sha256": self.html_sha256,
            "actual_input_tokens": self.input_tokens,
            "language": self.language,
            "output_dir": str(self.output_dir),
            "actual_output_tokens": self.output_tokens,
            "paper_id": self.paper_id,
            "review_status": self.review_status,
            "calls": self.calls,
        }


def _fail(error_code: str, issue_code: str) -> NoReturn:
    raise SlidePreviewServiceError(error_code, issue_code) from None


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


def _read_regular(path: Path, maximum: int, issue_code: str) -> bytes:
    descriptor: int | None = None
    try:
        if _has_symlink_component(path):
            _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, issue_code)
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
            _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, issue_code)
        with os.fdopen(descriptor, "rb", closefd=True) as handle:
            descriptor = None
            payload = handle.read(maximum + 1)
            after = os.fstat(handle.fileno())
        if (
            len(payload) > maximum
            or len(payload) != before.st_size
            or before.st_size != after.st_size
            or before.st_ino != after.st_ino
            or before.st_dev != after.st_dev
            or before.st_mtime_ns != after.st_mtime_ns
            or before.st_ctime_ns != after.st_ctime_ns
        ):
            _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, issue_code)
        return payload
    except (KeyboardInterrupt, SystemExit, SlidePreviewServiceError):
        raise
    except OSError:
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, issue_code)
    finally:
        if descriptor is not None:
            with suppress(OSError):
                os.close(descriptor)


def _read_json(path: Path, maximum: int, issue_code: str) -> object:
    try:
        return strict_json_loads(_read_regular(path, maximum, issue_code))
    except SlidePreviewServiceError:
        raise
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, issue_code)


def _validate_request(value: object) -> PaperSlidePreviewRequest:
    if type(value) is not PaperSlidePreviewRequest:
        _fail(PAPER_SLIDE_REQUEST_INVALID, "request_type_invalid")
    request = value
    if type(request.paper_id) is not str or _PAPER_ID_RE.fullmatch(request.paper_id) is None:
        _fail(PAPER_SLIDE_REQUEST_INVALID, "paper_id_invalid")
    if type(request.language) is not str or request.language not in {"ja", "en"}:
        _fail(PAPER_SLIDE_REQUEST_INVALID, "language_invalid")
    return PaperSlidePreviewRequest(request.paper_id, request.language)


def _validate_output_path(output_dir: Path) -> Path:
    try:
        requested = Path(output_dir)
        if "\x00" in os.fspath(requested) or ".." in requested.parts:
            _fail(PAPER_SLIDE_OUTPUT_INVALID, "output_path_invalid")
        output = Path(os.path.abspath(requested))
    except (TypeError, OSError):
        _fail(PAPER_SLIDE_OUTPUT_INVALID, "output_path_invalid")
    if output.name in {"", ".", ".."} or _has_symlink_component(output):
        _fail(PAPER_SLIDE_OUTPUT_INVALID, "output_path_invalid")
    if output.exists() or output.is_symlink():
        _fail(PAPER_SLIDE_OUTPUT_INVALID, "output_exists")
    return output


def _catalog_row(paper_id: str, paths: Sequence[Path]) -> Mapping[str, object]:
    if type(paths) not in {list, tuple} or not paths:
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "catalog_missing")
    matches: list[dict[str, object]] = []
    for path in paths:
        value = _read_json(Path(path), MAX_CATALOG_BYTES, "catalog_invalid")
        if type(value) is not list:
            _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "catalog_invalid")
        for row in value:
            if (
                type(row) is not dict
                or type(row.get("paper_id")) is not str
                or _PAPER_ID_RE.fullmatch(row["paper_id"]) is None
            ):
                _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "catalog_invalid")
            if row.get("paper_id") == paper_id:
                matches.append(row)
    if not matches:
        _fail(PAPER_SLIDE_PAPER_NOT_FOUND, "paper_not_found")
    if len(matches) != 1:
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "catalog_identity_ambiguous")
    row = matches[0]
    title = row.get("title")
    authors = row.get("authors")
    try:
        text_is_utf8 = type(title) is str and all(
            isinstance(value, str) and bool(value.encode("utf-8"))
            for value in [title, *(authors if type(authors) is list else [])]
        )
    except UnicodeError:
        text_is_utf8 = False
    if (
        type(title) is not str
        or not title.strip()
        or len(title) > 1_000
        or type(authors) is not list
        or not 1 <= len(authors) <= 100
        or not text_is_utf8
        or any(
            type(author) is not str or not author.strip() or len(author) > 300 for author in authors
        )
    ):
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "catalog_metadata_invalid")
    return row


def _detail_abstract(paper_id: str, detail_dir: Path) -> tuple[str, str]:
    directory = Path(detail_dir)
    if _has_symlink_component(directory):
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "detail_invalid")
    payload = _read_regular(directory / f"{paper_id[:2]}.json", MAX_DETAIL_BYTES, "detail_invalid")
    try:
        value = strict_json_loads(payload)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "detail_invalid")
    if (
        type(value) is not dict
        or set(value) != {"papers", "prefix", "schema_version"}
        or value.get("schema_version") != "paper-details-v1"
        or value.get("prefix") != paper_id[:2]
        or type(value.get("papers")) is not list
    ):
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "detail_invalid")
    matches: list[str] = []
    for pair in value["papers"]:
        if (
            type(pair) is not list
            or len(pair) != 2
            or type(pair[0]) is not str
            or _PAPER_ID_RE.fullmatch(pair[0]) is None
            or not pair[0].startswith(paper_id[:2])
            or type(pair[1]) is not str
        ):
            _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "detail_invalid")
        if pair[0] == paper_id:
            matches.append(pair[1])
    if len(matches) != 1:
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "detail_identity_invalid")
    abstract = matches[0]
    try:
        abstract.encode("utf-8")
    except UnicodeError:
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "abstract_insufficient")
    if (
        not abstract.strip()
        or not MIN_ABSTRACT_CODEPOINTS <= len(abstract) <= MAX_ABSTRACT_CODEPOINTS
    ):
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "abstract_insufficient")
    return abstract, hashlib.sha256(payload).hexdigest()


def _validate_source_constraint(
    value: object,
    *,
    request: PaperSlidePreviewRequest,
    row: Mapping[str, object],
    source: ResolvedPDFSource,
    detail_shard_sha256: str,
    abstract_sha256: str,
) -> None:
    if value is None:
        return
    if type(value) is not PaperSlideSourceConstraint:
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "source_constraint_invalid")
    constraint = value
    fields = (
        constraint.paper_id,
        constraint.language,
        constraint.source,
        constraint.source_id,
        constraint.detail_shard_sha256,
        constraint.abstract_sha256,
        constraint.title,
        constraint.landing_url,
        constraint.pdf_url,
    )
    if (
        any(type(item) is not str for item in fields)
        or type(constraint.authors) is not tuple
        or not constraint.authors
        or any(type(author) is not str for author in constraint.authors)
    ):
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "source_constraint_invalid")
    if (
        constraint.paper_id != request.paper_id
        or constraint.language != request.language
        or constraint.source != source.source
        or constraint.source_id != source.source_id
        or constraint.detail_shard_sha256 != detail_shard_sha256
        or constraint.abstract_sha256 != abstract_sha256
        or constraint.title != row.get("title")
        or constraint.authors != tuple(cast(list[str], row.get("authors")))
        or constraint.landing_url != source.landing_url
        or constraint.pdf_url != source.pdf_url
    ):
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "source_constraint_mismatch")


def _asset_references(asset_dir: Path) -> tuple[AssetReferences, dict[PurePosixPath, bytes]]:
    stylesheet = _read_regular(
        Path(asset_dir) / "paper-slides.css", MAX_ASSET_BYTES, "asset_invalid"
    )
    script = _read_regular(Path(asset_dir) / "paper-slides.js", MAX_ASSET_BYTES, "asset_invalid")
    css_sha = hashlib.sha256(stylesheet).hexdigest()
    js_sha = hashlib.sha256(script).hexdigest()
    css_name = f"paper-slides.{css_sha}.css"
    js_name = f"paper-slides.{js_sha}.js"
    return (
        AssetReferences(
            stylesheet_path=f"/assets/{css_name}",
            stylesheet_sha256=css_sha,
            script_path=f"/assets/{js_name}",
            script_sha256=js_sha,
        ),
        {
            PurePosixPath("assets") / css_name: stylesheet,
            PurePosixPath("assets") / js_name: script,
        },
    )


def _atomic_rename_noreplace(source: Path, destination: Path) -> None:
    """Atomically publish a directory without replacing a concurrent writer."""

    try:
        source_bytes = os.fsencode(source)
        destination_bytes = os.fsencode(destination)
        if b"\x00" in source_bytes or b"\x00" in destination_bytes:
            _fail(PAPER_SLIDE_OUTPUT_INVALID, "output_path_invalid")
        libc = ctypes.CDLL(None, use_errno=True)
        result: int
        if sys.platform.startswith("linux"):
            operation = getattr(libc, "renameat2", None)
            if operation is None:
                _fail(PAPER_SLIDE_OUTPUT_INVALID, "output_write_failed")
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
            operation = getattr(libc, "renamex_np", None)
            if operation is None:
                _fail(PAPER_SLIDE_OUTPUT_INVALID, "output_write_failed")
            operation.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
            operation.restype = ctypes.c_int
            result = operation(source_bytes, destination_bytes, 0x00000004)
        else:
            _fail(PAPER_SLIDE_OUTPUT_INVALID, "output_write_failed")
    except (KeyboardInterrupt, SystemExit, SlidePreviewServiceError):
        raise
    except BaseException:
        _fail(PAPER_SLIDE_OUTPUT_INVALID, "output_write_failed")
    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number in {errno.EEXIST, errno.ENOTEMPTY}:
        _fail(PAPER_SLIDE_OUTPUT_INVALID, "output_exists")
    _fail(PAPER_SLIDE_OUTPUT_INVALID, "output_write_failed")


def _write_bundle(files: Mapping[PurePosixPath, bytes], output: Path) -> None:
    parent = output.parent
    try:
        parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        _fail(PAPER_SLIDE_OUTPUT_INVALID, "output_write_failed")
    if _has_symlink_component(parent) or output.exists() or output.is_symlink():
        _fail(
            PAPER_SLIDE_OUTPUT_INVALID,
            "output_path_invalid" if _has_symlink_component(parent) else "output_exists",
        )
    temporary: Path | None = None
    committed = False
    try:
        temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}.tmp-", dir=parent))
        for relative, payload in sorted(files.items(), key=lambda item: item[0].as_posix()):
            if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
                _fail(PAPER_SLIDE_OUTPUT_INVALID, "output_projection_invalid")
            destination = temporary / Path(*relative.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
        _atomic_rename_noreplace(temporary, output)
        committed = True
    except (KeyboardInterrupt, SystemExit, SlidePreviewServiceError):
        raise
    except OSError:
        _fail(PAPER_SLIDE_OUTPUT_INVALID, "output_write_failed")
    finally:
        if temporary is not None and not committed:
            shutil.rmtree(temporary, ignore_errors=True)


def generate_paper_slide_preview(
    request: PaperSlidePreviewRequest,
    *,
    execution: PreparedProviderExecution,
    catalog_paths: Sequence[Path],
    detail_dir: Path,
    asset_dir: Path,
    output_dir: Path,
    at: datetime,
    source_constraint: PaperSlideSourceConstraint | None = None,
) -> LocalPreviewBundle:
    """Generate and atomically commit one unreviewed abstract-only preview."""

    checked = _validate_request(request)
    output = _validate_output_path(output_dir)
    if type(execution) is not PreparedProviderExecution:
        _fail(PAPER_SLIDE_PROVIDER_FAILED, "provider_execution_invalid")
    if (
        type(at) is not datetime
        or at.tzinfo is not timezone.utc
        or at.utcoffset() is None
        or at.microsecond != 0
    ):
        _fail(PAPER_SLIDE_REQUEST_INVALID, "generation_time_invalid")
    row = _catalog_row(checked.paper_id, catalog_paths)
    abstract, detail_shard_sha256 = _detail_abstract(checked.paper_id, detail_dir)
    assets, asset_files = _asset_references(asset_dir)
    try:
        source = resolve_pdf_source(row)
    except SourceResolutionError:
        _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "catalog_source_invalid")
    abstract_sha256 = hashlib.sha256(abstract.encode("utf-8")).hexdigest()
    _validate_source_constraint(
        source_constraint,
        request=checked,
        row=row,
        source=source,
        detail_shard_sha256=detail_shard_sha256,
        abstract_sha256=abstract_sha256,
    )
    coverage = AbstractOnlyGenerationInput(
        source=source,
        abstract=abstract,
        abstract_sha256=abstract_sha256,
    )
    request_input = SlideGenerationInput(
        paper_id=checked.paper_id,
        language=checked.language,
        deck_profile="research-brief-v1",
        title=cast(str, row["title"]),
        authors=tuple(cast(list[str], row["authors"])),
        coverage=coverage,
        fetched_at=None,
        generated_at=at,
    )
    try:
        generated: SlideGenerationResult = generate_slide_deck_from_prepared(
            request_input, execution=execution, at=at
        )
        parsed_deck = strict_json_loads(generated.deck_bytes)
        if type(parsed_deck) is not dict:
            _fail(PAPER_SLIDE_OUTPUT_INVALID, "candidate_invalid")
        context = SlideDeckValidationContext(
            expected_envelope_sha256=trusted_envelope_sha256(parsed_deck),
            abstract_sha256=coverage.abstract_sha256,
            abstract_source_anchor=source.landing_url,
        )
        deck = load_slide_deck(generated.deck_bytes, context=context)
        if deck.get("review") != {"status": "provisional", "review_record": None}:
            _fail(PAPER_SLIDE_OUTPUT_INVALID, "candidate_not_provisional")
        rendered = render_slide_deck_html(deck, context=context, mode="preview", assets=assets)
    except SlidePreviewServiceError:
        raise
    except SlideGenerationError as error:
        _fail(error.error_code, error.issue_code)
    except SlideDeckValidationError as error:
        _fail(error.code, error.issue_code)
    except SlideRenderError as error:
        _fail(error.error_code, error.issue_code)
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        _fail(PAPER_SLIDE_OUTPUT_INVALID, "preview_internal_failure")
    manifest = {
        "assets": {
            "script": {
                "path": assets.script_path,
                "sha256": assets.script_sha256,
            },
            "stylesheet": {
                "path": assets.stylesheet_path,
                "sha256": assets.stylesheet_sha256,
            },
        },
        "coverage": "abstract_only",
        "deck": {"path": "deck.json", "sha256": rendered.deck_sha256},
        "html": {"path": "index.html", "sha256": rendered.html_sha256},
        "language": checked.language,
        "paper_id": checked.paper_id,
        "review_status": "provisional",
        "schema_version": LOCAL_PREVIEW_MANIFEST_VERSION,
    }
    files = {
        **asset_files,
        PurePosixPath("deck.json"): generated.deck_bytes,
        PurePosixPath("index.html"): rendered.html_bytes,
        PurePosixPath("manifest.json"): canonical_json_bytes(manifest),
    }
    _write_bundle(files, output)
    return LocalPreviewBundle(
        output_dir=output,
        paper_id=checked.paper_id,
        language=checked.language,
        coverage="abstract_only",
        review_status="provisional",
        deck_sha256=rendered.deck_sha256,
        html_sha256=rendered.html_sha256,
        stylesheet_sha256=assets.stylesheet_sha256,
        script_sha256=assets.script_sha256,
        cache_key=generated.cache_key,
        input_sha256=generated.input_sha256,
        calls=generated.usage.calls,
        input_tokens=generated.usage.input_tokens,
        output_tokens=generated.usage.output_tokens,
        cost_micro_units=generated.usage.cost_micro_units,
        elapsed_wall_ms=generated.usage.elapsed_wall_ms,
        provider_request_id_sha256s=generated.provider_request_id_sha256s,
    )


__all__ = [
    "LOCAL_PREVIEW_MANIFEST_VERSION",
    "LocalPreviewBundle",
    "PaperSlidePreviewRequest",
    "PaperSlideSourceConstraint",
    "SlidePreviewServiceError",
    "generate_paper_slide_preview",
]

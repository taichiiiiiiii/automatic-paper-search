"""Deterministic, source-derived identities for public paper projections.

Identity Lite intentionally does not merge records across sources.  It turns a
canonical native record ID into a stable PaperPilot ID and rejects ambiguous or
unknown inputs instead of falling back to titles.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, cast
from urllib.parse import SplitResult, parse_qsl, unquote, urlsplit

SourceName = Literal["arxiv", "openreview", "acl_anthology", "cvf"]

_SOURCES = frozenset({"arxiv", "openreview", "acl_anthology", "cvf"})
_HOST_SOURCE: dict[str, SourceName] = {
    "arxiv.org": "arxiv",
    "www.arxiv.org": "arxiv",
    "export.arxiv.org": "arxiv",
    "openreview.net": "openreview",
    "www.openreview.net": "openreview",
    "aclanthology.org": "acl_anthology",
    "www.aclanthology.org": "acl_anthology",
    "openaccess.thecvf.com": "cvf",
}
_ARXIV_MODERN_RE = re.compile(r"^[0-9]{4}\.[0-9]{4,5}$")
_ARXIV_LEGACY_RE = re.compile(r"^([A-Za-z][A-Za-z0-9.-]*)/([0-9]{7})$")
_ARXIV_VERSION_RE = re.compile(r"v[0-9]+$")
_OPENREVIEW_RE = re.compile(r"^[A-Za-z0-9_-]{1,256}$")
_PATH_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,511}$")
_DOI_RE = re.compile(r"^10\.[0-9]{4,9}/[^\s\x00-\x1f\x7f]+$")


class IdentityError(ValueError):
    """Raised when a source URL or alias is unknown, malformed, or ambiguous."""


@dataclass(frozen=True)
class PaperIdentity:
    """One deterministic native-source identity."""

    source: SourceName
    source_id: str
    paper_id: str


def _decode_segment(raw: str) -> str:
    try:
        decoded = unquote(raw, encoding="utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise IdentityError("URL path is not valid UTF-8") from exc
    if not decoded:
        raise IdentityError("source ID contains an empty path segment")
    if "/" in decoded or "\\" in decoded:
        raise IdentityError("encoded slash or backslash is forbidden in a source ID")
    if any(ord(char) < 32 or ord(char) == 127 for char in decoded):
        raise IdentityError("control characters are forbidden in a source ID")
    return decoded


def _path_segments(parts: SplitResult, *, trailing_slash: bool = False) -> list[str]:
    if not parts.path.startswith("/"):
        raise IdentityError("source URL path must be absolute")
    raw = parts.path.split("/")[1:]
    if trailing_slash and raw and raw[-1] == "":
        raw.pop()
    if not raw or any(segment == "" for segment in raw):
        raise IdentityError("source URL contains an empty path segment")
    return [_decode_segment(segment) for segment in raw]


def _normalize_arxiv_id(value: str) -> str:
    candidate = value.strip()
    if not candidate or any(char.isspace() for char in candidate):
        raise IdentityError("arXiv ID is empty or contains whitespace")
    candidate = _ARXIV_VERSION_RE.sub("", candidate)
    if _ARXIV_MODERN_RE.fullmatch(candidate):
        return candidate
    legacy = _ARXIV_LEGACY_RE.fullmatch(candidate)
    if not legacy:
        raise IdentityError(f"invalid arXiv ID: {value!r}")
    archive = legacy.group(1)
    if "." in archive:
        primary, suffix = archive.split(".", 1)
        archive = f"{primary.lower()}.{suffix}"
    else:
        archive = archive.lower()
    return f"{archive}/{legacy.group(2)}"


def _normalize_openreview_id(value: str) -> str:
    candidate = value.strip()
    if not _OPENREVIEW_RE.fullmatch(candidate):
        raise IdentityError(f"invalid OpenReview forum ID: {value!r}")
    return candidate


def _normalize_path_id(value: str, source: str) -> str:
    candidate = value.strip()
    if not _PATH_ID_RE.fullmatch(candidate):
        raise IdentityError(f"invalid {source} ID: {value!r}")
    return candidate


def _normalize_arxiv_url(parts: SplitResult) -> str:
    if parts.query:
        raise IdentityError("arXiv identity URL must not contain a query")
    segments = _path_segments(parts)
    if segments[0] not in {"abs", "pdf"}:
        raise IdentityError("arXiv path must start with /abs/ or /pdf/")
    identifier = segments[1:]
    if not identifier or len(identifier) > 2:
        raise IdentityError("arXiv URL has an ambiguous ID path")
    if segments[0] == "pdf":
        if not identifier[-1].endswith(".pdf"):
            raise IdentityError("arXiv PDF path must end with .pdf")
        identifier[-1] = identifier[-1][: -len(".pdf")]
    return _normalize_arxiv_id("/".join(identifier))


def _normalize_openreview_url(parts: SplitResult) -> str:
    if _path_segments(parts, trailing_slash=True) != ["forum"]:
        raise IdentityError("OpenReview path must be /forum")
    try:
        pairs = parse_qsl(
            parts.query,
            keep_blank_values=True,
            strict_parsing=False,
            max_num_fields=20,
        )
    except ValueError as exc:
        raise IdentityError("OpenReview query is invalid") from exc
    candidates = [value for key, value in pairs if key == "id"]
    if len(candidates) != 1:
        raise IdentityError("OpenReview URL must contain exactly one id query value")
    candidate = _decode_segment(candidates[0])
    return _normalize_openreview_id(candidate)


def _normalize_acl_url(parts: SplitResult) -> str:
    if parts.query:
        raise IdentityError("ACL Anthology identity URL must not contain a query")
    segments = _path_segments(parts, trailing_slash=True)
    if len(segments) != 1:
        raise IdentityError("ACL Anthology path must contain one native ID")
    identifier = segments[0]
    if identifier.endswith(".pdf"):
        identifier = identifier[: -len(".pdf")]
    return _normalize_path_id(identifier, "ACL Anthology")


def _normalize_cvf_url(parts: SplitResult) -> str:
    if parts.query:
        raise IdentityError("CVF identity URL must not contain a query")
    segments = _path_segments(parts)
    if len(segments) != 4 or segments[0] != "content" or segments[2] != "html":
        raise IdentityError("CVF path must be /content/<collection>/html/<filename>.html")
    _normalize_path_id(segments[1], "CVF collection")
    filename = segments[3]
    if not filename.endswith(".html"):
        raise IdentityError("CVF paper filename must end with .html")
    return _normalize_path_id(filename[: -len(".html")], "CVF")


_URL_NORMALIZERS: dict[SourceName, Callable[[SplitResult], str]] = {
    "arxiv": _normalize_arxiv_url,
    "openreview": _normalize_openreview_url,
    "acl_anthology": _normalize_acl_url,
    "cvf": _normalize_cvf_url,
}


def normalize_alias(namespace: str, value: str) -> tuple[str, str]:
    """Normalize a strong alias without performing any fuzzy matching."""

    normalized_namespace = namespace.strip().lower()
    if normalized_namespace == "doi":
        candidate = value.strip()
        lowered = candidate.lower()
        if lowered.startswith("doi:"):
            candidate = candidate[4:]
        elif lowered.startswith(("http://", "https://")):
            try:
                parts = urlsplit(candidate)
            except ValueError as exc:
                raise IdentityError("invalid DOI URL") from exc
            if (parts.hostname or "").lower() not in {"doi.org", "dx.doi.org"}:
                raise IdentityError("DOI URL must use doi.org or dx.doi.org")
            if parts.username or parts.password or parts.port is not None:
                raise IdentityError("DOI URL authority is not canonical")
            candidate = parts.path.lstrip("/")
        try:
            candidate = unquote(candidate, encoding="utf-8", errors="strict").strip().lower()
        except UnicodeDecodeError as exc:
            raise IdentityError("DOI is not valid UTF-8") from exc
        if not _DOI_RE.fullmatch(candidate):
            raise IdentityError(f"invalid DOI alias: {value!r}")
        return "doi", candidate

    if normalized_namespace not in _SOURCES:
        raise IdentityError(f"unknown alias namespace: {namespace!r}")
    source = cast(SourceName, normalized_namespace)
    normalizers: dict[SourceName, Callable[[str], str]] = {
        "arxiv": _normalize_arxiv_id,
        "openreview": _normalize_openreview_id,
        "acl_anthology": lambda item: _normalize_path_id(item, "ACL Anthology"),
        "cvf": lambda item: _normalize_path_id(item, "CVF"),
    }
    return source, normalizers[source](value)


def make_paper_id(source: str, source_id: str) -> str:
    """Return the stable 40-hex PaperPilot ID for one native record."""

    normalized_source, normalized_id = normalize_alias(source, source_id)
    if normalized_source not in _SOURCES:
        raise IdentityError("a DOI alias cannot be a canonical paper source")
    payload = f"paperpilot:v1:{normalized_source}:{normalized_id}".encode()
    return hashlib.sha256(payload).hexdigest()[:40]


def identity_from_url(url: str) -> PaperIdentity:
    """Parse one known source URL into its deterministic identity.

    Unknown hosts and malformed inputs raise :class:`IdentityError`; callers
    must record a coverage failure rather than substituting a title-derived ID.
    """

    candidate = url.strip()
    if not candidate:
        raise IdentityError("source URL is empty")
    try:
        parts = urlsplit(candidate)
        port = parts.port
    except ValueError as exc:
        raise IdentityError("source URL is invalid") from exc
    if parts.scheme.lower() not in {"http", "https"}:
        raise IdentityError("source URL must use http or https")
    if parts.username or parts.password or port is not None:
        raise IdentityError("source URL authority is not canonical")
    host = (parts.hostname or "").lower()
    source = _HOST_SOURCE.get(host)
    if source is None:
        raise IdentityError(f"unknown paper source host: {host!r}")
    source_id = _URL_NORMALIZERS[source](parts)
    return PaperIdentity(source, source_id, make_paper_id(source, source_id))

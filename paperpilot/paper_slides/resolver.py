"""Resolve canonical catalog identities to trusted public PDF sources.

The resolver performs no I/O.  Three adapters derive their URLs solely from a
canonical native source ID.  CVF additionally verifies the collection encoded
in the catalog's paired landing/PDF paths before reconstructing both URLs.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal, NoReturn
from urllib.parse import SplitResult, urlsplit

from paperpilot.identity import IdentityError, make_paper_id, normalize_alias
from paperpilot.paper_slides.contract import PAPER_SLIDE_SOURCE_UNTRUSTED

AccessKind = Literal["open_access", "unknown", "restricted"]
SourceName = Literal["arxiv", "openreview", "acl_anthology", "cvf"]

_CVF_HOST = "openaccess.thecvf.com"
_PATH_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,511}$")

_CATALOG_ROW_INVALID = "catalog_row_invalid"
_CATALOG_IDENTITY_INVALID = "catalog_identity_invalid"
_SOURCE_UNSUPPORTED = "source_unsupported"
_SOURCE_ID_INVALID = "source_id_invalid"
_SOURCE_ID_NONCANONICAL = "source_id_noncanonical"
_PAPER_ID_MISMATCH = "paper_id_mismatch"
_CVF_LANDING_URL_INVALID = "cvf_landing_url_invalid"
_CVF_URL_INVALID = "cvf_url_invalid"
_CVF_PATH_INVALID = "cvf_path_invalid"
_CVF_COLLECTION_MISMATCH = "cvf_collection_mismatch"
_CVF_SOURCE_ID_MISMATCH = "cvf_source_id_mismatch"
_ISSUE_CODES = frozenset(
    {
        _CATALOG_ROW_INVALID,
        _CATALOG_IDENTITY_INVALID,
        _SOURCE_UNSUPPORTED,
        _SOURCE_ID_INVALID,
        _SOURCE_ID_NONCANONICAL,
        _PAPER_ID_MISMATCH,
        _CVF_LANDING_URL_INVALID,
        _CVF_URL_INVALID,
        _CVF_PATH_INVALID,
        _CVF_COLLECTION_MISMATCH,
        _CVF_SOURCE_ID_MISMATCH,
    }
)


class SourceResolutionError(ValueError):
    """A redacted source-resolution failure with stable machine-readable codes."""

    def __init__(self, error_code: str, issue_code: str) -> None:
        if error_code != PAPER_SLIDE_SOURCE_UNTRUSTED or issue_code not in _ISSUE_CODES:
            error_code = PAPER_SLIDE_SOURCE_UNTRUSTED
            issue_code = _CATALOG_ROW_INVALID
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__(f"{error_code}:{issue_code}")


class _ResolutionIssueError(Exception):
    """Internal control flow carrying only a fixed issue code."""

    def __init__(self, issue_code: str) -> None:
        self.issue_code = issue_code if issue_code in _ISSUE_CODES else _CATALOG_ROW_INVALID
        super().__init__(self.issue_code)


@dataclass(frozen=True)
class ResolvedPDFSource:
    """One identity-bound source accepted by the SD1 fetch boundary."""

    paper_id: str
    source: SourceName
    source_id: str
    landing_url: str
    pdf_url: str
    access: AccessKind
    license: str
    license_evidence_url: None


def _fail(issue_code: str) -> NoReturn:
    raise _ResolutionIssueError(issue_code)


def _base_result(
    *, paper_id: str, source: SourceName, source_id: str, landing_url: str, pdf_url: str
) -> ResolvedPDFSource:
    return ResolvedPDFSource(
        paper_id=paper_id,
        source=source,
        source_id=source_id,
        landing_url=landing_url,
        pdf_url=pdf_url,
        access="open_access",
        license="unknown",
        license_evidence_url=None,
    )


def _resolve_arxiv(paper_id: str, source_id: str, _: Mapping[str, object]) -> ResolvedPDFSource:
    return _base_result(
        paper_id=paper_id,
        source="arxiv",
        source_id=source_id,
        landing_url=f"https://arxiv.org/abs/{source_id}",
        pdf_url=f"https://arxiv.org/pdf/{source_id}",
    )


def _resolve_openreview(
    paper_id: str, source_id: str, _: Mapping[str, object]
) -> ResolvedPDFSource:
    return _base_result(
        paper_id=paper_id,
        source="openreview",
        source_id=source_id,
        landing_url=f"https://openreview.net/forum?id={source_id}",
        pdf_url=f"https://openreview.net/pdf?id={source_id}",
    )


def _resolve_acl(paper_id: str, source_id: str, _: Mapping[str, object]) -> ResolvedPDFSource:
    return _base_result(
        paper_id=paper_id,
        source="acl_anthology",
        source_id=source_id,
        landing_url=f"https://aclanthology.org/{source_id}/",
        pdf_url=f"https://aclanthology.org/{source_id}.pdf",
    )


def _catalog_landing_url(row: Mapping[str, object]) -> object:
    """Read the current catalog field while accepting its future clear name.

    Conference catalog rows historically store their landing page in
    ``arxiv_url`` even when the native source is CVF.  If both spellings are
    present they must agree, so no caller-controlled alternate is ignored.
    """

    legacy_present = "arxiv_url" in row
    clear_present = "landing_url" in row
    if not legacy_present and not clear_present:
        _fail(_CVF_LANDING_URL_INVALID)
    legacy = row.get("arxiv_url") if legacy_present else None
    clear = row.get("landing_url") if clear_present else None
    if legacy_present and clear_present and legacy != clear:
        _fail(_CVF_LANDING_URL_INVALID)
    return clear if clear_present else legacy


def _split_cvf_url(value: object) -> SplitResult:
    if not isinstance(value, str):
        _fail(_CVF_URL_INVALID)
    parse_failed = False
    try:
        parts = urlsplit(value)
        port = parts.port
    except (UnicodeError, ValueError):
        parse_failed = True
    if parse_failed:
        _fail(_CVF_URL_INVALID)
    if (
        parts.scheme != "https"
        or parts.netloc != _CVF_HOST
        or parts.hostname != _CVF_HOST
        or parts.username is not None
        or parts.password is not None
        or port is not None
        or parts.query
        or parts.fragment
    ):
        _fail(_CVF_URL_INVALID)
    return parts


def _cvf_path(parts: SplitResult, *, directory: str, suffix: str) -> tuple[str, str]:
    segments = parts.path.split("/")
    if (
        len(segments) != 5
        or segments[0] != ""
        or segments[1] != "content"
        or segments[3] != directory
        or not segments[4].endswith(suffix)
    ):
        _fail(_CVF_PATH_INVALID)
    collection = segments[2]
    filename = segments[4][: -len(suffix)]
    if not _PATH_ID_RE.fullmatch(collection) or not _PATH_ID_RE.fullmatch(filename):
        _fail(_CVF_PATH_INVALID)
    return collection, filename


def _resolve_cvf(paper_id: str, source_id: str, row: Mapping[str, object]) -> ResolvedPDFSource:
    landing_parts = _split_cvf_url(_catalog_landing_url(row))
    pdf_parts = _split_cvf_url(row.get("pdf_url"))
    landing_collection, landing_filename = _cvf_path(
        landing_parts, directory="html", suffix=".html"
    )
    pdf_collection, pdf_filename = _cvf_path(pdf_parts, directory="papers", suffix=".pdf")
    if landing_collection != pdf_collection:
        _fail(_CVF_COLLECTION_MISMATCH)
    if landing_filename != source_id or pdf_filename != source_id:
        _fail(_CVF_SOURCE_ID_MISMATCH)

    landing_url = f"https://{_CVF_HOST}/content/{landing_collection}/html/{source_id}.html"
    pdf_url = f"https://{_CVF_HOST}/content/{landing_collection}/papers/{source_id}.pdf"
    return _base_result(
        paper_id=paper_id,
        source="cvf",
        source_id=source_id,
        landing_url=landing_url,
        pdf_url=pdf_url,
    )


_Adapter = Callable[[str, str, Mapping[str, object]], ResolvedPDFSource]
_ADAPTERS: dict[str, _Adapter] = {
    "arxiv": _resolve_arxiv,
    "openreview": _resolve_openreview,
    "acl_anthology": _resolve_acl,
    "cvf": _resolve_cvf,
}


def _resolve_pdf_source(catalog_row: Mapping[str, object]) -> ResolvedPDFSource:
    if not isinstance(catalog_row, Mapping):
        _fail(_CATALOG_ROW_INVALID)
    paper_id = catalog_row.get("paper_id")
    source = catalog_row.get("source")
    source_id = catalog_row.get("source_id")
    if (
        not isinstance(paper_id, str)
        or not isinstance(source, str)
        or not isinstance(source_id, str)
    ):
        _fail(_CATALOG_IDENTITY_INVALID)
    adapter = _ADAPTERS.get(source)
    if adapter is None:
        _fail(_SOURCE_UNSUPPORTED)

    identity_failed = False
    try:
        normalized_source, normalized_id = normalize_alias(source, source_id)
        expected_paper_id = make_paper_id(source, source_id)
    except (IdentityError, TypeError, ValueError):
        identity_failed = True
    if identity_failed:
        _fail(_SOURCE_ID_INVALID)
    if normalized_source != source or normalized_id != source_id:
        _fail(_SOURCE_ID_NONCANONICAL)
    if paper_id != expected_paper_id:
        _fail(_PAPER_ID_MISMATCH)

    return adapter(paper_id, source_id, catalog_row)


def resolve_pdf_source(catalog_row: Mapping[str, object]) -> ResolvedPDFSource:
    """Resolve one canonical catalog row without leaking boundary exceptions."""

    result: ResolvedPDFSource | None = None
    issue_code: str | None = None
    try:
        result = _resolve_pdf_source(catalog_row)
    except Exception as exc:
        # A hostile Mapping can execute arbitrary code from ``get``, membership,
        # equality, hashing, or iteration.  None of those exceptions may cross
        # this public trust boundary or become an exception context.
        issue_code = exc.issue_code if type(exc) is _ResolutionIssueError else _CATALOG_ROW_INVALID

    if issue_code is not None:
        raise SourceResolutionError(PAPER_SLIDE_SOURCE_UNTRUSTED, issue_code)
    if result is None:  # Defensive totality if an internal adapter is mutated.
        raise SourceResolutionError(PAPER_SLIDE_SOURCE_UNTRUSTED, _CATALOG_ROW_INVALID)
    return result

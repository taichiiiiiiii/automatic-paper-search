"""SD1R trusted source resolver contracts (offline only)."""

from __future__ import annotations

import json
import socket
from collections import Counter
from collections.abc import Iterator, Mapping
from dataclasses import FrozenInstanceError
from pathlib import Path
from urllib import request

import pytest

from paperpilot.identity import make_paper_id
from paperpilot.paper_slides.contract import PAPER_SLIDE_SOURCE_UNTRUSTED
from paperpilot.paper_slides.resolver import (
    ResolvedPDFSource,
    SourceResolutionError,
    resolve_pdf_source,
)

ROOT = Path(__file__).resolve().parents[2]
CATALOG_DIRS = (
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
EXPECTED_SOURCE_COUNTS = {
    "acl_anthology": 3508,
    "arxiv": 1258,
    "cvf": 9640,
    "openreview": 13894,
}


def _row(source: str, source_id: str, **extra: object) -> dict[str, object]:
    return {
        "paper_id": make_paper_id(source, source_id),
        "source": source,
        "source_id": source_id,
        "title": "SENSITIVE PAPER TITLE",
        **extra,
    }


def _assert_safe_error(error: SourceResolutionError, issue_code: str, *secret_values: str) -> None:
    assert error.error_code == PAPER_SLIDE_SOURCE_UNTRUSTED
    assert error.issue_code == issue_code
    assert error.args == (f"{PAPER_SLIDE_SOURCE_UNTRUSTED}:{issue_code}",)
    assert str(error) == f"{PAPER_SLIDE_SOURCE_UNTRUSTED}:{issue_code}"
    assert repr(error) == (f"SourceResolutionError('{PAPER_SLIDE_SOURCE_UNTRUSTED}:{issue_code}')")
    assert error.__cause__ is None
    assert error.__context__ is None
    rendered = f"{error!s} {error!r} {error.args!r}"
    assert all(secret not in rendered for secret in secret_values)


class _ExplodingMapping(Mapping[str, object]):
    def __getitem__(self, key: str) -> object:
        raise RuntimeError(f"MAPPING_SECRET:{key}")

    def __iter__(self) -> Iterator[str]:
        raise RuntimeError("MAPPING_ITER_SECRET")

    def __len__(self) -> int:
        raise RuntimeError("MAPPING_LENGTH_SECRET")


@pytest.mark.parametrize(
    ("row", "expected"),
    [
        (
            _row("arxiv", "2601.01234", arxiv_url="https://attacker.invalid/a"),
            ResolvedPDFSource(
                paper_id=make_paper_id("arxiv", "2601.01234"),
                source="arxiv",
                source_id="2601.01234",
                landing_url="https://arxiv.org/abs/2601.01234",
                pdf_url="https://arxiv.org/pdf/2601.01234",
                access="open_access",
                license="unknown",
                license_evidence_url=None,
            ),
        ),
        (
            _row("arxiv", "math.GT/0309136"),
            ResolvedPDFSource(
                paper_id=make_paper_id("arxiv", "math.GT/0309136"),
                source="arxiv",
                source_id="math.GT/0309136",
                landing_url="https://arxiv.org/abs/math.GT/0309136",
                pdf_url="https://arxiv.org/pdf/math.GT/0309136",
                access="open_access",
                license="unknown",
                license_evidence_url=None,
            ),
        ),
        (
            _row("openreview", "AbC_123-x", pdf_url="https://attacker.invalid/a.pdf"),
            ResolvedPDFSource(
                paper_id=make_paper_id("openreview", "AbC_123-x"),
                source="openreview",
                source_id="AbC_123-x",
                landing_url="https://openreview.net/forum?id=AbC_123-x",
                pdf_url="https://openreview.net/pdf?id=AbC_123-x",
                access="open_access",
                license="unknown",
                license_evidence_url=None,
            ),
        ),
        (
            _row("acl_anthology", "2025.acl-long.153"),
            ResolvedPDFSource(
                paper_id=make_paper_id("acl_anthology", "2025.acl-long.153"),
                source="acl_anthology",
                source_id="2025.acl-long.153",
                landing_url="https://aclanthology.org/2025.acl-long.153/",
                pdf_url="https://aclanthology.org/2025.acl-long.153.pdf",
                access="open_access",
                license="unknown",
                license_evidence_url=None,
            ),
        ),
    ],
)
def test_derived_source_adapters_ignore_catalog_urls(
    row: dict[str, object], expected: ResolvedPDFSource
) -> None:
    assert resolve_pdf_source(row) == expected


def test_cvf_verifies_pair_then_reconstructs_canonical_urls() -> None:
    source_id = "Held_3D_Convex_Splatting_CVPR_2025_paper"
    collection = "CVPR2025"
    row = _row(
        "cvf",
        source_id,
        arxiv_url=f"https://openaccess.thecvf.com/content/{collection}/html/{source_id}.html",
        pdf_url=f"https://openaccess.thecvf.com/content/{collection}/papers/{source_id}.pdf",
    )
    result = resolve_pdf_source(row)
    assert result == ResolvedPDFSource(
        paper_id=make_paper_id("cvf", source_id),
        source="cvf",
        source_id=source_id,
        landing_url=f"https://openaccess.thecvf.com/content/{collection}/html/{source_id}.html",
        pdf_url=f"https://openaccess.thecvf.com/content/{collection}/papers/{source_id}.pdf",
        access="open_access",
        license="unknown",
        license_evidence_url=None,
    )
    with pytest.raises(FrozenInstanceError):
        result.access = "restricted"  # type: ignore[misc]


@pytest.mark.parametrize(
    ("mutation", "issue_code"),
    [
        ({"paper_id": "0" * 40}, "paper_id_mismatch"),
        ({"source": "unknown"}, "source_unsupported"),
        ({"source_id": "2601.01234v2"}, "source_id_noncanonical"),
        ({"source_id": "A PAPER TITLE"}, "source_id_invalid"),
        ({"paper_id": None}, "catalog_identity_invalid"),
    ],
)
def test_identity_failures_are_closed_and_do_not_title_fallback(
    mutation: dict[str, object], issue_code: str
) -> None:
    row = _row("arxiv", "2601.01234")
    row.update(mutation)
    with pytest.raises(SourceResolutionError) as caught:
        resolve_pdf_source(row)
    assert caught.value.error_code == PAPER_SLIDE_SOURCE_UNTRUSTED
    assert caught.value.issue_code == issue_code


@pytest.mark.parametrize("value", [None, [], "paper", 1, True])
def test_non_mapping_or_malformed_rows_have_stable_failures(value: object) -> None:
    with pytest.raises(SourceResolutionError) as caught:
        resolve_pdf_source(value)  # type: ignore[arg-type]
    assert caught.value.error_code == PAPER_SLIDE_SOURCE_UNTRUSTED
    assert caught.value.issue_code in {"catalog_row_invalid", "catalog_identity_invalid"}


@pytest.mark.parametrize(
    ("landing", "pdf", "issue_code"),
    [
        (
            "http://openaccess.thecvf.com/content/CVPR2025/html/Paper_CVPR_2025_paper.html",
            "https://openaccess.thecvf.com/content/CVPR2025/papers/Paper_CVPR_2025_paper.pdf",
            "cvf_url_invalid",
        ),
        (
            "https://user@openaccess.thecvf.com/content/CVPR2025/html/Paper_CVPR_2025_paper.html",
            "https://openaccess.thecvf.com/content/CVPR2025/papers/Paper_CVPR_2025_paper.pdf",
            "cvf_url_invalid",
        ),
        (
            "https://openaccess.thecvf.com:443/content/CVPR2025/html/Paper_CVPR_2025_paper.html",
            "https://openaccess.thecvf.com/content/CVPR2025/papers/Paper_CVPR_2025_paper.pdf",
            "cvf_url_invalid",
        ),
        (
            "https://openaccess.thecvf.com.evil.invalid/content/CVPR2025/html/Paper_CVPR_2025_paper.html",
            "https://openaccess.thecvf.com/content/CVPR2025/papers/Paper_CVPR_2025_paper.pdf",
            "cvf_url_invalid",
        ),
        (
            "https://openaccess.thecvf.com/content/CVPR2025/html/Paper_CVPR_2025_paper.html?download=1",
            "https://openaccess.thecvf.com/content/CVPR2025/papers/Paper_CVPR_2025_paper.pdf",
            "cvf_url_invalid",
        ),
        (
            "https://openaccess.thecvf.com/content/CVPR2025/html/Paper_CVPR_2025_paper.html",
            "https://openaccess.thecvf.com/content/ICCV2025/papers/Paper_CVPR_2025_paper.pdf",
            "cvf_collection_mismatch",
        ),
        (
            "https://openaccess.thecvf.com/content/CVPR2025/html/Other_CVPR_2025_paper.html",
            "https://openaccess.thecvf.com/content/CVPR2025/papers/Paper_CVPR_2025_paper.pdf",
            "cvf_source_id_mismatch",
        ),
        (
            "https://openaccess.thecvf.com/content/CVPR2025/papers/Paper_CVPR_2025_paper.html",
            "https://openaccess.thecvf.com/content/CVPR2025/papers/Paper_CVPR_2025_paper.pdf",
            "cvf_path_invalid",
        ),
    ],
)
def test_cvf_rejects_untrusted_authority_path_collection_and_filename(
    landing: str, pdf: str, issue_code: str
) -> None:
    source_id = "Paper_CVPR_2025_paper"
    row = _row("cvf", source_id, arxiv_url=landing, pdf_url=pdf)
    with pytest.raises(SourceResolutionError) as caught:
        resolve_pdf_source(row)
    assert caught.value.issue_code == issue_code


def test_error_text_is_stable_and_redacts_row_values() -> None:
    secret_id = "Private_Source_Identifier"
    row = {
        "paper_id": make_paper_id("cvf", secret_id),
        "source": "cvf",
        "source_id": secret_id,
        "title": "Private Title",
        "arxiv_url": "https://private.invalid/PrivateLanding",
        "pdf_url": "https://private.invalid/PrivatePDF",
    }
    with pytest.raises(SourceResolutionError) as caught:
        resolve_pdf_source(row)
    _assert_safe_error(
        caught.value,
        "cvf_url_invalid",
        secret_id,
        "Private Title",
        "private.invalid",
    )

    malformed = _row("arxiv", "2601.01234")
    malformed_secret = "SENSITIVE MALFORMED ID"
    malformed["source_id"] = malformed_secret
    with pytest.raises(SourceResolutionError) as invalid:
        resolve_pdf_source(malformed)
    _assert_safe_error(invalid.value, "source_id_invalid", malformed_secret)


def test_url_parser_error_context_and_secret_port_are_discarded() -> None:
    source_id = "Paper_CVPR_2025_paper"
    secret_port = "SECRET_URL_PORT"
    row = _row(
        "cvf",
        source_id,
        arxiv_url=(
            f"https://openaccess.thecvf.com:{secret_port}/content/CVPR2025/html/{source_id}.html"
        ),
        pdf_url=(f"https://openaccess.thecvf.com/content/CVPR2025/papers/{source_id}.pdf"),
    )
    with pytest.raises(SourceResolutionError) as caught:
        resolve_pdf_source(row)
    _assert_safe_error(caught.value, "cvf_url_invalid", secret_port)


def test_hostile_mapping_exception_is_replaced_at_public_boundary() -> None:
    with pytest.raises(SourceResolutionError) as caught:
        resolve_pdf_source(_ExplodingMapping())
    _assert_safe_error(caught.value, "catalog_row_invalid", "MAPPING_SECRET")


def test_exception_constructor_rejects_dynamic_public_codes() -> None:
    error = SourceResolutionError("SECRET_ERROR_CODE", "SECRET_ISSUE_CODE")
    _assert_safe_error(
        error,
        "catalog_row_invalid",
        "SECRET_ERROR_CODE",
        "SECRET_ISSUE_CODE",
    )


def test_all_28300_catalog_rows_resolve_offline_without_title_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def network_forbidden(*_args: object, **_kwargs: object) -> None:
        pytest.fail("source resolution attempted network I/O")

    monkeypatch.setattr(socket, "getaddrinfo", network_forbidden)
    monkeypatch.setattr(socket, "create_connection", network_forbidden)
    monkeypatch.setattr(request, "urlopen", network_forbidden)

    source_counts: Counter[str] = Counter()
    failures: Counter[tuple[str, str]] = Counter()
    resolved_count = 0
    for directory in CATALOG_DIRS:
        rows = json.loads((ROOT / "docs" / directory / "papers.json").read_text())
        for original in rows:
            row = dict(original)
            row["title"] = "TITLE MUST NOT PARTICIPATE IN RESOLUTION"
            try:
                resolved = resolve_pdf_source(row)
            except SourceResolutionError as exc:
                failures[(exc.error_code, exc.issue_code)] += 1
                continue
            assert resolved.paper_id == row["paper_id"]
            assert resolved.source_id == row["source_id"]
            source_counts[resolved.source] += 1
            resolved_count += 1

    assert resolved_count == 28_300
    assert dict(sorted(source_counts.items())) == EXPECTED_SOURCE_COUNTS
    assert failures == Counter()

"""Golden contracts for deterministic source-derived PaperPilot IDs."""

from __future__ import annotations

import pytest

from paperpilot.identity import (
    IdentityError,
    PaperIdentity,
    identity_from_url,
    make_paper_id,
    normalize_alias,
)


@pytest.mark.parametrize(
    ("url", "source", "source_id", "paper_id"),
    [
        (
            "https://arxiv.org/abs/2601.02771v3",
            "arxiv",
            "2601.02771",
            "a975ae530b334ab97e07817de3a60e7ed5d615ad",
        ),
        (
            "http://www.arxiv.org/pdf/2601.02771v1.pdf",
            "arxiv",
            "2601.02771",
            "a975ae530b334ab97e07817de3a60e7ed5d615ad",
        ),
        (
            "https://openreview.net/forum?id=rlZeILv3fm#discussion",
            "openreview",
            "rlZeILv3fm",
            "6d4921febdeb651471ac08d4744b5f22c9f62162",
        ),
        (
            "https://aclanthology.org/2025.acl-long.153/",
            "acl_anthology",
            "2025.acl-long.153",
            "e5b9066b221ffb3599ca8fa9df7cd51438080a2e",
        ),
        (
            "https://openaccess.thecvf.com/content/CVPR2025/html/"
            "Held_3D_Convex_Splatting_Radiance_Field_Rendering_with_3D_Smooth_"
            "Convexes_CVPR_2025_paper.html",
            "cvf",
            "Held_3D_Convex_Splatting_Radiance_Field_Rendering_with_3D_Smooth_"
            "Convexes_CVPR_2025_paper",
            "bab7ab158b1a4c717d23d44aa7af7c1e562fce08",
        ),
    ],
)
def test_identity_golden_vectors(url: str, source: str, source_id: str, paper_id: str) -> None:
    assert identity_from_url(url) == PaperIdentity(source, source_id, paper_id)


def test_arxiv_legacy_id_preserves_subarchive_and_drops_version() -> None:
    identity = identity_from_url("https://export.arxiv.org/abs/math.GT/0309136v2")
    assert identity.source_id == "math.GT/0309136"
    assert normalize_alias("ArXiV", "math.GT/0309136v4") == (
        "arxiv",
        "math.GT/0309136",
    )


def test_openreview_id_is_case_sensitive() -> None:
    upper = identity_from_url("https://openreview.net/forum?id=AbC_123")
    lower = identity_from_url("https://openreview.net/forum?id=abc_123")
    assert upper.source_id != lower.source_id
    assert upper.paper_id != lower.paper_id


def test_doi_alias_normalization() -> None:
    expected = ("doi", "10.1234/abc.def")
    assert normalize_alias("DOI", "doi:10.1234/ABC.Def") == expected
    assert normalize_alias("doi", "https://doi.org/10.1234%2FABC.Def") == expected
    assert normalize_alias("doi", "http://dx.doi.org/10.1234/ABC.Def") == expected


@pytest.mark.parametrize(
    "url",
    [
        "",
        "A Paper Title",
        "ftp://arxiv.org/abs/2601.02771",
        "https://example.com/abs/2601.02771",
        "https://user@arxiv.org/abs/2601.02771",
        "https://arxiv.org/abs/2601%2F02771",
        "https://arxiv.org/abs/not-an-id",
        "https://openreview.net/forum",
        "https://openreview.net/forum?id=one&id=two",
        "https://openreview.net/forum?id=one%2Ftwo",
        "https://aclanthology.org/one/two/",
        "https://openaccess.thecvf.com/content/CVPR2025/papers/test.html",
    ],
)
def test_unknown_or_ambiguous_url_fails_without_title_fallback(url: str) -> None:
    with pytest.raises(IdentityError):
        identity_from_url(url)


@pytest.mark.parametrize(
    ("namespace", "value"),
    [
        ("doi", ""),
        ("doi", "10.1234"),
        ("doi", "11.1234/abc"),
        ("doi", "https://example.com/10.1234/abc"),
        ("arxiv", "https://arxiv.org/abs/2601.02771"),
        ("arxiv", "2601.02771 v2"),
        ("pmid", "12345"),
    ],
)
def test_invalid_alias_fails(namespace: str, value: str) -> None:
    with pytest.raises(IdentityError):
        normalize_alias(namespace, value)


def test_make_paper_id_is_source_scoped_and_validates_input() -> None:
    assert make_paper_id("arxiv", "2601.02771v2") == make_paper_id("arxiv", "2601.02771")
    assert make_paper_id("cvf", "Same_ID") != make_paper_id("acl_anthology", "Same_ID")
    with pytest.raises(IdentityError):
        make_paper_id("unknown", "x")
    with pytest.raises(IdentityError):
        make_paper_id("arxiv", "")

"""The array elements are part of the answer.

Eight sites in one review shared a shape: a loop that quietly skipped
elements it could not interpret, so a broken page became a smaller —
and entirely plausible — result that was then cached without expiry.
These tests pin the rule at each site, and pin the other half too: a
record that is merely missing optional data is still filtered, not
turned into a fabricated outage.
"""

from __future__ import annotations

import pytest

from paperpilot.utils.payload import first_unusable


def test_first_unusable_returns_the_index_and_the_offending_element():
    assert first_unusable([1, 2, 3], lambda x: x < 5) is None
    assert first_unusable([1, 9, 3], lambda x: x < 5) == (1, 9)


def test_first_unusable_treats_a_throwing_predicate_as_a_failed_check():
    """Call sites pass the consumer's own accessor; it must not have to
    be pre-guarded against the very shapes we are looking for."""
    assert first_unusable(["ok", None], lambda s: s.startswith("o")) == (1, None)


def test_first_unusable_allows_a_none_hole_only_when_asked():
    """S2's /paper/batch writes null in place for an id it does not
    know. That is an answer about the id, not a broken page — and it is
    the only array where a hole is legitimate."""
    entries = [{"paperId": "P1"}, None]
    pred = lambda e: isinstance(e, dict) and bool(e.get("paperId"))  # noqa: E731
    assert first_unusable(entries, pred, allow_none=True) is None
    assert first_unusable(entries, pred) == (1, None)


# ---- one definition per identifier, shared by guard and consumer ----


@pytest.mark.parametrize(
    "value,expected",
    [
        ("https://openalex.org/W123", "W123"),
        ("W123", "W123"),
        ("https://openalex.org/W123/", "W123"),
        ("https://openalex.org/X999", None),
        ("https://openalex.org/Wjunk", None),
        ("W", None),
        ("https://openalex.org/", None),
        ("", None),
        (7, None),
        (None, None),
    ],
)
def test_openalex_short_id(value, expected):
    """`Wjunk` and a bare `W` used to pass the theme-side helper, so a
    guard built on it accepted ids the real consumer then dropped."""
    from paperpilot.utils.payload import openalex_short_id

    assert openalex_short_id(value) == expected


@pytest.mark.parametrize(
    "payload,expected",
    [
        ({"paperId": "abc"}, "abc"),
        ({"paperId": ""}, None),
        ({"paperId": "  "}, None),
        ({"paperId": 123}, None),
        ({"paperId": True}, None),
        ({}, None),
        (None, None),
        ("nope", None),
    ],
)
def test_s2_paper_id(payload, expected):
    """A truthy non-string survives `bool(paperId)` and is then carried
    into the artifact as a dict key and a graph node id."""
    from paperpilot.utils.payload import s2_paper_id

    assert s2_paper_id(payload) == expected


@pytest.mark.parametrize(
    "value,expected",
    [
        ("owner/repo", ("owner", "repo")),
        ("owner/with spaces", None),
        ("owner/$evil", None),
        ("owner/..", None),
        (".owner/repo", None),
        ("noslash", None),
        (7, None),
    ],
)
def test_gh_repo_slug(value, expected):
    from paperpilot.utils.payload import gh_repo_slug

    assert gh_repo_slug(value) == expected


@pytest.mark.parametrize(
    "work,expected",
    [
        ({"id": "https://openalex.org/W1"}, "W1"),
        ({"id": "https://openalex.org/W1 "}, "W1"),
        ({"id": "https://openalex.org/W1", "ids": {"doi": "x"}}, "W1"),
        ({"id": "https://openalex.org/W1", "locations": []}, "W1"),
        ({"id": "https://openalex.org/W1", "ids": []}, None),
        ({"id": "https://openalex.org/W1", "primary_location": []}, None),
        ({"id": "https://openalex.org/W1", "primary_location": {"source": 7}}, None),
        ({"id": "https://openalex.org/W1", "locations": "x"}, None),
        ({"id": "https://openalex.org/W1", "locations": [1]}, None),
        ({"id": "https://openalex.org/W1", "authorships": "x"}, None),
        ({"id": "https://openalex.org/X9"}, None),
        ("not-a-dict", None),
    ],
)
def test_openalex_work_shape(work, expected):
    """A missing alias is data — plenty of Works carry no DOI. A block
    of the wrong TYPE is not: consumers do `work.get("ids") or {}` then
    `.get()`, so `ids: []` reaches an AttributeError that crosses the
    fail-safe boundary and aborts the build."""
    from paperpilot.utils.payload import openalex_work_shape

    assert openalex_work_shape(work) == expected


def test_gh_repo_slug_rejects_a_trailing_newline():
    """`$` also matches before a trailing newline, and this function
    guards URL construction."""
    from paperpilot.utils.payload import gh_repo_slug

    assert gh_repo_slug("owner/repo\n") is None
    assert gh_repo_slug("owner\n/repo") is None


@pytest.mark.parametrize(
    "payload,expected",
    [
        ({"paperId": "P1"}, "P1"),
        ({"paperId": "P1", "title": "T", "venue": None, "abstract": None}, "P1"),
        ({"paperId": "P1", "authors": []}, "P1"),
        ({"paperId": "P1", "authors": None}, "P1"),
        ({"paperId": "P1", "authors": [{"name": "A"}]}, "P1"),
        ({"paperId": "P1", "authors": [1]}, None),
        ({"paperId": "P1", "authors": ["A"]}, None),
        ({"paperId": "P1", "authors": "A"}, None),
        ({"paperId": "P1", "title": 7}, None),
        ({"paperId": "P1", "venue": 7}, None),
        ({"paperId": "P1", "abstract": []}, None),
        ({"paperId": 7}, None),
    ],
)
def test_s2_paper_shape(payload, expected):
    """Validating the id alone left the class half-closed: `to_node`
    does `a.get("name")` over `authors` and uses title/venue/abstract
    as strings, so `{"paperId": "P1", "authors": [1]}` cleared the
    element guard, was cached, and then raised AttributeError through
    the fail-safe boundary. Absent and null stay legitimate — a paper
    with no recorded venue is data, not a broken response."""
    from paperpilot.utils.payload import s2_paper_shape

    assert s2_paper_shape(payload) == expected


@pytest.mark.parametrize(
    "work,expected",
    [
        ({"id": "https://openalex.org/W1", "authorships": [{"author": {"display_name": "A"}}]}, "W1"),
        ({"id": "https://openalex.org/W1", "authorships": [{}]}, "W1"),
        ({"id": "https://openalex.org/W1", "authorships": [{"author": None}]}, "W1"),
        ({"id": "https://openalex.org/W1", "title": None}, "W1"),
        ({"id": "https://openalex.org/W1", "authorships": [{"author": "x"}]}, None),
        ({"id": "https://openalex.org/W1", "authorships": [None]}, None),
        ({"id": "https://openalex.org/W1", "title": 7}, None),
        ({"id": "https://openalex.org/W1", "display_name": 7}, None),
        ({"id": "https://openalex.org/W1", "primary_location": {"source": 7}}, None),
    ],
)
def test_openalex_work_shape_checks_the_nested_author_objects(work, expected):
    """`authorships[i].author` is reached with `.get()` by both
    builders, so a string there is an AttributeError through the
    fail-safe boundary — while an authorship with no `author` at all is
    an uncredited paper, which is ordinary data."""
    from paperpilot.utils.payload import openalex_work_shape

    assert openalex_work_shape(work) == expected


@pytest.mark.parametrize(
    "authors,expected",
    [
        ([{"name": "A"}], "P1"),
        ([{}], "P1"),
        ([{"name": None}], "P1"),
        ([{"name": 7}], None),
        ([{"name": ["A"]}], None),
    ],
)
def test_s2_paper_shape_checks_the_author_name_string(authors, expected):
    """`to_node` does `a.get("name", "")` and copies the result into
    the artifact's `authors` array, so a non-string does not raise —
    it leaks past the shape check into published data. An anonymous
    author is still ordinary data."""
    from paperpilot.utils.payload import s2_paper_shape

    assert s2_paper_shape({"paperId": "P1", "authors": authors}) == expected


@pytest.mark.parametrize(
    "authorships,expected",
    [
        ([{"author": {"display_name": "A"}}], "W1"),
        ([{"author": {}}], "W1"),
        ([{"author": {"display_name": None}}], "W1"),
        ([{"author": {"display_name": 7}}], None),
    ],
)
def test_openalex_work_shape_checks_the_author_display_name(authorships, expected):
    """`build_conference_lineage._authors` appends `display_name`
    unguarded, so a non-string reached the node's `authors` list."""
    from paperpilot.utils.payload import openalex_work_shape

    assert (
        openalex_work_shape({"id": "https://openalex.org/W1", "authorships": authorships})
        == expected
    )


@pytest.mark.parametrize(
    "patch_work,expected",
    [
        ({"cited_by_count": 5}, "W1"),
        ({"cited_by_count": None}, "W1"),
        ({"cited_by_count": "bad"}, None),
        ({"cited_by_count": True}, None),
        ({"publication_year": 2024}, "W1"),
        ({"publication_year": "2024"}, None),
        ({"doi": 7}, None),
        ({"primary_location": {"source": {"display_name": [1]}}}, None),
        ({"primary_location": {"source": {"display_name": "V"}}}, "W1"),
        ({"ids": {"doi": 7}}, None),
        ({"ids": {"doi": "10.1/a"}}, "W1"),
        ({"primary_location": {"landing_page_url": 7}}, None),
        ({"locations": [{"pdf_url": 7}]}, None),
        ({"locations": [{"pdf_url": "https://x"}]}, "W1"),
    ],
)
def test_openalex_work_shape_checks_the_scalars_consumers_use(patch_work, expected):
    """`int(cited_by_count or 0)` raises on a string; `venue` reaches a
    `.strip()`; and a non-string alias value is dropped in silence,
    which for an Oral reads as "no match" rather than a broken Work."""
    from paperpilot.utils.payload import openalex_work_shape

    work = {"id": "https://openalex.org/W1", "title": "T"}
    work.update(patch_work)
    assert openalex_work_shape(work) == expected


@pytest.mark.parametrize(
    "entry,expected",
    [
        ({"citedPaper": {"paperId": "P1", "title": "T"}}, True),
        ({"citedPaper": {"paperId": "P1"}, "isInfluential": True}, True),
        ({"citedPaper": {"paperId": "P1"}, "isInfluential": None}, True),
        ({"citedPaper": {"paperId": "P1"}, "isInfluential": "false"}, False),
        ({"citedPaper": {"paperId": "P1"}, "intents": ["methodology"]}, True),
        ({"citedPaper": {"paperId": "P1"}, "intents": []}, True),
        ({"citedPaper": {"paperId": "P1"}, "intents": [{"a": 1}]}, False),
        ({"citedPaper": {"paperId": "P1"}, "intents": "methodology"}, False),
        ({"citedPaper": None}, False),
        ("not-a-dict", False),
    ],
)
def test_s2_relation_entry_ok(entry, expected):
    """`bool("false")` is True and `str({"a": 1})` is "{'a': 1}" —
    neither raises, and both are written to a cache with no expiry."""
    from paperpilot.utils.payload import s2_relation_entry_ok

    assert s2_relation_entry_ok(entry, "citedPaper") is expected


@pytest.mark.parametrize(
    "external,expected",
    [
        ({"ArXiv": "2501.00001"}, "P1"),
        ({"ArXiv": None}, "P1"),
        ({"MAG": 7}, "P1"),
        ({"ArXiv": 7}, None),
        ({"DOI": ["10.1/a"]}, None),
    ],
)
def test_s2_paper_shape_checks_the_external_id_values(external, expected):
    """`to_node` copies `external.get("ArXiv")` straight into the
    node's `arxiv_id`, so a non-string neither raises nor empties — it
    lands in the published artifact. Only the keys that are read are
    checked; `MAG` is not one of them."""
    from paperpilot.utils.payload import s2_paper_shape

    assert s2_paper_shape({"paperId": "P1", "externalIds": external}) == expected


@pytest.mark.parametrize(
    "value,expected",
    [
        ("W123", "W123"),
        ("https://openalex.org/W123", "W123"),
        ("http://openalex.org/W123", "W123"),
        ("https://api.openalex.org/works/W123", "W123"),
        ("https://openalex.org/W123/", "W123"),
        ("https://evil.example/W123", None),
        ("https://evil.example/openalex.org/W123", None),
        ("garbage/W123", None),
        ("//openalex.org/W123", None),
    ],
)
def test_openalex_short_id_validates_the_host(value, expected):
    """The host is part of the identity. Taking the last path segment
    of anything accepted `https://evil.example/W123`, and this one
    function now backs payload admission, catalog aliases and the
    unarXive lookup — so a spoofed URL would propagate as provenance
    everywhere at once."""
    from paperpilot.utils.payload import openalex_short_id

    assert openalex_short_id(value) == expected


@pytest.mark.parametrize(
    "paper,expected",
    [
        ({"paperId": "P1", "title": "T"}, True),
        ({"paperId": "P1", "title": "T", "_is_influential": True}, True),
        ({"paperId": "P1", "title": "T", "_is_influential": None}, True),
        ({"paperId": "P1", "title": "T", "_intents": ["methodology"]}, True),
        ({"paperId": "P1"}, False),
        ({"paperId": "P1", "title": "T", "_is_influential": "false"}, False),
        ({"paperId": "P1", "title": "T", "_intents": [{"a": 1}]}, False),
        ({"paperId": "P1", "title": "T", "_contexts": [7]}, False),
    ],
)
def test_s2_cached_neighbour_ok(paper, expected):
    """The cache stores the inner paper with the envelope's fields
    lifted onto it, so it must clear both bars: `to_node` indexes
    `paper["title"]` directly, and the lifted fields steer relation
    classification."""
    from paperpilot.utils.payload import s2_cached_neighbour_ok

    assert s2_cached_neighbour_ok(paper) is expected

"""Tests for paperpilot.utils.unarxive — the unarXive 2022 citation
context lookup module.

These tests use monkey-patching to inject a fake DuckDB connection so
they don't need the actual ~2 GB DuckDB file. The real lookup is
covered by integration tests that run only when ``UNARXIVE_DB`` env
points to a built index.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from paperpilot.utils import unarxive


def test_normalise_openalex_short_accepts_url_form():
    assert (
        unarxive._normalise_openalex_short(
            "https://openalex.org/W2962917714"
        )
        == "W2962917714"
    )


def test_normalise_openalex_short_accepts_paperpilot_prefix():
    """PaperPilot stores paperIds as ``openalex:W...`` — the lookup
    must accept that form directly so callers don't have to strip."""
    assert (
        unarxive._normalise_openalex_short("openalex:W2962917714")
        == "W2962917714"
    )


def test_normalise_openalex_short_accepts_bare_short_id():
    assert unarxive._normalise_openalex_short("W2962917714") == "W2962917714"


def test_normalise_openalex_short_rejects_non_w_prefixed():
    """Garbage inputs ("foo", S2 hash, missing W prefix) return None
    so the caller skips the lookup entirely."""
    assert unarxive._normalise_openalex_short("foo") is None
    assert unarxive._normalise_openalex_short("") is None
    assert unarxive._normalise_openalex_short(None) is None  # type: ignore[arg-type]
    assert unarxive._normalise_openalex_short("hashhash1234abcd") is None


def test_normalise_arxiv_id_accepts_bare_modern_form():
    assert unarxive._normalise_arxiv_id("2010.11929") == "2010.11929"
    assert unarxive._normalise_arxiv_id("2103.14030") == "2103.14030"


def test_normalise_arxiv_id_strips_version_suffix():
    """unarXive stores the base arXiv id without ``v2`` etc."""
    assert unarxive._normalise_arxiv_id("2010.11929v3") == "2010.11929"
    assert unarxive._normalise_arxiv_id("2103.14030v1") == "2103.14030"


def test_normalise_arxiv_id_strips_arxiv_prefix():
    assert unarxive._normalise_arxiv_id("arXiv:2010.11929") == "2010.11929"
    assert unarxive._normalise_arxiv_id("arxiv:2010.11929") == "2010.11929"


def test_normalise_arxiv_id_rejects_old_style_and_garbage():
    """Pre-2007 arXiv ids ("cs.LG/0512345") aren't supported — our
    themes are all post-2017. Garbage returns None."""
    assert unarxive._normalise_arxiv_id("cs.LG/0512345") is None
    assert unarxive._normalise_arxiv_id("not an id") is None
    assert unarxive._normalise_arxiv_id("") is None
    assert unarxive._normalise_arxiv_id(None) is None  # type: ignore[arg-type]


def test_fetch_contexts_empty_inputs_short_circuit():
    """Missing ids → empty list, never raises, never opens the DB."""
    assert unarxive.fetch_contexts(
        child_arxiv_id=None,
        parent_openalex_id="W123",
    ) == []
    assert unarxive.fetch_contexts(
        child_arxiv_id="2010.11929",
        parent_openalex_id="",
    ) == []


def test_fetch_contexts_returns_empty_when_db_absent(monkeypatch):
    """No DuckDB file → graceful empty result. Test pins the
    'feature disabled' fallback behaviour the build pipeline relies on
    when running on a fresh clone or CI without the artifact."""
    monkeypatch.setattr(unarxive, "_open_readonly", lambda: None)
    result = unarxive.fetch_contexts(
        child_arxiv_id="2010.11929",
        parent_openalex_id="W2962917714",
    )
    assert result == []


def test_fetch_contexts_returns_paragraphs(monkeypatch):
    """When the DuckDB returns rows, the function returns the text
    column verbatim."""
    fake_conn = MagicMock()
    fake_conn.execute.return_value.fetchall.return_value = [
        ("We build on the framework of [42] to model video diffusion.",),
        ("Unlike [42], we use a hierarchical attention.",),
    ]
    monkeypatch.setattr(
        unarxive, "_open_readonly", lambda: fake_conn
    )

    result = unarxive.fetch_contexts(
        child_arxiv_id="2103.14030",
        parent_openalex_id="openalex:W2962917714",
    )
    assert result == [
        "We build on the framework of [42] to model video diffusion.",
        "Unlike [42], we use a hierarchical attention.",
    ]
    # SQL contract: arxiv id is the bare modern form, OpenAlex is the
    # full URL — pin the call args so a refactor can't silently drop
    # the URL prefix and break the join.
    sql_args = fake_conn.execute.call_args[0][1]
    assert sql_args[0] == "2103.14030"
    assert sql_args[1] == "https://openalex.org/W2962917714"


def test_fetch_contexts_default_limit_is_5(monkeypatch):
    """Pin the limit so tooltips don't blow up the viewer width when
    a particularly chatty paper cites another paper many times."""
    fake_conn = MagicMock()
    fake_conn.execute.return_value.fetchall.return_value = []
    monkeypatch.setattr(unarxive, "_open_readonly", lambda: fake_conn)
    unarxive.fetch_contexts(
        child_arxiv_id="2103.14030",
        parent_openalex_id="W123",
    )
    sql_args = fake_conn.execute.call_args[0][1]
    assert sql_args[2] == 5  # default limit


def test_fetch_contexts_drops_empty_rows(monkeypatch):
    """DuckDB occasionally returns null text rows; filter them out
    so consumers don't get '' entries that confuse the regex
    classifier."""
    fake_conn = MagicMock()
    fake_conn.execute.return_value.fetchall.return_value = [
        ("real context",),
        (None,),
        ("",),
        ("another context",),
    ]
    monkeypatch.setattr(unarxive, "_open_readonly", lambda: fake_conn)
    result = unarxive.fetch_contexts(
        child_arxiv_id="2010.11929",
        parent_openalex_id="W123",
    )
    assert result == ["real context", "another context"]


def test_is_available_when_db_present(monkeypatch):
    """is_available() must reflect whether the DB is openable —
    used by build pipeline to log unarXive coverage status per run."""
    monkeypatch.setattr(unarxive, "_open_readonly", lambda: MagicMock())
    assert unarxive.is_available() is True


def test_is_available_when_db_absent(monkeypatch):
    monkeypatch.setattr(unarxive, "_open_readonly", lambda: None)
    assert unarxive.is_available() is False

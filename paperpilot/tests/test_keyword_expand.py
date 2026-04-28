"""Tests for the keyword-expansion helper."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from paperpilot.utils.keyword_expand import expand_keywords


class _FakeProvider:
    """Minimal provider stub — returns a pre-canned string from _chat."""

    def __init__(self, response_text: str) -> None:
        self._response_text = response_text

    def expand(self, system: str, user: str) -> str | None:
        return self._response_text


def test_expand_keywords_returns_merged_list():
    """expand_keywords merges originals + LLM suggestions and dedupes."""
    provider = _FakeProvider(
        response_text='["retrieval augmented generation", "dense retrieval", "RAG"]'
    )
    with patch("paperpilot.utils.keyword_expand._call_provider", return_value=provider._response_text):
        expanded = expand_keywords(
            keywords=["RAG"],
            provider=SimpleNamespace(name="fake", enabled=True),
            max_expansions=5,
        )
    # Original kept, new ones added, duplicates removed (case-insensitive)
    assert "RAG" in expanded
    assert "retrieval augmented generation" in expanded
    assert "dense retrieval" in expanded
    assert len(expanded) <= 1 + 5


def test_expand_keywords_respects_max_expansions():
    response = '["a", "b", "c", "d", "e", "f"]'
    with patch("paperpilot.utils.keyword_expand._call_provider", return_value=response):
        expanded = expand_keywords(
            keywords=["x"],
            provider=SimpleNamespace(name="fake", enabled=True),
            max_expansions=3,
        )
    assert len(expanded) == 1 + 3  # original + 3 additions


def test_expand_keywords_disabled_provider_returns_original():
    """If provider is disabled or None, return input unchanged (Fail-Safe)."""
    out = expand_keywords(
        keywords=["rag"],
        provider=None,
        max_expansions=5,
    )
    assert out == ["rag"]


def test_expand_keywords_dedup_case_insensitive():
    """'RAG' and 'rag' count as duplicates; first-seen casing is preserved."""
    response = '["rag", "Retrieval Augmented Generation"]'
    with patch("paperpilot.utils.keyword_expand._call_provider", return_value=response):
        expanded = expand_keywords(
            keywords=["RAG"],
            provider=SimpleNamespace(name="fake", enabled=True),
            max_expansions=5,
        )
    lowered = [k.lower() for k in expanded]
    assert len(lowered) == len(set(lowered))


def test_expand_keywords_provider_returns_invalid_json():
    """If the LLM returns garbage, fall back to originals."""
    with patch("paperpilot.utils.keyword_expand._call_provider", return_value="not json"):
        expanded = expand_keywords(
            keywords=["rag"],
            provider=SimpleNamespace(name="fake", enabled=True),
            max_expansions=5,
        )
    assert expanded == ["rag"]


def test_expand_keywords_empty_input():
    assert expand_keywords([], provider=None, max_expansions=5) == []


# ---- Silent-fallback detection (issue #45) -----------------------------------


@pytest.fixture()
def caplog_warning(caplog: pytest.LogCaptureFixture) -> pytest.LogCaptureFixture:
    """Capture warnings from the keyword_expand logger only."""
    caplog.set_level(logging.WARNING, logger="paperpilot.utils.keyword_expand")
    return caplog


def test_expand_keywords_warns_when_provider_unavailable(
    caplog_warning: pytest.LogCaptureFixture,
) -> None:
    """When provider is disabled, log a warning so silent fallback is visible."""
    expand_keywords(
        keywords=["rag"],
        provider=None,
        max_expansions=5,
    )
    msgs = [r.getMessage() for r in caplog_warning.records if r.levelno >= logging.WARNING]
    assert any("provider unavailable" in m or "fallback" in m.lower() for m in msgs), (
        f"expected fallback warning, got: {msgs}"
    )


def test_expand_keywords_warns_when_provider_returns_empty(
    caplog_warning: pytest.LogCaptureFixture,
) -> None:
    """LLM returning None / empty triggers a warning (silent fallback)."""
    with patch("paperpilot.utils.keyword_expand._call_provider", return_value=None):
        expand_keywords(
            keywords=["rag"],
            provider=SimpleNamespace(name="fake", enabled=True),
            max_expansions=5,
        )
    msgs = [r.getMessage() for r in caplog_warning.records if r.levelno >= logging.WARNING]
    assert any("empty" in m.lower() or "fallback" in m.lower() for m in msgs), (
        f"expected empty/fallback warning, got: {msgs}"
    )


def test_expand_keywords_no_warning_on_successful_expansion(
    caplog_warning: pytest.LogCaptureFixture,
) -> None:
    """Successful expansion (added > 0) must NOT emit a fallback warning."""
    with patch(
        "paperpilot.utils.keyword_expand._call_provider",
        return_value='["retrieval", "dense retrieval"]',
    ):
        expand_keywords(
            keywords=["rag"],
            provider=SimpleNamespace(name="fake", enabled=True),
            max_expansions=5,
        )
    msgs = [r.getMessage() for r in caplog_warning.records if r.levelno >= logging.WARNING]
    fallback_msgs = [m for m in msgs if "fallback" in m.lower() or "unavailable" in m.lower()]
    assert fallback_msgs == [], f"unexpected fallback warning on success: {fallback_msgs}"


def test_expand_keywords_warns_when_no_new_keywords_added(
    caplog_warning: pytest.LogCaptureFixture,
) -> None:
    """LLM returning only duplicates of input → warn (effectively no expansion)."""
    with patch(
        "paperpilot.utils.keyword_expand._call_provider",
        return_value='["RAG", "rag"]',
    ):
        out = expand_keywords(
            keywords=["rag"],
            provider=SimpleNamespace(name="fake", enabled=True),
            max_expansions=5,
        )
    assert out == ["rag"]
    msgs = [r.getMessage() for r in caplog_warning.records if r.levelno >= logging.WARNING]
    assert any("no new keywords" in m.lower() or "fallback" in m.lower() for m in msgs), (
        f"expected no-expansion warning, got: {msgs}"
    )


# --------------------------- Error / edge paths ----------------------------


def test_expand_keywords_provider_raises_returns_original():
    """If _call_provider raises, we Fail-Safe to the input list."""
    def _boom(*_args, **_kwargs):
        raise RuntimeError("LLM exploded")

    with patch("paperpilot.utils.keyword_expand._call_provider", side_effect=_boom):
        out = expand_keywords(
            keywords=["rag"],
            provider=SimpleNamespace(name="fake", enabled=True),
            max_expansions=5,
        )
    assert out == ["rag"]


def test_expand_keywords_empty_llm_response_returns_original():
    """LLM returning None (or empty string) is treated as no expansion."""
    with patch("paperpilot.utils.keyword_expand._call_provider", return_value=None):
        out = expand_keywords(
            keywords=["rag"],
            provider=SimpleNamespace(name="fake", enabled=True),
            max_expansions=5,
        )
    assert out == ["rag"]


def test_expand_keywords_json_non_list_returns_original():
    """parse_llm_response yielding a dict (not a list) is rejected cleanly."""
    with patch(
        "paperpilot.utils.keyword_expand._call_provider",
        return_value='{"not": "a list"}',
    ):
        out = expand_keywords(
            keywords=["rag"],
            provider=SimpleNamespace(name="fake", enabled=True),
            max_expansions=5,
        )
    assert out == ["rag"]


def test_expand_keywords_skips_non_string_and_empty_items():
    """Non-string items and whitespace-only strings in the LLM list are dropped."""
    # Mix: valid string, int, None, empty string, whitespace, duplicate, valid
    response = '["retrieval", 42, null, "", "   ", "retrieval", "dense"]'
    with patch("paperpilot.utils.keyword_expand._call_provider", return_value=response):
        out = expand_keywords(
            keywords=["rag"],
            provider=SimpleNamespace(name="fake", enabled=True),
            max_expansions=10,
        )
    assert out == ["rag", "retrieval", "dense"]


# --------------------------- _call_provider ---------------------------------


def test_call_provider_uses_chat_first():
    """_call_provider prefers `_chat` when present."""
    from paperpilot.utils.keyword_expand import _call_provider

    class _P:
        def _chat(self, system: str, user: str) -> str:
            assert "同義語" in system  # system prompt reached the provider
            assert "rag" in user
            return '["retrieval"]'

    assert _call_provider(_P(), ["rag"], "AI") == '["retrieval"]'


def test_call_provider_falls_through_to_messages():
    """If `_chat` is missing, `_messages` is tried next."""
    from paperpilot.utils.keyword_expand import _call_provider

    class _P:
        def _messages(self, system: str, user: str) -> str:
            return '["x"]'

    assert _call_provider(_P(), ["rag"], "AI") == '["x"]'


def test_call_provider_falls_through_to_generate():
    """If `_chat` and `_messages` are missing, `_generate` is tried."""
    from paperpilot.utils.keyword_expand import _call_provider

    class _P:
        def _generate(self, system: str, user: str) -> str:
            return '["y"]'

    assert _call_provider(_P(), ["rag"], "AI") == '["y"]'


def test_call_provider_returns_none_when_no_method():
    """If provider exposes none of _chat/_messages/_generate, bail out."""
    from paperpilot.utils.keyword_expand import _call_provider

    class _P:
        pass  # no chat-like method at all

    assert _call_provider(_P(), ["rag"], "AI") is None


def test_call_provider_skips_method_with_wrong_signature():
    """A method whose signature rejects (system, user) is skipped, not crashed on."""
    from paperpilot.utils.keyword_expand import _call_provider

    class _P:
        def _chat(self):  # wrong signature — takes no args beyond self
            return "nope"

        def _messages(self, system: str, user: str) -> str:
            return '["ok"]'

    assert _call_provider(_P(), ["rag"], "AI") == '["ok"]'


def test_call_provider_accepts_none_return():
    """A method that returns None is considered a valid (empty) answer."""
    from paperpilot.utils.keyword_expand import _call_provider

    class _P:
        def _chat(self, system: str, user: str) -> None:
            return None

    assert _call_provider(_P(), ["rag"], "AI") is None

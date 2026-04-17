"""Tests for the keyword-expansion helper."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

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

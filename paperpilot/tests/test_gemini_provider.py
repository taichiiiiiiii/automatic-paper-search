"""Gemini LLM provider tests (HTTP mocked)."""

from __future__ import annotations

import json
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.llm.gemini_provider import GeminiProvider
from paperpilot.models import Paper


def _resp(status: int, body=None):
    return SimpleNamespace(status_code=status, json=lambda: body or {})


def _gemini_body(text: str) -> dict:
    return {
        "candidates": [
            {"content": {"parts": [{"text": text}]}}
        ]
    }


def _mk_paper(title: str) -> Paper:
    return Paper(
        title=title,
        authors=["A"],
        abstract="abs",
        url="u",
        published_date=date.today(),
        source="arxiv",
    )


def test_provider_requires_api_key():
    # No key → enabled property falls back to False even if config says enabled
    provider = GeminiProvider({"enabled": True}, api_key=None)
    assert provider.enabled is False


def test_provider_has_api_key_enabled():
    provider = GeminiProvider({"enabled": True}, api_key="key123")
    assert provider.enabled is True


def test_evaluate_batch_parses_json_array():
    papers = [_mk_paper("P1"), _mk_paper("P2")]
    eval_json = [
        {"relevance": 4, "summary_ja": "s1", "reason": "r1", "tags": ["tag"]},
        {"relevance": 2, "summary_ja": "s2", "reason": "r2", "tags": []},
    ]
    body = _gemini_body(json.dumps(eval_json))

    provider = GeminiProvider({"enabled": True, "model": "gemini-1.5-flash"}, api_key="k")
    with patch(
        "paperpilot.llm.gemini_provider.request_with_retry",
        return_value=_resp(200, body),
    ) as mock:
        evals = provider.evaluate_batch(papers, profile="RAG")
    assert evals[0].relevance == 4
    assert evals[1].relevance == 2

    # URL includes model name; API key is in x-goog-api-key header (not URL)
    url = mock.call_args.args[1]
    assert "gemini-1.5-flash" in url
    headers = mock.call_args.kwargs["headers"]
    assert headers.get("x-goog-api-key") == "k"
    # Security: the key must NOT appear in URL or params (avoids proxy logs)
    assert "key=" not in url
    assert "key" not in (mock.call_args.kwargs.get("params") or {})


def test_evaluate_batch_api_failure():
    papers = [_mk_paper("P1")]
    provider = GeminiProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.gemini_provider.request_with_retry",
        return_value=_resp(503),
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert evals == [None]


def test_evaluate_batch_empty_candidates():
    papers = [_mk_paper("P1")]
    provider = GeminiProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.gemini_provider.request_with_retry",
        return_value=_resp(200, {"candidates": []}),
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert evals == [None]


def test_evaluate_batch_handles_markdown_fences():
    papers = [_mk_paper("P1")]
    wrapped = "```json\n[{\"relevance\": 3, \"summary_ja\": \"x\", \"reason\": \"y\", \"tags\": []}]\n```"
    body = _gemini_body(wrapped)
    provider = GeminiProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.gemini_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert evals[0].relevance == 3


def test_evaluate_batch_empty_input():
    provider = GeminiProvider({"enabled": True}, api_key="k")
    assert provider.evaluate_batch([], profile="") == []


def test_evaluate_batch_non_array_response():
    papers = [_mk_paper("P1")]
    body = _gemini_body('{"not": "an array"}')
    provider = GeminiProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.gemini_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert evals == [None]


def test_evaluate_batch_missing_results_padded_with_none():
    papers = [_mk_paper("P1"), _mk_paper("P2"), _mk_paper("P3")]
    eval_json = [{"relevance": 5, "summary_ja": "", "reason": "", "tags": []}]
    body = _gemini_body(json.dumps(eval_json))
    provider = GeminiProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.gemini_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert len(evals) == 3
    assert evals[0] is not None
    assert evals[1] is None
    assert evals[2] is None

"""OllamaProvider — tests with mocked HTTP."""

from __future__ import annotations

import json
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.llm.ollama_provider import OllamaProvider
from paperpilot.models import Paper


def _resp(body):
    return SimpleNamespace(status_code=200, json=lambda: body)


def _mk_paper(title: str) -> Paper:
    return Paper(
        title=title,
        authors=["A"],
        abstract="abs",
        url="u",
        published_date=date.today(),
        source="arxiv",
    )


def test_evaluate_batch_parses_json_array():
    papers = [_mk_paper("Paper 1"), _mk_paper("Paper 2")]
    llm_json = [
        {"relevance": 5, "summary_ja": "要約1", "reason": "必読", "tags": ["新手法"]},
        {"relevance": 2, "summary_ja": "要約2", "reason": "弱関連", "tags": ["応用"]},
    ]
    ollama_body = {"message": {"content": json.dumps(llm_json)}}

    provider = OllamaProvider({"enabled": True, "model": "qwen2.5:7b"})
    with patch(
        "paperpilot.llm.ollama_provider.request_with_retry",
        return_value=_resp(ollama_body),
    ):
        evals = provider.evaluate_batch(papers, profile="RAG")

    assert len(evals) == 2
    assert evals[0] is not None and evals[0].relevance == 5
    assert evals[1] is not None and evals[1].relevance == 2


def test_evaluate_batch_handles_markdown_fences():
    papers = [_mk_paper("Paper 1")]
    wrapped = "```json\n" + json.dumps(
        [{"relevance": 3, "summary_ja": "s", "reason": "r", "tags": []}]
    ) + "\n```"
    ollama_body = {"message": {"content": wrapped}}

    provider = OllamaProvider({"enabled": True})
    with patch(
        "paperpilot.llm.ollama_provider.request_with_retry",
        return_value=_resp(ollama_body),
    ):
        evals = provider.evaluate_batch(papers, profile="RAG")

    assert evals[0] is not None
    assert evals[0].relevance == 3


def test_evaluate_batch_returns_none_list_on_http_failure():
    papers = [_mk_paper("P1"), _mk_paper("P2")]
    provider = OllamaProvider({"enabled": True})
    with patch(
        "paperpilot.llm.ollama_provider.request_with_retry",
        return_value=None,
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert evals == [None, None]


def test_evaluate_batch_truncates_extra_results():
    papers = [_mk_paper("P1")]
    # Model returns more elements than requested — only first is kept.
    llm_json = [
        {"relevance": 4, "summary_ja": "a", "reason": "b", "tags": []},
        {"relevance": 2, "summary_ja": "x", "reason": "y", "tags": []},
    ]
    ollama_body = {"message": {"content": json.dumps(llm_json)}}

    provider = OllamaProvider({"enabled": True})
    with patch(
        "paperpilot.llm.ollama_provider.request_with_retry",
        return_value=_resp(ollama_body),
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert len(evals) == 1
    assert evals[0] is not None
    assert evals[0].relevance == 4


def test_evaluate_batch_pads_missing_results():
    papers = [_mk_paper("P1"), _mk_paper("P2"), _mk_paper("P3")]
    # Model only returned 1 element — pad with None.
    llm_json = [{"relevance": 5, "summary_ja": "a", "reason": "b", "tags": []}]
    ollama_body = {"message": {"content": json.dumps(llm_json)}}

    provider = OllamaProvider({"enabled": True})
    with patch(
        "paperpilot.llm.ollama_provider.request_with_retry",
        return_value=_resp(ollama_body),
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert len(evals) == 3
    assert evals[0] is not None
    assert evals[1] is None
    assert evals[2] is None


def test_evaluate_batch_non_array_response():
    papers = [_mk_paper("P1")]
    # Model returns an object instead of a list.
    ollama_body = {"message": {"content": '{"not": "an array"}'}}
    provider = OllamaProvider({"enabled": True})
    with patch(
        "paperpilot.llm.ollama_provider.request_with_retry",
        return_value=_resp(ollama_body),
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert evals == [None]


def test_evaluate_batch_empty_input():
    provider = OllamaProvider({"enabled": True})
    assert provider.evaluate_batch([], profile="x") == []

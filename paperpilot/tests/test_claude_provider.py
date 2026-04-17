"""Claude LLM provider tests (HTTP mocked)."""

from __future__ import annotations

import json
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.llm.claude_provider import ClaudeProvider
from paperpilot.models import Paper


def _resp(status: int, body=None):
    return SimpleNamespace(status_code=status, json=lambda: body or {})


def _claude_body(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}]}


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
    provider = ClaudeProvider({"enabled": True}, api_key=None)
    assert provider.enabled is False


def test_provider_with_api_key_is_enabled():
    provider = ClaudeProvider({"enabled": True}, api_key="sk-ant-x")
    assert provider.enabled is True


def test_evaluate_batch_parses_json_array():
    papers = [_mk_paper("P1"), _mk_paper("P2")]
    eval_json = [
        {"relevance": 5, "summary_ja": "必読", "reason": "革新", "tags": ["新手法"]},
        {"relevance": 2, "summary_ja": "弱関連", "reason": "応用外", "tags": []},
    ]
    body = _claude_body(json.dumps(eval_json))

    provider = ClaudeProvider(
        {"enabled": True, "model": "claude-sonnet-4-20250514"}, api_key="sk-ant-x"
    )
    with patch(
        "paperpilot.llm.claude_provider.request_with_retry",
        return_value=_resp(200, body),
    ) as mock:
        evals = provider.evaluate_batch(papers, profile="LLM")
    assert evals[0].relevance == 5
    assert evals[1].relevance == 2

    # API key is in x-api-key header, NOT in URL or params
    headers = mock.call_args.kwargs["headers"]
    assert headers["x-api-key"] == "sk-ant-x"
    assert headers["anthropic-version"]  # version header sent
    url = mock.call_args.args[1]
    assert "api.anthropic.com" in url
    assert "sk-ant-x" not in url


def test_evaluate_batch_handles_markdown_fences():
    papers = [_mk_paper("P1")]
    wrapped = "```json\n" + json.dumps(
        [{"relevance": 3, "summary_ja": "s", "reason": "r", "tags": []}]
    ) + "\n```"
    body = _claude_body(wrapped)
    provider = ClaudeProvider({"enabled": True}, api_key="sk-ant-x")
    with patch(
        "paperpilot.llm.claude_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert evals[0].relevance == 3


def test_evaluate_batch_api_failure():
    papers = [_mk_paper("P1")]
    provider = ClaudeProvider({"enabled": True}, api_key="sk-ant-x")
    with patch(
        "paperpilot.llm.claude_provider.request_with_retry",
        return_value=_resp(529),  # Anthropic overloaded
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert evals == [None]


def test_evaluate_batch_empty_content():
    papers = [_mk_paper("P1")]
    provider = ClaudeProvider({"enabled": True}, api_key="sk-ant-x")
    with patch(
        "paperpilot.llm.claude_provider.request_with_retry",
        return_value=_resp(200, {"content": []}),
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert evals == [None]


def test_evaluate_batch_non_text_part():
    """Claude may occasionally return a non-text content part; handle gracefully."""
    papers = [_mk_paper("P1")]
    body = {"content": [{"type": "tool_use", "id": "x"}]}
    provider = ClaudeProvider({"enabled": True}, api_key="sk-ant-x")
    with patch(
        "paperpilot.llm.claude_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert evals == [None]


def test_evaluate_batch_empty_input():
    provider = ClaudeProvider({"enabled": True}, api_key="sk-ant-x")
    assert provider.evaluate_batch([], profile="") == []


def test_evaluate_batch_pads_missing_results():
    papers = [_mk_paper("P1"), _mk_paper("P2"), _mk_paper("P3")]
    eval_json = [{"relevance": 4, "summary_ja": "", "reason": "", "tags": []}]
    body = _claude_body(json.dumps(eval_json))
    provider = ClaudeProvider({"enabled": True}, api_key="sk-ant-x")
    with patch(
        "paperpilot.llm.claude_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert len(evals) == 3
    assert evals[0] is not None
    assert evals[1] is None
    assert evals[2] is None

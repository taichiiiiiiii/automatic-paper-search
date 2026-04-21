"""Groq LLM provider tests (HTTP mocked).

Groq uses an OpenAI-compatible Chat Completions API, so this mirrors the
Gemini test harness in shape. Additional tests exercise classify_relation
which Groq implements as the primary lineage-classification backend.
"""

from __future__ import annotations

import json
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.llm.groq_provider import GroqProvider
from paperpilot.models import Paper


def _resp(status: int, body=None):
    return SimpleNamespace(status_code=status, json=lambda: body or {})


def _groq_body(text: str) -> dict:
    return {"choices": [{"message": {"content": text}}]}


def _mk_paper(title: str) -> Paper:
    return Paper(
        title=title,
        authors=["A"],
        abstract="abs",
        url="u",
        published_date=date.today(),
        source="arxiv",
    )


# ---- enabled / auth ----


def test_provider_requires_api_key():
    provider = GroqProvider({"enabled": True}, api_key=None)
    assert provider.enabled is False


def test_provider_has_api_key_enabled():
    provider = GroqProvider({"enabled": True}, api_key="gsk_test")
    assert provider.enabled is True


# ---- evaluate_batch ----


def test_evaluate_batch_parses_json_array():
    papers = [_mk_paper("P1"), _mk_paper("P2")]
    eval_json = [
        {"relevance": 4, "summary_ja": "s1", "reason": "r1", "tags": ["t"]},
        {"relevance": 2, "summary_ja": "s2", "reason": "r2", "tags": []},
    ]
    body = _groq_body(json.dumps(eval_json))
    provider = GroqProvider(
        {"enabled": True, "model": "llama-3.3-70b-versatile"}, api_key="gsk_x"
    )
    with patch(
        "paperpilot.llm.groq_provider.request_with_retry",
        return_value=_resp(200, body),
    ) as mock:
        evals = provider.evaluate_batch(papers, profile="RAG")

    assert evals[0] is not None and evals[0].relevance == 4
    assert evals[1] is not None and evals[1].relevance == 2

    # Auth goes in Authorization header (never in URL / params)
    headers = mock.call_args.kwargs["headers"]
    assert headers.get("Authorization") == "Bearer gsk_x"
    url = mock.call_args.args[1]
    assert "api_key" not in url
    assert "key=" not in url

    # Body should contain the configured model
    sent_body = mock.call_args.kwargs["json_body"]
    assert sent_body["model"] == "llama-3.3-70b-versatile"


def test_evaluate_batch_api_failure():
    provider = GroqProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.groq_provider.request_with_retry",
        return_value=_resp(503),
    ):
        evals = provider.evaluate_batch([_mk_paper("P1")], profile="")
    assert evals == [None]


def test_evaluate_batch_empty_input():
    provider = GroqProvider({"enabled": True}, api_key="k")
    assert provider.evaluate_batch([], profile="") == []


def test_evaluate_batch_missing_results_padded_with_none():
    papers = [_mk_paper("P1"), _mk_paper("P2")]
    eval_json = [{"relevance": 5, "summary_ja": "", "reason": "", "tags": []}]
    body = _groq_body(json.dumps(eval_json))
    provider = GroqProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.groq_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        evals = provider.evaluate_batch(papers, profile="")
    assert len(evals) == 2
    assert evals[0] is not None
    assert evals[1] is None


def test_evaluate_batch_non_array_response():
    body = _groq_body('{"not": "an array"}')
    provider = GroqProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.groq_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        evals = provider.evaluate_batch([_mk_paper("P1")], profile="")
    assert evals == [None]


def test_evaluate_batch_handles_markdown_fences():
    wrapped = "```json\n[{\"relevance\": 3, \"summary_ja\": \"x\", \"reason\": \"y\", \"tags\": []}]\n```"
    body = _groq_body(wrapped)
    provider = GroqProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.groq_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        evals = provider.evaluate_batch([_mk_paper("P1")], profile="")
    assert evals[0] is not None and evals[0].relevance == 3


# ---- classify_relation ----


def test_classify_relation_returns_parsed_object():
    body = _groq_body(
        json.dumps({"relation": "extends", "confidence": 0.8, "rationale": "同じ課題を別領域へ適用"})
    )
    provider = GroqProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.groq_provider.request_with_retry",
        return_value=_resp(200, body),
    ) as mock:
        rc = provider.classify_relation(
            {"title": "A", "year": 2020, "abstract": "first"},
            {"title": "B", "year": 2024, "abstract": "applied"},
        )
    assert rc is not None
    assert rc.relation == "extends"
    assert rc.confidence == 0.8
    assert rc.rationale.startswith("同じ課題")

    # Groq's native JSON mode must be requested so the model returns a single
    # object — this is the main reason we use Groq for this task.
    sent_body = mock.call_args.kwargs["json_body"]
    assert sent_body.get("response_format") == {"type": "json_object"}


def test_classify_relation_rejects_invalid_relation():
    body = _groq_body(
        json.dumps({"relation": "bogus", "confidence": 0.5, "rationale": "x"})
    )
    provider = GroqProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.groq_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        rc = provider.classify_relation({"title": "A"}, {"title": "B"})
    assert rc is None


def test_classify_relation_api_failure_returns_none():
    provider = GroqProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.groq_provider.request_with_retry",
        return_value=_resp(500),
    ):
        rc = provider.classify_relation({"title": "A"}, {"title": "B"})
    assert rc is None

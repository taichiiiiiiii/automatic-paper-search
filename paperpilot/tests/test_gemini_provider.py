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
    assert evals[0] is not None and evals[0].relevance == 4
    assert evals[1] is not None and evals[1].relevance == 2

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
    assert evals[0] is not None
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


# ---- classify_relation (lineage) ----


def test_classify_relation_returns_parsed_object():
    body = _gemini_body(
        json.dumps({"relation": "successor", "confidence": 0.7, "rationale": "後続研究"})
    )
    provider = GeminiProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.gemini_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        rc = provider.classify_relation(
            {"title": "A", "year": 2020, "abstract": "x"},
            {"title": "B", "year": 2024, "abstract": "y"},
        )
    assert rc is not None
    assert rc.relation == "successor"
    assert rc.confidence == 0.7


def test_classify_relation_api_failure_returns_none():
    provider = GeminiProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.gemini_provider.request_with_retry",
        return_value=_resp(500),
    ):
        rc = provider.classify_relation({"title": "A"}, {"title": "B"})
    assert rc is None


def test_classify_relation_rejects_invalid_relation():
    body = _gemini_body(
        json.dumps({"relation": "nonsense", "confidence": 0.5, "rationale": "x"})
    )
    provider = GeminiProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.gemini_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        rc = provider.classify_relation({"title": "A"}, {"title": "B"})
    assert rc is None


# ---- #209 / PR-D: rate limit + circuit breaker ----


def test_rate_limit_default_rpm_matches_paid_tier1():
    """Default 250 RPM = 240 ms spacing — fits paid Tier 1 (300 RPM)
    with 17% headroom. Pin the default so a careless edit doesn't
    silently re-introduce the free-tier 8 RPM throttle."""
    provider = GeminiProvider({"enabled": True}, api_key="k")
    assert provider._min_call_interval_s == 60.0 / 250


def test_rate_limit_respects_config_override():
    """Operators on the free tier (10 RPM) override via
    `rate_limit_rpm: 8` to stay under the cap."""
    provider = GeminiProvider(
        {"enabled": True, "rate_limit_rpm": 8}, api_key="k"
    )
    assert provider._min_call_interval_s == 60.0 / 8


def test_rate_limit_handles_zero_rpm_safely():
    """Misconfigured rate_limit_rpm=0 → fall back to the default
    rather than divide-by-zero."""
    provider = GeminiProvider(
        {"enabled": True, "rate_limit_rpm": 0}, api_key="k"
    )
    assert provider._min_call_interval_s == 60.0 / 250


def test_circuit_breaker_latches_after_consecutive_failures():
    """Three consecutive non-200 responses latch ``_quota_exhausted``
    so subsequent calls short-circuit to None without hitting the
    API. Mirrors GroqProvider's #191 behaviour."""
    provider = GeminiProvider({"enabled": True}, api_key="k")
    with patch(
        "paperpilot.llm.gemini_provider.request_with_retry",
        return_value=_resp(429),
    ) as mock_req:
        for _ in range(3):
            provider.classify_relation({"title": "A"}, {"title": "B"})
        assert provider._quota_exhausted is True
        # Fourth call must NOT hit the API.
        before_count = mock_req.call_count
        result = provider.classify_relation({"title": "X"}, {"title": "Y"})
        assert result is None
        assert mock_req.call_count == before_count, (
            "Circuit breaker should short-circuit without calling request_with_retry"
        )


def test_circuit_breaker_resets_on_success():
    """A successful 200 response resets the failure counter, so an
    isolated 429 doesn't poison the rest of the build."""
    success_body = _gemini_body(
        json.dumps({"relation": "extends", "confidence": 0.8, "rationale": "ok"})
    )
    provider = GeminiProvider({"enabled": True}, api_key="k")
    responses = iter([_resp(429), _resp(429), _resp(200, success_body)])
    with patch(
        "paperpilot.llm.gemini_provider.request_with_retry",
        side_effect=lambda *a, **kw: next(responses),
    ):
        provider.classify_relation({"title": "A"}, {"title": "B"})
        provider.classify_relation({"title": "C"}, {"title": "D"})
        # Failures = 2 (under threshold) → next success resets.
        provider.classify_relation({"title": "E"}, {"title": "F"})
    assert provider._consecutive_failures == 0
    assert provider._quota_exhausted is False


def test_first_call_does_not_sleep():
    """No prior call → throttle returns immediately (no sleep)."""
    import time as _time

    provider = GeminiProvider({"enabled": True}, api_key="k")
    t0 = _time.monotonic()
    provider._throttle_for_rate_limit()
    elapsed = _time.monotonic() - t0
    # 240 ms is the spacing; first call must complete in < 50 ms.
    assert elapsed < 0.05


def test_default_model_is_gemini_2_5_flash():
    """Pin the production default. Operators on free tier may want to
    swap to gemini-1.5-flash via config; the default tracks the
    swap target."""
    provider = GeminiProvider({"enabled": True}, api_key="k")
    assert provider.model == "gemini-2.5-flash"

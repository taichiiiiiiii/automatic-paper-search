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


# ---- Rate limiter (#129) ----
# Groq free tier is 30 RPM. PaperPilot's build_theme_lineage in
# --llm-strict=all fires ~40 classify_relation calls in a tight loop,
# so without a built-in interval the second half of the burst silently
# 429s and falls back to heuristic templates. The provider sleeps to
# stay under the limit; tests below pin the sleep behaviour without
# burning real wall-clock time (time.monotonic + time.sleep are mocked).


def test_groq_provider_rate_limits_consecutive_calls(monkeypatch):
    """Two back-to-back calls must trigger a sleep between them so the
    second one doesn't exceed the per-minute budget. ``_chat`` is the
    natural place to hook the throttle because both `evaluate_batch` and
    `classify_relation` flow through it."""
    sleeps: list[float] = []
    # Use a manually-advanced clock so we can pin exactly how long the
    # rate limiter thinks has elapsed between calls — using real
    # time.monotonic would make this test order-dependent and flaky.
    times = iter([0.0, 0.0, 0.0, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2])
    monkeypatch.setattr("paperpilot.llm.groq_provider.time.monotonic",
                        lambda: next(times, 0.0))
    monkeypatch.setattr("paperpilot.llm.groq_provider.time.sleep",
                        lambda s: sleeps.append(s))

    provider = GroqProvider({"enabled": True}, api_key="k")
    body = _groq_body("hi")
    with patch(
        "paperpilot.llm.groq_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        provider._chat("sys", "u1")
        provider._chat("sys", "u2")
        provider._chat("sys", "u3")

    # 3 calls, first one no wait (no prior call), 2nd and 3rd should
    # each sleep enough to maintain the configured RPM budget.
    assert len(sleeps) == 2, f"expected 2 sleeps, got {sleeps}"
    # 25 RPM default → min interval ~2.4s; clock advanced 0.1s between
    # calls so each sleep should be ~2.3s.
    for s in sleeps:
        assert s > 2.0, f"sleep was too short: {s}s (expected ~2.4)"


def test_groq_provider_no_sleep_when_interval_already_elapsed(monkeypatch):
    """If the previous call was far enough in the past, no sleep is
    needed — the provider must not introduce dead time when the rate
    limit isn't binding.

    The throttle calls monotonic once on first call (initial stamp) and
    twice per subsequent call (elapsed check + post-stamp), so a 2-call
    test consumes 3 clock readings total.
    """
    sleeps: list[float] = []
    # Clock jumps 10s between calls — well past the 2.4s min interval.
    times = iter([0.0, 10.0, 10.0])
    monkeypatch.setattr("paperpilot.llm.groq_provider.time.monotonic",
                        lambda: next(times, 999.0))
    monkeypatch.setattr("paperpilot.llm.groq_provider.time.sleep",
                        lambda s: sleeps.append(s))

    provider = GroqProvider({"enabled": True}, api_key="k")
    body = _groq_body("hi")
    with patch(
        "paperpilot.llm.groq_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        provider._chat("sys", "u1")
        provider._chat("sys", "u2")
    assert sleeps == []


def test_groq_provider_rate_limit_configurable(monkeypatch):
    """The RPM budget must be configurable so an operator on a paid plan
    (1000+ RPM) doesn't pay the throttle tax. Default is conservative
    (25 RPM) for the free tier."""
    sleeps: list[float] = []
    # Clock advances 0s — every call would be back-to-back without sleep.
    monkeypatch.setattr("paperpilot.llm.groq_provider.time.monotonic", lambda: 0.0)
    monkeypatch.setattr("paperpilot.llm.groq_provider.time.sleep",
                        lambda s: sleeps.append(s))

    # 1000 RPM → 0.06s interval → trivially small sleep.
    provider = GroqProvider(
        {"enabled": True, "rate_limit_rpm": 1000}, api_key="k"
    )
    body = _groq_body("hi")
    with patch(
        "paperpilot.llm.groq_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        provider._chat("sys", "u1")
        provider._chat("sys", "u2")
    # Sleep happens but is tiny — pin that it's < 0.1s.
    assert len(sleeps) == 1
    assert sleeps[0] < 0.1


def test_groq_provider_no_throttle_for_first_call(monkeypatch):
    """Sanity: the very first call should never sleep because there's no
    'previous call' to space against."""
    sleeps: list[float] = []
    monkeypatch.setattr("paperpilot.llm.groq_provider.time.monotonic", lambda: 5.0)
    monkeypatch.setattr("paperpilot.llm.groq_provider.time.sleep",
                        lambda s: sleeps.append(s))

    provider = GroqProvider({"enabled": True}, api_key="k")
    body = _groq_body("hi")
    with patch(
        "paperpilot.llm.groq_provider.request_with_retry",
        return_value=_resp(200, body),
    ):
        provider._chat("sys", "u1")
    assert sleeps == []

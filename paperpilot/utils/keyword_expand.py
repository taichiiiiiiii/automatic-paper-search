"""LLM-backed keyword expansion.

Wraps any `AbstractLLMProvider` to generate synonyms / near-synonyms for
the user's search keywords, improving arXiv recall (e.g. "RAG" picks up
"retrieval augmented generation", "dense retrieval"). Runs once at the
start of a `collector expand-keywords` invocation and writes the merged
list back to `config.yaml`.

Fail-Safe: provider unavailable / invalid JSON / empty list all fall
back to the original keywords.
"""

from __future__ import annotations

from typing import Any

from .json_parser import parse_llm_response
from .logger import get_logger

logger = get_logger(__name__)

_SYSTEM_PROMPT = """\
あなたは学術論文の検索クエリ最適化アシスタントです。
与えられたキーワードに対し、同義語・略語・関連用語を英語で提案してください。

## 出力形式（厳守）
- JSON配列のみを返してください
- マークダウンのバッククォートは絶対に含めないでください
- 各要素は文字列（キーワード1つ）
- 最大15個まで
"""

_USER_TEMPLATE = """\
## 入力キーワード
{keywords}

## 研究分野
{domain}

上記のキーワードに対する同義語・略語・関連用語を JSON 配列で返してください。
"""


def expand_keywords(
    keywords: list[str],
    provider: Any,
    max_expansions: int = 10,
    domain: str = "AI / machine learning research",
) -> list[str]:
    """Return the original keywords plus up to `max_expansions` LLM suggestions.

    Parameters are loose-typed so callers can pass any object with
    `.enabled` and compatible `_chat`-like method; the util isolates the
    provider-specific shape behind `_call_provider`.
    """
    if not keywords:
        return []

    if provider is None or not getattr(provider, "enabled", False):
        # Issue #45: silent fallback masked Groq quota exhaustion during bulk
        # theme generation. Surface this at WARNING so downstream pipelines
        # (e.g. build_theme_lineage) can detect a degraded run.
        logger.warning(
            "keyword_expand: provider unavailable — using fallback (originals only)"
        )
        return list(keywords)

    try:
        raw = _call_provider(provider, keywords, domain)
    except Exception as e:
        logger.warning("keyword_expand: provider raised — using fallback: %s", e)
        return list(keywords)

    if not raw:
        logger.warning(
            "keyword_expand: LLM returned empty response — using fallback (originals only)"
        )
        return list(keywords)

    parsed = parse_llm_response(raw)
    if not isinstance(parsed, list):
        logger.warning(
            "keyword_expand: LLM returned non-list (%s) — using fallback",
            type(parsed).__name__,
        )
        return list(keywords)

    # Dedup case-insensitively, preserve first-seen casing.
    seen_lower: set[str] = set()
    merged: list[str] = []
    for kw in keywords:
        key = kw.strip().lower()
        if key and key not in seen_lower:
            seen_lower.add(key)
            merged.append(kw.strip())

    added = 0
    for item in parsed:
        if added >= max_expansions:
            break
        if not isinstance(item, str):
            continue
        text = item.strip()
        if not text:
            continue
        key = text.lower()
        if key in seen_lower:
            continue
        seen_lower.add(key)
        merged.append(text)
        added += 1

    if added == 0:
        # Same length out as in: LLM returned only duplicates / nothing
        # usable. Worth flagging — bulk theme runs lose seed diversity here.
        logger.warning(
            "keyword_expand: no new keywords added (%d returned, all duplicates) — "
            "seed discovery quality may be degraded",
            len(parsed),
        )
    logger.info("keyword_expand: %d -> %d keywords", len(keywords), len(merged))
    return merged


def _call_provider(provider: Any, keywords: list[str], domain: str) -> str | None:
    """Translate a provider-agnostic request into whatever the backend offers.

    We try the private `_chat` (Ollama), then `_messages` (Claude), then
    `_generate` (Gemini). Each returns `str | None`. If none match we
    bail out — the util stays provider-agnostic but concrete providers
    must expose at least one of these.
    """
    user = _USER_TEMPLATE.format(
        keywords="\n".join(f"- {k}" for k in keywords), domain=domain
    )
    for method_name in ("_chat", "_messages", "_generate"):
        method = getattr(provider, method_name, None)
        if callable(method):
            try:
                result = method(_SYSTEM_PROMPT, user)
            except TypeError:
                continue
            if isinstance(result, str) or result is None:
                return result
    logger.warning("keyword_expand: provider has no usable chat method")
    return None

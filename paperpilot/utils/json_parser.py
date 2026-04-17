"""Robust LLM JSON output parser (design doc §4.5.2).

Three-step fallback:
    Step 1: direct json.loads()
    Step 2: strip markdown code fences (```json ... ```) and retry
    Step 3: regex-extract the first JSON array in the text and retry

Returns the parsed object on success, or None if all steps fail. The
caller decides whether to retry the LLM call or skip the batch.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .logger import get_logger

logger = get_logger(__name__)

_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)
_JSON_ARRAY_RE = re.compile(r"\[\s*\{.*\}\s*\]", re.DOTALL)
_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)


def parse_llm_response(text: str) -> Any | None:
    """Try three strategies to parse an LLM response into JSON."""
    if text is None:
        return None
    s = text.strip()
    if not s:
        return None

    # Step 1: direct parse
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass

    # Step 2: strip markdown fences
    cleaned = _CODE_FENCE_RE.sub("", s).strip()
    if cleaned != s:
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            pass

    # Step 3: extract the first JSON array/object substring
    for pattern in (_JSON_ARRAY_RE, _JSON_OBJECT_RE):
        match = pattern.search(s)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                continue

    logger.error("json_parser: all 3 strategies failed for: %s", s[:200])
    return None

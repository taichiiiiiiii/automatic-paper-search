"""json_parser — 3-step fallback parse tests."""

from __future__ import annotations

from paperpilot.utils.json_parser import parse_llm_response


def test_direct_json_array():
    text = '[{"relevance": 5}, {"relevance": 3}]'
    out = parse_llm_response(text)
    assert out == [{"relevance": 5}, {"relevance": 3}]


def test_markdown_code_fence_stripped():
    text = "```json\n[{\"a\": 1}]\n```"
    out = parse_llm_response(text)
    assert out == [{"a": 1}]


def test_markdown_code_fence_no_language():
    text = "```\n{\"a\": 1}\n```"
    out = parse_llm_response(text)
    assert out == {"a": 1}


def test_embedded_array_extracted():
    text = 'Here is the result: [{"x": 1}, {"x": 2}] — hope this helps!'
    out = parse_llm_response(text)
    assert out == [{"x": 1}, {"x": 2}]


def test_embedded_object_extracted_when_no_array():
    text = 'The answer is {"k": "v"} trust me'
    out = parse_llm_response(text)
    assert out == {"k": "v"}


def test_unparseable_returns_none():
    assert parse_llm_response("not json at all") is None


def test_empty_returns_none():
    assert parse_llm_response("") is None
    assert parse_llm_response(None) is None

/**
 * Port of `paperpilot/tests/test_json_parser.py`.
 */
import { expect, it } from "vitest";
import { parseLlmResponse } from "../../src/collect/jsonParser.js";

it("test_direct_json_array", () => {
  const text = '[{"relevance": 5}, {"relevance": 3}]';
  expect(parseLlmResponse(text)).toEqual([{ relevance: 5 }, { relevance: 3 }]);
});

it("test_markdown_code_fence_stripped", () => {
  const text = '```json\n[{"a": 1}]\n```';
  expect(parseLlmResponse(text)).toEqual([{ a: 1 }]);
});

it("test_markdown_code_fence_no_language", () => {
  const text = '```\n{"a": 1}\n```';
  expect(parseLlmResponse(text)).toEqual({ a: 1 });
});

it("test_embedded_array_extracted", () => {
  const text = 'Here is the result: [{"x": 1}, {"x": 2}] — hope this helps!';
  expect(parseLlmResponse(text)).toEqual([{ x: 1 }, { x: 2 }]);
});

it("test_embedded_object_extracted_when_no_array", () => {
  const text = 'The answer is {"k": "v"} trust me';
  expect(parseLlmResponse(text)).toEqual({ k: "v" });
});

it("test_unparseable_returns_none", () => {
  expect(parseLlmResponse("not json at all")).toBeNull();
});

it("test_empty_returns_none", () => {
  expect(parseLlmResponse("")).toBeNull();
  expect(parseLlmResponse(null)).toBeNull();
});

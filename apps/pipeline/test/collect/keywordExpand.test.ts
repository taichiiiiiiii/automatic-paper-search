/**
 * Port of `paperpilot/tests/test_keyword_expand.py`.
 *
 * ADAPTED: Python's `_call_provider` probes `_chat`/`_messages`/`_generate`
 * in turn (whichever the concrete provider happens to expose);
 * `llm/provider.ts` collapses that into a single `chat()` method every
 * provider implements (see its doc comment), so the probe-fallback tests
 * (`test_call_provider_falls_through_to_*`, `_skips_method_with_wrong_
 * signature`, `_returns_none_when_no_method`) have no TS analogue — one
 * test below (`test_call_provider_uses_chat_first`) is kept, adapted to
 * confirm `chat()` receives the expected `(system, user)` arguments.
 */
import { expect, it, vi } from "vitest";
import { expandKeywords } from "../../src/collect/keywordExpand.js";
import type { LLMProvider } from "../../src/collect/llm/provider.js";

function fakeProvider(chat: LLMProvider["chat"]): LLMProvider {
  return {
    name: "fake",
    enabled: true,
    batchSize: 5,
    async evaluateBatch() {
      return [];
    },
    chat,
  };
}

it("test_expand_keywords_returns_merged_list", async () => {
  const provider = fakeProvider(
    async () => '["retrieval augmented generation", "dense retrieval", "RAG"]',
  );
  const expanded = await expandKeywords(["RAG"], provider, { maxExpansions: 5 });
  expect(expanded).toContain("RAG");
  expect(expanded).toContain("retrieval augmented generation");
  expect(expanded).toContain("dense retrieval");
  expect(expanded.length).toBeLessThanOrEqual(6);
});

it("test_expand_keywords_respects_max_expansions", async () => {
  const provider = fakeProvider(async () => '["a", "b", "c", "d", "e", "f"]');
  const expanded = await expandKeywords(["x"], provider, { maxExpansions: 3 });
  expect(expanded.length).toBe(4);
});

it("test_expand_keywords_disabled_provider_returns_original", async () => {
  expect(await expandKeywords(["rag"], null, { maxExpansions: 5 })).toEqual(["rag"]);
});

it("test_expand_keywords_dedup_case_insensitive", async () => {
  const provider = fakeProvider(async () => '["rag", "Retrieval Augmented Generation"]');
  const expanded = await expandKeywords(["RAG"], provider, { maxExpansions: 5 });
  const lowered = expanded.map((k) => k.toLowerCase());
  expect(new Set(lowered).size).toBe(lowered.length);
});

it("test_expand_keywords_provider_returns_invalid_json", async () => {
  const provider = fakeProvider(async () => "not json");
  expect(await expandKeywords(["rag"], provider, { maxExpansions: 5 })).toEqual(["rag"]);
});

it("test_expand_keywords_empty_input", async () => {
  expect(await expandKeywords([], null, { maxExpansions: 5 })).toEqual([]);
});

it("test_expand_keywords_warns_when_provider_unavailable", async () => {
  const warnings: string[] = [];
  await expandKeywords(["rag"], null, {
    maxExpansions: 5,
    logger: { warn: (m) => warnings.push(m), info: () => {} },
  });
  expect(
    warnings.some(
      (m) => m.includes("provider unavailable") || m.toLowerCase().includes("fallback"),
    ),
  ).toBe(true);
});

it("test_expand_keywords_warns_when_provider_returns_empty", async () => {
  const provider = fakeProvider(async () => null);
  const warnings: string[] = [];
  await expandKeywords(["rag"], provider, {
    maxExpansions: 5,
    logger: { warn: (m) => warnings.push(m), info: () => {} },
  });
  expect(
    warnings.some((m) => m.toLowerCase().includes("empty") || m.toLowerCase().includes("fallback")),
  ).toBe(true);
});

it("test_expand_keywords_no_warning_on_successful_expansion", async () => {
  const provider = fakeProvider(async () => '["retrieval", "dense retrieval"]');
  const warnings: string[] = [];
  await expandKeywords(["rag"], provider, {
    maxExpansions: 5,
    logger: { warn: (m) => warnings.push(m), info: () => {} },
  });
  const fallbackMsgs = warnings.filter(
    (m) => m.toLowerCase().includes("fallback") || m.toLowerCase().includes("unavailable"),
  );
  expect(fallbackMsgs).toEqual([]);
});

it("test_expand_keywords_warns_when_no_new_keywords_added", async () => {
  const provider = fakeProvider(async () => '["RAG", "rag"]');
  const warnings: string[] = [];
  const out = await expandKeywords(["rag"], provider, {
    maxExpansions: 5,
    logger: { warn: (m) => warnings.push(m), info: () => {} },
  });
  expect(out).toEqual(["rag"]);
  expect(
    warnings.some(
      (m) => m.toLowerCase().includes("no new keywords") || m.toLowerCase().includes("fallback"),
    ),
  ).toBe(true);
});

it("test_expand_keywords_provider_raises_returns_original", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("LLM exploded");
  });
  expect(await expandKeywords(["rag"], provider, { maxExpansions: 5 })).toEqual(["rag"]);
});

it("test_expand_keywords_empty_llm_response_returns_original", async () => {
  const provider = fakeProvider(async () => null);
  expect(await expandKeywords(["rag"], provider, { maxExpansions: 5 })).toEqual(["rag"]);
});

it("test_expand_keywords_json_non_list_returns_original", async () => {
  const provider = fakeProvider(async () => '{"not": "a list"}');
  expect(await expandKeywords(["rag"], provider, { maxExpansions: 5 })).toEqual(["rag"]);
});

it("test_expand_keywords_skips_non_string_and_empty_items", async () => {
  const provider = fakeProvider(
    async () => '["retrieval", 42, null, "", "   ", "retrieval", "dense"]',
  );
  const out = await expandKeywords(["rag"], provider, { maxExpansions: 10 });
  expect(out).toEqual(["rag", "retrieval", "dense"]);
});

it("test_call_provider_uses_chat_first (adapted)", async () => {
  const chat = vi.fn(async (system: string, user: string) => {
    expect(system).toContain("同義語");
    expect(user).toContain("rag");
    return '["retrieval"]';
  });
  const provider = fakeProvider(chat);
  await expandKeywords(["rag"], provider, { maxExpansions: 5 });
  expect(chat).toHaveBeenCalledOnce();
});

/**
 * Port of `paperpilot/tests/test_runner.py`'s
 * `test_build_llm_provider_ollama/gemini/groq/claude` — exercised directly
 * against `buildLlmProviderFromConfig` here (dispatch + field mapping +
 * env wiring); `runner.test.ts` separately proves `PipelineRunner` itself
 * calls through `RunnerDeps.llmProviderFactory` correctly.
 */
import { expect, it } from "vitest";
import type { Env } from "../../../src/collect/config/env.js";
import type { LlmConfig } from "../../../src/collect/config/types.js";
import type { HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { buildLlmProviderFromConfig } from "../../../src/collect/runtime/llmProvider.js";
import { ClaudeProvider } from "../../../src/lineage/llm/claude.js";
import { GeminiProvider } from "../../../src/lineage/llm/gemini.js";
import { GroqProvider } from "../../../src/lineage/llm/groq.js";
import { OllamaProvider } from "../../../src/lineage/llm/ollama.js";

function emptyEnv(overrides: Partial<Env> = {}): Env {
  return {
    githubToken: null,
    s2ApiKey: null,
    openalexEmail: null,
    slackWebhookUrl: null,
    geminiApiKey: null,
    claudeApiKey: null,
    groqApiKey: null,
    groqModel: null,
    geminiModel: null,
    smtp: { server: null, port: 587, user: null, password: null, to: null, useTls: true },
    ...overrides,
  };
}

const fetchImpl = async (): Promise<HttpResponseLike> => ({ status: 200, json: async () => ({}) });

it("test_build_llm_provider_ollama", () => {
  const llmCfg: LlmConfig = { enabled: true, provider: "ollama", model: "qwen2.5:7b" };
  const provider = buildLlmProviderFromConfig(llmCfg, emptyEnv(), { fetchImpl });
  expect(provider).toBeInstanceOf(OllamaProvider);
  expect(provider?.model).toBe("qwen2.5:7b");
});

it("test_build_llm_provider_gemini", () => {
  const llmCfg: LlmConfig = { enabled: true, provider: "gemini" };
  const provider = buildLlmProviderFromConfig(llmCfg, emptyEnv({ geminiApiKey: "k" }), {
    fetchImpl,
  });
  expect(provider).toBeInstanceOf(GeminiProvider);
  expect(provider?.enabled).toBe(true); // api key wired through
});

it("test_build_llm_provider_groq", () => {
  const llmCfg: LlmConfig = { enabled: true, provider: "groq" };
  const provider = buildLlmProviderFromConfig(llmCfg, emptyEnv({ groqApiKey: "gsk_k" }), {
    fetchImpl,
  });
  expect(provider).toBeInstanceOf(GroqProvider);
  expect(provider?.enabled).toBe(true);
});

it("test_build_llm_provider_claude", () => {
  const llmCfg: LlmConfig = { enabled: true, provider: "claude" };
  const provider = buildLlmProviderFromConfig(llmCfg, emptyEnv({ claudeApiKey: "sk-ant-k" }), {
    fetchImpl,
  });
  expect(provider).toBeInstanceOf(ClaudeProvider);
  expect(provider?.enabled).toBe(true);
});

it("test_build_llm_provider_unknown_returns_none", () => {
  const llmCfg: LlmConfig = { enabled: true, provider: "bogus-vendor" };
  const provider = buildLlmProviderFromConfig(llmCfg, emptyEnv(), { fetchImpl });
  expect(provider).toBeNull();
});

it("provider name match is case-insensitive (config.yaml comment allows either case)", () => {
  const llmCfg: LlmConfig = { enabled: true, provider: "GROQ" };
  const provider = buildLlmProviderFromConfig(llmCfg, emptyEnv({ groqApiKey: "gsk_k" }), {
    fetchImpl,
  });
  expect(provider).toBeInstanceOf(GroqProvider);
});

it("missing API key still constructs the provider, but .enabled is false (auto-disable, not a thrown error)", () => {
  const llmCfg: LlmConfig = { enabled: true, provider: "gemini" };
  const provider = buildLlmProviderFromConfig(llmCfg, emptyEnv(), { fetchImpl });
  expect(provider).toBeInstanceOf(GeminiProvider);
  expect(provider?.enabled).toBe(false);
});

it("config fields (batch_size/temperature/timeout_seconds/host) pass through to the concrete provider", () => {
  const llmCfg: LlmConfig = {
    enabled: true,
    provider: "ollama",
    model: "llama3.1:8b",
    batch_size: 3,
    host: "http://example.local:11434",
    temperature: 0.7,
    timeout_seconds: 42,
  };
  const provider = buildLlmProviderFromConfig(llmCfg, emptyEnv(), { fetchImpl });
  expect(provider).toBeInstanceOf(OllamaProvider);
  expect(provider?.batchSize).toBe(3);
});

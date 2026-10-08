/**
 * Real Stage 4 LLM provider construction — TS port of
 * `paperpilot/pipeline/runner.py::PipelineRunner._build_llm_provider`'s
 * dispatch (#26/#29 of docs/migration/p4-followups.md, COL-26 of
 * docs/migration/safety-contracts.md).
 *
 * DECISION: this does NOT reuse `lineage/shared/providerFactory.ts`'s
 * `buildProvider` (even though it is the one already-ported "pick an LLM
 * provider" function in this codebase). That function solves a different
 * problem with different semantics: it AUTO-selects Groq-then-Gemini by
 * which API key happens to be present (optionally overridden by the
 * ambient `PAPERPILOT_LLM_PROVIDER` var), throws when no key is found, and
 * hardcodes temperature/timeout for the lineage-classification workload.
 * `collect`'s Stage 4 instead mirrors `_build_llm_provider` exactly:
 * `config.llm.provider` (an EXPLICIT, case-insensitive name the operator
 * wrote in config.yaml) selects the concrete class — ollama/gemini/claude/
 * groq — every config field passes straight through, the matching `.env`
 * secret is read, an unrecognized name returns `null` (never throws) so
 * the caller (`PipelineRunner.buildLlmProvider`) can keep reporting
 * `unknown LLM provider '<name>'` exactly as it already did pre-#26, and a
 * missing API key does not short-circuit here either — the provider is
 * still constructed and its own `enabled` getter (`flag && !!apiKey`)
 * reports `false`, matching Python's `ClaudeProvider.enabled` /
 * `GeminiProvider.enabled` / `GroqProvider.enabled` auto-disable.
 *
 * The concrete provider classes (GroqProvider/GeminiProvider/
 * ClaudeProvider/OllamaProvider) are imported from the concurrently-ported
 * `apps/pipeline/src/lineage/llm/` per this task's brief — `lineage/**` is
 * the one directory this task may import from (not edit). There is no
 * import-cycle risk: `lineage/llm/*` only imports from `collect/llm`,
 * `collect/http`, `collect/model`, `collect/jsonParser` — never from
 * `collect/runtime` — so this stays a one-way edge
 * (`collect/runtime -> lineage/llm -> collect/llm`).
 */

// Sanctioned cross-import (see module doc): concrete providers live under
// the concurrently-ported lineage/llm/, not duplicated here.
import { ClaudeProvider } from "../../lineage/llm/claude.js";
import { GeminiProvider } from "../../lineage/llm/gemini.js";
import { GroqProvider } from "../../lineage/llm/groq.js";
import { OllamaProvider } from "../../lineage/llm/ollama.js";
import type { Env } from "../config/env.js";
import type { LlmConfig } from "../config/types.js";
import type { FetchLike } from "../http/requestWithRetry.js";
import type { LLMProvider } from "../llm/provider.js";

export interface LlmProviderFactoryDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn: (msg: string) => void };
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Builds the concrete provider `llmCfg.provider` names, or `null` for an
 * unrecognized/empty name. Only called once the caller has already
 * confirmed `llmCfg.enabled` is truthy (matches `_build_llm_provider`'s
 * own early `if not llm_cfg.get("enabled"): return None` guard, which
 * runs before this dispatch in Python too).
 */
export function buildLlmProviderFromConfig(
  llmCfg: LlmConfig,
  env: Env,
  deps: LlmProviderFactoryDeps,
): LLMProvider | null {
  const providerName = String(llmCfg.provider ?? "").toLowerCase();
  const common = {
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
    now: deps.now,
    logger: deps.logger,
  };
  const enabled = llmCfg.enabled ?? true;
  const batchSize = llmCfg.batch_size;
  const model = llmCfg.model;
  const temperature = asNumber(llmCfg.temperature);
  const timeoutSeconds = asNumber(llmCfg.timeout_seconds);

  switch (providerName) {
    case "ollama":
      return new OllamaProvider(
        { enabled, batchSize, model, host: asString(llmCfg.host), temperature, timeoutSeconds },
        common,
      );
    case "gemini":
      return new GeminiProvider(
        { enabled, batchSize, model, temperature, timeoutSeconds },
        env.geminiApiKey,
        common,
      );
    case "claude":
      return new ClaudeProvider(
        {
          enabled,
          batchSize,
          model,
          temperature,
          maxTokens: asNumber(llmCfg.max_tokens),
          timeoutSeconds,
        },
        env.claudeApiKey,
        common,
      );
    case "groq":
      return new GroqProvider(
        {
          enabled,
          batchSize,
          model,
          temperature,
          timeoutSeconds,
          rateLimitRpm: asNumber(llmCfg.rate_limit_rpm),
        },
        env.groqApiKey,
        common,
      );
    default:
      return null;
  }
}

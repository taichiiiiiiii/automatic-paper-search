/**
 * LLM provider selection for the lineage builders — TS port of
 * `paperpilot/scripts/build_lineage.py::build_provider` (LLM-44: no key
 * found -> `RuntimeError`, which the CLI turns into exit 3; never
 * `sys.exit` directly, so this stays safe to call from a non-CLI host).
 *
 * Consolidated per docs/migration/p4-followups.md #23: this used to be a
 * local, scoped copy inside `apps/pipeline/src/lineage/theme/
 * providerFactory.ts` (`build_theme_lineage.py` imports and calls
 * `build_provider` directly), because the P4d task that ported
 * `build_lineage.py`'s conference/ICLR builder and the one that ported
 * the theme builder had non-overlapping edit scopes. The conference and
 * deep builders' own CLIs (`buildLineageCli.ts`, `buildDeepLineageCli.ts`)
 * already called this same function via `../theme/providerFactory.js` —
 * that reverse dependency (conference/deep reaching into theme/ for
 * logic that was never theme-specific) is what this move fixes.
 */

import type { Env } from "../../collect/config/env.js";
import type { FetchLike } from "../../collect/http/requestWithRetry.js";
import type { LLMProvider } from "../../collect/llm/provider.js";
import { FallbackProvider } from "../llm/fallback.js";
import { GEMINI_DEFAULT_MODEL, GeminiProvider } from "../llm/gemini.js";
import { GroqProvider } from "../llm/groq.js";

const LLM_RATE_DELAY: Readonly<Record<"groq" | "gemini", number>> = {
  groq: 2.2, // ~27 RPM (Groq free tier: 30 RPM)
  gemini: 7.0, // ~8 RPM (Gemini 2.5-flash free tier: 10 RPM)
};
/** Gemini's own pacing default (the rateDelay above is not applied by every builder). */
const GEMINI_DEFAULT_RPM = 8;
/**
 * R2-20: per-run Groq token budget (per provider instance = per model;
 * the theme CLI runs one theme per process, so this is per theme). About
 * 30% of a model's 200K tokens/day free tier, so one theme cannot eat the
 * day. `PAPERPILOT_GROQ_RUN_TOKEN_BUDGET` overrides; `0` disables.
 */
export const DEFAULT_GROQ_RUN_TOKEN_BUDGET = 60_000;
/**
 * R2-20: model for the citation-context prompt (theme builder). Groq's
 * free tier lists openai/gpt-oss-20b with its own 30 RPM / 1K RPD / 8K TPM
 * / 200K TPD row, separate from gpt-oss-120b's (limits are per model;
 * https://console.groq.com/docs/rate-limits, checked 2026-10-10). The
 * context prompt is a short attribution + 4-way label question, so the
 * 20b model answers it first and the main model (120b) is the fallback.
 * `PAPERPILOT_GROQ_CONTEXT_MODEL` overrides; `off`, empty, or the main
 * model disables the routing.
 */
export const DEFAULT_GROQ_CONTEXT_MODEL = "openai/gpt-oss-20b";

function positiveNumber(raw: string | undefined): number | undefined {
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
function nonNegativeNumber(raw: string | undefined): number | undefined {
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
/** `PAPERPILOT_GROQ_REASONING_EFFORT`: unset -> provider default (`low`);
 * `off`/`none`/`default` -> omit the parameter. */
function reasoningEffortFrom(raw: string | undefined): string | null | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = raw.trim().toLowerCase();
  return v === "off" || v === "none" || v === "default" ? null : v;
}

export interface BuildProviderDeps {
  /** From `loadEnv()` (`apps/pipeline/src/collect/config/env.ts`, the
   * TS port of `paperpilot/utils/config_loader.py::load_env`). */
  env: Env;
  /** Ambient process env (unprefixed convenience vars + the runtime
   * selector `PAPERPILOT_LLM_PROVIDER`), injected rather than read from
   * `process.env` directly so tests stay hermetic. */
  ambientEnv: Readonly<Record<string, string | undefined>>;
  fetchImpl: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: { warn: (msg: string) => void };
}

export interface BuildProviderOptions {
  /**
   * R2-6 (design 41 D2): in `auto` mode, chain EVERY provider that has a
   * key — Groq first, then Gemini — in a {@link FallbackProvider} instead
   * of returning only the first. A forced `PAPERPILOT_LLM_PROVIDER` still
   * returns that one provider alone. Opt-in: the theme builder records
   * the answering provider per edge (`producedBy`); the conference/deep
   * builders stamp one provider per run and keep the single-provider
   * behaviour.
   */
  fallback?: boolean;
  /**
   * R2-20: also build {@link BuiltProvider.contextProvider}, a chain that
   * asks `PAPERPILOT_GROQ_CONTEXT_MODEL` (default gpt-oss-20b) first and
   * then the regular chain (same member instances, so latches and budgets
   * are shared). Only when Groq is in use and the model differs.
   */
  contextModelRouting?: boolean;
}

export interface BuiltProvider {
  provider: LLMProvider;
  rateDelay: number;
  /** R2-20: provider for the citation-context prompt (see `contextModelRouting`). */
  contextProvider?: LLMProvider;
}

/** Pick the first available LLM provider and return `{provider, rateDelay}`.
 *
 * Groq takes precedence (most generous free tier for the
 * hundreds-of-calls classification workload), then Gemini.
 * `PAPERPILOT_LLM_PROVIDER` (ambient env, or `env.llm_provider`) overrides
 * the precedence to force a specific backend.
 *
 * @throws {Error} no key is available for the selected/default provider,
 * or an unrecognised `PAPERPILOT_LLM_PROVIDER` value — callers (the CLI)
 * must catch this and map it to exit code 3, never let it propagate as
 * an uncaught process exit (LLM-44).
 */
export function buildProvider(
  deps: BuildProviderDeps,
  options: BuildProviderOptions = {},
): BuiltProvider {
  const built = buildMainProvider(deps, options);
  if (!options.contextModelRouting) return built;
  const groqKey = deps.env.groqApiKey || deps.ambientEnv.GROQ_API_KEY || null;
  const members =
    built.provider instanceof FallbackProvider ? [...built.provider.members] : [built.provider];
  const mainGroq = members.find((m): m is GroqProvider => m instanceof GroqProvider);
  const raw = deps.ambientEnv.PAPERPILOT_GROQ_CONTEXT_MODEL;
  const ctxModel = raw === undefined ? DEFAULT_GROQ_CONTEXT_MODEL : raw.trim();
  if (!groqKey || mainGroq === undefined || ctxModel === "" || ctxModel.toLowerCase() === "off") {
    return built;
  }
  if (ctxModel === mainGroq.model) return built;
  const ctxGroq = new GroqProvider(
    { ...groqConfigFrom(deps.ambientEnv, DEFAULT_GROQ_RUN_TOKEN_BUDGET), model: ctxModel },
    groqKey,
    { fetchImpl: deps.fetchImpl, now: deps.now, sleep: deps.sleep, logger: deps.logger },
  );
  return {
    ...built,
    contextProvider: new FallbackProvider([ctxGroq, ...members], { logger: deps.logger }),
  };
}

/** Groq settings shared by every Groq instance (env overrides; unset -> groq.ts defaults). */
function groqConfigFrom(
  ambientEnv: Readonly<Record<string, string | undefined>>,
  defaultRunTokenBudget: number | undefined,
) {
  return {
    enabled: true,
    temperature: 0.1,
    timeoutSeconds: 30,
    // Free-tier pacing overrides; unset → the model's defaults in groq.ts.
    rateLimitRpm: positiveNumber(ambientEnv.PAPERPILOT_GROQ_RPM),
    rateLimitTpm: nonNegativeNumber(ambientEnv.PAPERPILOT_GROQ_TPM),
    maxThrottleWaitSeconds: positiveNumber(ambientEnv.PAPERPILOT_GROQ_MAX_THROTTLE_WAIT_S),
    // R2-20 token controls.
    reasoningEffort: reasoningEffortFrom(ambientEnv.PAPERPILOT_GROQ_REASONING_EFFORT),
    maxCompletionTokens: nonNegativeNumber(ambientEnv.PAPERPILOT_GROQ_MAX_COMPLETION_TOKENS),
    runTokenBudget:
      nonNegativeNumber(ambientEnv.PAPERPILOT_GROQ_RUN_TOKEN_BUDGET) ?? defaultRunTokenBudget,
  };
}

function buildMainProvider(deps: BuildProviderDeps, options: BuildProviderOptions): BuiltProvider {
  const { env, ambientEnv } = deps;
  const groqKey = env.groqApiKey || ambientEnv.GROQ_API_KEY || null;
  const geminiKey = env.geminiApiKey || ambientEnv.GEMINI_API_KEY || null;

  const makeGroq = (): { provider: LLMProvider; rateDelay: number } => {
    const model = env.groqModel || "openai/gpt-oss-120b";
    const provider = new GroqProvider(
      // The default run budget is for the theme builder (one theme per
      // process, `fallback`); conference/deep runs keep no budget unless
      // the env sets one.
      {
        ...groqConfigFrom(ambientEnv, options.fallback ? DEFAULT_GROQ_RUN_TOKEN_BUDGET : undefined),
        model,
      },
      groqKey,
      { fetchImpl: deps.fetchImpl, now: deps.now, sleep: deps.sleep, logger: deps.logger },
    );
    return { provider, rateDelay: LLM_RATE_DELAY.groq };
  };
  const makeGemini = (): { provider: LLMProvider; rateDelay: number } => {
    const model = env.geminiModel || GEMINI_DEFAULT_MODEL;
    const provider = new GeminiProvider(
      {
        enabled: true,
        model,
        temperature: 0.1,
        timeoutSeconds: 30,
        rateLimitRpm: positiveNumber(ambientEnv.PAPERPILOT_GEMINI_RPM) ?? GEMINI_DEFAULT_RPM,
      },
      geminiKey,
      { fetchImpl: deps.fetchImpl, now: deps.now, sleep: deps.sleep, logger: deps.logger },
    );
    return { provider, rateDelay: LLM_RATE_DELAY.gemini };
  };

  // Python reads `env.get("llm_provider")` too, but `load_env()` never
  // populates that key (grepped: no call site sets it) — it is always
  // None there, so omitting it here is not a parity gap, just skipping
  // genuinely dead code. The ambient `PAPERPILOT_LLM_PROVIDER` var is
  // the only way this preference is actually set in practice.
  const preference = (ambientEnv.PAPERPILOT_LLM_PROVIDER || "").trim().toLowerCase();
  if (preference === "gemini" || preference === "groq") {
    const key = preference === "gemini" ? geminiKey : groqKey;
    if (!key) {
      const up = preference.toUpperCase();
      throw new Error(
        `PAPERPILOT_LLM_PROVIDER=${preference} requested but no key found ` +
          `(set PAPERPILOT_${up}_API_KEY in data/config/.env, or ${up}_API_KEY in the environment).`,
      );
    }
    return preference === "gemini" ? makeGemini() : makeGroq();
  }
  if (preference !== "" && preference !== "auto") {
    throw new Error(
      `PAPERPILOT_LLM_PROVIDER=${JSON.stringify(preference)} is not recognised (expected 'groq', 'gemini', or 'auto').`,
    );
  }

  if (options.fallback && groqKey && geminiKey) {
    const groq = makeGroq();
    const gemini = makeGemini();
    return {
      provider: new FallbackProvider([groq.provider, gemini.provider], { logger: deps.logger }),
      rateDelay: groq.rateDelay,
    };
  }
  if (groqKey) return makeGroq();
  if (geminiKey) return makeGemini();

  throw new Error(
    "No LLM key found. Set PAPERPILOT_GROQ_API_KEY (preferred) or PAPERPILOT_GEMINI_API_KEY.",
  );
}

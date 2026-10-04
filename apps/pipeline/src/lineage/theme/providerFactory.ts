/**
 * LLM provider selection for the lineage builders — TS port of
 * `paperpilot/scripts/build_lineage.py::build_provider` (LLM-44: no key
 * found -> `RuntimeError`, which the CLI turns into exit 3; never
 * `sys.exit` directly, so this stays safe to call from a non-CLI host).
 *
 * Scope note: `build_provider` belongs to `build_lineage.py` (the
 * conference/ICLR builder script), a separate P4d task from this one.
 * `build_theme_lineage.py` imports and calls it directly, so a local,
 * scoped copy lives here — same pattern as `./node.ts`'s scope note.
 * The concrete providers it constructs (`GroqProvider`/`GeminiProvider`)
 * ARE imported from the concurrently-ported `apps/pipeline/src/lineage/llm/`
 * per this task's brief.
 */

import type { Env } from "../../collect/config/env.js";
import type { FetchLike } from "../../collect/http/requestWithRetry.js";
import type { LLMProvider } from "../../collect/llm/provider.js";
import { GeminiProvider } from "../llm/gemini.js";
import { GroqProvider } from "../llm/groq.js";

const LLM_RATE_DELAY: Readonly<Record<"groq" | "gemini", number>> = {
  groq: 2.2, // ~27 RPM (Groq free tier: 30 RPM)
  gemini: 7.0, // ~8 RPM (Gemini 2.5-flash free tier: 10 RPM)
};

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
export function buildProvider(deps: BuildProviderDeps): {
  provider: LLMProvider;
  rateDelay: number;
} {
  const { env, ambientEnv } = deps;
  const groqKey = env.groqApiKey || ambientEnv.GROQ_API_KEY || null;
  const geminiKey = env.geminiApiKey || ambientEnv.GEMINI_API_KEY || null;

  const makeGroq = (): { provider: LLMProvider; rateDelay: number } => {
    const model = env.groqModel || "llama-3.3-70b-versatile";
    const provider = new GroqProvider(
      { enabled: true, model, temperature: 0.1, timeoutSeconds: 30 },
      groqKey,
      { fetchImpl: deps.fetchImpl, now: deps.now, sleep: deps.sleep, logger: deps.logger },
    );
    return { provider, rateDelay: LLM_RATE_DELAY.groq };
  };
  const makeGemini = (): { provider: LLMProvider; rateDelay: number } => {
    const model = env.geminiModel || "gemini-2.5-flash";
    const provider = new GeminiProvider(
      { enabled: true, model, temperature: 0.1, timeoutSeconds: 30 },
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
          `(set PAPERPILOT_${up}_API_KEY in paperpilot/.env, or ${up}_API_KEY in the environment).`,
      );
    }
    return preference === "gemini" ? makeGemini() : makeGroq();
  }
  if (preference !== "" && preference !== "auto") {
    throw new Error(
      `PAPERPILOT_LLM_PROVIDER=${JSON.stringify(preference)} is not recognised (expected 'groq', 'gemini', or 'auto').`,
    );
  }

  if (groqKey) return makeGroq();
  if (geminiKey) return makeGemini();

  throw new Error(
    "No LLM key found. Set PAPERPILOT_GROQ_API_KEY (preferred) or PAPERPILOT_GEMINI_API_KEY.",
  );
}

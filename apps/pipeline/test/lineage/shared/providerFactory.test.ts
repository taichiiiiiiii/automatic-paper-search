/**
 * Vitest port of `test_build_provider_*` (`paperpilot/tests/test_build_lineage.py`),
 * adapted to this module's injected-deps signature (no ambient `process.env`
 * or real network — `fetchImpl` is a stub that is never actually called by
 * these tests, since `buildProvider` itself never makes a request).
 */
import { describe, expect, it } from "vitest";
import type { Env } from "../../../src/collect/config/env.js";
import { buildProvider } from "../../../src/lineage/shared/providerFactory.js";

const neverFetch = async () => {
  throw new Error("buildProvider must not perform network I/O");
};

function mkEnv(overrides: Partial<Env> = {}): Env {
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

describe("buildProvider", () => {
  it("prefers groq when both keys are present", () => {
    const { provider, rateDelay } = buildProvider({
      env: mkEnv({ groqApiKey: "gsk_x", geminiApiKey: "gemini_y" }),
      ambientEnv: {},
      fetchImpl: neverFetch,
    });
    expect(provider.name).toBe("groq");
    expect(rateDelay).toBe(2.2);
  });

  it("falls back to gemini when groq has no key", () => {
    const { provider, rateDelay } = buildProvider({
      env: mkEnv({ geminiApiKey: "gemini_y" }),
      ambientEnv: {},
      fetchImpl: neverFetch,
    });
    expect(provider.name).toBe("gemini");
    expect(rateDelay).toBe(7.0);
  });

  it("throws when no key is available at all", () => {
    expect(() => buildProvider({ env: mkEnv(), ambientEnv: {}, fetchImpl: neverFetch })).toThrow();
  });

  it("applies a model override from env", () => {
    const { provider } = buildProvider({
      env: mkEnv({ groqApiKey: "gsk_x", groqModel: "llama-4-800b" }),
      ambientEnv: {},
      fetchImpl: neverFetch,
    });
    expect(provider.model).toBe("llama-4-800b");
  });

  it("PAPERPILOT_LLM_PROVIDER=gemini overrides the default groq-first precedence", () => {
    const { provider, rateDelay } = buildProvider({
      env: mkEnv({ groqApiKey: "gsk_x", geminiApiKey: "gemini_y" }),
      ambientEnv: { PAPERPILOT_LLM_PROVIDER: "gemini" },
      fetchImpl: neverFetch,
    });
    expect(provider.name).toBe("gemini");
    expect(rateDelay).toBe(7.0);
  });

  it("PAPERPILOT_LLM_PROVIDER=groq is accepted explicitly", () => {
    const { provider } = buildProvider({
      env: mkEnv({ groqApiKey: "gsk_x", geminiApiKey: "gemini_y" }),
      ambientEnv: { PAPERPILOT_LLM_PROVIDER: "groq" },
      fetchImpl: neverFetch,
    });
    expect(provider.name).toBe("groq");
  });

  it("throws when the override names a provider with no key", () => {
    expect(() =>
      buildProvider({
        env: mkEnv({ groqApiKey: "gsk_x" }),
        ambientEnv: { PAPERPILOT_LLM_PROVIDER: "gemini" },
        fetchImpl: neverFetch,
      }),
    ).toThrow(/GEMINI_API_KEY/);
  });

  it("throws on an unrecognised override value", () => {
    expect(() =>
      buildProvider({
        env: mkEnv({ groqApiKey: "gsk_x" }),
        ambientEnv: { PAPERPILOT_LLM_PROVIDER: "bogus" },
        fetchImpl: neverFetch,
      }),
    ).toThrow(/not recognised/);
  });

  it("'auto' falls through to the default precedence", () => {
    const { provider } = buildProvider({
      env: mkEnv({ groqApiKey: "gsk_x", geminiApiKey: "gemini_y" }),
      ambientEnv: { PAPERPILOT_LLM_PROVIDER: "auto" },
      fetchImpl: neverFetch,
    });
    expect(provider.name).toBe("groq");
  });

  it("accepts an unprefixed ambient GROQ_API_KEY fallback", () => {
    const { provider } = buildProvider({
      env: mkEnv(),
      ambientEnv: { GROQ_API_KEY: "gsk_ambient" },
      fetchImpl: neverFetch,
    });
    expect(provider.name).toBe("groq");
  });
});

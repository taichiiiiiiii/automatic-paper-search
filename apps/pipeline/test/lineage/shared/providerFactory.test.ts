/**
 * Vitest port of `test_build_provider_*` (`paperpilot/tests/test_build_lineage.py`),
 * adapted to this module's injected-deps signature (no ambient `process.env`
 * or real network — `fetchImpl` is a stub that is never actually called by
 * these tests, since `buildProvider` itself never makes a request).
 */
import { describe, expect, it } from "vitest";
import type { Env } from "../../../src/collect/config/env.js";
import { FallbackProvider } from "../../../src/lineage/llm/fallback.js";
import { GroqProvider } from "../../../src/lineage/llm/groq.js";
import {
  buildProvider,
  DEFAULT_GROQ_CONTEXT_MODEL,
  DEFAULT_GROQ_RUN_TOKEN_BUDGET,
} from "../../../src/lineage/shared/providerFactory.js";

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

describe("buildProvider — Groq pacing env overrides", () => {
  async function sleepsFor(ambientEnv: Record<string, string>): Promise<number[]> {
    let t = 0;
    const sleeps: number[] = [];
    const { provider } = buildProvider({
      env: mkEnv({ groqApiKey: "gsk_fake_for_test" }),
      ambientEnv,
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
      }),
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    await provider.chat("s", "u");
    await provider.chat("s", "u");
    return sleeps;
  }

  it("defaults gpt-oss-120b to 20 RPM", async () => {
    expect(await sleepsFor({})).toEqual([3000]);
  });

  it("PAPERPILOT_GROQ_RPM overrides the RPM", async () => {
    expect(await sleepsFor({ PAPERPILOT_GROQ_RPM: "10" })).toEqual([6000]);
  });

  it("ignores a non-numeric / non-positive PAPERPILOT_GROQ_RPM", async () => {
    expect(await sleepsFor({ PAPERPILOT_GROQ_RPM: "abc" })).toEqual([3000]);
    expect(await sleepsFor({ PAPERPILOT_GROQ_RPM: "0" })).toEqual([3000]);
  });
});

describe("buildProvider — R2-20 token controls and context-model routing", () => {
  const keys = { groqApiKey: "k-groq", geminiApiKey: "k-gem" };
  const summaryOf = (p: unknown) => (p as GroqProvider).usageSummary();

  it("routes the context prompt to gpt-oss-20b first, then the SAME main chain members", () => {
    const built = buildProvider(
      { env: mkEnv(keys), ambientEnv: {}, fetchImpl: neverFetch },
      { fallback: true, contextModelRouting: true },
    );
    const main = built.provider as FallbackProvider;
    const ctx = built.contextProvider as FallbackProvider;
    expect(ctx).toBeInstanceOf(FallbackProvider);
    expect(ctx.members.map((m) => m.model)).toEqual([
      DEFAULT_GROQ_CONTEXT_MODEL,
      "openai/gpt-oss-120b",
      "gemini-2.5-flash",
    ]);
    // Shared instances: a latch / budget on the 120b is seen by both chains.
    expect(ctx.members[1]).toBe(main.members[0]);
    expect(ctx.members[2]).toBe(main.members[1]);
    // Theme runs get the default run budget.
    expect(summaryOf(ctx.members[0])).toContain(`run_budget=0/${DEFAULT_GROQ_RUN_TOKEN_BUDGET}`);
  });

  it("PAPERPILOT_GROQ_CONTEXT_MODEL=off / the main model disables the routing", () => {
    for (const v of ["off", "", "openai/gpt-oss-120b"]) {
      const built = buildProvider(
        {
          env: mkEnv(keys),
          ambientEnv: { PAPERPILOT_GROQ_CONTEXT_MODEL: v },
          fetchImpl: neverFetch,
        },
        { fallback: true, contextModelRouting: true },
      );
      expect(built.contextProvider).toBeUndefined();
    }
  });

  it("no routing without a Groq key or without the option", () => {
    expect(
      buildProvider(
        { env: mkEnv({ geminiApiKey: "k-gem" }), ambientEnv: {}, fetchImpl: neverFetch },
        { fallback: true, contextModelRouting: true },
      ).contextProvider,
    ).toBeUndefined();
    expect(
      buildProvider({ env: mkEnv(keys), ambientEnv: {}, fetchImpl: neverFetch }, { fallback: true })
        .contextProvider,
    ).toBeUndefined();
  });

  it("run budget env override; conference/deep (no fallback option) get no default budget", () => {
    const theme = buildProvider(
      {
        env: mkEnv(keys),
        ambientEnv: { PAPERPILOT_GROQ_RUN_TOKEN_BUDGET: "12345" },
        fetchImpl: neverFetch,
      },
      { fallback: true },
    );
    expect(summaryOf((theme.provider as FallbackProvider).members[0])).toContain(
      "run_budget=0/12345",
    );
    const conf = buildProvider({ env: mkEnv(keys), ambientEnv: {}, fetchImpl: neverFetch });
    expect(summaryOf(conf.provider)).toContain("run_budget=off");
  });

  it("reasoning effort / completion cap env reach the request body", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = async (_u: string, init: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return {
        status: 200,
        headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: "{}" } }] }),
      };
    };
    const { provider } = buildProvider({
      env: mkEnv({ groqApiKey: "k-groq" }),
      ambientEnv: {
        PAPERPILOT_GROQ_REASONING_EFFORT: "medium",
        PAPERPILOT_GROQ_MAX_COMPLETION_TOKENS: "500",
      },
      fetchImpl,
      sleep: async () => {},
    });
    await provider.completeJson("s", "u");
    expect(bodies[0]?.reasoning_effort).toBe("medium");
    expect(bodies[0]?.max_completion_tokens).toBe(500);
  });
});

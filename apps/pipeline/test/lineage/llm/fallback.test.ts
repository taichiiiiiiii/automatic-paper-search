/**
 * R2-6 (design 41 D2): Groq -> Gemini fallback chain, Gemini daily-quota
 * latching, and the provider factory's opt-in chain. Mocks only.
 */
import { describe, expect, it } from "vitest";
import type { Env } from "../../../src/collect/config/env.js";
import type { HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type {
  ClassifyPaperLike,
  LLMProvider,
  LlmUsageStats,
  PaperEvaluation,
  RelationClassification,
} from "../../../src/collect/llm/provider.js";
import { FallbackProvider, usageOf } from "../../../src/lineage/llm/fallback.js";
import {
  GEMINI_DEFAULT_MODEL,
  GeminiProvider,
  isGeminiDailyQuota429,
} from "../../../src/lineage/llm/gemini.js";
import { buildProvider } from "../../../src/lineage/shared/providerFactory.js";

const CLS: RelationClassification = {
  relation: "extends",
  confidence: 0.9,
  rationale: "B は A のグラフ畳み込みを空間領域へ拡張している",
};

class Stub implements LLMProvider {
  enabled = true;
  batchSize = 1;
  calls = 0;
  exhausted = false;
  constructor(
    readonly name: string,
    readonly model: string,
    private readonly answers: (RelationClassification | null)[],
    private readonly latchAfter: number | null = null,
  ) {}
  async evaluateBatch(): Promise<(PaperEvaluation | null)[]> {
    return [];
  }
  async chat(): Promise<string | null> {
    return null;
  }
  async completeJson(): Promise<string | null> {
    return null;
  }
  async classifyRelation(_a: ClassifyPaperLike, _b: ClassifyPaperLike) {
    this.calls += 1;
    if (this.latchAfter !== null && this.calls >= this.latchAfter) this.exhausted = true;
    return this.answers.shift() ?? null;
  }
  isExhausted(): boolean {
    return this.exhausted;
  }
  usageStats(): LlmUsageStats {
    return {
      calls: this.calls,
      ok: 0,
      failed: 0,
      latched: this.exhausted,
      latchReason: this.exhausted ? "daily rate limit exhausted" : null,
      dailyLimitHit: this.exhausted,
    };
  }
  usageSummary(): string {
    return `${this.name} summary: calls=${this.calls}`;
  }
}

describe("FallbackProvider", () => {
  it("answers from the primary when it can, tagging producedBy", async () => {
    const groq = new Stub("groq", "openai/gpt-oss-120b", [CLS]);
    const gemini = new Stub("gemini", GEMINI_DEFAULT_MODEL, [CLS]);
    const chain = new FallbackProvider([groq, gemini]);
    const r = await chain.classifyRelation({}, {});
    expect(r?.producedBy).toEqual({ provider: "groq", model: "groq:openai/gpt-oss-120b" });
    expect(gemini.calls).toBe(0);
    expect(chain.name).toBe("groq");
  });

  it("asks the secondary for a pair the primary returned null for (primary not latched)", async () => {
    const groq = new Stub("groq", "m", [null, CLS]);
    const gemini = new Stub("gemini", GEMINI_DEFAULT_MODEL, [CLS]);
    const chain = new FallbackProvider([groq, gemini]);
    const r1 = await chain.classifyRelation({}, {});
    expect(r1?.producedBy?.provider).toBe("gemini");
    const r2 = await chain.classifyRelation({}, {});
    expect(r2?.producedBy?.provider).toBe("groq");
    expect(groq.calls).toBe(2);
    expect(gemini.calls).toBe(1);
  });

  it("skips a latched primary entirely once it is exhausted", async () => {
    const groq = new Stub("groq", "m", [null], 1); // latches on its first call
    const gemini = new Stub("gemini", GEMINI_DEFAULT_MODEL, [CLS, CLS, CLS]);
    const warns: string[] = [];
    const chain = new FallbackProvider([groq, gemini], { logger: { warn: (m) => warns.push(m) } });
    for (let i = 0; i < 3; i++) {
      expect((await chain.classifyRelation({}, {}))?.producedBy?.provider).toBe("gemini");
    }
    expect(groq.calls).toBe(1);
    expect(gemini.calls).toBe(3);
    expect(warns.filter((w) => w.includes("groq is exhausted"))).toHaveLength(1);
  });

  it("returns null when every provider is exhausted and reports per-member usage", async () => {
    const groq = new Stub("groq", "m", [], 1);
    const gemini = new Stub("gemini", GEMINI_DEFAULT_MODEL, [], 1);
    const chain = new FallbackProvider([groq, gemini]);
    expect(await chain.classifyRelation({}, {})).toBeNull();
    expect(chain.isExhausted()).toBe(true);
    expect(await chain.classifyRelation({}, {})).toBeNull();
    expect(groq.calls + gemini.calls).toBe(2);
    const usage = usageOf(chain);
    expect(usage.map((u) => u.provider)).toEqual(["groq", "gemini"]);
    expect(usage.every((u) => u.stats?.dailyLimitHit)).toBe(true);
    expect(chain.usageSummary()).toContain("llm fallback summary: chain=groq>gemini");
    expect(chain.usageSummary()).toContain("unanswered=2");
  });

  it("disabled (keyless) members never participate", async () => {
    const groq = new Stub("groq", "m", [CLS]);
    groq.enabled = false;
    const gemini = new Stub("gemini", GEMINI_DEFAULT_MODEL, [CLS]);
    const r = await new FallbackProvider([groq, gemini]).classifyRelation({}, {});
    expect(r?.producedBy?.provider).toBe("gemini");
    expect(groq.calls).toBe(0);
  });
});

function geminiResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}
const DAILY_429 = {
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "You exceeded your current quota.",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }],
      },
    ],
  },
};

describe("GeminiProvider (fallback hardening)", () => {
  it("defaults to a currently available free-tier model", () => {
    expect(GEMINI_DEFAULT_MODEL).toBe("gemini-2.5-flash");
    const p = new GeminiProvider({}, "k", {
      fetchImpl: async () => geminiResp(200, {}),
    });
    expect(p.model).toBe("gemini-2.5-flash");
  });

  it("recognises a per-day quota 429 body, not a per-minute one", () => {
    expect(isGeminiDailyQuota429(DAILY_429)).toBe(true);
    expect(
      isGeminiDailyQuota429({
        error: {
          message: "quota",
          details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }] }],
        },
      }),
    ).toBe(false);
  });

  it("latches on a daily-quota 429 without retrying, then short-circuits", async () => {
    let fetches = 0;
    const p = new GeminiProvider({}, "k", {
      fetchImpl: async () => {
        fetches += 1;
        return geminiResp(429, DAILY_429);
      },
      sleep: async () => {},
    });
    expect(await p.classifyRelation({ title: "A" }, { title: "B" })).toBeNull();
    expect(fetches).toBe(1);
    expect(p.isExhausted()).toBe(true);
    expect(p.usageStats().dailyLimitHit).toBe(true);
    expect(await p.classifyRelation({ title: "A" }, { title: "B" })).toBeNull();
    expect(fetches).toBe(1);
    expect(p.usageSummary()).toMatch(/latched=yes \(daily rate limit exhausted/);
  });

  it("latches after 3 consecutive unusable responses (e.g. a retired model's 404)", async () => {
    const p = new GeminiProvider({}, "k", {
      fetchImpl: async () => geminiResp(404, {}),
      sleep: async () => {},
    });
    for (let i = 0; i < 3; i++) await p.classifyRelation({}, {});
    expect(p.isExhausted()).toBe(true);
    expect(p.usageStats().dailyLimitHit).toBe(false);
  });
});

describe("buildProvider fallback option", () => {
  const env = (o: Partial<Env>): Env => ({ ...(o as Env) });
  const fetchImpl = async () => geminiResp(200, {});

  it("chains groq then gemini when both keys exist and fallback is requested", () => {
    const { provider } = buildProvider(
      { env: env({ groqApiKey: "g", geminiApiKey: "m" }), ambientEnv: {}, fetchImpl },
      { fallback: true },
    );
    expect(provider).toBeInstanceOf(FallbackProvider);
    expect((provider as FallbackProvider).members.map((m) => m.name)).toEqual(["groq", "gemini"]);
    expect((provider as FallbackProvider).members[1]?.model).toBe("gemini-2.5-flash");
  });

  it("returns the single keyed provider when only one key exists", () => {
    const { provider } = buildProvider(
      { env: env({ groqApiKey: "g" }), ambientEnv: {}, fetchImpl },
      { fallback: true },
    );
    expect(provider).not.toBeInstanceOf(FallbackProvider);
    expect(provider.name).toBe("groq");
  });

  it("a forced PAPERPILOT_LLM_PROVIDER disables the chain; no option keeps the old behaviour", () => {
    const forced = buildProvider(
      {
        env: env({ groqApiKey: "g", geminiApiKey: "m" }),
        ambientEnv: { PAPERPILOT_LLM_PROVIDER: "gemini" },
        fetchImpl,
      },
      { fallback: true },
    );
    expect(forced.provider.name).toBe("gemini");
    expect(forced.provider).not.toBeInstanceOf(FallbackProvider);
    const plain = buildProvider({
      env: env({ groqApiKey: "g", geminiApiKey: "m" }),
      ambientEnv: {},
      fetchImpl,
    });
    expect(plain.provider).not.toBeInstanceOf(FallbackProvider);
  });
});

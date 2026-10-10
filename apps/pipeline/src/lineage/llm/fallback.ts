/**
 * Ordered LLM provider fallback chain (design 41 D2, R2-6).
 *
 * Groq's free tier (`openai/gpt-oss-120b`, 200K tokens/day) is the
 * primary lineage classifier; Gemini's free tier is the secondary. A call
 * walks the chain in order and returns the first usable answer:
 *
 *  - a provider whose breaker has latched (`isExhausted()`: daily quota,
 *    persistent 429s, repeated unusable responses) is skipped without an
 *    API call — so once Groq's daily quota is gone every remaining pair
 *    goes straight to Gemini;
 *  - a provider that returns `null` for ONE pair (unparseable answer,
 *    transient failure) does not latch, but that pair is retried on the
 *    next provider.
 *
 * Only providers that are `enabled` (i.e. have a key) participate — the
 * provider factory builds the chain from the keys it finds.
 *
 * `classifyRelation` stamps `producedBy` with the provider/model that
 * actually answered, so edge provenance and the classification cache
 * record the real producer (the chain itself is not a model).
 */

import type {
  ClassifyPaperLike,
  LLMProvider,
  LlmUsageStats,
  PaperEvaluation,
  RelationClassification,
} from "../../collect/llm/provider.js";
import type { Paper } from "../../collect/model/paper.js";
import { providerModelTag } from "./base.js";

export interface FallbackProviderDeps {
  logger?: { warn: (msg: string) => void };
}

/** One provider's counters, labelled, as the gate / CLI report them. */
export interface LabelledUsage {
  provider: string;
  model: string;
  stats: LlmUsageStats | null;
  summary: string | null;
}

export class FallbackProvider implements LLMProvider {
  readonly name: string;
  readonly model?: string;
  batchSize: number;
  enabled: boolean;
  /** The chain, primary first. */
  readonly members: readonly LLMProvider[];
  private readonly deps: FallbackProviderDeps;
  /** Pairs answered per provider name, plus pairs no provider answered. */
  private readonly answered = new Map<string, number>();
  private unanswered = 0;
  private readonly announcedSkip = new Set<string>();

  constructor(members: readonly LLMProvider[], deps: FallbackProviderDeps = {}) {
    if (members.length === 0) throw new Error("FallbackProvider needs at least one provider");
    this.members = members;
    const primary = members[0] as LLMProvider;
    // The chain reports as its primary so code that only knows one
    // provider (logs, legacy identity) keeps reading "groq"; per-answer
    // attribution goes through `producedBy`.
    this.name = primary.name;
    this.model = primary.model;
    this.batchSize = primary.batchSize;
    this.enabled = members.some((m) => m.enabled);
    this.deps = deps;
  }

  /** Members that can still be asked (enabled and not latched), in order. */
  private live(): LLMProvider[] {
    const out: LLMProvider[] = [];
    for (const m of this.members) {
      if (!m.enabled) continue;
      if (m.isExhausted?.()) {
        if (!this.announcedSkip.has(m.name)) {
          this.announcedSkip.add(m.name);
          this.deps.logger?.warn(
            `llm fallback: ${m.name} is exhausted; remaining calls go to the next provider in the chain`,
          );
        }
        continue;
      }
      out.push(m);
    }
    return out;
  }

  /** True when every member is exhausted (nothing left to ask). */
  isExhausted(): boolean {
    return this.members.every((m) => !m.enabled || m.isExhausted?.() === true);
  }

  async classifyRelation(
    a: ClassifyPaperLike,
    b: ClassifyPaperLike,
  ): Promise<RelationClassification | null> {
    for (const m of this.live()) {
      const result = await m.classifyRelation(a, b);
      if (result !== null) {
        this.answered.set(m.name, (this.answered.get(m.name) ?? 0) + 1);
        return {
          ...result,
          producedBy: result.producedBy ?? { provider: m.name, model: providerModelTag(m) },
        };
      }
    }
    this.unanswered += 1;
    return null;
  }

  async evaluateBatch(
    papers: readonly Paper[],
    profile: string,
  ): Promise<(PaperEvaluation | null)[]> {
    let last: (PaperEvaluation | null)[] = new Array(papers.length).fill(null);
    for (const m of this.live()) {
      last = await m.evaluateBatch(papers, profile);
      if (last.some((e) => e !== null)) return last;
    }
    return last;
  }

  async chat(system: string, user: string): Promise<string | null> {
    for (const m of this.live()) {
      const text = await m.chat(system, user);
      if (text !== null) return text;
    }
    return null;
  }

  async completeJson(system: string, user: string): Promise<string | null> {
    for (const m of this.live()) {
      const text = await m.completeJson(system, user);
      if (text !== null) return text;
    }
    return null;
  }

  /** Per-member usage, primary first. */
  memberUsage(): LabelledUsage[] {
    return this.members.map((m) => ({
      provider: m.name,
      model: providerModelTag(m),
      stats: m.usageStats?.() ?? null,
      summary: m.usageSummary?.() ?? null,
    }));
  }

  /** Every member's own summary line, then one line for the chain. */
  usageSummary(): string {
    const lines = this.members.map((m) => m.usageSummary?.() ?? `${m.name} summary: n/a`);
    const answered = this.members
      .map((m) => `${m.name}=${this.answered.get(m.name) ?? 0}`)
      .join(", ");
    lines.push(
      `llm fallback summary: chain=${this.members.map((m) => m.name).join(">")}, ` +
        `pairs answered ${answered}, unanswered=${this.unanswered}`,
    );
    return lines.join("\n");
  }
}

/**
 * Usage of `provider` as a flat list: a chain reports each member, a bare
 * provider reports itself. Used by the classification-rate gate.
 */
export function usageOf(provider: LLMProvider | null): LabelledUsage[] {
  if (provider === null) return [];
  if (provider instanceof FallbackProvider) return provider.memberUsage();
  return [
    {
      provider: provider.name,
      model: providerModelTag(provider),
      stats: provider.usageStats?.() ?? null,
      summary: provider.usageSummary?.() ?? null,
    },
  ];
}

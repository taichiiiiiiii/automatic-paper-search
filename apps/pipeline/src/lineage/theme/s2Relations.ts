/**
 * API-first relation classification of theme-lineage edges (design 41 D6,
 * R2-10; evidence in design 43).
 *
 * For a cited->citing pair whose citing paper Semantic Scholar knows:
 *   1. rule set v2 (`classifyS2Pair`) classifies the pair from S2's
 *      citation contexts / intents / isInfluential;
 *   2. only when a cue phrase fired (build on / unlike / outperform / use
 *      the dataset …, or a results-table row), or S2 marks the citation
 *      influential with no cue, the citation-context LLM prompt is asked
 *      whether the cue is about the cited paper and which simplified
 *      relation it is (`../llm/contextPrompt.ts`);
 *   3. the result is mapped onto the v1 relation enum (`v1RelationFor`).
 * When the LLM is unavailable or answers nothing usable, the rule result
 * stands, so the D3 evidence-classified rate does not depend on the LLM.
 *
 * `cites_unspecified` (S2 has no context/intent for the pair) and pairs
 * whose citing paper S2 does not know return `null`: the caller keeps its
 * existing path (abstract LLM prompt under `--llm-strict`, else the
 * year/citation heuristic, which the D3 gate counts as unclassified).
 *
 * Edge provenance: rule results use method `s2_context_rule` with the
 * hash of the S2 signals; context-LLM answers use method `llm` with
 * `prompt_version: relation-prompt-v3-context` and the hash of that
 * prompt. Rationales are a short Japanese sentence plus the quoted
 * English context sentence, so the web shows the evidence.
 */

import type { LLMProvider } from "../../collect/llm/provider.js";
import {
  type ApiRelation,
  classifyS2Pair,
  type PairSignals,
  type S2RuleResult,
  v1RelationFor,
} from "../classify/apiRelations.js";
import type { DerivedEdge } from "../classify/classify.js";
import { canonicalJsonSha256 } from "../contract/v1.js";
import {
  buildContextPrompt,
  CONTEXT_PROMPT_VERSION,
  type ContextAnswer,
  parseContextAnswer,
  parseContextResponse,
} from "../llm/contextPrompt.js";
import { completeJsonAttributed } from "../llm/fallback.js";
import type { S2CitationSource } from "./s2Citations.js";

type PaperLike = Record<string, unknown>;

/** Max characters of the quoted context sentence in a rationale. */
export const QUOTE_MAX_CHARS = 240;
const TITLE_TRIM = 50;
/** Same floor as `applyLlmClassification`: below it the model itself says
 * the relation is weak, so the rule result is kept instead. */
const MIN_LLM_CONFIDENCE = 0.4;

export interface S2RelationStats {
  /** Pairs S2 classified by rule only (no LLM asked, or none available). */
  rule: number;
  /** Pairs routed to the context LLM, and how many got a usable answer. */
  llmAsked: number;
  llmAnswered: number;
  /** Pairs left to the caller (`cites_unspecified` / no S2 data). */
  unspecified: number;
  noS2Data: number;
}

export function newS2RelationStats(): S2RelationStats {
  return { rule: 0, llmAsked: 0, llmAnswered: 0, unspecified: 0, noS2Data: 0 };
}

export interface S2RelationContext {
  source: S2CitationSource;
  /** `null` = rules only (`--llm-strict off`, or no provider). */
  provider: LLMProvider | null;
  stats: S2RelationStats;
}

function trimTitle(paper: PaperLike): string {
  const raw = typeof paper.title === "string" ? paper.title.trim() : "";
  const cps = Array.from(raw.replaceAll("「", "").replaceAll("」", ""));
  if (cps.length === 0) return "引用元の論文";
  return cps.length > TITLE_TRIM ? `${cps.slice(0, TITLE_TRIM - 1).join("")}…` : cps.join("");
}

function yearOf(paper: PaperLike): string {
  return typeof paper.year === "number" && Number.isInteger(paper.year) ? String(paper.year) : "?";
}

/** The quoted evidence sentence, truncated to {@link QUOTE_MAX_CHARS}. */
export function quote(sentence: string | null): string {
  if (!sentence) return "";
  const cps = Array.from(sentence.replace(/\s+/g, " ").trim());
  const text =
    cps.length > QUOTE_MAX_CHARS ? `${cps.slice(0, QUOTE_MAX_CHARS - 1).join("")}…` : cps.join("");
  return ` 引用文: "${text}"`;
}

function ruleSentence(
  rel: ApiRelation,
  mapped: string,
  parent: PaperLike,
  child: PaperLike,
): string {
  const b = `「${trimTitle(child)}」(${yearOf(child)})`;
  const a = `「${trimTitle(parent)}」(${yearOf(parent)})`;
  switch (rel) {
    case "builds_on":
      return `${b} は ${a} を土台にしている`;
    case "compares_with":
      return mapped === "contrasts"
        ? `${b} は ${a} と異なる手法を取ると述べている`
        : `${b} は ${a} と比較している`;
    case "uses_resource":
      return `${b} は ${a} のデータ・コード等を利用している`;
    default:
      return `${b} は ${a} を背景・関連研究として引用している`;
  }
}

function s2EvidenceSha(
  srcId: string,
  dstId: string,
  signals: PairSignals,
  citingTitle: string | null,
): string {
  return canonicalJsonSha256({
    src: srcId,
    dst: dstId,
    s2: {
      found: signals.found,
      intents: [...signals.intents],
      contexts: [...signals.contexts],
      is_influential: signals.isInfluential,
      citing_title: citingTitle,
    },
  });
}

/** The `s2_context_rule` edge for a v2 result (null for cites_unspecified). */
export function ruleEdge(
  r: S2RuleResult,
  signals: PairSignals,
  ids: { srcId: string; dstId: string },
  parent: PaperLike,
  child: PaperLike,
): DerivedEdge | null {
  const mapped = v1RelationFor(r.relation, { contrast: r.contrast, targetsCited: r.singleTarget });
  if (mapped === null) return null;
  const citingTitle = typeof child.title === "string" ? child.title : null;
  return {
    relation: mapped,
    confidence: r.confidence,
    rationale:
      `${ruleSentence(r.relation, mapped, parent, child)}` +
      `（Semantic Scholar の引用文・引用の意図から規則で判定）。${quote(r.evidence).trimStart()}`,
    provenance: "s2_context_rule",
    evidence: {
      source: "semantic_scholar",
      kind: "citation-context",
      sha256: s2EvidenceSha(ids.srcId, ids.dstId, signals, citingTitle),
    },
  };
}

/** Whether the context LLM is asked about this pair (design 43 §8). */
export function needsContextLlm(r: S2RuleResult, signals: PairSignals): boolean {
  if (r.relation === "cites_unspecified" || r.rule === "citing_survey") return false;
  if (signals.contexts.length === 0) return false;
  return r.cue || r.influential;
}

/** Ask the context prompt; through the theme cache when it has one. */
async function askContext(
  provider: LLMProvider,
  req: { src: string; dst: string; system: string; user: string },
): Promise<{ value: ContextAnswer; producedBy: { provider: string; model: string } } | null> {
  const cached = provider as LLMProvider & {
    cachedJsonAnswer?: (
      r: { src: string; dst: string; system: string; user: string; promptVersion: string },
      parse: (text: string | null) => ContextAnswer | null,
      validate: (cached: unknown) => ContextAnswer | null,
    ) => Promise<{ value: ContextAnswer; producedBy: { provider: string; model: string } } | null>;
  };
  if (typeof cached.cachedJsonAnswer === "function") {
    return cached.cachedJsonAnswer(
      { ...req, promptVersion: CONTEXT_PROMPT_VERSION },
      parseContextResponse,
      parseContextAnswer,
    );
  }
  const answer = await completeJsonAttributed(provider, req.system, req.user);
  const value = parseContextResponse(answer?.text ?? null);
  return answer === null || value === null ? null : { value, producedBy: answer.producedBy };
}

/**
 * Classify one pair from Semantic Scholar evidence. `parent` = cited
 * (older), `child` = citing (newer). Returns `null` when S2 has nothing to
 * say about the pair — the caller then uses its existing path.
 * `onLlm(usable)` is told about every context-LLM call.
 */
export async function deriveS2Relation(
  parent: PaperLike,
  child: PaperLike,
  ctx: S2RelationContext,
  onLlm?: (usable: boolean) => void,
): Promise<DerivedEdge | null> {
  const srcId = typeof parent.paperId === "string" ? parent.paperId : String(parent.id ?? "");
  const dstId = typeof child.paperId === "string" ? child.paperId : String(child.id ?? "");
  const lookup = await ctx.source.lookup(child, parent);
  if (lookup.kind === "no_s2_data") {
    ctx.stats.noS2Data += 1;
    return null;
  }
  const citingTitle = typeof child.title === "string" ? child.title : undefined;
  const signals: PairSignals = { ...lookup.signals, citingTitle };
  const r = classifyS2Pair(signals);
  const rule = ruleEdge(r, signals, { srcId, dstId }, parent, child);
  if (rule === null) {
    ctx.stats.unspecified += 1;
    return null;
  }
  if (ctx.provider === null || !needsContextLlm(r, signals)) {
    ctx.stats.rule += 1;
    return rule;
  }
  ctx.stats.llmAsked += 1;
  const [system, user] = buildContextPrompt(parent, child, signals.contexts);
  const answer = await askContext(ctx.provider, { src: srcId, dst: dstId, system, user });
  onLlm?.(answer !== null);
  if (answer === null || answer.value.confidence < MIN_LLM_CONFIDENCE) {
    ctx.stats.rule += 1;
    return rule;
  }
  ctx.stats.llmAnswered += 1;
  const a = answer.value;
  const mapped = v1RelationFor(a.relation, {
    contrast: a.contrast,
    targetsCited: a.refers_to_cited,
  }) as DerivedEdge["relation"];
  const evidenceSentence = r.evidence ?? signals.contexts[0] ?? null;
  return {
    relation: mapped,
    confidence: a.confidence,
    rationale: `${a.rationale}${quote(evidenceSentence)}`,
    provenance: "llm",
    producedBy: answer.producedBy,
    promptVersion: CONTEXT_PROMPT_VERSION,
    evidence: {
      source: "semantic_scholar",
      kind: "relation-input",
      sha256: canonicalJsonSha256({ src: srcId, dst: dstId, system, user }),
    },
  };
}

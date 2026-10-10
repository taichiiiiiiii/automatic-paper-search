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
 * `prompt_version: relation-prompt-v4-context` and the hash of that
 * prompt. Rationales are a short Japanese sentence naming both papers by
 * their short titles plus the quoted English context sentence, so the web
 * shows the evidence.
 *
 * R2-20 (Groq token budget):
 *  - confident rule results skip the LLM ({@link contextLlmSkipReason});
 *  - answers are cached per pair under the prompt's SEMANTIC version and
 *    input data (`CONTEXT_SEMANTIC_VERSION`), so a cached pair is never
 *    re-asked after a wording-only prompt edit;
 *  - with `batchSize > 1` the uncached pairs are DEFERRED: the rule edge
 *    goes into the graph first, and {@link resolvePendingContext} asks
 *    up to `batchSize` pairs per request after the BFS (one JSON answer
 *    keyed by pair id), falling back to single requests for a malformed
 *    batch answer or a missing id. Each pair still gets its own cache
 *    entry and its edge provenance hashes its own single-pair prompt (the
 *    relation input), not the batch request.
 *
 * R2-22 (design 41 D5): the LLM may only CONFIRM or DOWNGRADE a strong
 * rule claim (`mergeContextAnswer`); it is not asked when the rule result
 * is not strong (skip reason `no_strong_claim`), and a strong label without
 * the rule's cue is kept only as a hint in the rationale.
 *
 * R2-16 quote rule: the quote is the sentence that triggered the rule and
 * that identifies the cited paper (its name or reference marker, or the
 * only work the sentence cites). Bibliography lines, bare marker lists and
 * very short fragments are never quoted; when no sentence qualifies the
 * rationale says so instead of quoting an unrelated sentence.
 */

import type { CompletionOptions, LLMProvider } from "../../collect/llm/provider.js";
import {
  type ApiRelation,
  classifyS2Pair,
  type PairSignals,
  type S2RuleResult,
  v1RelationFor,
} from "../classify/apiRelations.js";
import {
  citedIdentity,
  isUsableContext,
  pickQuote,
  sentenceTarget,
  shortPaperName,
  titleizeRationale,
} from "../classify/citedTarget.js";
import type { DerivedEdge } from "../classify/classify.js";
import { canonicalJsonSha256 } from "../contract/v1.js";
import {
  buildContextBatchPrompt,
  buildContextPrompt,
  CONTEXT_PROMPT_VERSION,
  CONTEXT_SEMANTIC_VERSION,
  type ContextAnswer,
  type ContextPromptInputs,
  contextPromptInputs,
  parseContextAnswer,
  parseContextBatchResponse,
  parseContextResponse,
} from "../llm/contextPrompt.js";
import { completeJsonAttributed } from "../llm/fallback.js";
import { isSurveyLike } from "../shared/surveyLike.js";
import type { S2CitationSource } from "./s2Citations.js";

type PaperLike = Record<string, unknown>;

/** Max characters of the quoted context sentence in a rationale. */
export const QUOTE_MAX_CHARS = 240;
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
  /** R2-20: pairs whose confident rule result skipped the LLM, by reason. */
  skipped: Record<string, number>;
  /** R2-20: asked pairs answered from the cache (no request). */
  cached: number;
  /** R2-20: requests sent — single-pair and batched — and pairs in batches. */
  singleCalls: number;
  batchCalls: number;
  batchPairs: number;
  /** R2-20: pairs re-asked singly after a malformed/failed batch answer or a missing id. */
  batchFallbacks: number;
  /** R2-20: deferred pairs whose edge did not survive to resolution (never asked). */
  deferredUnused: number;
  /** R2-20: deferred pairs that shared one request with an identical pair. */
  deduped: number;
}

export function newS2RelationStats(): S2RelationStats {
  return {
    rule: 0,
    llmAsked: 0,
    llmAnswered: 0,
    unspecified: 0,
    noS2Data: 0,
    skipped: {},
    cached: 0,
    singleCalls: 0,
    batchCalls: 0,
    batchPairs: 0,
    batchFallbacks: 0,
    deferredUnused: 0,
    deduped: 0,
  };
}

/** One summary line of the context-LLM accounting (R2-20). */
export function contextLlmSummary(st: S2RelationStats): string {
  const skipped = Object.entries(st.skipped)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  const requests = st.singleCalls + st.batchCalls;
  const asked = st.llmAsked - st.deferredUnused;
  const savedByBatch = Math.max(0, st.batchPairs - st.batchCalls);
  return (
    `context-llm summary: asked=${asked} (cached=${st.cached}, deduped=${st.deduped}), ` +
    `requests=${requests} (single=${st.singleCalls}, batch=${st.batchCalls} for ${st.batchPairs} pairs, ` +
    `batch fallbacks=${st.batchFallbacks}); calls saved: by batching=${savedByBatch}, ` +
    `by cache=${st.cached + st.deduped}, by skip=${Object.values(st.skipped).reduce((a, b) => a + b, 0)}` +
    `${skipped ? ` (${skipped})` : ""}, deferred-unused=${st.deferredUnused}`
  );
}

/** A deferred context-LLM pair (R2-20 batching). */
export interface PendingContextPair {
  srcId: string;
  dstId: string;
  parent: PaperLike;
  child: PaperLike;
  /** The rule edge that stands until the pair is resolved. */
  ruleEdge: DerivedEdge;
  req: ContextRequest;
  /** Turn the answer (or `null`) into the final edge. */
  finish: (answer: AttributedAnswer | null) => DerivedEdge;
  onLlm?: (usable: boolean) => void;
}

export interface S2RelationContext {
  source: S2CitationSource;
  /** `null` = rules only (`--llm-strict off`, or no provider). */
  provider: LLMProvider | null;
  stats: S2RelationStats;
  /** R2-20: provider for the context prompt (e.g. a gpt-oss-20b-first
   * chain); defaults to `provider`. */
  contextProvider?: LLMProvider | null;
  /** R2-20: pairs per context request; > 1 defers uncached pairs to
   * {@link resolvePendingContext}. Default 1 (ask inline). */
  batchSize?: number;
  /** R2-20: deferred pairs (filled by `deriveS2Relation`). */
  pending?: PendingContextPair[];
}

function yearOf(paper: PaperLike): string {
  return typeof paper.year === "number" && Number.isInteger(paper.year) ? String(paper.year) : "?";
}

/** Said instead of a quote when no context sentence identifies the cited paper. */
export const NO_SPECIFIC_QUOTE = " 被引用論文を特定できる引用文はない。";

/** The quoted evidence sentence, truncated to {@link QUOTE_MAX_CHARS}, or
 * {@link NO_SPECIFIC_QUOTE} when there is none. */
export function quote(sentence: string | null): string {
  if (!sentence) return NO_SPECIFIC_QUOTE;
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
  const b = `「${shortPaperName(child)}」(${yearOf(child)})`;
  const a = `「${shortPaperName(parent)}」(${yearOf(parent)})`;
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
      `（Semantic Scholar の引用文・引用の意図から規則で判定）。${quote(r.quotable ? r.evidence : null).trimStart()}`,
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
  if (!signals.contexts.some(isUsableContext)) return false;
  return r.cue || r.influential;
}

/** Rules whose cue is explicitly NOT a method-building one (protocol /
 * ablation sentences; `classifySentence` checks them first). */
const NEGATIVE_CUE_RULES: ReadonlySet<string> = new Set(["phrase_protocol", "phrase_ablation"]);

/**
 * R2-20: a reason to keep the rule result without asking the LLM, for a
 * pair {@link needsContextLlm} would send, or `null`. Since R2-22 the
 * context answer can only confirm or downgrade the rule's own `extends` /
 * `contrasts` ({@link mergeContextAnswer}). So the LLM is skipped when it
 * cannot change the relation:
 *  - `negative_cue`: the cue is a protocol / ablation sentence — never
 *    builds_on by construction — and carries no contrast;
 *  - `multi_citation`: no cue fired (S2 only marks the citation
 *    influential) and every usable sentence cites three or more works
 *    without naming the cited paper, or only other works — the prompt
 *    tells the model to answer `background` then;
 *  - `no_strong_claim` (R2-22): the rule result is not extends/contrasts,
 *    and the answer may not create a strong claim.
 * (A survey-like citing paper never reaches here: `citing_survey`.)
 */
export function contextLlmSkipReason(r: S2RuleResult, signals: PairSignals): string | null {
  if (NEGATIVE_CUE_RULES.has(r.rule) && !r.contrast) return "negative_cue";
  if (!r.cue) {
    const id = citedIdentity(signals.cited, signals.contexts);
    const usable = signals.contexts.filter(isUsableContext);
    if (
      usable.length > 0 &&
      usable.every((c) => {
        const t = sentenceTarget(c.replace(/\s+/g, " ").trim(), id);
        return t === "multi" || t === "other";
      })
    ) {
      return "multi_citation";
    }
  }
  // R2-22: the LLM may only confirm or downgrade a strong rule claim
  // (`mergeContextAnswer`), so a pair whose rule result is not strong
  // cannot change — asking would only spend tokens.
  const mapped = v1RelationFor(r.relation, { contrast: r.contrast, targetsCited: r.singleTarget });
  if (mapped === null || !STRONG_V1.has(mapped)) return "no_strong_claim";
  return null;
}

/** Strong (lineage) relations in the v1 enum: what the graph draws as a
 * lineage claim (design 41 D5). */
const STRONG_V1: ReadonlySet<string> = new Set(["extends", "successor", "supersedes", "contrasts"]);

/**
 * R2-22: how a context-LLM answer may change the rule edge (design 41 D5:
 * a strong claim needs a quoted citing sentence that names the cited paper
 * and carries a build/contrast cue — i.e. the RULE's cue). The LLM can
 * confirm or downgrade a strong rule claim, never create one:
 *  - `llm`: use the LLM edge — it confirms the rule's strong relation, or
 *    downgrades it to baseline_only, or both are baseline_only;
 *  - `rule`: keep the rule edge;
 *  - `rule_with_hint`: keep the rule edge (no strong claim) and note the
 *    LLM's strong label in the rationale as a hint only.
 *
 * Downgrades: on the published lineages the LLM's downgrades of a rule
 * `extends` were right when the model read the named sentence as about the
 * cited paper and as use/comparison (Hash Layers <- BASE "we use the
 * architecture, data and hyperparameters directly from [10]"; VR-GCN <-
 * GraphSAGE "subsample … following Hamilton et al."), and wrong when it
 * claimed the sentence was not about the cited paper although the
 * sentence names it (DiffPool <- GraphSAGE "We use the “mean” variant of
 * GRAPHSAGE [16]", answered refers_to_cited=false). So a downgrade with
 * refers_to_cited=false is ignored when the rule's sentence names the cited
 * paper in words (title stem, acronym, author, method name); it is
 * accepted when the sentence identifies it only by a reference marker
 * (inferred, so the model may be right that S2 attached it wrongly).
 */
export function mergeContextAnswer(
  ruleRelation: string,
  llmRelation: string,
  a: Pick<ContextAnswer, "refers_to_cited">,
  r: Pick<S2RuleResult, "namedInWords">,
): "llm" | "rule" | "rule_with_hint" | "baseline_with_hint" {
  const ruleStrong = STRONG_V1.has(ruleRelation);
  const llmStrong = STRONG_V1.has(llmRelation);
  if (llmStrong) {
    if (llmRelation === ruleRelation) return "llm";
    // A strong label the rule has no cue for is never created by the LLM;
    // a different strong label than the rule's does not confirm it either.
    return ruleStrong ? "baseline_with_hint" : "rule_with_hint";
  }
  if (!ruleStrong) return "llm";
  if (!a.refers_to_cited && r.namedInWords) return "rule";
  return "llm";
}

/** The rationale note for an LLM strong label that is not published. */
export function llmHint(llmRelation: string): string {
  return `（引用文の LLM は ${llmRelation} と判定したが、規則の手がかり（引用文中の継承・対比の語）がないため強い関係としては採らない）`;
}

/** R2-22: an LLM rationale that argues against the relation it labels
 * (an `extends` described as "対照的", a `contrasts` described as "拡張"). */
export function contradictsRelation(rationale: string, relation: string): boolean {
  if (relation === "extends") return /対照的|対比し|対比する|と異なり|とは異なる/u.test(rationale);
  if (relation === "contrasts") return /拡張し|拡張する|土台に|基に構築|踏襲/u.test(rationale);
  return false;
}

/** One context-prompt cache request (theme cache `JsonAnswerRequest`). */
interface ContextRequest {
  src: string;
  dst: string;
  system: string;
  user: string;
  promptVersion: string;
  semantic: { version: string; inputs: ContextPromptInputs };
  opts?: CompletionOptions;
}

type AttributedAnswer = { value: ContextAnswer; producedBy: { provider: string; model: string } };

/** The theme cache's methods, when `provider` is the cache wrapper. */
interface ContextCache {
  lookupJsonAnswer: (
    r: ContextRequest,
    validate: (cached: unknown) => ContextAnswer | null,
  ) => AttributedAnswer | null;
  storeJsonAnswer: (
    r: ContextRequest,
    value: ContextAnswer,
    producedBy: { provider: string; model: string },
  ) => Promise<void>;
}

function cacheOf(provider: LLMProvider): ContextCache | null {
  const c = provider as LLMProvider & Partial<ContextCache>;
  return typeof c.lookupJsonAnswer === "function" && typeof c.storeJsonAnswer === "function"
    ? (c as unknown as ContextCache)
    : null;
}

/** Ask one pair: cache first, then a single-pair request (cached on success). */
async function askContext(
  provider: LLMProvider,
  req: ContextRequest,
  stats: S2RelationStats,
): Promise<AttributedAnswer | null> {
  const cache = cacheOf(provider);
  const hit = cache?.lookupJsonAnswer(req, parseContextAnswer) ?? null;
  if (hit !== null) {
    stats.cached += 1;
    return hit;
  }
  if (provider.isExhausted?.() === true) return null;
  stats.singleCalls += 1;
  const answer = await completeJsonAttributed(provider, req.system, req.user, {
    kind: "context",
    answers: 1,
  });
  const value = parseContextResponse(answer?.text ?? null);
  if (answer === null || value === null) return null;
  await cache?.storeJsonAnswer(req, value, answer.producedBy);
  return { value, producedBy: answer.producedBy };
}

/**
 * Classify one pair from Semantic Scholar evidence. `parent` = cited
 * (older), `child` = citing (newer). Returns `null` when S2 has nothing to
 * say about the pair — the caller then uses its existing path.
 * `onLlm(usable)` is told about every context-LLM call (for a deferred
 * pair: when it is resolved).
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
  // R2-15: the full survey test (publication type, title, abstract) — a
  // review whose title has no survey word still gives only background.
  const signals: PairSignals = {
    ...lookup.signals,
    citingTitle,
    citingSurvey: isSurveyLike(child),
    cited: parent,
  };
  const r = classifyS2Pair(signals);
  const rule = ruleEdge(r, signals, { srcId, dstId }, parent, child);
  if (rule === null) {
    ctx.stats.unspecified += 1;
    return null;
  }
  const provider = ctx.contextProvider ?? ctx.provider;
  if (ctx.provider === null || provider === null || !needsContextLlm(r, signals)) {
    ctx.stats.rule += 1;
    return rule;
  }
  const skip = contextLlmSkipReason(r, signals);
  if (skip !== null) {
    ctx.stats.rule += 1;
    ctx.stats.skipped[skip] = (ctx.stats.skipped[skip] ?? 0) + 1;
    return rule;
  }
  ctx.stats.llmAsked += 1;
  // Only usable sentences go to the model (no bibliography lines / bare
  // marker lists); `needsContextLlm` guarantees at least one.
  const usable = signals.contexts.filter(isUsableContext);
  const [system, user] = buildContextPrompt(parent, child, usable);
  const req: ContextRequest = {
    src: srcId,
    dst: dstId,
    system,
    user,
    promptVersion: CONTEXT_PROMPT_VERSION,
    semantic: {
      version: CONTEXT_SEMANTIC_VERSION,
      inputs: contextPromptInputs(parent, child, usable),
    },
  };
  const finish = (answer: AttributedAnswer | null): DerivedEdge => {
    if (answer === null || answer.value.confidence < MIN_LLM_CONFIDENCE) {
      ctx.stats.rule += 1;
      return rule;
    }
    ctx.stats.llmAnswered += 1;
    const a = answer.value;
    // R2-16: `contrasts` needs the rule's own contrast cue on a sentence
    // that targets the cited paper, not only the model's say-so.
    const llmMapped = v1RelationFor(a.relation, {
      contrast: a.contrast && r.contrast,
      targetsCited: a.refers_to_cited && r.singleTarget,
    }) as DerivedEdge["relation"];
    const decision = mergeContextAnswer(rule.relation, llmMapped, a, r);
    if (decision === "rule") return rule;
    if (decision === "rule_with_hint" || decision === "baseline_with_hint") {
      const base =
        decision === "rule_with_hint"
          ? rule
          : (ruleEdge(
              { ...r, relation: "compares_with", contrast: false },
              signals,
              { srcId, dstId },
              parent,
              child,
            ) as DerivedEdge);
      return { ...base, rationale: `${base.rationale}${llmHint(llmMapped)}` };
    }
    const evidenceSentence = r.quotable
      ? r.evidence
      : pickQuote(signals.contexts, citedIdentity(parent, signals.contexts));
    // R2-22: a confirming answer whose own sentence argues the opposite
    // ("…を拡張し、Bは…して対照的にする" on an extends) is shown with the
    // rule's sentence instead; the relation and provenance stay the LLM's.
    const llmText = titleizeRationale(a.rationale, parent, child);
    const lead = contradictsRelation(llmText, llmMapped)
      ? rule.rationale.replace(/（Semantic Scholar[^）]*）。.*$/u, "。")
      : llmText;
    return {
      relation: llmMapped,
      confidence: a.confidence,
      rationale: `${lead}${quote(evidenceSentence)}`,
      provenance: "llm",
      producedBy: answer.producedBy,
      promptVersion: CONTEXT_PROMPT_VERSION,
      evidence: {
        source: "semantic_scholar",
        kind: "relation-input",
        sha256: canonicalJsonSha256({ src: srcId, dst: dstId, system, user }),
      },
    };
  };
  if ((ctx.batchSize ?? 1) > 1) {
    // Cached pairs resolve now; the rest wait for a batched request.
    const hit = cacheOf(provider)?.lookupJsonAnswer(req, parseContextAnswer) ?? null;
    if (hit !== null) {
      ctx.stats.cached += 1;
      onLlm?.(true);
      return finish(hit);
    }
    if (ctx.pending === undefined) ctx.pending = [];
    ctx.pending.push({ srcId, dstId, parent, child, ruleEdge: rule, req, finish, onLlm });
    return rule;
  }
  const answer = await askContext(provider, req, ctx.stats);
  onLlm?.(answer !== null);
  return finish(answer);
}

/**
 * R2-20: resolve the deferred pairs of `ctx` with batched requests.
 * `keep(pair)` says whether the pair's rule edge is still in the graph
 * (pairs whose edge was dropped are not asked). Identical pairs share one
 * answer. Returns the final edge of every kept pair, in queue order.
 */
export async function resolvePendingContext(
  ctx: S2RelationContext,
  keep: (pair: PendingContextPair) => boolean,
): Promise<{ pair: PendingContextPair; edge: DerivedEdge }[]> {
  const queue = (ctx.pending ?? []).splice(0);
  const provider = ctx.contextProvider ?? ctx.provider;
  if (queue.length === 0 || provider === null) return [];
  const kept = queue.filter((p) => {
    if (keep(p)) return true;
    ctx.stats.deferredUnused += 1;
    return false;
  });
  // One request per distinct (src, dst, inputs).
  const groups = new Map<string, PendingContextPair[]>();
  for (const p of kept) {
    const k = canonicalJsonSha256({ src: p.srcId, dst: p.dstId, inputs: p.req.semantic.inputs });
    const g = groups.get(k);
    if (g) {
      g.push(p);
      ctx.stats.deduped += 1;
    } else groups.set(k, [p]);
  }
  const reps = [...groups.values()];
  const answers = new Map<PendingContextPair, AttributedAnswer | null>();
  const size = Math.max(1, Math.floor(ctx.batchSize ?? 1));
  const cache = cacheOf(provider);
  for (let i = 0; i < reps.length; i += size) {
    const chunk = reps.slice(i, i + size).map((g) => g[0] as PendingContextPair);
    const open: PendingContextPair[] = [];
    for (const p of chunk) {
      const hit = cache?.lookupJsonAnswer(p.req, parseContextAnswer) ?? null;
      if (hit !== null) {
        ctx.stats.cached += 1;
        answers.set(p, hit);
      } else open.push(p);
    }
    if (open.length === 1) {
      const p = open[0] as PendingContextPair;
      answers.set(p, await askContext(provider, p.req, ctx.stats));
      continue;
    }
    if (open.length === 0) continue;
    let parsed: Map<string, ContextAnswer> | null = null;
    let producedBy: { provider: string; model: string } | null = null;
    if (provider.isExhausted?.() !== true) {
      const ids = open.map((_, n) => `p${n + 1}`);
      const [system, user] = buildContextBatchPrompt(
        open.map((p, n) => ({ id: ids[n] as string, inputs: p.req.semantic.inputs })),
      );
      ctx.stats.batchCalls += 1;
      ctx.stats.batchPairs += open.length;
      const res = await completeJsonAttributed(provider, system, user, {
        kind: "context-batch",
        answers: open.length,
      });
      parsed = parseContextBatchResponse(res?.text ?? null, ids);
      producedBy = res?.producedBy ?? null;
    }
    for (const [n, p] of open.entries()) {
      const value = parsed?.get(`p${n + 1}`) ?? null;
      if (value !== null && producedBy !== null) {
        const a = { value, producedBy };
        await cache?.storeJsonAnswer(p.req, value, producedBy);
        answers.set(p, a);
      } else if (provider.isExhausted?.() === true) {
        answers.set(p, null);
      } else {
        // Malformed / failed batch answer, or no answer for this id.
        ctx.stats.batchFallbacks += 1;
        answers.set(p, await askContext(provider, p.req, ctx.stats));
      }
    }
  }
  const out: { pair: PendingContextPair; edge: DerivedEdge }[] = [];
  const answerOf = new Map<PendingContextPair, AttributedAnswer | null>();
  for (const g of reps) {
    const a = answers.get(g[0] as PendingContextPair) ?? null;
    for (const p of g) answerOf.set(p, a);
  }
  for (const p of kept) {
    const a = answerOf.get(p) ?? null;
    p.onLlm?.(a !== null);
    out.push({ pair: p, edge: p.finish(a) });
  }
  return out;
}

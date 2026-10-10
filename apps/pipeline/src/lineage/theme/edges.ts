/**
 * Edge construction + provenance binding — TS port of
 * `paperpilot/scripts/build_theme_lineage.py`'s `_heuristic_evidence_input`,
 * `_classification_provenance`, `_make_edge`, `_is_trending`.
 *
 * `_is_degenerate_rationale`/`_filter_edges_by_rationale` (LIN-37) are
 * `build_lineage.py`'s own functions, consolidated into
 * `../shared/rationale.ts` per docs/migration/p4-followups.md #23 and
 * re-exported here unchanged so this module's own importers
 * (`./build.ts`) are unaffected.
 */

import type { LLMProvider } from "../../collect/llm/provider.js";
import type { DerivedEdge } from "../classify/classify.js";
import { CLASSIFICATION_METHODS, canonicalJsonSha256, makeProvenance } from "../contract/v1.js";
import { buildClassifyPrompt, providerModelTag } from "../llm/base.js";

export { filterEdgesByRationale, isDegenerateRationale } from "../shared/rationale.js";

export const PRODUCER_NAME = "paperpilot.scripts.build_theme_lineage";
export const PRODUCER_VERSION = "p2t-v1";
/** Abstract prompt (`buildClassifyPrompt`). R2-16 changed its text
 * (no contrasts, surveys baseline_only only, title-based rationales) and
 * bumped v2 -> v4 (v3 is taken by the context prompt's history), in step
 * with the conference / deep builders that share the prompt. The theme
 * cache key hashes the prompt text, so v2 answers are not reused.
 * Citation-context answers carry `CONTEXT_PROMPT_VERSION`
 * (`../llm/contextPrompt.ts`, `relation-prompt-v4-context`). */
export const PROMPT_VERSION = "relation-prompt-v4";
export const CLASSIFICATION_SCHEMA_VERSION = "relation-classification-v1";

type PaperLike = Record<string, unknown>;

function fields(paper: PaperLike): { title: unknown; year: unknown; citations: unknown } {
  // Python's `dict.get(key)` always returns `None` for an absent key — the
  // key itself is never omitted. `pyJsonDumps` now throws on a bare JS
  // `undefined` (the LOW item closing the undefined/non-plain-object gap)
  // rather than silently writing `null` for it, so every optional access
  // here must coerce an absent field to `null` explicitly to keep hashing
  // the same canonical shape Python does.
  return {
    title: paper.title ?? null,
    year: paper.year ?? null,
    citations: ("citationCount" in paper ? paper.citationCount : paper.citation_count) ?? null,
  };
}

/** The canonical-JSON input hashed into a heuristic edge's evidence. */
export function heuristicEvidenceInput(options: {
  srcId: string;
  dstId: string;
  parent: PaperLike;
  child: PaperLike;
  intentRecord: PaperLike;
}): Record<string, unknown> {
  const { srcId, dstId, parent, child, intentRecord } = options;
  return {
    src: srcId,
    dst: dstId,
    parent: fields(parent),
    child: fields(child),
    intent_record: {
      ...fields(intentRecord),
      intents: intentRecord._intents ?? null,
      contexts: intentRecord._contexts ?? null,
      is_influential: intentRecord._is_influential ?? null,
    },
  };
}

/** Build the structured provenance object for one classified edge,
 * either the LLM branch (hashes the exact prompt) or a heuristic
 * method from the closed `CLASSIFICATION_METHODS` set. */
export function classificationProvenance(
  classification: DerivedEdge,
  options: {
    srcId: string;
    dstId: string;
    parent: PaperLike;
    child: PaperLike;
    intentRecord: PaperLike;
    provider: LLMProvider | null;
  },
): Record<string, unknown> {
  const { srcId, dstId, parent, child, intentRecord, provider } = options;
  const method = String(classification.provenance || "");
  if (method === "llm") {
    // R2-10: a citation-context answer carries the hash of its own prompt.
    let evidenceSha256 = classification.evidence?.sha256;
    if (evidenceSha256 === undefined) {
      const [system, user] = buildClassifyPrompt(parent, child);
      evidenceSha256 = canonicalJsonSha256({ src: srcId, dst: dstId, system, user });
    }
    return makeProvenance({
      producerName: PRODUCER_NAME,
      producerVersion: PRODUCER_VERSION,
      evidenceSource: classification.evidence?.source ?? "semantic_scholar",
      evidenceKind: classification.evidence?.kind ?? "relation-input",
      evidenceSha256,
      method: "llm",
      // R2-6: the answering provider when the fallback chain / cache knows
      // it (a Gemini answer behind a Groq-primary chain says "gemini").
      provider:
        classification.producedBy?.provider ??
        (provider ? String(provider.name ?? "unknown") : "unknown"),
      model: classification.producedBy?.model ?? providerModelTag(provider),
      promptVersion: classification.promptVersion ?? PROMPT_VERSION,
      classificationSchemaVersion: CLASSIFICATION_SCHEMA_VERSION,
    });
  }
  if (!CLASSIFICATION_METHODS.has(method)) {
    throw new RangeError(`unsupported heuristic provenance method: ${JSON.stringify(method)}`);
  }
  const evidenceSha256 =
    classification.evidence?.sha256 ??
    canonicalJsonSha256(heuristicEvidenceInput({ srcId, dstId, parent, child, intentRecord }));
  return makeProvenance({
    producerName: PRODUCER_NAME,
    producerVersion: PRODUCER_VERSION,
    evidenceSource:
      classification.evidence?.source ??
      (method === "context_pattern" ? "unarxive" : "semantic_scholar"),
    evidenceKind:
      classification.evidence?.kind ??
      (method === "context_pattern" ? "citation-context" : "citation-metadata"),
    evidenceSha256,
    method,
    provider: null,
    model: null,
    promptVersion: null,
    classificationSchemaVersion: CLASSIFICATION_SCHEMA_VERSION,
  });
}

// ---- R2-2b: low-information citation edges ----

/** Confidence of an edge backed only by "B cites A" plus the two years —
 * same value the conference builder uses for its `citation_heuristic`
 * edges, and below every real classifier's output (context patterns
 * 0.75+, intent map / year-cite 0.7, LLM floor 0.4 with typical 0.8). */
export const CITATION_HEURISTIC_CONFIDENCE = 0.4;

const CITATION_TITLE_TRIM = 60;

function trimTitle(paper: PaperLike): string {
  const raw = typeof paper.title === "string" ? paper.title.trim() : "";
  if (!raw) return "引用元の論文";
  const cps = Array.from(raw.replaceAll("「", "").replaceAll("」", ""));
  return cps.length > CITATION_TITLE_TRIM
    ? `${cps.slice(0, CITATION_TITLE_TRIM - 1).join("")}…`
    : cps.join("");
}

function yearOf(paper: PaperLike): string {
  return typeof paper.year === "number" && Number.isInteger(paper.year) ? String(paper.year) : "?";
}

/**
 * Demote the year/citation-count guess to what it really is: a citation
 * link of unknown kind. `deriveRelationHeuristic`'s `year_cite` branch
 * labels a pair "contrasts" when the two papers are ≤1 year apart with
 * similar citation counts, and "successor" when 1–5 years apart —
 * neither says anything about the content ("SuperGlue contrasts Text Data
 * Augmentation"). Under `--llm-strict ambiguous` with OpenAlex data
 * (which carries no S2 intents, so every pair is "ambiguous") the LLM is
 * asked, but when it returns nothing usable (quota latch, HTTP error,
 * malformed JSON) `applyLlmClassification` keeps the heuristic verbatim.
 * That is how a whole lineage ended up as 0.7 successor/contrasts.
 *
 * Here such an edge becomes `baseline_only` at
 * {@link CITATION_HEURISTIC_CONFIDENCE} with provenance method
 * `citation_heuristic` (already in the v1 contract's closed set, and what
 * the conference builder emits for the same evidence), so `contrasts`
 * only ever comes from a real classification and the quality audit can
 * count these edges through `meta.provenance_breakdown`. Every other
 * classification passes through.
 *
 * R2-16: the relation used to be `successor`. The v1 contract has no
 * "unclassified" value, and `successor` claims a research-line
 * continuation the evidence does not show — the second review found
 * Swin -> ConvNeXt (a competitor) drawn as a successor. `baseline_only`
 * ("cited, no inheritance claimed"; shown as 参照/背景 on the web) is the
 * weakest claim the enum has, and the rationale says the kind is
 * unclassified. The D3 gate counts these edges as unclassified by their
 * method, whatever the relation.
 */
export function demoteLowInformationEdge(
  classification: DerivedEdge,
  parent: PaperLike,
  child: PaperLike,
): DerivedEdge {
  if (classification.provenance !== "year_cite") return classification;
  return {
    relation: "baseline_only",
    confidence: CITATION_HEURISTIC_CONFIDENCE,
    rationale:
      `「${trimTitle(child)}」(${yearOf(child)}) は「${trimTitle(parent)}」(${yearOf(parent)}) を引用している` +
      "（引用関係と年代のみからの推定で、関係の種類は未分類）。",
    provenance: "citation_heuristic",
  };
}

export interface ThemeEdge {
  src: string;
  dst: string;
  rel: string;
  relation: string;
  conf: number;
  confidence: number;
  rationale: string;
  provenance: Record<string, unknown>;
  [extra: string]: unknown;
}

/** Build one serialized theme-lineage edge from a classifier result. */
export function makeEdge(
  classification: DerivedEdge,
  options: {
    srcId: string;
    dstId: string;
    parent: PaperLike;
    child: PaperLike;
    intentRecord: PaperLike;
    provider: LLMProvider | null;
  },
): ThemeEdge {
  const { srcId, dstId } = options;
  const relation = classification.relation;
  const confidence = classification.confidence;
  return {
    src: srcId,
    dst: dstId,
    rel: relation,
    relation,
    conf: confidence,
    confidence,
    rationale: classification.rationale,
    provenance: classificationProvenance(classification, options),
  };
}

// ---- #68 trending badge ----

const TRENDING_VELOCITY_THRESHOLD = 200.0;
const TRENDING_AGE_LIMIT_YEARS = 3;

/** True when citation velocity (cites/year) clears the threshold AND the
 * paper is recent enough that "trending" makes sense. */
export function isTrending(
  paper: { citationCount?: unknown; year?: unknown },
  currentYear: number,
): boolean {
  const cit = Number(paper.citationCount) || 0;
  const year = paper.year;
  if (typeof year !== "number" || !Number.isInteger(year) || year > currentYear) return false;
  const age = currentYear - year;
  if (age > TRENDING_AGE_LIMIT_YEARS) return false;
  const ageYears = Math.max(age, 0.5);
  return cit / ageYears >= TRENDING_VELOCITY_THRESHOLD;
}

/**
 * Edge construction + provenance binding — TS port of
 * `paperpilot/scripts/build_theme_lineage.py`'s `_heuristic_evidence_input`,
 * `_classification_provenance`, `_make_edge`, `_is_trending`, plus
 * `build_lineage.py`'s `_is_degenerate_rationale`/`_filter_edges_by_rationale`
 * (LIN-37 — scope note: belongs to `build_lineage.py`, a separate P4d
 * task, copied locally because `build_theme_lineage`'s own final filter
 * depends on it; same pattern as `./node.ts`).
 */

import type { LLMProvider } from "../../collect/llm/provider.js";
import type { DerivedEdge } from "../classify/classify.js";
import { CLASSIFICATION_METHODS, canonicalJsonSha256, makeProvenance } from "../contract/v1.js";
import {
  buildClassifyPrompt,
  codePointLength,
  MIN_RATIONALE_LEN,
  providerModelTag,
} from "../llm/base.js";

export const PRODUCER_NAME = "paperpilot.scripts.build_theme_lineage";
export const PRODUCER_VERSION = "p2t-v1";
export const PROMPT_VERSION = "relation-prompt-v1";
export const CLASSIFICATION_SCHEMA_VERSION = "relation-classification-v1";

type PaperLike = Record<string, unknown>;

function fields(paper: PaperLike): { title: unknown; year: unknown; citations: unknown } {
  return {
    title: paper.title,
    year: paper.year,
    citations: "citationCount" in paper ? paper.citationCount : paper.citation_count,
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
      intents: intentRecord._intents,
      contexts: intentRecord._contexts,
      is_influential: intentRecord._is_influential,
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
    const [system, user] = buildClassifyPrompt(parent, child);
    const evidenceSha256 = canonicalJsonSha256({ src: srcId, dst: dstId, system, user });
    return makeProvenance({
      producerName: PRODUCER_NAME,
      producerVersion: PRODUCER_VERSION,
      evidenceSource: "semantic_scholar",
      evidenceKind: "relation-input",
      evidenceSha256,
      method: "llm",
      provider: provider ? String(provider.name ?? "unknown") : "unknown",
      model: providerModelTag(provider),
      promptVersion: PROMPT_VERSION,
      classificationSchemaVersion: CLASSIFICATION_SCHEMA_VERSION,
    });
  }
  if (!CLASSIFICATION_METHODS.has(method)) {
    throw new RangeError(`unsupported heuristic provenance method: ${JSON.stringify(method)}`);
  }
  const evidenceSha256 = canonicalJsonSha256(
    heuristicEvidenceInput({ srcId, dstId, parent, child, intentRecord }),
  );
  return makeProvenance({
    producerName: PRODUCER_NAME,
    producerVersion: PRODUCER_VERSION,
    evidenceSource: method === "context_pattern" ? "unarxive" : "semantic_scholar",
    evidenceKind: method === "context_pattern" ? "citation-context" : "citation-metadata",
    evidenceSha256,
    method,
    provider: null,
    model: null,
    promptVersion: null,
    classificationSchemaVersion: CLASSIFICATION_SCHEMA_VERSION,
  });
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

// ---- LIN-37: drop edges with an empty/degenerate rationale ----

/** True iff `rationale` is empty or below the `MIN_RATIONALE_LEN` floor
 * (#297). Centralises the "is this a meaningless tooltip" test. */
export function isDegenerateRationale(rationale: unknown): boolean {
  if (typeof rationale !== "string") return true;
  return codePointLength(rationale.trim()) < MIN_RATIONALE_LEN;
}

/** Drop edges whose rationale is empty or below the min-length floor —
 * belt-and-braces final filter (`RelationClassification.from_dict` and
 * the cache-hit guard already reject both, but this also catches edges
 * built outside those paths). */
export function filterEdgesByRationale<T extends { rationale?: unknown }>(
  edges: readonly T[],
): T[] {
  return edges.filter((e) => !isDegenerateRationale(e.rationale));
}

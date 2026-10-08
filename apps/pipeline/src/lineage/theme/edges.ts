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
export const PROMPT_VERSION = "relation-prompt-v1";
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

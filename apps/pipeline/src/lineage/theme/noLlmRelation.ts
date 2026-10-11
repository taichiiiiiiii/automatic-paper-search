/**
 * R2-24 (design 41): relation classification with no LLM at all, from API
 * evidence only — shared by the theme BFS (`bfs.ts`) and the conference /
 * deep builders.
 *
 * Order for a cited (`parent`, older) -> citing (`child`, newer) pair that
 * came from an API reference / citing-paper list:
 *  1. an explicit version increment in the titles -> `title_version`;
 *  2. Semantic Scholar citation contexts / intents / isInfluential, rule set
 *     v3 (`deriveS2Relation` with no provider: the rule result stands — the
 *     strong claims need a quoted cue, design 41 D5);
 *  3. the other LLM-free rules (`deriveRelation` with no classifier:
 *     unarXive context patterns, S2 intents, the foundational allowlist);
 *  4. what is left — a year/citation guess, or no edge when the years are
 *     far apart (LLM mode would ask the abstract prompt) — becomes an
 *     `api_citation` baseline_only edge ("cites; kind not stated") when the
 *     S2 lookup answered for the pair ({@link citationListSource}); else
 *     the old `citation_heuristic` demotion / no edge.
 * Every result goes through `guardRelation`.
 */

import type { ClassifyPaperLike } from "../../collect/llm/provider.js";
import {
  type DerivedEdge,
  deriveRelation,
  isVersionIncrement,
  titleVersionEdge,
} from "../classify/classify.js";
import { canonicalJsonSha256, makeProvenance } from "../contract/v1.js";
import {
  apiCitationEdge,
  type CitationListSource,
  demoteLowInformationEdge,
  heuristicEvidenceInput,
} from "./edges.js";
import { guardRelation } from "./relationGuard.js";
import { deriveS2Relation, type S2LookupOutcome, type S2RelationContext } from "./s2Relations.js";

type PaperLike = Record<string, unknown>;

/** Counters of the no-LLM fallback (logged by the callers). */
export interface NoLlmCounters {
  /** Pairs emitted as `api_citation`. */
  apiCitationEdges: number;
  /** Pairs whose S2 lookup failed this run (left as guesses / dropped). */
  s2Unreachable: number;
}

export function newNoLlmCounters(): NoLlmCounters {
  return { apiCitationEdges: 0, s2Unreachable: 0 };
}

/**
 * R2-24: the reference list that holds a pair's citation, when the no-LLM
 * mode may state it (`null` = it may not). Every pair the builders
 * classify came from a reference or citing-paper list (OpenAlex
 * `referenced_works` / `cites:`, or S2 `/references` / `/citations`), so
 * the citation itself is API-confirmed; the question is only whether the
 * S2 citation sentences were read:
 *  - S2 lists the pair (`listed`) -> Semantic Scholar: its contexts were
 *    read and stated no relation (no cue / no context);
 *  - S2 has the citing paper's list without this pair, or no record of
 *    the paper (`not_listed`, `no-id`, `citing-not-in-s2`) -> the list the
 *    pair came from (`listSource`; for the theme BFS an `s2:` id came
 *    through the S2 expansion fallback, any other id from OpenAlex): there
 *    is no sentence to read, now or on a retry;
 *  - S2 could not be reached this run (`fetch-failed`), or no S2 lookup
 *    was made -> `null`: the sentences were never read, so the edge stays
 *    a `citation_heuristic` guess, which the D3 gate counts as
 *    unclassified (an S2 outage blocks a theme build instead of publishing
 *    a graph that only looks classified).
 */
export function citationListSource(
  lookup: S2LookupOutcome | undefined,
  parent: PaperLike,
  child: PaperLike,
  listSource?: CitationListSource,
): CitationListSource | null {
  if (lookup === undefined || lookup === "fetch-failed") return null;
  if (lookup === "listed") return "semantic_scholar";
  if (listSource !== undefined) return listSource;
  const ids = [parent.paperId, child.paperId].filter((x): x is string => typeof x === "string");
  return ids.some((id) => id.startsWith("s2:")) ? "semantic_scholar" : "openalex";
}

/**
 * Step 3–4 above, for a pair S2's citation contexts did not classify.
 * `outcome` = what the S2 lookup found (`null` = no S2 lookup was made).
 */
export async function classifyWithoutLlm(
  intentRecord: PaperLike,
  parent: PaperLike,
  child: PaperLike,
  counters: NoLlmCounters,
  outcome: { lookup?: S2LookupOutcome } | null,
  listSource?: CitationListSource,
): Promise<DerivedEdge | null> {
  const source =
    outcome === null ? null : citationListSource(outcome.lookup, parent, child, listSource);
  if (outcome?.lookup === "fetch-failed") counters.s2Unreachable += 1;
  const cls = await deriveRelation(intentRecord as ClassifyPaperLike, {
    parent: parent as ClassifyPaperLike,
    child: child as ClassifyPaperLike,
    strictMode: "off",
  });
  const api = (): DerivedEdge => {
    counters.apiCitationEdges += 1;
    return apiCitationEdge(parent, child, source as CitationListSource);
  };
  if (cls === null) {
    // `_is_influential === false`: S2 marks the citation incidental; such
    // pairs are dropped in both modes.
    if (source === null || intentRecord._is_influential === false) return null;
    return guardRelation(api(), parent, child);
  }
  if (cls.provenance === "year_cite" && source !== null) return guardRelation(api(), parent, child);
  return guardRelation(demoteLowInformationEdge(cls, parent, child), parent, child);
}

/**
 * Steps 1–4 for one pair (conference / deep builders). `s2` must have
 * `provider: null`; `listSource` names the list the pair came from.
 */
export async function classifyPairApiOnly(
  parent: PaperLike,
  child: PaperLike,
  intentRecord: PaperLike,
  s2: S2RelationContext | null,
  counters: NoLlmCounters,
  listSource: CitationListSource,
): Promise<DerivedEdge | null> {
  if (isVersionIncrement(parent as ClassifyPaperLike, child as ClassifyPaperLike)) {
    return guardRelation(
      titleVersionEdge(parent as ClassifyPaperLike, child as ClassifyPaperLike),
      parent,
      child,
    );
  }
  const outcome: { lookup?: S2LookupOutcome } = {};
  if (s2 !== null) {
    if (s2.provider !== null) throw new Error("classifyPairApiOnly: s2.provider must be null");
    const fromS2 = await deriveS2Relation(parent, child, s2, undefined, outcome);
    if (fromS2 !== null) return guardRelation(fromS2, parent, child);
  }
  return classifyWithoutLlm(
    intentRecord,
    parent,
    child,
    counters,
    s2 === null ? null : outcome,
    listSource,
  );
}

/**
 * The v1 edge provenance of a no-LLM classification for the conference /
 * deep builders (their own producer name/version; no provider, model or
 * prompt). Rule edges hash their own evidence (`DerivedEdge.evidence`),
 * the other methods the paper-metadata input, like the theme builder.
 */
export function noLlmProvenance(
  derived: DerivedEdge,
  options: {
    producerName: string;
    producerVersion: string;
    classificationSchemaVersion: string;
    srcId: string;
    dstId: string;
    parent: PaperLike;
    child: PaperLike;
    intentRecord: PaperLike;
  },
): Record<string, unknown> {
  const method = derived.provenance;
  if (method === "llm") throw new Error("noLlmProvenance: an LLM classification is not no-LLM");
  return makeProvenance({
    producerName: options.producerName,
    producerVersion: options.producerVersion,
    evidenceSource:
      derived.evidence?.source ?? (method === "context_pattern" ? "unarxive" : "semantic_scholar"),
    evidenceKind:
      derived.evidence?.kind ??
      (method === "context_pattern" ? "citation-context" : "citation-metadata"),
    evidenceSha256:
      derived.evidence?.sha256 ??
      canonicalJsonSha256(
        heuristicEvidenceInput({
          srcId: options.srcId,
          dstId: options.dstId,
          parent: options.parent,
          child: options.child,
          intentRecord: options.intentRecord,
        }),
      ),
    method,
    provider: null,
    model: null,
    promptVersion: null,
    classificationSchemaVersion: options.classificationSchemaVersion,
  });
}

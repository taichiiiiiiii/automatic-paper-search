/**
 * R2-9: API-only relation classification (evaluation, not wired into
 * generation). Maps the public citation signals Semantic Scholar exposes
 * for one citing->cited pair — `intents`, `contexts` (the citing paper's
 * sentences around the citation marker) and `isInfluential` — plus shared
 * authorship onto a SIMPLIFIED, evidence-backed taxonomy:
 *
 *   builds_on         B inherits A's method (extend / build on / follow /
 *                     based on / S2 methodology intent / S2 influential)
 *   compares_with     B measures itself against A, or positions itself
 *                     against it (outperform / compared with / baseline /
 *                     unlike / S2 result intent)
 *   uses_resource     B uses A's dataset / benchmark / code / optimizer
 *   background        B mentions A only as related work (S2 background
 *                     intent, no stronger signal)
 *   cites_unspecified B cites A, but no API gives a type (no S2 record,
 *                     contexts elided, no intents)
 *
 * Pure functions only; the network side lives in `apiRelationsCli.ts`.
 * See docs/design/43-api-based-relation-evaluation.md.
 */

export const API_RELATIONS = [
  "builds_on",
  "compares_with",
  "uses_resource",
  "background",
  "cites_unspecified",
] as const;
export type ApiRelation = (typeof API_RELATIONS)[number];

/** Signals for ONE citing->cited pair, as returned by the S2 Graph API
 * `/paper/{citing}/references` endpoint (plus author overlap). */
export interface PairSignals {
  /** The pair was found in S2's reference list of the citing paper. */
  found: boolean;
  intents: readonly string[];
  contexts: readonly string[];
  isInfluential: boolean | null;
  /** Citing and cited share at least one S2 author id. */
  sharedAuthors?: boolean;
  /** Title of the citing paper (v2: surveys only ever give background). */
  citingTitle?: string;
}

export interface ApiClassification {
  relation: ApiRelation;
  /** Which rule fired (stable id, used in reports and provenance). */
  rule: string;
  /** Rule-level confidence (a fixed prior per rule, not a probability). */
  confidence: number;
  /** The context sentence that triggered a phrase rule, if any. */
  evidence: string | null;
  /** True when the phrase rule found a contrast cue ("unlike", "in contrast"). */
  contrast: boolean;
}

// Phrase rules are applied per context sentence. A sentence often cites
// several works ("[3, 7, 12]"), so phrase evidence is still noisy; the
// confidence priors below are calibrated on the R2-9 hand check.
const BUILD_PATTERNS: readonly RegExp[] = [
  /\bbuil(d|ds|t|ding)\s+(up)?on\b/i,
  /\b(we|our\s+\w+|this\s+\w+)\s+(further\s+)?(extend|extends|generali[sz]e|generali[sz]es|adapt|adapts|modify|modifies)\b/i,
  /\b(extension|generali[sz]ation|variant|modification)\s+of\b/i,
  /\bfollow(ing)?\s+(the\s+)?(\[|\(|[A-Z][\w-]+\s+et\s+al|[A-Z][\w-]+\s*[[(])/,
  /\b(we|our\s+\w+)\s+follows?\b/i,
  /\b(our|this|the\s+proposed)\s+(\w+\s+){0,3}(is|are)\s+(largely\s+|mainly\s+)?based\s+on\b/i,
  /\binspired\s+by\b/i,
  /\b(we|our\s+\w+)\s+(adopt|adopts|borrow|borrows|reuse|reuses)\b/i,
  /\b(we|our\s+\w+)\s+(use|uses|employ|employs)\s+(the\s+|a\s+)?([\w-]+\s+){0,3}(architecture|model|layer|layers|module|backbone|encoder|decoder|mechanism|block|blocks|operator)\b/i,
];

const CONTRAST_PATTERNS: readonly RegExp[] = [
  /\bunlike\b/i,
  /\bin\s+contrast\s+(to|with)\b/i,
  /\bdiffer(s|ent)?\s+from\b/i,
  /\bas\s+opposed\s+to\b/i,
];

const COMPARE_PATTERNS: readonly RegExp[] = [
  /\boutperform(s|ed|ing)?\b/i,
  /\bsurpass(es|ed|ing)?\b/i,
  /\bsuperior\s+to\b/i,
  /\bbetter\s+than\b/i,
  /\bcompar(e|ed|es|ing|ison)\s+(\w+\s+){0,2}(to|with|against)\b/i,
  /\bbaselines?\b/i,
  /\bstate[\s-]of[\s-]the[\s-]art\b/i,
  /\bcompetitive\s+(with|to)\b/i,
  /\bimprove(s|d|ment|ments)?\s+(\w+\s+){0,2}over\b/i,
];

const RESOURCE_NOUN =
  /\b(dataset|datasets|data\s+set|benchmark|benchmarks|corpus|corpora|code|codebase|implementation|library|toolkit|optimi[sz]er|initiali[sz]ation|pre-?trained|checkpoints?|splits?)\b/i;
const RESOURCE_VERB =
  /\b(use|uses|used|using|utili[sz]e[sd]?|adopt(ed)?|employ(ed)?|train(ed)?\s+on|evaluat(e|ed|ing)\s+on|available|provided|released|from)\b/i;

function cleanContexts(contexts: readonly string[]): string[] {
  return contexts.filter((c) => typeof c === "string" && c.trim().length > 0);
}

function firstMatch(contexts: readonly string[], patterns: readonly RegExp[]): string | null {
  for (const ctx of contexts) {
    if (patterns.some((p) => p.test(ctx))) return ctx.trim();
  }
  return null;
}

function resourceMatch(contexts: readonly string[]): string | null {
  for (const ctx of contexts) {
    if (RESOURCE_NOUN.test(ctx) && RESOURCE_VERB.test(ctx)) return ctx.trim();
  }
  return null;
}

/**
 * Classify one pair from API signals only. Priority:
 *   1. phrase rules on S2 contexts: build > contrast > compare > resource
 *   2. S2 intents: methodology > result > background
 *   3. isInfluential (Valenzuela et al. 2015: "used or extended")
 *   4. shared authors (self-citation lineage)
 *   5. background when S2 has contexts but nothing fired, else unspecified
 */
export function classifyApiRelation(s: PairSignals): ApiClassification {
  const none = (rule: string): ApiClassification => ({
    relation: "cites_unspecified",
    rule,
    confidence: 0.3,
    evidence: null,
    contrast: false,
  });
  if (!s.found) return none("s2_pair_missing");

  const contexts = cleanContexts(s.contexts);
  const intents = new Set(s.intents.map((i) => i.toLowerCase()));

  const build = firstMatch(contexts, BUILD_PATTERNS);
  if (build) {
    return {
      relation: "builds_on",
      rule: "phrase_build",
      confidence: 0.8,
      evidence: build,
      contrast: false,
    };
  }
  const contrast = firstMatch(contexts, CONTRAST_PATTERNS);
  if (contrast) {
    return {
      relation: "compares_with",
      rule: "phrase_contrast",
      confidence: 0.7,
      evidence: contrast,
      contrast: true,
    };
  }
  const compare = firstMatch(contexts, COMPARE_PATTERNS);
  if (compare) {
    return {
      relation: "compares_with",
      rule: "phrase_compare",
      confidence: 0.75,
      evidence: compare,
      contrast: false,
    };
  }
  const resource = resourceMatch(contexts);
  if (resource) {
    return {
      relation: "uses_resource",
      rule: "phrase_resource",
      confidence: 0.7,
      evidence: resource,
      contrast: false,
    };
  }
  if (intents.has("methodology")) {
    return {
      relation: "builds_on",
      rule: "intent_methodology",
      confidence: 0.65,
      evidence: contexts[0]?.trim() ?? null,
      contrast: false,
    };
  }
  if (intents.has("result")) {
    return {
      relation: "compares_with",
      rule: "intent_result",
      confidence: 0.65,
      evidence: contexts[0]?.trim() ?? null,
      contrast: false,
    };
  }
  if (s.isInfluential === true) {
    return {
      relation: "builds_on",
      rule: "influential",
      confidence: 0.55,
      evidence: contexts[0]?.trim() ?? null,
      contrast: false,
    };
  }
  if (s.sharedAuthors === true) {
    return {
      relation: "builds_on",
      rule: "shared_authors",
      confidence: 0.5,
      evidence: null,
      contrast: false,
    };
  }
  if (intents.has("background")) {
    return {
      relation: "background",
      rule: "intent_background",
      confidence: 0.6,
      evidence: contexts[0]?.trim() ?? null,
      contrast: false,
    };
  }
  if (contexts.length > 0) {
    return {
      relation: "background",
      rule: "context_no_cue",
      confidence: 0.45,
      evidence: contexts[0]?.trim() ?? null,
      contrast: false,
    };
  }
  return none("s2_no_context");
}

// ---------------------------------------------------------------- v2

// v2 = v1 revised after the R2-9 hand check (docs/design/43 §4). v1's
// weak rules (S2 methodology intent alone, isInfluential alone, shared
// authors) and the comparison phrases on multi-citation sentences mostly
// fired on plain related-work mentions; v2 demotes them to `background`,
// requires a first-person subject for comparison/contrast phrases, treats
// survey citing papers as background-only, and checks resource use
// within one clause. v2 was validated on a separate hold-out sample.

const SURVEY_TITLE = /\b(survey|review|overview|tutorial|primer|introduction\s+to)\b/i;
const FIRST_PERSON = /\b(we|our|ours|this\s+(paper|work))\b/i;
const RESOURCE_CLAUSE: readonly RegExp[] = [
  /\b(use|uses|used|using|adopt|adopts|adopted|employ|employs|employed|utili[sz]e[sd]?|train(ed)?\s+on|evaluat\w*\s+(on|with)|pre-?trained\s+on|initiali[sz]ed\s+(with|from|by)|transfer\w*\s+\w+\s+to|regulari[sz]e\w*\s+\w+\s+with)\b[^.;:]{0,70}\b(datasets?|benchmarks?|corpus|corpora|code|codebase|implementation|library|toolkit|optimi[sz]er|framework|weights|splits?|initiali[sz]ation|smoothing|augmentation|regulari[sz]ation)\b/i,
  /\b(datasets?|benchmarks?|corpus|corpora|code|codebase|implementation|optimi[sz]er|framework|weights|splits?)\b[^.;:]{0,40}\b(is|are|was|were)\s+(used|adopted|employed)\b/i,
];
/** A results-table row flattened into a sentence: many decimal numbers. */
const TABLE_ROW = /(\d+\.\d+[^\d]+){4,}/;

function firstMatchWhere(
  contexts: readonly string[],
  patterns: readonly RegExp[],
  extra: (ctx: string) => boolean,
): string | null {
  for (const ctx of contexts) {
    if (patterns.some((p) => p.test(ctx)) && extra(ctx)) return ctx.trim();
  }
  return null;
}

/**
 * v2 rule set (recommended). Priority:
 *   0. S2 has no record of the pair -> cites_unspecified
 *   1. citing paper is a survey/review -> background
 *   2. build phrase -> builds_on
 *   3. resource verb + resource noun in one clause -> uses_resource
 *   4. first-person comparison / contrast phrase, or a results-table row -> compares_with
 *   5. S2 result intent -> compares_with
 *   6. S2 methodology intent AND isInfluential -> builds_on (weak)
 *   7. any context -> background; no context -> cites_unspecified
 */
export function classifyApiRelationV2(s: PairSignals): ApiClassification {
  const mk = (
    relation: ApiClassification["relation"],
    rule: string,
    confidence: number,
    evidence: string | null,
    contrast = false,
  ): ApiClassification => ({ relation, rule, confidence, evidence, contrast });
  if (!s.found) return mk("cites_unspecified", "s2_pair_missing", 0.3, null);
  const contexts = cleanContexts(s.contexts);
  const intents = new Set(s.intents.map((i) => i.toLowerCase()));
  const first = contexts[0]?.trim() ?? null;

  if (s.citingTitle && SURVEY_TITLE.test(s.citingTitle)) {
    return mk("background", "citing_survey", 0.8, first);
  }
  const build = firstMatch(contexts, BUILD_PATTERNS);
  if (build) return mk("builds_on", "phrase_build", 0.8, build);
  const resource = firstMatch(contexts, RESOURCE_CLAUSE);
  if (resource) return mk("uses_resource", "phrase_resource", 0.7, resource);
  const fp = (c: string) => FIRST_PERSON.test(c);
  const contrast = firstMatchWhere(contexts, CONTRAST_PATTERNS, fp);
  if (contrast) return mk("compares_with", "phrase_contrast", 0.7, contrast, true);
  const compare = firstMatchWhere(contexts, COMPARE_PATTERNS, fp);
  if (compare) return mk("compares_with", "phrase_compare", 0.75, compare);
  const table = contexts.find((c) => TABLE_ROW.test(c));
  if (table) return mk("compares_with", "table_row", 0.65, table.trim());
  if (intents.has("result")) return mk("compares_with", "intent_result", 0.6, first);
  if (intents.has("methodology") && s.isInfluential === true) {
    return mk("builds_on", "intent_methodology_influential", 0.5, first);
  }
  if (contexts.length > 0) return mk("background", "context_no_cue", 0.6, first);
  return mk("cites_unspecified", "s2_no_context", 0.3, null);
}

export const RULESETS = { v1: classifyApiRelation, v2: classifyApiRelationV2 } as const;

/** Project the 7-way LLM relation enum (relation-prompt-v2) onto the
 * simplified taxonomy. `baseline_only` ("compared against / background /
 * dataset, no intellectual inheritance") cannot be split without the
 * sentence, so it maps to the coarse `not_inherit` bucket used for the
 * binary agreement; `contrasts` maps to compares_with. */
export function llmToSimplified(rel: string): ApiRelation | "not_inherit" | null {
  switch (rel) {
    case "supersedes":
    case "successor":
    case "extends":
    case "ablation":
      return "builds_on";
    case "contrasts":
      return "compares_with";
    case "baseline_only":
      return "not_inherit";
    default:
      return null;
  }
}

/** Coarse inherit / not-inherit / unknown projection shared by both sides. */
export function coarse(
  rel: ApiRelation | "not_inherit" | null,
): "inherit" | "not_inherit" | "unknown" {
  if (rel === "builds_on") return "inherit";
  if (rel === "cites_unspecified" || rel === null) return "unknown";
  return "not_inherit";
}

/** Count `(row, col)` pairs into a nested record. */
export function confusion<T>(
  items: readonly T[],
  row: (t: T) => string,
  col: (t: T) => string,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const it of items) {
    const r = row(it);
    const c = col(it);
    out[r] ??= {};
    out[r][c] = (out[r][c] ?? 0) + 1;
  }
  return out;
}

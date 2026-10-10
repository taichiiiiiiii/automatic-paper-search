/**
 * API-based relation classification (design 41 D6, design 43). Written
 * for the R2-9 evaluation (rule sets v1/v2); R2-10 made rule set v2 the
 * production classifier of theme lineages, and since R2-16 production
 * uses rule set v3 (per-sentence target matching, negative cues; see the
 * v3 section) through `classifyS2Pair` / `v1RelationFor` below, used by
 * `../theme/s2Relations.ts`. v1/v2 stay unchanged for the evaluation. The
 * evaluation entry point `../eval/apiRelations.ts` re-exports this module.
 * Maps the public citation signals Semantic Scholar exposes
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
 * Pure functions only; the network side lives in `../theme/s2Citations.ts`
 * (production) and `../eval/apiRelationsCli.ts` (evaluation).
 * See docs/design/43-api-based-relation-evaluation.md.
 */

import type { ClassifyPaperLike } from "../../collect/llm/provider.js";
import { isSurveyLikeTitle } from "../shared/surveyLike.js";
import { citationTargetCount } from "./citationCount.js";
import {
  type CitedIdentity,
  citedIdentity,
  citingSelfNames,
  cueTargetsCited,
  isCueTarget,
  isQuotable,
  isStrongTarget,
  isUsableContext,
  mentionsAny,
  namedOnlyInMarkerGroup,
  namesCitedPaper,
  ownVariantOf,
  pickQuote,
  type SentenceTarget,
  sentenceTarget,
} from "./citedTarget.js";

export { citationTargetCount };

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
  /** R2-15: the citing paper is a survey/review per the full
   * `isSurveyLike` test (publication type, title, abstract). When
   * omitted, the title-only test on `citingTitle` decides. */
  citingSurvey?: boolean;
  /** R2-16: the cited paper (title / authors / year), used to tell which
   * context sentences are about it (`citedTarget.ts`). Omitted = every
   * sentence is judged by its citation-marker count alone. */
  cited?: ClassifyPaperLike;
  /** R2-23: the citing paper's abstract. A build / contrast cue in one of
   * its sentences that names the cited paper in words ("we propose …
   * SwinIR … based on the Swin Transformer") is evidence when the
   * citation contexts carry no strong cue (rule `abstract_build` /
   * `abstract_contrast`). */
  citingAbstract?: string | null;
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
  /** R2-16 (rule set v3): how the evidence sentence refers to the cited
   * paper; `null` when there is no evidence sentence. */
  target?: SentenceTarget | null;
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

  if (s.citingSurvey ?? isSurveyLikeTitle(s.citingTitle)) {
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

// ---------------------------------------------------------------- v3 (R2-16)

// v3 = v2 revised after the second review of the published lineages
// (ERROR_PATTERNS 2/3/4/7). Changes, all per context sentence:
//  - a sentence counts only when it is usable evidence (not a bibliography
//    line, not a bare marker list, >= 40 chars) and its cue can be about
//    the cited paper (`citedTarget.ts`): it names the cited paper (short
//    title, acronym, first-author "et al.", or the inferred reference
//    marker) or cites at most two works; a sentence citing three or more
//    works without singling out the cited one is background at most;
//  - a build cue needs a first-person subject ("our architecture is
//    adapted from Swin Transformer [28]", "we build on [16]"), so "Built
//    upon the success of ViT, many efforts…" or "a concurrent work [82]
//    proposed … based on [56]" do not make an extends edge; "adapted from
//    / built upon / based on / extends" is now recognised in the passive
//    too, and outranks the S2 intents (Swin -> Video Swin);
//  - negative cues: an experimental protocol ("we follow [30, 47] and
//    train … 80k iterations", "following [1], we use 4x3 views", "same
//    setting as"), "for (a) fair comparison", an ablation ("we also try …
//    in [11]") and comparison words (outperform / surpass / compared with)
//    make the sentence a comparison / resource use, never builds_on;
//  - a comparison cue counts without a first-person subject when the
//    sentence names the cited paper ("outperforming PVT-Small [34]");
//  - a contrast cue gives `contrast: true` only when the sentence targets
//    the cited paper unambiguously (named, or the only work it cites);
//  - the weak "methodology intent + influential" rule needs a sentence
//    that names / singles out the cited paper (R2-22: and gives background
//    only — intent + influential + a name is not a build claim);
//  - the evidence of every rule is the sentence that triggered it; the
//    intent / background rules quote the best sentence about the cited
//    paper (`pickQuote`) or none.

/** The citing paper as the subject of a build cue: we / our / us, a
 * sentence opening with "(In) this paper/work", or "this/the proposed
 * model/method/…". Not "this work" as an object ("Concurrent work extends
 * this work to …" is about other papers). */
const FIRST_PERSON_BUILD: readonly RegExp[] = [
  // R2-23: not inside a hyphenated word ("us-ing" from a PDF line break).
  /(?<![\w-])(we|our|ours|us)(?![\w-])/i,
  /^(in\s+)?this\s+(paper|work)\b/i,
  /\b(this|the\s+proposed)\s+(model|method|approach|architecture|design|framework)\b/i,
];

const ADAPT_PATTERNS: readonly RegExp[] = [
  /\b(is|are|was|were)\s+(largely\s+|mainly\s+|directly\s+|partly\s+)?(adapted|derived|built|extended|developed|modified)\s+(from|upon|on)\b/i,
  /\badapt(s|ed|ing)?\s+from\b/i,
  /\b(spatiotemporal\s+|temporal\s+)?adaptation\s+of\b/i,
  /\bbased\s+on\b/i,
  /\bextend(s|ed|ing)?\b/i,
  // R2-21: the citing method generalises the cited one ("… GCN [21] and
  // DCNN [3] on graphs as particular instances of our approach", "our
  // framework subsumes …"). Only "of OUR …": "our work is a particular
  // instance of MoNet" says the opposite and does not match.
  /\b(particular|special)\s+(instances?|cases?)\s+of\s+(our|the\s+proposed)\b/i,
  /\b(we|our\s+\w+)\s+(subsume|subsumes|generali[sz]e|generali[sz]es)\b/i,
  // R2-21: "we use the “mean” variant of GraphSAGE [16]" (quoted words
  // allowed between the verb and variant/version).
  /\b(we|our\s+\w+)\s+(use|uses|employ|employs|adopt|adopts)\s+(the\s+|a\s+)?([\w"“”'‘’-]+\s+){0,3}(variant|version)\s+of\b/i,
  // R2-22: "Motivated by the Swin Transformer's [19] success, we propose
  // Swin-Unet" (with the first-person subject `classifySentence` requires).
  /\bmotivated\s+by\s+(the\s+)?[^.;,]{0,40}\b(success|design|idea)\b/i,
  // R2-22: "Following [39], we place the MoEs on every other layer" (V-MoE
  // <- GShard). BUILD_PATTERNS' "follow(ing) [x]" is case-sensitive, so a
  // sentence-initial "Following [x], we …" never matched; protocol
  // sentences ("Following [1], we use 4x3 views") are caught first.
  /^\s*following\s+(\[\d|\(?[A-Z][\w-]+(\s+et\s+al\.?|\s*\[\d))[^,]{0,60},\s*(we|our)\b/i,
];

const PROTOCOL_PATTERNS: readonly RegExp[] = [
  /\bfollow(s|ed|ing)?\b[^.;]{0,80}\b(train(ing)?|schedul\w*|settings?|setup|protocols?|iterations?|epochs?|batch(\s+size)?|views?|crops?|evaluat\w*|learning\s+rate|lr|optimi[sz]\w*|augmentations?|hyper-?parameters?|recipes?|implementation\s+details?|inference|pre-?process\w*|splits?|metrics?|resolution|report\w*|results?|accuracy)\b/i,
  /\b(train(ing|ed)?|evaluat\w*|inference|schedul\w*|settings?|protocols?|test(ing|ed)?)\b[^.;]{0,60}\bfollow(s|ed|ing)?\b/i,
  /\b(same|identical|similar)\s+(training\s+|experimental\s+|evaluation\s+)?(settings?|setup|protocols?|configurations?|recipes?|hyper-?parameters?)\s+(as|to|with|of)\b/i,
  /\bmatching\s+the\s+[\w-]+\s+used\s+(by|in)\b/i,
  /\bresults?\s+(are|is|were)\s+(copied|taken|borrowed|reported)\s+from\b/i,
  // R2-22: copying a model size / configuration (Longformer: "a large (30
  // layers, 512 hidden size) model as in Child et al. (2019)").
  /\b(models?|sizes?|layers?|hidden|dimensions?|heads?|configurations?|depth|width)\b[^.;]{0,60}\bas\s+in\s+(\[|\(|[A-Z])/,
  // R2-22: taking the setup wholesale (Hash Layers: "We use the
  // architecture, data …, and hyperparameters directly from [10]").
  /\bhyper-?parameters?\b[^.;]{0,40}\b(directly\s+)?from\b/i,
  /\b(sampl\w*|subsampl\w*)\b[^.;]{0,80}\bfollow(s|ed|ing)?\b/i,
  // R2-23 (more contexts per pair surface more setup sentences):
  // copying an architecture for the experiments ("We use the same
  // architecture as Kipf & Welling (2017)"),
  /\b(same|identical)\s+([\w-]+\s+){0,2}(architectures?|models?|networks?|backbones?|configurations?)\s+(as|to)\b/i,
  // a per-dataset setup line ("PPI and Reddit: We use the mean pooling
  // architecture proposed by Hamilton et al."),
  /^[•·*\s-]*[A-Z][\w-]*(\s*(,|and|&)\s*[A-Z][\w-]*){0,4}\s*:\s*we\s+(use|adopt|employ)\b/i,
  // a training-recipe item adopted ("We adopt learning rate warmup [16]"),
  /\b(adopt\w*|use[sd]?|using|apply|applies|applied|employ\w*)\b[^.;]{0,40}\b(warm-?up|learning\s+rates?|lr\s+schedul\w*|epochs?|batch\s+sizes?|weight\s+decay|dropout|label[\s-]smoothing|data\s+augmentations?)\b/i,
  // following someone's analysis / measurement procedure ("we follow
  // Brown et al. (2020) and include all adjectives … manual labeling",
  // "we measure the runtime … following [20]"),
  /\bfollow(s|ed|ing)?\b[^.;]{0,120}\b(analys[ie]s|annotat\w*|label(l)?ing|measur\w*|runtime|latency|throughput)\b/i,
  /\b(analys[ie]s|annotat\w*|label(l)?ing|measur\w*|runtime|latency|throughput)\b[^.;]{0,120}\bfollow(s|ed|ing)?\b/i,
  // an analysis that starts from other models ("Based on … DeiT [69] and
  // Swin [44], we systematically analyze …"), a design merely similar to
  // others ("We use fewer blocks … similar to MobileNetV3 [26] and LeViT").
  /\bbased\s+on\b[^.;]{0,100},\s*we\s+(\w+\s+)?(analy[sz]e|study|investigate|evaluate|compare|measure|examine|benchmark)\b/i,
  /\bwe\s+use\b[^.;]{0,100}\bsimilar\s+to\b/i,
];
const FAIR_COMPARISON =
  /\b(for|to\s+make)\s+(a\s+)?fair(er)?\s+comparisons?\b|\bfair(ly)?\s+compar\w*/i;
const ABLATION_PATTERNS: readonly RegExp[] = [
  /\b(we|also)\s+(also\s+)?(try|tried|experiment(ed)?\s+with|test(ed)?|replace[ds]?)\b/i,
  /\bablat\w*/i,
];

/** Classification of one context sentence (null = no cue about the cited paper). */
interface SentenceCandidate {
  relation: ApiRelation;
  rule: string;
  confidence: number;
  contrast: boolean;
  sentence: string;
  target: SentenceTarget;
}

const anyMatch = (patterns: readonly RegExp[], s: string) => patterns.some((p) => p.test(s));

/** R2-23: v3 contrast cues: v1/v2's plus "While X uses …, our … allows …"
 * (Shazeer et al. <- Eigen et al.) — a sentence-initial "while"/"whereas"
 * clause about the cited work answered by a first-person clause. A
 * concessive "While X has been successful, we …" also matches; the
 * contrast still needs the cited paper inside the "while" clause and a
 * single target (`cueTargetsCited`, `isStrongTarget`). */
const CONTRAST_PATTERNS_V3: readonly RegExp[] = [
  ...CONTRAST_PATTERNS,
  /^\s*(while|whereas)\b[^,;]{0,200},\s*(we|our)\b/i,
];

/** R2-23: v3's first-person test; not inside a hyphenated word ("us-ing"). */
const FIRST_PERSON_V3 = /(?<![\w-])(we|our|ours|this\s+(paper|work))(?![\w-])/i;

/** R2-23: the R2-21 generalisation cue names the cited paper BEFORE the
 * cue ("GCN [26] … as particular instances of our approach"). */
const INSTANCE_OF_OURS =
  /\b(particular|special)\s+(instances?|cases?)\s+of\s+(our|the\s+proposed)\b/i;

/** R2-23: the citing paper proposing its own method as a baseline. */
const OWN_BASELINE =
  /\b(?:we|this\s+(?:paper|work))\s+(?:propose|present|introduce|establish)s?\s+(?:an?\s+)?(?:[\w-]+\s+){0,2}baselines?\b/gi;

/** R2-23: per-pair facts `classifySentence` needs beyond the cited identity. */
interface SentenceOpts {
  /** The citing paper's own names (`citingSelfNames`): a sentence about
   * them is first-person in effect. */
  self: readonly string[];
  /** `abstract`: a sentence of the citing paper's abstract — it has no
   * citation markers, so it must name the cited paper in words, and only
   * build / contrast cues count. */
  source: "context" | "abstract";
}

const CONTEXT_OPTS: SentenceOpts = { self: [], source: "context" };

function classifySentence(
  raw: string,
  id: CitedIdentity,
  opts: SentenceOpts = CONTEXT_OPTS,
): SentenceCandidate | null {
  const sentence = raw.replace(/\s+/g, " ").trim();
  const target = sentenceTarget(sentence, id);
  if (!isCueTarget(target)) return null;
  if (opts.source === "abstract" && !namesCitedPaper(sentence, id)) return null;
  const strong = isStrongTarget(target);
  const mk = (
    relation: ApiRelation,
    rule: string,
    confidence: number,
    contrast = false,
  ): SentenceCandidate => ({ relation, rule, confidence, contrast, sentence, target });
  if (!isUsableContext(sentence)) {
    // A flattened results-table row naming the cited paper is still a
    // comparison; it is never quoted (see `isQuotable`).
    return strong && TABLE_ROW.test(sentence) ? mk("compares_with", "table_row", 0.65) : null;
  }
  // R2-23: the citing method's own name as the subject ("These merits make
  // Swin Transformer suitable …") counts as first person.
  // Not for build cues: the own name is often the object there ("Weight-
  // update sharding … based on XLA … a special case for GShard", "while
  // RegNet [44] …, the Swin Transformer is manually adapted from …").
  const self = mentionsAny(sentence, opts.self);
  const fp = FIRST_PERSON_V3.test(sentence) || self;
  const fpBuild = anyMatch(FIRST_PERSON_BUILD, sentence);
  // Negative cues first: a protocol / fair-comparison / ablation sentence
  // is never builds_on, whatever build word it also contains.
  // R2-23: "et al." must not end the protocol patterns' clause scan ("we
  // follow Brown et al. (2020) and include … our analysis …").
  if (anyMatch(PROTOCOL_PATTERNS, sentence.replace(/\bet\s+al\./g, "et al"))) {
    return FAIR_COMPARISON.test(sentence) || anyMatch(COMPARE_PATTERNS, sentence)
      ? mk("compares_with", "phrase_protocol", 0.7)
      : mk("uses_resource", "phrase_protocol", 0.7);
  }
  if (FAIR_COMPARISON.test(sentence)) return mk("compares_with", "phrase_compare", 0.7);
  if (fp && anyMatch(ABLATION_PATTERNS, sentence)) {
    return mk("compares_with", "phrase_ablation", 0.65);
  }
  // R2-23: "we propose a strong baseline model SwinIR … based on the Swin
  // Transformer" offers the citing method as a baseline for others; that
  // "baseline" is not a comparison with the cited paper.
  const compare = anyMatch(COMPARE_PATTERNS, sentence.replace(OWN_BASELINE, " ")) && (fp || strong);
  const buildCues = [...ADAPT_PATTERNS, ...BUILD_PATTERNS];
  const scope = opts.source === "abstract" ? "phrase" : "clause";
  if (
    !compare &&
    fpBuild &&
    target !== "pair" &&
    // R2-22: a marker shared with other works ("[8, 15]") does not single
    // the cited paper out as what is built on.
    !namedOnlyInMarkerGroup(sentence, id) &&
    (ownVariantOf(sentence, id) ||
      (anyMatch(buildCues, sentence) &&
        // R2-23: the build cue must govern the cited paper (its name or
        // marker inside the cue's clause), not another work of the sentence.
        cueTargetsCited(sentence, id, buildCues, [INSTANCE_OF_OURS], scope)))
  ) {
    return opts.source === "abstract"
      ? mk("builds_on", "abstract_build", 0.75)
      : mk("builds_on", "phrase_build", 0.8);
  }
  if (anyMatch(RESOURCE_CLAUSE, sentence)) return mk("uses_resource", "phrase_resource", 0.7);
  if (fp && anyMatch(CONTRAST_PATTERNS_V3, sentence)) {
    // R2-23: a targeted contrast also needs the cue to govern the cited
    // paper, and not through a marker group shared with other works
    // ("Unlike CNN backbone networks [53, 21], … our PVT …").
    const targeted =
      strong &&
      !namedOnlyInMarkerGroup(sentence, id) &&
      cueTargetsCited(sentence, id, CONTRAST_PATTERNS_V3, [], scope);
    if (opts.source === "abstract") {
      return targeted ? mk("compares_with", "abstract_contrast", 0.7, true) : null;
    }
    return mk("compares_with", "phrase_contrast", 0.7, targeted);
  }
  if (compare) return mk("compares_with", "phrase_compare", 0.75);
  if (strong && TABLE_ROW.test(sentence)) return mk("compares_with", "table_row", 0.65);
  return null;
}

/** Sentences of an abstract (simple split on sentence-final punctuation). */
export function abstractSentences(abstract: string | null | undefined): string[] {
  if (typeof abstract !== "string") return [];
  return abstract
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z(“"])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Rank of a sentence candidate across the pair's sentences. */
function candidateRank(c: SentenceCandidate): number {
  if (c.relation === "builds_on") return 4;
  if (c.contrast) return 3;
  if (c.relation === "compares_with") return 2;
  return 1;
}

/**
 * v3 rule set (production since R2-16). Priority:
 *   0. S2 has no record of the pair -> cites_unspecified
 *   1. citing paper is a survey/review -> background
 *   2. per-sentence cues on sentences about the cited paper (see above):
 *      builds_on > contrast > comparison > resource / protocol
 *   3. S2 result intent -> compares_with
 *   4. S2 methodology intent AND isInfluential AND a sentence that names /
 *      singles out the cited paper -> background (rule id
 *      `intent_methodology_influential`; builds_on until R2-22)
 *   5. any context -> background; no context -> cites_unspecified
 * R2-22: builds_on comes only from a build cue in a sentence about the
 * cited paper (design 41 D5) — not from S2's intent/influential flags, not
 * from a marker shared with other works ("[8, 15]"), and never from a
 * copied setup ("model as in Child et al.", "hyperparameters directly
 * from [10]", "subsample … following Hamilton et al.").
 */
export function classifyApiRelationV3(s: PairSignals): ApiClassification {
  const id = citedIdentity(s.cited, s.contexts);
  const quote = (): { evidence: string | null; target: SentenceTarget | null } => {
    const q = pickQuote(s.contexts, id);
    return { evidence: q, target: q === null ? null : sentenceTarget(q, id) };
  };
  const mk = (
    relation: ApiRelation,
    rule: string,
    confidence: number,
    ev: { evidence: string | null; target: SentenceTarget | null },
    contrast = false,
  ): ApiClassification => ({ relation, rule, confidence, contrast, ...ev });
  if (!s.found)
    return mk("cites_unspecified", "s2_pair_missing", 0.3, { evidence: null, target: null });
  const contexts = cleanContexts(s.contexts);
  const intents = new Set(s.intents.map((i) => i.toLowerCase()));

  if (s.citingSurvey ?? isSurveyLikeTitle(s.citingTitle)) {
    return mk("background", "citing_survey", 0.8, quote());
  }
  const sentenceOpts: SentenceOpts = {
    self: citingSelfNames(s.citingTitle, id),
    source: "context",
  };
  let best: SentenceCandidate | null = null;
  for (const c of contexts) {
    const cand = classifySentence(c, id, sentenceOpts);
    if (cand !== null && (best === null || candidateRank(cand) > candidateRank(best))) best = cand;
  }
  // R2-23: no strong cue in the citation contexts — the citing paper's own
  // abstract may state it ("we propose … SwinIR … based on the Swin
  // Transformer", "We build on the recent Vision Transformer (ViT)"). Only
  // a build or a targeted contrast cue on a sentence that names the cited
  // paper in words counts (the abstract has no citation markers).
  if (best === null || candidateRank(best) < 3) {
    const abs: SentenceOpts = { ...sentenceOpts, source: "abstract" };
    for (const sent of abstractSentences(s.citingAbstract)) {
      const cand = classifySentence(sent, id, abs);
      if (cand === null || candidateRank(cand) < 3) continue;
      if (best === null || candidateRank(cand) > candidateRank(best)) best = cand;
    }
  }
  if (best !== null) {
    return mk(
      best.relation,
      best.rule,
      best.confidence,
      { evidence: best.sentence, target: best.target },
      best.contrast,
    );
  }
  if (intents.has("result")) return mk("compares_with", "intent_result", 0.6, quote());
  // R2-22: S2's methodology intent + isInfluential on a sentence that names
  // the cited paper is NOT builds_on any more. On the published lineages it
  // fired on related-work lists, limitation remarks and copied setups
  // (Performer <- Sparse Transformer / Reformer / Longformer, FlashAttention
  // <- Longformer / SMYRF); a build claim needs a build cue in the sentence
  // (design 41 D5), which the per-sentence rules above already look for.
  // The rule id stays so reports and the LLM routing still see the signal.
  if (intents.has("methodology") && s.isInfluential === true) {
    const q = quote();
    if (q.target !== null && isStrongTarget(q.target)) {
      return mk("background", "intent_methodology_influential", 0.6, q);
    }
  }
  if (contexts.length > 0) return mk("background", "context_no_cue", 0.6, quote());
  return mk("cites_unspecified", "s2_no_context", 0.3, { evidence: null, target: null });
}

export const RULESETS = {
  v1: classifyApiRelation,
  v2: classifyApiRelationV2,
  v3: classifyApiRelationV3,
} as const;

// ---------------------------------------------------------------- production (R2-10)

/** Rules whose evidence is a cue phrase (or a flattened results-table
 * row) in one context sentence. Such a sentence often cites several works
 * at once ("[3, 7, 12]"), so whether the cue is about THIS cited paper is
 * the main error source of the rules (design 43 §4.3) — these edges are
 * the ones the context LLM is asked about. */
export const CUE_RULES: ReadonlySet<string> = new Set([
  "phrase_build",
  "phrase_resource",
  "phrase_contrast",
  "phrase_compare",
  "phrase_protocol",
  "phrase_ablation",
  "table_row",
  "abstract_build",
  "abstract_contrast",
]);

/** R2-23: rules whose evidence sentence comes from the citing paper's
 * abstract, not from a Semantic Scholar citation context. */
export const ABSTRACT_RULES: ReadonlySet<string> = new Set(["abstract_build", "abstract_contrast"]);

/** Production view of one classification (design 41 D6; rule set v3
 * since R2-16). */
export interface S2RuleResult extends ApiClassification {
  /** A cue phrase / table row fired (see {@link CUE_RULES}). */
  cue: boolean;
  /** S2 marked the citation as influential. */
  influential: boolean;
  /** The evidence sentence refers to the cited paper unambiguously — it
   * names it (title stem, acronym, first author, inferred reference
   * marker) or cites exactly one work — so its cue can only be about the
   * cited paper. Gate for `contrasts`. */
  singleTarget: boolean;
  /** The evidence sentence may be shown as the quote: usable evidence
   * that identifies the cited paper (`citedTarget.ts::isQuotable`). */
  quotable: boolean;
  /** R2-22: the evidence sentence names the cited paper in words (title
   * stem, acronym, author, method name), not only by a reference marker. */
  namedInWords: boolean;
  /** R2-23: the evidence sentence is from the citing paper's abstract
   * ({@link ABSTRACT_RULES}), not a citation context. */
  fromAbstract: boolean;
}

/** Rule set v3 plus the routing facts production needs. */
export function classifyS2Pair(s: PairSignals): S2RuleResult {
  const base = classifyApiRelationV3(s);
  const id = citedIdentity(s.cited, s.contexts);
  return {
    ...base,
    cue: CUE_RULES.has(base.rule),
    influential: s.isInfluential === true,
    singleTarget: base.target != null && isStrongTarget(base.target),
    quotable: isQuotable(base.evidence, id),
    namedInWords: namesCitedPaper(base.evidence, id),
    fromAbstract: ABSTRACT_RULES.has(base.rule),
  };
}

/** The v1 artifact relations an API classification can map to. */
export type V1MappedRelation = "extends" | "contrasts" | "baseline_only";

/**
 * Map a simplified relation onto the v1 artifact enum (design 43 §9 案 A):
 *   builds_on -> extends
 *   compares_with -> contrasts only for a contrast cue that clearly targets
 *     the cited paper (`targetsCited`), otherwise baseline_only
 *   uses_resource / background -> baseline_only
 *   cites_unspecified -> null (the caller keeps its year/citation
 *     heuristic, which the D3 gate counts as unclassified)
 */
export function v1RelationFor(
  relation: ApiRelation,
  opts: { contrast: boolean; targetsCited: boolean },
): V1MappedRelation | null {
  switch (relation) {
    case "builds_on":
      return "extends";
    case "compares_with":
      return opts.contrast && opts.targetsCited ? "contrasts" : "baseline_only";
    case "uses_resource":
    case "background":
      return "baseline_only";
    default:
      return null;
  }
}

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

/**
 * Post-classification relation guard (R2-2d, R2-15; design doc 40).
 *
 * Three rules, applied to every classification the theme BFS produces
 * (LLM, Semantic Scholar context rules, heuristics):
 *
 *  0. R2-16 — `contrasts` needs a contrast cue in a Semantic Scholar
 *     citation sentence that targets the cited paper: only the
 *     `s2_context_rule` path (contrast cue on a sentence naming / singling
 *     out the cited paper) and the citation-context LLM (which is mapped to
 *     contrasts only on top of that rule cue) may emit it. The
 *     abstract-only LLM prompt, unarXive context patterns and heuristics
 *     cannot see such a sentence, so their `contrasts` becomes
 *     `baseline_only` (second review: T2T-ViT -> Swin, ViViT -> Swin V2).
 *
 *  1. R2-15 — the CITING (child, newer) paper is a survey/review
 *     ({@link isSurveyLike}: publication type, title or abstract). A
 *     review only organises the works it cites, so any `extends`,
 *     `successor`, `supersedes` or `contrasts` it was given becomes
 *     `baseline_only`. A `title_version` supersedes (an explicit new
 *     version of the same work) is left alone.
 *  2. R2-2d — `contrasts` means "both papers propose competing methods for
 *     the same task". The LLM over-assigns it whenever two papers look
 *     different — e.g. "signal processing on graphs" contrasts "A
 *     Comprehensive Survey on GNNs", or a pets dataset contrasts the ViT
 *     paper. When EITHER endpoint is a survey/review or a
 *     dataset/benchmark paper, `contrasts` becomes `baseline_only`.
 *
 *  3. R2-22 (design 41 D5) — an `extends`/`successor`/`supersedes`/
 *     `ablation` must rest on quoted evidence: an S2 citation-sentence
 *     build cue (`s2_context_rule`, or the citation-context LLM confirming
 *     one), an explicit version in the titles (`title_version`) or the
 *     curated ancestor list (`foundational_allowlist`, only used when the
 *     pair has no citation evidence). The abstract-only LLM, S2 intents
 *     alone (`intent_map`), unarXive patterns and heuristics become
 *     `baseline_only`; the rationale keeps the original label as a hint.
 *
 * Every other classification passes through unchanged. The edge keeps its
 * classification provenance (`llm`, prompt version, evidence hash of the
 * prompt actually sent); the rationale says that the relation was
 * corrected and why, so a reviewer can tell the two apart.
 */

import type { DerivedEdge } from "../classify/classify.js";
import { CONTEXT_PROMPT_VERSION } from "../llm/contextPrompt.js";
import { isSurveyLike } from "../shared/surveyLike.js";
import { looksLikeDataset, type TopicPaperLike } from "./topicScope.js";

export { isSurveyLike };

/** Highest confidence a corrected edge may carry: the classifier was
 * wrong about the kind of relation, so it should not look certain. */
export const GUARDED_RELATION_MAX_CONFIDENCE = 0.6;

const MAX_RATIONALE_CODEPOINTS = 200;

function why(parent: TopicPaperLike, child: TopicPaperLike): string | null {
  if (isSurveyLike(parent) || isSurveyLike(child)) return "サーベイ/レビュー論文";
  if (looksLikeDataset(parent) || looksLikeDataset(child)) return "データセット/ベンチマーク論文";
  return null;
}

/** Relations that claim intellectual inheritance or a competing method —
 * none of which a survey/review can have towards a paper it cites. */
const SURVEY_FORBIDDEN_RELATIONS: ReadonlySet<string> = new Set([
  "extends",
  "successor",
  "supersedes",
  "contrasts",
]);

function corrected(classification: DerivedEdge, note: string): DerivedEdge {
  const original = String(classification.rationale ?? "").trim();
  const rationale = [...`${note}${original ? ` 元の判定: ${original}` : ""}`]
    .slice(0, MAX_RATIONALE_CODEPOINTS)
    .join("");
  return {
    ...classification,
    relation: "baseline_only",
    confidence: Math.min(classification.confidence, GUARDED_RELATION_MAX_CONFIDENCE),
    rationale,
  };
}

/** Whether a `contrasts` classification rests on an S2 citation-context
 * contrast cue (rule 0). */
export function hasContextContrastEvidence(classification: DerivedEdge): boolean {
  if (classification.provenance === "s2_context_rule") return true;
  return (
    classification.provenance === "llm" && classification.promptVersion === CONTEXT_PROMPT_VERSION
  );
}

/** Lineage claims other than `contrasts` (rule 0 handles that one). */
const BUILD_CLAIMS: ReadonlySet<string> = new Set([
  "extends",
  "successor",
  "supersedes",
  "ablation",
]);

/**
 * R2-22 (design 41 D5): whether a build/replace claim rests on evidence
 * that can back it in public:
 *  - `s2_context_rule`: a build cue in a citing sentence that names the
 *    cited paper (rule set v3);
 *  - the citation-context LLM, which since R2-22 can only CONFIRM such a
 *    rule claim (`s2Relations.ts::mergeContextAnswer`);
 *  - `title_version`: an explicit new version in the titles;
 *  - `foundational_allowlist`: the curated ancestor list, used only when
 *    the pair has no citation evidence at all (R2-16).
 * The abstract-only LLM prompt, S2 intents alone (`intent_map`), unarXive
 * context patterns (no check that the sentence is about the cited paper)
 * and heuristics are not quoted evidence.
 */
export function hasQuotedBuildEvidence(classification: DerivedEdge): boolean {
  switch (classification.provenance) {
    case "s2_context_rule":
    case "title_version":
    case "foundational_allowlist":
      return true;
    case "llm":
      return classification.promptVersion === CONTEXT_PROMPT_VERSION;
    default:
      return false;
  }
}

/** `parent` = cited (older), `child` = citing (newer). Rewrite to
 * `baseline_only`: (1) an extends/successor/supersedes/contrasts whose
 * citing paper is a survey/review (except a `title_version` supersedes);
 * (0) a `contrasts` without S2 citation-context evidence; (2) a
 * `contrasts` whose endpoint is a survey/review or a dataset/benchmark
 * paper. Pass everything else. */
export function guardRelation(
  classification: DerivedEdge,
  parent: TopicPaperLike,
  child: TopicPaperLike,
): DerivedEdge {
  if (
    SURVEY_FORBIDDEN_RELATIONS.has(classification.relation) &&
    classification.provenance !== "title_version" &&
    isSurveyLike(child)
  ) {
    return corrected(
      classification,
      `引用側の論文がサーベイ/レビューのため ${classification.relation} を baseline_only に補正（レビューは引用先を整理するだけで、手法を継承・置換・対比しない）。`,
    );
  }
  if (BUILD_CLAIMS.has(classification.relation) && !hasQuotedBuildEvidence(classification)) {
    const by =
      classification.provenance === "llm"
        ? "要旨だけの LLM"
        : `規則（${classification.provenance}）`;
    return corrected(
      classification,
      `引用文の裏付けがないため ${classification.relation} を baseline_only に補正（${by}の判定は参考として残す）。`,
    );
  }
  if (classification.relation !== "contrasts") return classification;
  const kind = why(parent, child);
  if (kind !== null) {
    return corrected(
      classification,
      `${kind}が端点のため contrasts を baseline_only に補正（競合手法の対比ではない）。`,
    );
  }
  if (!hasContextContrastEvidence(classification)) {
    return corrected(
      classification,
      "引用文に被引用論文との対比を示す記述がないため contrasts を baseline_only に補正（要旨だけでは競合手法かどうか判断できない）。",
    );
  }
  return classification;
}

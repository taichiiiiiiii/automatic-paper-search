/**
 * Post-classification relation guard (R2-2d, R2-15; design doc 40).
 *
 * Two rules, applied to every classification the theme BFS produces (LLM,
 * Semantic Scholar context rules, heuristics):
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
 * Every other classification passes through unchanged. The edge keeps its
 * classification provenance (`llm`, prompt version, evidence hash of the
 * prompt actually sent); the rationale says that the relation was
 * corrected and why, so a reviewer can tell the two apart.
 */

import type { DerivedEdge } from "../classify/classify.js";
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

/** `parent` = cited (older), `child` = citing (newer). Rewrite to
 * `baseline_only`: (1) an extends/successor/supersedes/contrasts whose
 * citing paper is a survey/review (except a `title_version` supersedes);
 * (2) a `contrasts` whose endpoint is a survey/review or a
 * dataset/benchmark paper. Pass everything else. */
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
  if (classification.relation !== "contrasts") return classification;
  const kind = why(parent, child);
  if (kind === null) return classification;
  return corrected(
    classification,
    `${kind}が端点のため contrasts を baseline_only に補正（競合手法の対比ではない）。`,
  );
}
